import { SerialPort } from 'serialport';

const DEFAULT_PATH = '/dev/ttyUSB0';
const DEFAULT_BAUD = 115200;

let portPath = process.argv[2] || DEFAULT_PATH;
let baudRate = parseInt(process.argv[3], 10) || DEFAULT_BAUD;

if (!portPath) {
  console.error('Usage: node serial-log.js <port> [baud]');
  process.exit(1);
}

const port = new SerialPort({ path: portPath, baudRate: baudRate });

port.on('open', () => {
  console.log(`Serial log started on ${portPath} at ${baudRate} baud.`);
});

port.on('data', (data) => process.stdout.write(data.toString()));

port.on('error', (err) => {
  console.error('Serial error:', err.message);
  process.exit(1);
});

port.on('close', () => {
  console.log('\nSerial port closed.');
  process.exit(0);
}); 