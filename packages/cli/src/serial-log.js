"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var serialport_1 = require("serialport");
var portPath = process.argv[2];
var baud = parseInt(process.argv[3] || '115200', 10);
if (!portPath) {
    console.error('Usage: node serial-log.js <port> [baud]');
    process.exit(1);
}
var port = new serialport_1.SerialPort({ path: portPath, baudRate: baud });
port.on('open', function () {
    console.log("Serial log started on ".concat(portPath, " at ").concat(baud, " baud."));
});
port.on('data', function (data) { return process.stdout.write(data.toString()); });
port.on('error', function (err) {
    console.error('Serial error:', err.message);
    process.exit(1);
});
port.on('close', function () {
    console.log('\nSerial port closed.');
    process.exit(0);
});
