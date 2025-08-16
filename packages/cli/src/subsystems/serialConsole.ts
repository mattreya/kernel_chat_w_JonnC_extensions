import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';

/**
 * SerialConsole provides a reusable, event-driven serial port interface.
 * Emits: 'open', 'data', 'error', 'close'.
 * Extensible for future features: X/Y-modem, logging, auto-reconnect, etc.
 */
export class SerialConsole extends EventEmitter {
  private port: SerialPort | null = null;
  private isOpen = false;

  connect(path: string, baudRate: number = 115200): void {
    if (this.isOpen) {
      this.emit('error', new Error('Serial port already open'));
      return;
    }
    this.port = new SerialPort({ path, baudRate }, (err) => {
      if (err) {
        this.emit('error', err);
      }
    });
    this.port.on('open', () => {
      this.isOpen = true;
      this.emit('open');
    });
    this.port.on('data', (data) => {
      this.emit('data', data.toString());
    });
    this.port.on('close', () => {
      this.isOpen = false;
      this.emit('close');
    });
    this.port.on('error', (err) => {
      this.emit('error', err);
    });
  }

  send(data: string): void {
    if (this.port && this.isOpen) {
      this.port.write(data + '\n');
    } else {
      this.emit('error', new Error('Serial port not open'));
    }
  }

  disconnect(): void {
    if (this.port && this.isOpen) {
      this.port.close();
    }
  }
}

// Usage example (to be integrated with CLI UI):
// const serial = new SerialConsole();
// serial.on('data', (data) => process.stdout.write(data));
// serial.connect('/dev/ttyUSB0', 115200);
// serial.send('help');
// serial.disconnect();
