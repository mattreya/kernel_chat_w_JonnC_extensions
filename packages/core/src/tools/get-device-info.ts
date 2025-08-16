/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import { BaseTool, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import { Config } from '../config/config.js';

/**
 * Parameters accepted by the GetDeviceInfoTool.
 */
export interface GetDeviceInfoParams {
  /** Serial device path, e.g. "/dev/ttyUSB0". If omitted, runs locally. */
  serial_port?: string;
  /** Baud rate, default 115200. */
  baud_rate?: number;
  /** Username for login, default "root". */
  username?: string;
  /** Password, optional. */
  password?: string;
  /** Perform deep device-tree inspection. */
  deep?: boolean;
  /** Return ultra-short summary. */
  summary?: boolean;
  /** Return JSON payload instead of markdown. */
  json?: boolean;
  /** Include raw payload debug block. */
  debug?: boolean;
  /** Reuse current serial session */
  use_current_serial?: boolean;
}

/**
 * Collects command output locally, falling back gracefully if the command
 * fails or is unavailable.
 */
function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function parseDiagnostic(out: string): Record<string, unknown> {
  // Skip obvious command echoes or prompt wrappers.
  const COMMAND_PREFIX_RE = /^(>|echo\s|cat\s|uname\s|grep\s|uptime\s|free\s|df\s|lsusb|ip\s)/i;

  const rawLines = out.split(/\r?\n/).map((l) => l.trim());
  const lines: string[] = rawLines.filter((l) => l && !l.startsWith('awk:') && !COMMAND_PREFIX_RE.test(l));

  // Quick helper to pop the first line safely.
  const next = (): string => (lines.length ? lines.shift() || '' : '');

  const identity: Record<string, string> = {};
  // First line may contain both model and arch concatenated if the device-tree model
  // string lacks a trailing newline (common on some boards). Detect and split.
  const first = next();
  const ARCH_RE = /(armv\d+l?|aarch64|x86_64|i[3-6]86|riscv\d+|mips|arm64|powerpc|ppc64le)$/i;
  if (ARCH_RE.test(first)) {
    const match = first.match(ARCH_RE)!;
    identity.arch = match[0];
    identity.model = first.replace(ARCH_RE, '').trim();
    if (!identity.model) identity.model = '(unknown)';
  } else {
    identity.model = first;
    identity.arch = next();
  }
  identity.kernel = next();
  const distroLine = next();
  identity.distro = distroLine.replace(/PRETTY_NAME="?(.*)"?/, '$1');

  const uptime = next();

  // Look for markers we emitted.
  const seekMarker = (marker: string): string[] => {
    const idx = lines.findIndex((l) => l.includes(marker));
    if (idx === -1) return [];
    // discard marker line
    lines.splice(0, idx + 1);
    return [];
  };

  // Discard section markers where present.
  seekMarker('---MEM---');
  const memLines: string[] = [];
  while (lines.length && !lines[0].includes('---STORAGE---')) memLines.push(next());

  seekMarker('---STORAGE---');
  const storageLines: string[] = [];
  while (lines.length && !lines[0].includes('---USB---')) storageLines.push(next());

  seekMarker('---USB---');
  const usbLines: string[] = [];
  while (lines.length && !lines[0].includes('---NET---')) usbLines.push(next());

  seekMarker('---NET---');
  const ifaceLines: string[] = [...lines];

  // Debug output is now shown in CLI markdown section when GEMINI_DEVINFO_DEBUG=1

  return {
    identity,
    uptime,
    cpuMem: { memSummary: memLines.join('\n') },
    storage: { root: storageLines.join('\n') },
    peripherals: { usb: usbLines.join('\n') },
    network: { ifaces: ifaceLines.join('\n') },
  };
}

/**
 * A Gemini CLI tool that gathers system diagnostics from an embedded Linux
 * target (via serial or locally) and returns a friendly, emoji-rich summary.
 */
export class GetDeviceInfoTool extends BaseTool<GetDeviceInfoParams, ToolResult> {
  static readonly Name = 'get_device_info';

  constructor(private readonly config: Config) {
    super(
      GetDeviceInfoTool.Name,
      'DeviceInfo',
      'Gathers detailed system diagnostics from an embedded Linux device (over serial or locally) and summarises them in developer-friendly natural language grouped by categories with emojis.',
      {
        type: 'object',
        properties: {
          serial_port: {
            type: 'string',
            description: 'Optional absolute path to the serial device, e.g. "/dev/ttyUSB0". If omitted, tool executes commands on the host running Gemini CLI.',
          },
          baud_rate: {
            type: 'number',
            description: 'Optional baud rate for the serial connection. Defaults to 115200.',
          },
          username: {
            type: 'string',
            description: 'Login username. Defaults to "root".',
          },
          password: {
            type: 'string',
            description: 'Login password. If omitted, assumes passwordless login.',
          },
          deep: { type: 'boolean', description: 'Perform deep device-tree inspection.' },
          summary: { type: 'boolean', description: 'Return condensed summary.' },
          json: { type: 'boolean', description: 'Return structured JSON.' },
          debug: { type: 'boolean', description: 'Include raw payload debug block.' },
          use_current_serial: { type: 'boolean', description: 'Reuse currently connected serial session; if true and serial_port omitted, tool uses GEMINI_SERIAL_PORT env var.' },
        },
      },
    );
  }

  validateToolParams(params: GetDeviceInfoParams): string | null {
    if (
      this.schema.parameters &&
      !SchemaValidator.validate(this.schema.parameters as Record<string, unknown>, params)
    ) {
      return 'Parameters failed schema validation.';
    }
    if (params.serial_port && !path.isAbsolute(params.serial_port)) {
      return `Serial port must be an absolute path but got: ${params.serial_port}`;
    }
    return null;
  }

  getDescription(params: GetDeviceInfoParams): string {
    return params.serial_port
      ? `Collecting diagnostics via serial (${params.serial_port})`
      : 'Collecting diagnostics from local device';
  }

  async execute(
    params: GetDeviceInfoParams,
    _signal: AbortSignal,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    // Validate
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    // Resolve serial port if not explicitly provided
    if (!params.serial_port && (params.use_current_serial || !params.serial_port)) {
      if (process.env.GEMINI_SERIAL_PORT) {
        params.serial_port = process.env.GEMINI_SERIAL_PORT;
      }
    }

    try {
      let info: Record<string, unknown>;
      const activeSerial = (globalThis as any).GEMINI_ACTIVE_SERIAL;
      if (activeSerial) {
        try {
          info = await this.collectViaActiveSerialLogBuffer();
        } catch {
          // Fallback to direct listener method if log buffer unavailable
          info = await this.collectViaActiveSerial();
        }
      } else if (params.serial_port) {
        // Open a fresh connection (may fail if port busy)
        info = await this.collectViaSerial(params);
      } else {
        // Local execution
        info = await this.collectLocally(params);
      }

      // Output formatting
      if (params.debug) info._alwaysDebug = true;
      const output = params.json ? JSON.stringify(info, null, 2) : this.formatMarkdown(info, !!params.summary);

      return {
        llmContent: output,
        returnDisplay: output,
      };
    } catch (error) {
      const msg = `Failed to gather device info: ${getErrorMessage(error)}`;
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: msg,
      };
    }
  }

  /**
   * Collect diagnostics locally on the host.
   */
  private async collectLocally(params: GetDeviceInfoParams): Promise<Record<string, unknown>> {
    const identity = {
      model: existsSync('/proc/device-tree/model') ? safeExec('cat /proc/device-tree/model') : safeExec('hostnamectl --transient'),
      arch: safeExec('uname -m'),
      cpuinfo: safeExec('grep -m1 "model name" /proc/cpuinfo') || safeExec('lscpu | grep "Model name"'),
      kernel: safeExec('uname -r'),
      distro: existsSync('/etc/os-release') ? safeExec(". /etc/os-release && echo $PRETTY_NAME") : safeExec('uname -s'),
    };

    const uptime = safeExec('uptime -p') || safeExec('cat /proc/uptime | awk "{print $1}"');

    const cpuMem = {
      cpuSummary: safeExec('lscpu | egrep "^Architecture|^CPU\\(s\\)|Model name"'),
      memSummary: safeExec('free -h | head -n 2'),
    };

    const storage = {
      root: safeExec('df -h / | tail -n 1'),
      lsblk: safeExec('lsblk -f -o NAME,FSTYPE,SIZE,LABEL | head -n 20'),
    };

    const peripherals = {
      usb: safeExec('lsusb || true'),
      ttys: safeExec('ls /dev/tty* | head -n 20') || '',
      spi: safeExec('ls /dev/spidev* 2>/dev/null || true'),
      i2c: safeExec('ls /dev/i2c-* 2>/dev/null || true'),
    };

    const network = {
      ifaces: safeExec('ip -o -4 addr show | awk "{print $2, $4}"'),
      mac: safeExec('ip link | awk "/link\\/ether/ {print $2}" | head -n 1'),
      ping: safeExec('ping -c1 -w1 8.8.8.8 >/dev/null && echo "Online" || echo "Offline"'),
    };

    const result: Record<string, unknown> = {
      identity,
      uptime,
      cpuMem,
      storage,
      peripherals,
      network,
    };

    if (params.deep) {
      // Gather device tree nodes (top-level and their immediate children)
      const rawNodes = safeExec('find /sys/firmware/devicetree/base -maxdepth 2 -type d 2>/dev/null | sed "s#.*/##" | sort -u | tr -d "\\000"');
      const nodes = rawNodes.split('\n').map((n) => n.trim()).filter((n) => n.length > 0);

      // Very lightweight heuristic categorisation – good enough for an at-a-glance summary.
      const categories: Record<string, string[]> = {
        communication: [],
        processing: [],
        io: [],
        storage: [],
        system: [],
      };

      const push = (cat: keyof typeof categories, node: string) => {
        if (!categories[cat].includes(node)) categories[cat].push(node);
      };

      for (const node of nodes) {
        const lname = node.toLowerCase();
        if (/^(i2c|spi|uart|serial|can|usb|eth|ethernet)$/.test(lname)) {
          push('communication', node);
        } else if (/^(cpu|pru|pruss|gpu|cores|processor)/.test(lname)) {
          push('processing', node);
        } else if (/^(gpio|pwm|adc|tscadc|led|fan|sensor|touch|display|screen)/.test(lname)) {
          push('io', node);
        } else if (/^(mmc|sd|emmc|nand|flash|spi-flash|ocmcram|ram|memory)/.test(lname)) {
          push('storage', node);
        } else {
          push('system', node);
        }
      }

      result.deviceTree = {
        model: identity.model,
        rawNodes: nodes.slice(0, 200), // cap length for output
        categories,
      };
    }

    if (process.env.GEMINI_DEVINFO_DEBUG === '1') {
      result._raw = safeExec('uname -a'); // simple raw example for local
    }

    return result;
  }

  /**
   * Collect diagnostics over a serial console.
   * NOTE: This is a best-effort minimal implementation. It assumes the target
   * presents a login prompt and a root shell after credentials are sent. The
   * method times out gracefully if the serial session cannot be established.
   */
  private async collectViaSerial(params: GetDeviceInfoParams): Promise<Record<string, unknown>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return new Promise((resolve, reject) => {
      const results: string[] = [];
      let gathered = false;
      const port = new SerialPort({
        path: params.serial_port!,
        baudRate: params.baud_rate || 115200,
        autoOpen: false,
      });

      const timeout = setTimeout(() => {
        if (!gathered) {
          port.close(() => {});
          reject(new Error('Serial connection timed out'));
        }
      }, 15000); // 15s timeout

      const writeCmd = (cmd: string) => {
        port.write(cmd + '\n');
      };

      let buffer = '';
      // Helper to see if shell prompt present
      const isPrompt = (line: string) => /[#\$] $/.test(line.trim());

      port.on('data', (data: Buffer) => {
        buffer += data.toString();
        // Simple state machine: once prompt detected, send commands once.
        if (buffer.includes('login:')) {
          writeCmd(params.username || 'root');
          buffer = '';
        } else if (buffer.toLowerCase().includes('password:')) {
          writeCmd(params.password || '');
          buffer = '';
        } else if (isPrompt(buffer.split('\n').pop() || '')) {
          // send bundled script once
          const script = [
            'echo __START__',
            'echo "MODEL=$(cat /proc/device-tree/model 2>/dev/null || echo unknown)"',
            'echo "ARCH=$(uname -m)"',
            'echo "KERNEL=$(uname -r)"',
            'echo "DISTRO=$(grep -m1 PRETTY_NAME /etc/os-release | cut -d= -f2-)"',
            'echo "UPTIME=$(uptime -p || cat /proc/uptime)"',
            'echo "---MEM---"',
            'free -h',
            'echo "---STORAGE---"',
            'df -h /',
            'echo "---USB---"',
            'lsusb || true',
            'echo "---NET---"',
            'ip -o -4 addr show | awk \'{print $2\":\"$4}\' || true',
            'echo __END__',
          ].join(' && ');
          writeCmd(script);
        } else if (buffer.includes('__END__')) {
          gathered = true;
          clearTimeout(timeout);
          // extract between markers
          const dataSection = buffer.split('__START__')[1] || '';
          const cleaned = dataSection.split('__END__')[0] || '';
          port.close(() => {});
          // Naïve parse: return as single text block
          resolve(parseDiagnostic(cleaned));
        }
      });

      port.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      port.open((err) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }
        // wake up
        writeCmd('');
      });
    }).then((data) => {
      return data as Record<string, unknown>;
    });
  }

  private async collectViaActiveSerial(): Promise<Record<string, unknown>> {
    const serial = (globalThis as any).GEMINI_ACTIVE_SERIAL as EventEmitter & {
      send?: (d: string) => void;
      on: (event: string, cb: (data: string | Buffer) => void) => void;
    };
    if (!serial || typeof serial.send !== 'function') {
      throw new Error('No active serial session available.');
    }
    return new Promise((resolve, reject) => {
      let buffer = '';
      const dataHandler = (chunk: string | Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('__END__')) {
          serial.off?.('data', dataHandler as any);
          const section = buffer.split('__START__')[1] || '';
          const cleaned = section.split('__END__')[0] || '';
          const parsed = parseDiagnostic(cleaned);
          resolve({ ...parsed, _raw: cleaned });
        }
      };

      (serial as any).on('data', dataHandler);
      // send script
      const oneLiner = `
cat <<'__DIAG_SCRIPT__' > /tmp/diag.sh
echo __START__
cat /proc/device-tree/model 2>/dev/null || echo unknown
uname -m
uname -r
grep -m1 PRETTY_NAME /etc/os-release | cut -d= -f2-
uptime -p || cat /proc/uptime
echo "---MEM---"
free -h
echo "---STORAGE---"
df -h /
echo "---USB---"
lsusb || true
echo "---NET---"
ip -o -4 addr show | awk '{print $2":"$4}' || true
echo __END__
__DIAG_SCRIPT__
sh /tmp/diag.sh
rm /tmp/diag.sh
`.trim();
      try {
        serial.send?.(oneLiner);
      } catch (e) {
        serial.off?.('data', dataHandler as any);
        reject(e);
      }
      // timeout
      setTimeout(() => {
        serial.off?.('data', dataHandler as any);
        reject(new Error('Timed out waiting for device info'));
      }, 15000);
    }).then((data) => {
      return data as Record<string, unknown>;
    });
  }

  private async collectViaActiveSerialLogBuffer(): Promise<Record<string, unknown>> {
    const serial = (globalThis as any).GEMINI_ACTIVE_SERIAL as EventEmitter & {
      send?: (d: string) => void;
    };
    const logs: string[] | undefined = (globalThis as any).GEMINI_SERIAL_LOGS as string[] | undefined;
    if (!serial || typeof serial.send !== 'function' || !logs) {
      throw new Error('Active serial log buffer not available');
    }

    // Unique markers to correlate request and response even if multiple tool
    // calls run back-to-back and the ring buffer wraps.
    const runId = Math.random().toString(36).slice(2, 8);
    const START_MARK = `__START_${runId}__`;
    const END_MARK = `__END_${runId}__`;

    const oneLiner = `
cat <<'__DIAG_SCRIPT__' > /tmp/diag.sh
echo ${START_MARK}
cat /proc/device-tree/model 2>/dev/null || echo unknown
uname -m
uname -r
grep -m1 PRETTY_NAME /etc/os-release | cut -d= -f2-
uptime -p || cat /proc/uptime
echo "---MEM---"
free -h
echo "---STORAGE---"
df -h /
echo "---USB---"
lsusb || true
echo "---NET---"
ip -o -4 addr show | awk '{print $2":"$4}' || true
echo ${END_MARK}
__DIAG_SCRIPT__
sh /tmp/diag.sh
rm /tmp/diag.sh
`.trim();

    const startLen = logs.length;
    serial.send?.(oneLiner);

    return new Promise((resolve, reject) => {
      const timeoutMs = 20000;
      const pollMs = 150;
      const startTime = Date.now();

      const poller = setInterval(() => {
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(poller);
          return reject(new Error('Timed out waiting for device info'));
        }

        const slice = logs.slice(startLen);

        const idxStart = slice.findIndex((l) => l.trim() === START_MARK);
        if (idxStart === -1) return;

        const idxEnd = slice.findIndex((l, i) => i > idxStart && l.trim() === END_MARK);
        if (idxEnd === -1) return;

        const payloadLines = slice.slice(idxStart + 1, idxEnd);
        const payload = payloadLines.join('\n');

        clearInterval(poller);
        try {
          const parsed = parseDiagnostic(payload);
          resolve({ ...parsed, _raw: payload });
        } catch (err) {
          reject(err);
        }
      }, pollMs);
    });
  }

  /**
   * Converts the collected info object into a markdown summary with emojis.
   */
  private formatMarkdown(info: Record<string, unknown>, compact = false): string {
    // Helper to safely access nested
    const g = (pathStr: string): string => {
      const fields = pathStr.split('.');
      let obj: any = info;
      for (const f of fields) {
        obj = obj?.[f];
      }
      return obj || '';
    };

    if (compact) {
      return (
        `🖥️ ${g('identity.model')} • ${g('identity.arch')} • ${g('identity.kernel')} ` +
        `| RAM ${g('cpuMem.memSummary')?.split('\n')[1] || ''} | Uptime ${g('uptime')}`
      );
    }

    let md = '';
    md += '🔹 **System Identity**\n';
    md += `- 📦 Model: ${g('identity.model')}\n`;
    const cpuExtra = g('identity.cpuinfo');
    md += `- 🧠 Arch: ${g('identity.arch')}${cpuExtra ? ` (${cpuExtra})` : ''}\n`;
    md += `- 🖥️ Kernel: ${g('identity.kernel')}\n`;
    md += `- 🏷️ Distro: ${g('identity.distro')}\n`;

    md += '🔹 **Boot Environment**\n';
    md += `- ⏱️ Uptime: ${g('uptime')}\n\n`;

    md += '�� **CPU & Memory**\n';
    const cpuMemBlock = [g('cpuMem.cpuSummary'), g('cpuMem.memSummary')].filter(Boolean).join('\n').trim();
    if (cpuMemBlock) {
      md += '```\n' + cpuMemBlock + '\n```\n';
    }

    md += '\n🔹 **Filesystem & Storage**\n';
    const storageBlock = [g('storage.root'), g('storage.lsblk')].filter(Boolean).join('\n').trim();
    if (storageBlock) {
      md += '```\n' + storageBlock + '\n```\n';
    }

    md += '\n🔹 **Peripherals**\n';
    const periLines: string[] = [];
    if (g('peripherals.usb')) periLines.push('USB:\n' + g('peripherals.usb'));
    if (g('peripherals.spi')) periLines.push('SPI: ' + g('peripherals.spi'));
    if (g('peripherals.i2c')) periLines.push('I2C: ' + g('peripherals.i2c'));
    if (g('peripherals.ttys')) periLines.push('TTYs:\n' + g('peripherals.ttys'));
    if (periLines.length) {
      md += '```\n' + periLines.join('\n') + '\n```\n';
    }

    md += '\n🔹 **Network**\n';
    const netBlock = [g('network.ifaces'), g('network.mac') ? 'MAC: ' + g('network.mac') : '', g('network.ping') ? 'Status: ' + g('network.ping') : ''].filter(Boolean).join('\n').trim();
    if (netBlock) {
      md += '```\n' + netBlock + '\n```';
    }

    if (info._raw && info._alwaysDebug) {
      md += '\n\n🔹 **Debug Raw Payload**\n';
      md += '```\n' + (info._raw as string).trim() + '\n```';
    }

    return md.trim();
  }
}