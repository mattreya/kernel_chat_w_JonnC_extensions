import { parentPort, workerData } from 'node:worker_threads';
import { TerminalSpooler } from './terminalSpooler.js';

interface WorkerData {
  path: string;
  baudRate: number;
  windowTitle: string;
}

(async () => {
  const { windowTitle } = workerData as WorkerData;
  const spool = new TerminalSpooler();
  try {
    await spool.open(windowTitle);
    parentPort?.postMessage({ type: 'ready' });
  } catch (err) {
    // Forward error then exit
    parentPort?.postMessage({ type: 'error', message: (err as Error).message });
    process.exit(1);
  }

  process.on('uncaughtException', (err) => {
    parentPort?.postMessage({ type: 'error', message: `Worker uncaught exception: ${(err as Error).message}` });
    try {
      spool.close();
    } catch {}
    process.exit(1);
  });

  parentPort?.on('message', (msg: { type: string; data?: string }) => {
    if (msg.type === 'line') {
      spool.write(msg.data ?? '');
    } else if (msg.type === 'quit') {
      spool.close();
      process.exit(0);
    }
  });
})(); 