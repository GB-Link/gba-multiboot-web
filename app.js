/**
 * GBA Multiboot Web App
 * Main application logic
 */

class App {
    constructor() {
        this.usb = null;  // chosen lazily on first connect (UsbConnection or SerialConnection)
        this.romData = null;
        this.romName = null;

        this.elements = {
            dropZone: document.getElementById('drop-zone'),
            fileInput: document.getElementById('file-input'),
            fileInfo: document.getElementById('file-info'),
            fileName: document.getElementById('file-name'),
            fileSize: document.getElementById('file-size'),
            btnClearFile: document.getElementById('btn-clear-file'),
            btnConnectUsb: document.getElementById('btn-connect-usb'),
            btnSendMultiboot: document.getElementById('btn-send-multiboot'),
            usbStatus: document.getElementById('usb-status'),
            btnDarkMode: document.getElementById('btn-dark-mode'),
            logContainer: document.getElementById('log-container'),
            browserWarning: document.getElementById('browser-warning')
        };

        this.init();
    }

    init() {
        const hasUsb = 'usb' in navigator;
        const hasSerial = 'serial' in navigator;

        // Prefer WebUSB; fall back to WebSerial only when WebUSB is unavailable.
        this.transport = hasUsb ? 'usb' : (hasSerial ? 'serial' : null);

        if (!this.transport) {
            this.elements.browserWarning.classList.add('show');
            this.elements.btnConnectUsb.disabled = true;
            this.log("Neither WebUSB nor WebSerial supported in this browser.", "error");
            return;
        }
        this.elements.btnConnectUsb.textContent =
            this.transport === 'serial' ? 'Connect Serial' : 'Connect USB';

        this.attachListeners();
        this.log("Ready. Select a .gba file to begin.");
    }

    attachListeners() {
        // Drop zone
        this.elements.dropZone.addEventListener('click', () => {
            this.elements.fileInput.click();
        });

        this.elements.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.elements.dropZone.classList.add('drag-over');
        });

        this.elements.dropZone.addEventListener('dragleave', () => {
            this.elements.dropZone.classList.remove('drag-over');
        });

        this.elements.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.elements.dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) this.loadFile(file);
        });

        this.elements.fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) this.loadFile(file);
        });

        this.elements.btnClearFile.addEventListener('click', () => {
            this.clearFile();
        });

        // Connect (auto-selected transport: WebUSB preferred, WebSerial fallback)
        this.elements.btnConnectUsb.addEventListener('click', () => {
            this.connect(this.transport);
        });

        // Multiboot
        this.elements.btnSendMultiboot.addEventListener('click', () => {
            this.sendMultiboot();
        });

        // Dark mode
        this.elements.btnDarkMode.addEventListener('click', () => {
            this.toggleDarkMode();
        });
    }

    async loadFile(file) {
        if (!file.name.match(/\.(gba|bin|mb)$/i)) {
            this.log("Please select a .gba, .bin or .mb file", "error");
            return;
        }

        try {
            this.romData = await file.arrayBuffer();
            this.romName = file.name;

            this.elements.fileName.textContent = file.name;
            this.elements.fileSize.textContent = this.formatSize(file.size);
            this.elements.dropZone.style.display = 'none';
            this.elements.fileInfo.style.display = 'flex';

            this.log(`Loaded: ${file.name} (${this.formatSize(file.size)})`, "success");
            this.updateButtonState();
        } catch (error) {
            this.log(`Failed to load file: ${error.message}`, "error");
        }
    }

    clearFile() {
        this.romData = null;
        this.romName = null;
        this.elements.fileInput.value = '';
        this.elements.dropZone.style.display = 'block';
        this.elements.fileInfo.style.display = 'none';
        this.updateButtonState();
        this.log("File cleared");
    }

    async connect(kind) {
        try {
            // Tear down any existing connection so switching transports works cleanly
            if (this.usb && this.usb.isConnected) {
                try { await this.usb.disconnect(); } catch (_) {}
            }
            this.usb = kind === 'serial' ? new SerialConnection() : new UsbConnection();
            this.log(`Requesting ${kind === 'serial' ? 'serial port' : 'USB device'}...`);
            await this.usb.connect();

            this.elements.usbStatus.textContent = `Connected (${kind})`;
            this.elements.usbStatus.className = "status connected";
            this.log(`${kind === 'serial' ? 'Serial' : 'USB'} connected!`, "success");
            this.updateButtonState();
        } catch (error) {
            this.log(`${kind} connection failed: ${error.message}`, "error");
        }
    }

    async sendMultiboot() {
        if (!this.romData) {
            this.log("Please select a ROM file first", "error");
            return;
        }

        if (!this.usb || !this.usb.isConnected) {
            this.log("Please connect first (USB or Serial)", "error");
            return;
        }

        this.elements.btnSendMultiboot.disabled = true;
        this.log("═".repeat(40));
        this.log(`Starting multiboot: ${this.romName}`);
        this.log("═".repeat(40));

        try {
            const success = await window.GBAMultiboot.multiboot(
                this.usb,
                this.romData,
                (msg, type) => this.log(msg, type)
            );

            if (!success) {
                this.log("Multiboot failed", "error");
            }
        } catch (error) {
            this.log(`Multiboot error: ${error.message}`, "error");
        }

        this.elements.btnSendMultiboot.disabled = false;
    }

    updateButtonState() {
        const canSend = this.romData && this.usb && this.usb.isConnected;
        this.elements.btnSendMultiboot.disabled = !canSend;
    }

    toggleDarkMode() {
        const isLight = document.body.classList.toggle('light-mode');
        this.elements.btnDarkMode.textContent = isLight ? '☀️' : '🌙';
    }

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    log(message, type = '') {
        const entry = document.createElement('div');
        entry.className = 'log-entry' + (type ? ' ' + type : '');

        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${message}`;

        this.elements.logContainer.appendChild(entry);
        this.elements.logContainer.scrollTop = this.elements.logContainer.scrollHeight;
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
