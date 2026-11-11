/**
 * USB Connection for WebUSB
 * Supports both old (reconfigurable) and new (GBLink unified) firmware.
 */

// Check firmware version from USB device descriptor (bcdDevice)
// Available instantly on the device object — no USB transfers needed
function fwVersionAtLeast(device, minMajor, minMinor, minPatch) {
    if (!device) return false;
    const major = device.deviceVersionMajor || 0;
    const minor = device.deviceVersionMinor || 0;
    const patch = device.deviceVersionSubminor || 0;
    if (major !== minMajor) return major > minMajor;
    if (minor !== minMinor) return minor > minMinor;
    return patch >= minPatch;
}

// --- Old firmware magic packets (reconfigurable firmware) ---
const MAGIC_PREFIX = new Uint8Array([
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE, 0xCA, 0xFE,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF,
    0xDE, 0xAD, 0xBE, 0xEF, 0xDE, 0xAD, 0xBE, 0xEF
]);

function buildVswitchPacket(suffix) {
    const packet = new Uint8Array(36);
    packet.set(MAGIC_PREFIX);
    packet.set(new TextEncoder().encode(suffix), 32);
    return packet;
}

const VSWITCH_3V3_PACKET = buildVswitchPacket('V3V3');
const VSWITCH_5V_PACKET = buildVswitchPacket('V5V0');

const LED_PREFIX = new Uint8Array([
    ...MAGIC_PREFIX,
    0x4C, 0x45, 0x44, 0x53  // "LEDS"
]);

function buildLedPacket(r, g, b, on) {
    const packet = new Uint8Array(40);
    packet.set(LED_PREFIX);
    packet[36] = r;
    packet[37] = g;
    packet[38] = b;
    packet[39] = on ? 1 : 0;
    return packet;
}

// --- New firmware command IDs (GBLink unified firmware) ---
const CMD = {
    SET_MODE: 0x00,
    CANCEL: 0x01,
    GET_FIRMWARE_INFO: 0x0F,
    SET_TIMING_CONFIG: 0x30,
    SET_VOLTAGE_3V3: 0x40,
    SET_VOLTAGE_5V: 0x41,
    SET_LED_COLOR: 0x42,
};

const MODE = {
    GBA_TRADE_EMU: 0x00,
    GBA_LINK: 0x01,
    GB_LINK: 0x02,
};

class UsbConnection {
    constructor() {
        this.device = null;
        this.interfaceNumber = 0;
        this.endpointIn = 0;    // Data IN
        this.endpointOut = 0;   // Data OUT
        this.cmdEndpointIn = 0;  // Command/Status IN (new firmware only)
        this.cmdEndpointOut = 0; // Command OUT (new firmware only)
        this.isConnected = false;
        this.isNewFirmware = false; // true if GBLink unified firmware detected
    }

