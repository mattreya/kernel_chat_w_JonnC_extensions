/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import { BaseTool, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';

export interface GetDeviceTreeParams {
  serial_port?: string;
  baud_rate?: number;
  username?: string;
  password?: string;
  deep?: boolean;
  format?: 'markdown' | 'json' | 'table';
  summary?: boolean;
  output_dir?: string;
  use_current_serial?: boolean;
  debug?: boolean;
}

interface DTNodeInfo {
  node: string;
  compatible: string[];
  reg: string[];
}

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function parseRegFile(filePath: string): string[] {
  try {
    const buf = readFileSync(filePath);
    const words: string[] = [];
    for (let i = 0; i + 4 <= buf.length; i += 4) {
      words.push('0x' + buf.readUInt32BE(i).toString(16).padStart(8, '0'));
    }
    return words;
  } catch {
    return [];
  }
}

export class GetDeviceTreeTool extends BaseTool<GetDeviceTreeParams, ToolResult> {
  private lastRawPayload: string | null = null;

  static readonly Name = 'get_device_tree';

  constructor() {
    super(
      GetDeviceTreeTool.Name,
      'DeviceTree',
      'Extracts the live Device Tree and summarises nodes.',
      {
        type: 'object',
        properties: {
          serial_port: { type: 'string' },
          baud_rate: { type: 'number' },
          username: { type: 'string' },
          password: { type: 'string' },
          deep: { type: 'boolean' },
          format: { type: 'string', enum: ['markdown', 'json', 'table'] },
          summary: { type: 'boolean' },
          debug: { type: 'boolean' },
          output_dir: { type: 'string' },
          use_current_serial: { type: 'boolean' },
        },
      },
    );
  }

  validateToolParams(params: GetDeviceTreeParams): string | null {
    if (this.schema.parameters && !SchemaValidator.validate(this.schema.parameters as Record<string, unknown>, params)) {
      return 'Parameters failed schema validation.';
    }
    if (params.serial_port && !path.isAbsolute(params.serial_port)) return 'Serial port must be absolute path';
    if (params.output_dir && !path.isAbsolute(params.output_dir)) return 'output_dir must be absolute path';
    return null;
  }

  getDescription(params: GetDeviceTreeParams): string {
    if (params.serial_port) return 'Extracting Device-Tree via serial';
    if ((globalThis as any).GEMINI_ACTIVE_SERIAL) return 'Extracting Device-Tree via existing serial session';
    return 'Extracting Device-Tree locally';
  }

  async execute(params: GetDeviceTreeParams): Promise<ToolResult> {
    const invalid = this.validateToolParams(params);
    if (invalid) return { llmContent: invalid, returnDisplay: invalid };

    if (!params.serial_port && params.use_current_serial && process.env.GEMINI_SERIAL_PORT) {
      params.serial_port = process.env.GEMINI_SERIAL_PORT;
    }

    try {
      let nodes: DTNodeInfo[] = [];
      const active = (globalThis as any).GEMINI_ACTIVE_SERIAL;
      const logs = (globalThis as any).GEMINI_SERIAL_LOGS;
      if (active && logs) {
        nodes = await this.collectViaActiveSerialLogBuffer(params, active as EventEmitter & { send?: (d: string) => void }, logs);
      } else if (params.serial_port) {
        // No buffered logs; open a temporary serial connection instead
        nodes = await this.collectViaSerial(params);
      } else if (!active) {
        // Not connected at all – fall back to local execution
        nodes = await this.collectLocally(params);
      } else {
        throw new Error('Active serial session does not expose a log buffer; cannot capture output. Re-run with serial_port parameter or ensure GEMINI_SERIAL_LOGS is configured.');
      }

      const out = this.render(nodes, params);
      return { llmContent: out, returnDisplay: out };
    } catch (e) {
      const msg = `Failed to get device-tree: ${getErrorMessage(e)}`;
      return { llmContent: msg, returnDisplay: msg };
    }
  }

  /* Local */
  private findDtRoot(): string {
    if (existsSync('/sys/firmware/devicetree/base')) return '/sys/firmware/devicetree/base';
    if (existsSync('/proc/device-tree')) return '/proc/device-tree';
    return '';
  }

  private async collectLocally(params: GetDeviceTreeParams): Promise<DTNodeInfo[]> {
    const root = this.findDtRoot();
    if (!root) throw new Error('Device-tree not found on host.');
    return this.scanDt(root, params);
  }

  /* Serial fresh */
  private async collectViaSerial(params: GetDeviceTreeParams): Promise<DTNodeInfo[]> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: params.serial_port!, baudRate: params.baud_rate || 115200, autoOpen: false });
      let buf = '';
      const nodes: DTNodeInfo[] = [];
      const writeLn = (s: string) => port.write(s + '\n');

      const id = Math.random().toString(36).slice(2, 8);
      const START = `__DT_START_${id}__`;
      const END = `__DT_END_${id}__`;

      let scriptSent = false;
      port.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('login:')) { writeLn(params.username || 'root'); buf = ''; return; }
        if (buf.toLowerCase().includes('password:')) { writeLn(params.password || ''); buf = ''; return; }
        const lines = buf.split('\n');
        if (!scriptSent && /[#\$] $/.test(lines[lines.length - 1]?.trim() || '')) {
          const heredoc = `bash <<'ENDDT${id}'
echo ${START}
${this.buildScript(params.deep)}

echo ${END}
ENDDT${id}
`;
          writeLn(heredoc);
          scriptSent = true;
          return;
        }
        if (buf.includes(END)) {
          const payload = buf.split(START)[1]?.split(END)[0] || '';
          if (params.debug || process.env.GEMINI_DEVINFO_DEBUG==='1') console.error('DeviceTree raw (fresh serial):\n', payload);
          this.lastRawPayload = payload;
          this.parseLines(payload.split(/\r?\n/), nodes);
          port.close(() => {});
          resolve(nodes);
        }
      });
      port.on('error', reject);
      port.open((err) => {
        if (err) return reject(err);
        writeLn(''); // wake prompt
      });
      setTimeout(() => reject(new Error('Serial timeout')), 20000);
    });
  }

  /* Active serial - log buffer */
  private async collectViaActiveSerialLogBuffer(
    params: GetDeviceTreeParams,
    serial: EventEmitter & { send?: (d: string) => void },
    logs: any,
  ): Promise<DTNodeInfo[]> {
    if (typeof serial.send !== 'function' || !logs) throw new Error('Serial logging not available');
    const id = Math.random().toString(36).slice(2, 8);
    const START = `__DT_START_${id}__`;
    const END = `__DT_END_${id}__`;
    const heredoc = `bash <<'ENDDT${id}'\n` +
      `echo ${START}\n` +
      `${this.buildScript(params.deep)}\n` +
      `\n` +                             // blank line for newline
      `echo ${END}\n` +
      `ENDDT${id}\n`;
    serial.send?.(heredoc);

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const nodes: DTNodeInfo[] = [];
      const poll = setInterval(() => {
        if (Date.now() > deadline) { clearInterval(poll); reject(new Error('Timeout waiting for device tree')); }
        let full = '';
        if (Array.isArray(logs)) full = logs.join('\n');
        else if (typeof logs.buffer === 'string') full = logs.buffer;
        else if (typeof logs === 'string') full = logs;
        if (!full.includes(START) || !full.includes(END)) return;
        clearInterval(poll);
        // User request: take SECOND START/END pair
        let firstStart = full.indexOf(START);
        if (firstStart === -1) return; // should not happen
        const firstEnd = full.indexOf(END, firstStart + START.length);
        if (firstEnd === -1) return;
        const secondStart = full.indexOf(START, firstEnd + END.length);
        const secondEnd = secondStart !== -1 ? full.indexOf(END, secondStart + START.length) : -1;
        let payload = '';
        if (secondStart !== -1 && secondEnd !== -1) {
          payload = full.slice(secondStart + START.length, secondEnd);
        } else {
          // fallback: last valid slice with real data
          let scanPos = firstStart;
          while (scanPos !== -1) {
            const s = full.indexOf(START, scanPos);
            if (s === -1) break;
            const e = full.indexOf(END, s + START.length);
            if (e === -1) break;
            const slice = full.slice(s + START.length, e);
            if (/^N\|/m.test(slice)) payload = slice; // keep latest valid slice
            scanPos = e + END.length;
          }
        }
        if (params.debug || process.env.GEMINI_DEVINFO_DEBUG==='1') console.error('DeviceTree raw (log buffer):\n', payload);
        this.lastRawPayload = payload;
        this.parseLines(payload.split(/\r?\n/), nodes);
        resolve(nodes);
      }, 150);
    });
  }

  /* Active serial - direct stream listener (when no log buffer) */
  private async collectViaActiveSerialStream(
    params: GetDeviceTreeParams,
    serial: EventEmitter & { send?: (d: string) => void; on: (e: string, cb: (d: string|Buffer) => void)=>void; off?: any },
  ): Promise<DTNodeInfo[]> {
    if (typeof serial.send !== 'function') throw new Error('Serial send() unavailable');
    const id = Math.random().toString(36).slice(2, 8);
    const START = `__DT_START_${id}__`;
    const END = `__DT_END_${id}__`;

    const heredoc = [
      `echo ${START}`,
      this.buildScript(params.deep),
      `echo ${END}`,
      ''
    ].join('\n');

    const payloadLines: string[] = [];
    let capturing = false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for device-tree'));
      }, 30000);

      const handler = (chunk: string | Buffer) => {
        const text = chunk.toString();
        if (text.includes(START)) capturing = true;
        if (capturing) payloadLines.push(text);
        if (text.includes(END)) {
          clearTimeout(timeout);
          cleanup();
          const joined = payloadLines.join('');
          const inner = joined.split(START)[1]?.split(END)[0] || '';
          if (params.debug || process.env.GEMINI_DEVINFO_DEBUG==='1') console.error('DeviceTree raw (stream):\n', inner);
          this.lastRawPayload = inner;
          const nodes: DTNodeInfo[] = [];
          this.parseLines(inner.split(/\r?\n/), nodes);
          resolve(nodes);
        }
      };

      const cleanup = () => {
        if (serial.off) serial.off('data', handler as any);
        else (serial as any).removeListener?.('data', handler);
      };

      serial.on('data', handler);
      try {
        serial.send?.(heredoc);
      } catch (e) {
        cleanup();
        clearTimeout(timeout);
        reject(e);
      }
    });
  }

  /* Shared */
  private buildScript(deep?: boolean): string {
    const depth = deep ? '2' : '1';
    return [
      'DTROOT="$( [ -d /sys/firmware/devicetree/base ] && echo /sys/firmware/devicetree/base || echo /proc/device-tree )"',
      `find "$DTROOT" -maxdepth ${depth} -type d | while read n; do`,
      '  [ "$n" = "$DTROOT" ] && continue;',
      '  name="$(basename "$n")";',
      '  comp="$( [ -f \\"$n/compatible\\" ] && tr -d \\"\\\\0\\" < \\"$n/compatible\\" 2>/dev/null | head -c120 )";',
      '  reg="$(hexdump -v -e "1/4 %08x " "$n/reg" 2>/dev/null)";',
      '  echo "N|$name|$comp|$reg";',
      'done',
    ].join('\n');
  }

  private parseLines(lines: string[], out: DTNodeInfo[]) {
    for (const raw of lines) {
      const line = raw.trim();
      const idx = line.indexOf('N|');
      if (idx === -1) continue;
      const payload = line.slice(idx); // strip any leading prompt chars
      const p = payload.split('|');
      out.push({
        node: p[1] || '',
        compatible: (p[2] || '').split(/[\s,]+/).filter(Boolean),
        reg: (p[3] || '').split(/\s+/).filter(Boolean).map((h) => '0x' + h.toLowerCase()),
      });
    }
  }

  private scanDt(root: string, params: GetDeviceTreeParams): DTNodeInfo[] {
    const nodes: DTNodeInfo[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 0) {
        const name = path.basename(dir);
        const compPath = path.join(dir, 'compatible');
        const regPath = path.join(dir, 'reg');
        const comp = existsSync(compPath) ? readFileSync(compPath).toString('utf8').replace(/\0/g, ' ').trim().split(/\s+/) : [];
        const reg = existsSync(regPath) ? parseRegFile(regPath) : [];
        nodes.push({ node: name, compatible: comp, reg });
      }
      if (params.deep || depth === 0) {
        for (const child of readdirSync(dir, { withFileTypes: true })) {
          if (!child.isDirectory() || child.name.startsWith('.')) continue;
          walk(path.join(dir, child.name), depth + 1);
        }
      }
    };
    walk(root, 0);
    if (params.output_dir) this.dumpDtFiles(root, params.output_dir);
    return nodes;
  }

  private dumpDtFiles(root: string, outDir: string): void {
    try {
      mkdirSync(outDir, { recursive: true });
      const dtb = path.join(outDir, 'live.dtb');
      const dts = path.join(outDir, 'live.dts');
      if (existsSync('/sys/firmware/fdt')) {
        execSync(`cp /sys/firmware/fdt ${dtb}`);
      } else if (safeExec('which dtc')) {
        execSync(`dtc -O dtb -o ${dtb} ${root}`);
      }
      if (safeExec('which dtc')) {
        execSync(`dtc -I dtb -O dts -o ${dts} ${dtb}`);
      }
    } catch {/* ignore */}
  }

  private render(nodes: DTNodeInfo[], params: GetDeviceTreeParams): string {
    const fmt = params.format || 'markdown';
    if (fmt === 'json') return JSON.stringify(nodes, null, 2);
    if (fmt === 'table') {
      const header = '| Node | Compatible | Addresses |\n|---|---|---|';
      const rows = nodes.map(n => `| ${n.node} | ${n.compatible.join(', ')} | ${n.reg.join(', ')} |`).join('\n');
      return `${header}\n${rows}`;
    }
    if (params.summary) {
      const compact = nodes.map(n => `🔹 ${n.node}: ${(n.reg[0] || '?')}${n.reg.length > 1 ? '…' : ''}`).join(' | ');
      if (params.debug && this.lastRawPayload) {
        return compact + `\n\nRAW:\n${this.lastRawPayload}`;
      }
      return compact;
    }
    const lines: string[] = ['Device-Tree Nodes'];
    for (const n of nodes) {
      lines.push(`- **${n.node}**`);
      if (n.compatible.length) lines.push(`  • Compatible: ${n.compatible.join(', ')}`);
      if (n.reg.length) lines.push(`  • Addresses: ${n.reg.join(', ')}`);
    }
    // Debug: include raw payload
    if (this.lastRawPayload) {
      lines.push('');
      lines.push('🔹 **Debug Raw Payload**');
      lines.push('```');
      lines.push(this.lastRawPayload.trim());
      lines.push('```');
    }
    return lines.join('\n');
  }
}
