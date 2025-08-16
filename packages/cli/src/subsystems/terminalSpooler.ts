import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as os from 'node:os';

/**
 * TerminalSpooler spawns a detached terminal window and pipes lines to it.
 * Extensible for future features: log-to-file, tee, auto-reconnect, etc.
 *
 * macOS  : uses `osascript` to run "tell application 'Terminal'…"
 * Linux  : falls back to `x-terminal-emulator -e bash -c 'cat -'`
 * Windows: TODO – for now open PowerShell; marked FIXME.
 */
export class TerminalSpooler extends EventEmitter {
  private child?: ReturnType<typeof spawn>;
  private logFile?: string;
  private logStream?: import('node:fs').WriteStream;

  async open(title = 'Serial Console'): Promise<void> {
    if (this.child) return;

    // Lazily create a temporary file that the spawned terminal will tail.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const osTmpDir = os.tmpdir();
    const tmpDir = path.join(osTmpDir, 'gemini-cli');
    try {
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
    } catch (err) {
      // ignored – best-effort
    }

    const tmpFile = path.join(tmpDir, `serial-${Date.now()}.log`);
    this.logFile = tmpFile;
    this.logStream = fs.createWriteStream(tmpFile, { flags: 'a' });

    const tailCmd = process.platform === 'win32'
      ? `Get-Content -Wait -Path \"${tmpFile}\"`
      : `tail -f '${tmpFile.replace(/'/g, "'\\''")}'`;

    if (process.platform === 'darwin') {
      // Use AppleScript to open a new Terminal window and tail the file.
      const script = `tell application "Terminal" to do script "echo '${title}'; ${tailCmd}"`;
      this.child = spawn('osascript', [
        '-e', script,
        '-e', 'tell application "Terminal" to activate',
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    } else if (process.platform === 'linux') {
      // Try to open the user's default terminal.
      this.child = spawn('x-terminal-emulator', [
        '-T', title,
        '-e', 'bash', '-c', `echo "${title}"; ${tailCmd}`
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    } else if (process.platform === 'win32') {
      this.child = spawn('powershell', [
        '-NoExit', '-Command', `Write-Host '${title}'; ${tailCmd}`
      ], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    } else {
      // Fallback: no GUI terminal – just emit 'error'.
      this.emit('error', new Error('Unsupported platform for TerminalSpooler'));
      return;
    }

    this.child.on('exit', () => this.emit('exit'));
    this.emit('open');
  }

  write(chunk: string): void {
    // Write raw chunk as-is to preserve device line endings.
    this.logStream?.write(chunk);
  }

  close(): void {
    this.logStream?.end();
    this.logStream = undefined;

    // Attempt to gracefully close the spawned terminal.
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* ignore */ }
    }
    this.child = undefined;
  }
} 