    async connect() {
        try {
            const filters = [
                { vendorId: 0xcafe },  // Old reconfigurable firmware (TinyUSB)
                { vendorId: 0x239A },  // Adafruit boards
                { vendorId: 0x2FE3 },   // GBLink unified firmware (Zephyr default VID)
                { vendorId: 0x1209, productId: 0xB011 } // GBLink firmware 3.0.0 and newer
            ];

            this.device = await navigator.usb.requestDevice({ filters: filters });
            await this.device.open();

            // Fix for stale connections on refresh
            if (this.device.reset) {
                await this.device.reset().catch(e => {
                    console.warn("Device reset failed (non-fatal):", e);
                });
            }

            await this.device.selectConfiguration(1);

            // Detect firmware type based on vendorId
            this.isNewFirmware = this.device.vendorId === 0x2FE3
                || (this.device.vendorId === 0x1209 && this.device.productId === 0xB011);

            // Find interface and endpoints
            const interfaces = this.device.configuration.interfaces;
            let foundInterface = false;

            for (const iface of interfaces) {
                for (const alt of iface.alternates) {
                    if (alt.interfaceClass === 0xFF) {
                        this.interfaceNumber = iface.interfaceNumber;

                        // Sort endpoints by number to map them correctly
                        const inEps = alt.endpoints
                            .filter(ep => ep.direction === "in")
                            .sort((a, b) => a.endpointNumber - b.endpointNumber);
                        const outEps = alt.endpoints
                            .filter(ep => ep.direction === "out")
                            .sort((a, b) => a.endpointNumber - b.endpointNumber);

                        if (this.isNewFirmware && inEps.length >= 2 && outEps.length >= 2) {
                            // Firmware source: commandOutEndpoint=1, dataOutEndpoint=2
                            // EP1 = commands (mode, voltage, timing)
                            // EP2 = data (SPI bytes in/out)
                            this.cmdEndpointOut = outEps[0].endpointNumber;  // EP1 OUT
                            this.cmdEndpointIn = inEps[0].endpointNumber;   // EP1 IN
                            this.endpointOut = outEps[1].endpointNumber;    // EP2 OUT
                            this.endpointIn = inEps[1].endpointNumber;      // EP2 IN
                            console.log(`New firmware: cmd=EP${this.cmdEndpointOut} data=EP${this.endpointOut}`);
                        } else {
                            // Old firmware: single pair of endpoints
                            if (outEps.length > 0) this.endpointOut = outEps[0].endpointNumber;
                            if (inEps.length > 0) this.endpointIn = inEps[0].endpointNumber;
                        }

                        foundInterface = true;
                        break;
                    }
                }
                if (foundInterface) break;
            }

            if (!foundInterface) {
                throw new Error("Could not find compatible interface");
            }

            await this.device.claimInterface(this.interfaceNumber);
            await this.device.selectAlternateInterface(this.interfaceNumber, 0);

            // CDC handshake — only needed for old firmware (TinyUSB)
            if (!this.isNewFirmware) {
                await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x22,
                    value: 0x01,
                    index: this.interfaceNumber
                });
            }

            this.isConnected = true;

            if (this.isNewFirmware) {
                console.log("Firmware: GBLink Unified");
            } else {
                const fwVer = `${this.device.deviceVersionMajor}.${this.device.deviceVersionMinor}.${this.device.deviceVersionSubminor}`;
                console.log(`Firmware: Reconfigurable, version: ${fwVer}`);
            }

            // GBA multiboot requires 3.3V
            await this.setVoltage('3v3');

