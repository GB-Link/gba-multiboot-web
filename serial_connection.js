/**
 * Serial Connection for WebSerial (Firefox + Chromium).
 *
 * Exposes the same public API as UsbConnection so callers (multiboot.js,
 * RSESPTrading.js, etc.) don't need to know which transport is in use.
 *
 * CDC-ACM is a single bidirectional byte stream — packet boundaries are not
 * preserved. The firmware (SerialLayer) wraps each logical message in a tiny
 * frame, and this class parses those frames and reconstructs the same span
 * shape WebUSB delivers per endpoint.
 *
 *   | 0x47 0x42 | channel:1 | len:2 LE | payload[len] |
 *     sync 'GB'   0=cmd,1=data,2=status
 */

// New firmware command IDs (must match gblink-multiboot-web/usb_connection.js)
const SERIAL_CMD = {
    SET_MODE: 0x00,
    CANCEL: 0x01,
    GET_FIRMWARE_INFO: 0x0F,
    SET_TIMING_CONFIG: 0x30,
    SET_VOLTAGE_3V3: 0x40,
    SET_VOLTAGE_5V: 0x41,
    SET_LED_COLOR: 0x42,
};

const SERIAL_MODE = {
    GBA_TRADE_EMU: 0x00,
    GBA_LINK: 0x01,
    GB_LINK: 0x02,
};

const SYNC_0 = 0x47; // 'G'
const SYNC_1 = 0x42; // 'B'
const CH_COMMAND = 0x00;
const CH_DATA = 0x01;
const CH_STATUS = 0x02;
const MAX_PAYLOAD = 64;

class SerialConnection {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;
        // Mirror UsbConnection so calling code that branches on this works
        this.isNewFirmware = true;

        // Per-channel queues of received frames + pending waiters
        this._dataQueue = [];
        this._dataWaiters = [];
        this._statusQueue = [];
        this._statusWaiters = [];

        // Framing parser state — carried across read chunks
        this._rxState = 'sync1';
        this._rxChannel = 0;
        this._rxLen = 0;
        this._rxBuf = null;
        this._rxPos = 0;

        this._readLoopPromise = null;
    }

    async connect() {
        try {
            // GBLink unified firmware uses Zephyr default VID
            this.port = await navigator.serial.requestPort({
                filters: [{ usbVendorId: 0x2FE3 }]
            });
            // CDC-ACM ignores baud rate but WebSerial requires a value
            await this.port.open({ baudRate: 115200 });

            this.writer = this.port.writable.getWriter();
            this.reader = this.port.readable.getReader();
            this.isConnected = true;

            this._readLoopPromise = this._runReadLoop();
            console.log('Firmware: GBLink Unified (WebSerial)');

            // GBA multiboot requires 3.3V (matches UsbConnection.connect)
            await this.setVoltage('3v3');
            return true;
        } catch (error) {
            console.error('Serial connection failed:', error);
            this.isConnected = false;
            throw error;
        }
    }

    async disconnect() {
        this.isConnected = false;
        try {
            if (this.reader) {
                try { await this.reader.cancel(); } catch (_) {}
                try { this.reader.releaseLock(); } catch (_) {}
                this.reader = null;
            }
            if (this.writer) {
                try { this.writer.releaseLock(); } catch (_) {}
                this.writer = null;
            }
            if (this.port) {
                try { await this.port.close(); } catch (_) {}
                this.port = null;
            }
        } catch (e) {
            console.warn('Disconnect warning:', e);
        }
        // Reject pending waiters so callers don't hang
        for (const w of this._dataWaiters) w.reject(new Error('Disconnected'));
        for (const w of this._statusWaiters) w.reject(new Error('Disconnected'));
        this._dataWaiters = [];
        this._statusWaiters = [];
        this._dataQueue = [];
        this._statusQueue = [];
    }

    // --- Frame I/O ---

    async _runReadLoop() {
        try {
            while (this.isConnected && this.reader) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (!value || value.length === 0) continue;
                for (let i = 0; i < value.length; i++) {
                    this._feedByte(value[i]);
                }
            }
        } catch (e) {
            if (this.isConnected) console.warn('Serial read loop error:', e);
        }
    }

    _feedByte(b) {
        switch (this._rxState) {
            case 'sync1':
                if (b === SYNC_0) this._rxState = 'sync2';
                break;
            case 'sync2':
                if (b === SYNC_1) this._rxState = 'channel';
                else if (b === SYNC_0) this._rxState = 'sync2';
                else this._rxState = 'sync1';
                break;
            case 'channel':
                this._rxChannel = b;
                this._rxState = 'lenLo';
                break;
            case 'lenLo':
                this._rxLen = b;
                this._rxState = 'lenHi';
                break;
            case 'lenHi':
                this._rxLen |= b << 8;
                if (this._rxLen > MAX_PAYLOAD) {
                    this._rxState = 'sync1';
                    break;
                }
                this._rxPos = 0;
                this._rxBuf = new Uint8Array(this._rxLen);
                if (this._rxLen === 0) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                } else {
                    this._rxState = 'payload';
                }
                break;
            case 'payload':
                this._rxBuf[this._rxPos++] = b;
                if (this._rxPos >= this._rxLen) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                }
                break;
        }
    }

    _dispatchFrame() {
        const frame = this._rxBuf;
        if (this._rxChannel === CH_DATA) {
            const waiter = this._dataWaiters.shift();
            if (waiter) waiter.resolve(frame);
            else this._dataQueue.push(frame);
        } else if (this._rxChannel === CH_STATUS) {
            const waiter = this._statusWaiters.shift();
            if (waiter) waiter.resolve(frame);
            else this._statusQueue.push(frame);
        }
        // Channel COMMAND is host→device only; ignore if it ever arrives
    }

    async _writeFrame(channel, payload) {
        if (!this.isConnected || !this.writer) throw new Error('Not connected');
        if (payload.length > MAX_PAYLOAD) throw new Error('Payload too large');
        const frame = new Uint8Array(5 + payload.length);
        frame[0] = SYNC_0;
        frame[1] = SYNC_1;
        frame[2] = channel;
        frame[3] = payload.length & 0xFF;
        frame[4] = (payload.length >> 8) & 0xFF;
        frame.set(payload, 5);
        await this.writer.write(frame);
    }

    _awaitChannel(queue, waiters, timeoutMs) {
        if (queue.length > 0) return Promise.resolve(queue.shift());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            waiters.push(waiter);
            if (timeoutMs > 0) {
                setTimeout(() => {
                    const idx = waiters.indexOf(waiter);
                    if (idx !== -1) {
                        waiters.splice(idx, 1);
                        resolve(null); // match WebUSB: return null/empty on timeout
                    }
                }, timeoutMs);
            }
        });
    }

    // --- Public API (matches UsbConnection) ---

    async sendCommand(bytes) {
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        await this._writeFrame(CH_COMMAND, buf);
    }

    async readCommandResponse(timeoutMs = 500) {
        if (!this.isConnected) return null;
        return await this._awaitChannel(this._statusQueue, this._statusWaiters, timeoutMs);
    }

    async writeBytes(data) {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
        await this._writeFrame(CH_DATA, buf);
    }

    async readBytesRaw(length = 64, timeoutMs = 100) {
        if (!this.isConnected) throw new Error('Not connected');
        const frame = await this._awaitChannel(this._dataQueue, this._dataWaiters, timeoutMs);
        return frame || new Uint8Array(0);
    }

    async setVoltage(mode) {
        if (!this.isConnected) return false;
        const cmd = mode === '5v' ? SERIAL_CMD.SET_VOLTAGE_5V : SERIAL_CMD.SET_VOLTAGE_3V3;
        await this.sendCommand(new Uint8Array([cmd]));
        console.log(`Voltage switched to ${mode}`);
        return true;
    }

    async setLed(r, g, b, on = true) {
        if (!this.isConnected) return false;
        await this.sendCommand(new Uint8Array([SERIAL_CMD.SET_LED_COLOR, r, g, b, on ? 1 : 0]));
        return true;
    }

    async setTimingConfig(usBetweenTransfer, bytesPerTransfer) {
        if (!this.isConnected) return false;
        await this.sendCommand(new Uint8Array([
            SERIAL_CMD.SET_TIMING_CONFIG,
            usBetweenTransfer & 0xFF,
            (usBetweenTransfer >> 8) & 0xFF,
            (usBetweenTransfer >> 16) & 0xFF,
            bytesPerTransfer & 0xFF
        ]));
        return true;
    }

    async setMode(mode) {
        if (!this.isConnected) return false;
        await this.sendCommand(new Uint8Array([SERIAL_CMD.SET_MODE, mode]));
        return true;
    }

    async getFirmwareInfo() {
        if (!this.isConnected) return null;
        await this.sendCommand(new Uint8Array([SERIAL_CMD.GET_FIRMWARE_INFO]));
        // Firmware replies via sendData (channel 1), matching the WebUSB path
        // where the response lands on the data IN endpoint.
        const resp = await this._awaitChannel(this._dataQueue, this._dataWaiters, 1000);
        if (resp && resp.length >= 4 && resp[0] === 0x0F) {
            return { major: resp[1], minor: resp[2], patch: resp[3] };
        }
        return null;
    }
}

// Export onto window so non-module clients can pick it up alongside UsbConnection
window.SerialConnection = SerialConnection;