            return true;

        } catch (error) {
            console.error("USB Connection failed:", error);
            this.isConnected = false;
            throw error;
        }
    }

    async disconnect() {
        if (this.device) {
            try {
                await this.device.releaseInterface(this.interfaceNumber);
                await this.device.close();
            } catch (e) {
                console.warn("Disconnect warning:", e);
            }
            this.device = null;
            this.isConnected = false;
            this.isNewFirmware = false;
        }
    }

    // --- Command endpoint (new firmware only) ---

    async sendCommand(bytes) {
        if (!this.isConnected) throw new Error("Not connected");
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (this.isNewFirmware && this.cmdEndpointOut) {
            await this.device.transferOut(this.cmdEndpointOut, buffer);
        } else {
            // Old firmware: commands go on the data endpoint as magic packets
            await this.device.transferOut(this.endpointOut, buffer);
        }
    }

    async readCommandResponse(timeoutMs = 500) {
        if (!this.isConnected || !this.isNewFirmware || !this.cmdEndpointIn) return null;
        try {
            const result = await Promise.race([
                this.device.transferIn(this.cmdEndpointIn, 64),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("timeout")), timeoutMs)
                )
            ]);
            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
                return new Uint8Array(result.data.buffer);
            }
        } catch (e) { /* timeout */ }
        return null;
    }

    // --- Data endpoint ---

    async writeBytes(data) {
        if (!this.isConnected) throw new Error("Not connected");
        const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
        await this.device.transferOut(this.endpointOut, buffer);
    }

    async readBytesRaw(length = 64, timeoutMs = 100) {
        if (!this.isConnected) throw new Error("Not connected");

        try {
            const result = await Promise.race([
                this.device.transferIn(this.endpointIn, length),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Read timeout")), timeoutMs)
                )
            ]);

            if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
                return new Uint8Array(result.data.buffer);
            }
        } catch (e) {
            // Timeout or no data
        }
        return new Uint8Array(0);
    }

    // --- Voltage switching ---

    async setVoltage(mode) {
        if (!this.isConnected) return false;

        if (this.isNewFirmware) {
            const cmd = mode === '5v' ? CMD.SET_VOLTAGE_5V : CMD.SET_VOLTAGE_3V3;
            await this.sendCommand(new Uint8Array([cmd]));
        } else {
            if (!fwVersionAtLeast(this.device, 1, 0, 6)) return false;
            const packet = mode === '5v' ? VSWITCH_5V_PACKET : VSWITCH_3V3_PACKET;
            await this.device.transferOut(this.endpointOut, packet);
            try {
                await Promise.race([
                    this.device.transferIn(this.endpointIn, 64),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500))
                ]);
            } catch (e) { /* ack timeout is non-fatal */ }
        }

        console.log(`Voltage switched to ${mode}`);
        return true;
    }

    // --- LED control ---

    async setLed(r, g, b, on = true) {
        if (!this.isConnected) return false;

        if (this.isNewFirmware) {
            await this.sendCommand(new Uint8Array([CMD.SET_LED_COLOR, r, g, b, on ? 1 : 0]));
        } else {
            if (!fwVersionAtLeast(this.device, 1, 0, 6)) return false;
            const packet = buildLedPacket(r, g, b, on);
            await this.device.transferOut(this.endpointOut, packet);
            try {
                await Promise.race([
                    this.device.transferIn(this.endpointIn, 64),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 500))
                ]);
            } catch (e) { /* ack timeout is non-fatal */ }
        }
        return true;
    }

    // --- Timing configuration ---

    async setTimingConfig(usBetweenTransfer, bytesPerTransfer) {
        if (!this.isConnected) return false;

        if (this.isNewFirmware) {
            // New firmware: send SetTimingConfig command on command endpoint
            const cmd = new Uint8Array([
                CMD.SET_TIMING_CONFIG,
                usBetweenTransfer & 0xFF,
                (usBetweenTransfer >> 8) & 0xFF,
                (usBetweenTransfer >> 16) & 0xFF,
                bytesPerTransfer & 0xFF
            ]);
            await this.sendCommand(cmd);
        } else {
            // Old firmware: magic prefix packet on data endpoint
            const config = new Uint8Array(36);
            config.set(MAGIC_PREFIX);
            config[32] = usBetweenTransfer & 0xFF;
            config[33] = (usBetweenTransfer >> 8) & 0xFF;
            config[34] = (usBetweenTransfer >> 16) & 0xFF;
            config[35] = bytesPerTransfer & 0xFF;
            await this.device.transferOut(this.endpointOut, config);
        }
        return true;
    }

    // --- Mode selection (new firmware only) ---

    async setMode(mode) {
        if (!this.isConnected) return false;
        if (this.isNewFirmware) {
            await this.sendCommand(new Uint8Array([CMD.SET_MODE, mode]));
        }
        return true;
    }

    // --- Firmware info (new firmware only) ---

    async getFirmwareInfo() {
        if (!this.isConnected || !this.isNewFirmware) return null;
        await this.sendCommand(new Uint8Array([CMD.GET_FIRMWARE_INFO]));
        const resp = await this.readCommandResponse(1000);
        if (resp && resp.length >= 4 && resp[0] === 0x0F) {
            return { major: resp[1], minor: resp[2], patch: resp[3] };
        }
        return null;
    }
}

// Export
window.UsbConnection = UsbConnection;
window.CMD = CMD;
window.MODE = MODE;
