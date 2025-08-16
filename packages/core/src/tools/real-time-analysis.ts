/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { SerialPort } from 'serialport';
import { EventEmitter } from 'events';
import { BaseTool, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';

export interface RealTimeAnalysisParams {
  serial_port?: string;
  baud_rate?: number;
  username?: string;
  password?: string;
  json?: boolean;
  debug?: boolean;
  use_current_serial?: boolean;
}

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

/**
 * Tool that collects an extensive set of real-time Linux diagnostics either over
 * an already-connected serial console or locally and returns the raw text
 * output. A friendlier narrative interpretation can be implemented later once
 * the raw payload structure is stable.
 */
export class RealTimeAnalysisTool extends BaseTool<RealTimeAnalysisParams, ToolResult> {
  // Holds additional debug context extracted during collection
  private latestFullBuffer?: string;
  private latestIsolatedPayload?: string;
  static readonly Name = 'real_time_analysis';

  constructor() {
    super(
      RealTimeAnalysisTool.Name,
      'RealTimeAnalysis',
      'Runs an extensive real-time Linux diagnostics script (IRQ/latency, RT scheduling, power, etc.) on the target device and returns the raw output for later parsing.',
      {
        type: 'object',
        properties: {
          serial_port: { type: 'string', description: 'Absolute path to serial device to use if connecting fresh.' },
          baud_rate: { type: 'number', description: 'Baud rate when opening a fresh serial connection. Defaults to 115200.' },
          username: { type: 'string', description: 'Login username when opening a fresh serial connection (default "root")' },
          password: { type: 'string', description: 'Login password, if required.' },
          json: { type: 'boolean', description: 'Return JSON payload (with a single `raw` field) instead of markdown.' },
          debug: { type: 'boolean', description: 'Include debug payload information in the markdown.' },
          use_current_serial: { type: 'boolean', description: 'Reuse currently-connected serial session.' },
        },
      },
    );
  }

  validateToolParams(params: RealTimeAnalysisParams): string | null {
    if (this.schema.parameters && !SchemaValidator.validate(this.schema.parameters as Record<string, unknown>, params)) {
      return 'Parameters failed schema validation.';
    }
    if (params.serial_port && !path.isAbsolute(params.serial_port)) return 'serial_port must be absolute path';
    return null;
  }

  getDescription(params: RealTimeAnalysisParams): string {
    const via = params.serial_port || (globalThis as any).GEMINI_ACTIVE_SERIAL ? 'serial' : 'local';
    return `Collecting real-time diagnostics via ${via}`;
  }

  async execute(params: RealTimeAnalysisParams): Promise<ToolResult> {
    const invalid = this.validateToolParams(params);
    if (invalid) return { llmContent: invalid, returnDisplay: invalid };

    // Implicitly reuse active serial port env if requested
    if (!params.serial_port && params.use_current_serial && process.env.GEMINI_SERIAL_PORT) {
      params.serial_port = process.env.GEMINI_SERIAL_PORT;
    }

    try {
      let raw = '';
      let source = '';
      const active = (globalThis as any).GEMINI_ACTIVE_SERIAL;
      const logs = (globalThis as any).GEMINI_SERIAL_LOGS;
      if (active && logs) {
        source = 'collectViaActiveSerialLogBuffer';
        console.log('running command in : collectViaActiveSerialLogBuffer');
        raw = await this.collectViaActiveSerialLogBuffer(active as EventEmitter & { send?: (d: string) => void }, logs, params);
      } else if (active) {
        source = 'collectViaActiveSerialStream';
        console.log('running command in : collectViaActiveSerialStream');
        raw = await this.collectViaActiveSerialStream(active as EventEmitter & { send?: (d: string) => void; on: (e:string,cb:(d:string|Buffer)=>void)=>void; off?: any }, params);
      } else if (params.serial_port) {
        source = 'collectViaSerial';
        console.log('running command in : collectViaSerial');
        raw = await this.collectViaSerial(params);
      } else {
        source = 'collectLocally';
        console.log('running command in : collectLocally');
        raw = await this.collectLocally();
      }

      const content = params.json
        ? JSON.stringify({ raw, source }, null, 2)
        : this.formatMarkdown(raw, !!params.debug, source);

      return { llmContent: content, returnDisplay: content };
    } catch (e) {
      const msg = `Failed to gather real-time diagnostics: ${getErrorMessage(e)}`;
      return { llmContent: msg, returnDisplay: msg };
    }
  }

  /* ---------------------------------- Script ---------------------------------- */
  private buildScript(): string {
    // This intentionally mirrors the command list provided by the user prompt.
    const lines: string[] = [
      '# Enhanced Real-Time Linux Analysis Script',
      'echo "===== RT_ANALYSIS_BEGIN ====="',
      '',
      '# 1. Kernel Configuration Analysis',
      'uname -r',
      'grep -E "(PREEMPT|RT)" /boot/config-$(uname -r) 2>/dev/null || echo "Config not available"',
      '[ -f /proc/config.gz ] && zcat /proc/config.gz | grep -E "(PREEMPT|RT)"',
      'uname -v | grep -i preempt',
      'cat /sys/kernel/realtime 2>/dev/null || echo "Not RT kernel"',
      '',
      '# 2. Interrupt & Latency Analysis',
      'cat /proc/interrupts',
      'cat /proc/softirqs',
      'for irq in $(ls /proc/irq/); do',
      '  if [[ "$irq" =~ ^[0-9]+$ ]]; then',
      '    echo "IRQ $irq: $(cat /proc/irq/$irq/smp_affinity 2>/dev/null)"',
      '  fi',
      'done',
      'ps aux | grep -E "\\[irq/[0-9]"',
      'cat /proc/timer_list | head -20',
      'cat /sys/devices/system/clocksource/clocksource0/current_clocksource',
      'cat /sys/devices/system/clocksource/clocksource0/available_clocksource',
      '',
      '# 3. RT Task and Scheduling Analysis',
      'ps -eTo pid,tid,cls,rtprio,pri,psr,comm | grep -E "(FF|RR)" | head -20',
      'for pid in $(ps -eo pid,cls | awk "$2~/FF|RR/{print $1}"); do',
      '  echo "PID $pid affinity: $(taskset -p $pid 2>/dev/null | cut -d: -f2)"',
      'done',
      'cat /proc/sched_debug 2>/dev/null | head -50 || echo "sched_debug not available"',
      'echo "RT Period: $(cat /proc/sys/kernel/sched_rt_period_us)microseconds"',
      'echo "RT Runtime: $(cat /proc/sys/kernel/sched_rt_runtime_us)microseconds"',
      'echo "RT Throttling: $(($(cat /proc/sys/kernel/sched_rt_runtime_us) < $(cat /proc/sys/kernel/sched_rt_period_us)))"',
      '',
      '# 4. Priority Inversion Detection',
      'cat /proc/locks | head -20',
      'ls /sys/kernel/debug/rt_mutex/ 2>/dev/null && cat /sys/kernel/debug/rt_mutex/*',
      'grep -r "pi_mutex\\|rt_mutex" /proc/*/status 2>/dev/null | head -10',
      'dmesg | grep -i "priority\\|inversion" | tail -10',
      '',
      '# 5. CPU and Power Management Analysis',
      'cat /sys/devices/system/cpu/isolated 2>/dev/null || echo "No CPU isolation"',
      'cat /sys/devices/system/cpu/nohz_full 2>/dev/null || echo "No nohz_full"',
      'for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do',
      '  echo "$cpu: $(cat $cpu 2>/dev/null)"',
      'done',
      'for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/name; do',
      '  if [ -f "$cpu" ]; then',
      '    echo "$cpu: $(cat $cpu)"',
      '  fi',
      'done',
      'cat /sys/devices/system/cpu/online',
      'cat /sys/devices/system/cpu/offline 2>/dev/null',
      '',
      '# 6. Memory and Cache Analysis',
      'cat /proc/buddyinfo',
      'numactl --hardware 2>/dev/null || echo "NUMA tools not available"',
      'cat /proc/pagetypeinfo | head -10',
      'cat /sys/kernel/mm/transparent_hugepage/enabled',
      'grep -E "(VmLck|VmPin)" /proc/*/status 2>/dev/null | grep -v ": 0 kB" | head -10',
      '',
      '# 7. Workqueue and Kernel Thread Analysis',
      'ps aux | grep -E "\\[.*\\]" | grep -E "(migration|rcu|ksoftirqd|watchdog)" | head -10',
      'if [ -d /sys/kernel/debug/workqueue ]; then',
      '  echo "Workqueue status available"',
      '  ls /sys/kernel/debug/workqueue/ | head -10',
      'else',
      '  echo "Workqueue debug not available (mount debugfs: mount -t debugfs none /sys/kernel/debug)"',
      'fi',
      'cat /sys/kernel/debug/rcu/rcu_preempt/rcudata 2>/dev/null | head -5 || echo "RCU debug not available"',
      '',
      '# 8. Hardware-Specific RT Features',
      'cat /proc/cpuinfo | grep -E "(flags|Features)" | head -2',
      'cat /proc/cpuinfo | grep -E "(hypervisor|vmx|svm)"',
      'systemd-detect-virt 2>/dev/null || echo "systemd-detect-virt not available"',
      'ls /sys/kernel/debug/hwlat_detector/ 2>/dev/null && echo "HW latency detector available"',
      '',
      '# 9. Network Stack RT Configuration',
      'cat /proc/sys/net/core/busy_poll 2>/dev/null',
      'cat /proc/sys/net/core/busy_read 2>/dev/null',
      'grep eth /proc/interrupts 2>/dev/null | head -5',
      '',
      '# 10. Boot Parameters',
      'cat /proc/cmdline',
      'echo "RT-relevant boot params:"',
      'cat /proc/cmdline | tr " " "\n" | grep -E "(isolcpus|nohz|rcu_nocb|processor.max_cstate|intel_idle.max_cstate)"',
      '',
      '# 11. Optional Cyclictest Integration',
      'which cyclictest 2>/dev/null && echo "cyclictest available"',
      'which rt-tests 2>/dev/null && echo "rt-tests available"',
      'if command -v cyclictest >/dev/null 2>&1; then',
      '  echo "Running minimal cyclictest (10 seconds)..."',
      '  timeout 10 cyclictest -t1 -p80 -i1000 -n -q 2>/dev/null || echo "cyclictest failed"',
      'fi',
      '',
      'echo "===== RT_ANALYSIS_END ====="',
    ];
    return lines.join('\n');
  }

  /* --------------------------- Serial (log buffer) --------------------------- */
  private async collectViaActiveSerialLogBuffer(
    serial: EventEmitter & { send?: (d: string) => void },
    logs: any,
    params: RealTimeAnalysisParams,
  ): Promise<string> {
    console.log('### collectViaActiveSerialLogBuffer ###');
    if (typeof serial.send !== 'function' || !logs) {
      throw new Error('Serial logging not available');
    }
    const id = Math.random().toString(36).slice(2, 8);
    const START = `__RT_START_${id}__`;
    const END = `__RT_END_${id}__`;
    const heredoc = `bash <<'ENDRT${id}'\n` +
      `echo ${START}\n` +
      `${this.buildScript()}\n` +
      `echo ${END}\n` +
      `ENDRT${id}\n`;

    serial.send?.(heredoc);

    return new Promise((resolve, reject) => {
      const timeoutMs = 60000; // generous time due to heavy script
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(poll);
          return reject(new Error('Timeout waiting for RT analysis output'));
        }
        let full = '';
        if (Array.isArray(logs)) full = logs.join('\n');
        else if (typeof logs.buffer === 'string') full = logs.buffer;
        else if (typeof logs === 'string') full = logs;
        // We need the *second* START/END pair – the first is just the echoed script
        const startPieces = full.split(START);
        if (startPieces.length < 3) return; // second START not yet seen
        const afterSecondStart = startPieces[2];
        const secondEndIdx = afterSecondStart.indexOf(END);
        if (secondEndIdx === -1) return; // second END not yet present
        clearInterval(poll);
        const payload = afterSecondStart.slice(0, secondEndIdx);
        // Store for downstream formatting
        this.latestFullBuffer = full;
        this.latestIsolatedPayload = payload;
        console.error('\n🧾 FULL RAW BUFFER:\n', full);
        console.error('\n🧩 ISOLATED PAYLOAD:\n', payload);
        //if (params.debug) console.error('RT analysis RAW (log buffer):\n', payload);
        resolve(this.pickAnalysisSlice(payload));
      }, 150);
    });
  }

  /* ----------------------------- Serial stream ----------------------------- */
  private async collectViaActiveSerialStream(
    serial: EventEmitter & { send?: (d: string) => void; on: (e: string, cb: (d: string|Buffer) => void)=>void; off?: any },
    params: RealTimeAnalysisParams,
  ): Promise<string> {
    console.log('### collectViaActiveSerialStream ###');
    if (typeof serial.send !== 'function') throw new Error('Serial send() unavailable');
    const id = Math.random().toString(36).slice(2, 8);
    const START = `__RT_START_${id}__`;
    const END = `__RT_END_${id}__`;
    const heredoc = `bash <<'ENDRT${id}'\n` +
      `echo ${START}\n` +
      `${this.buildScript()}\n` +
      `echo ${END}\n` +
      `ENDRT${id}\n`;

    const payloadLines: string[] = [];
    let capturing = false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for RT analysis'));
      }, 60000);

      const handler = (chunk: string | Buffer) => {
        const text = chunk.toString();
        if (text.includes(START)) capturing = true;
        if (capturing) payloadLines.push(text);
        if (text.includes(END)) {
          clearTimeout(timeout);
          cleanup();
          const joined = payloadLines.join('');
          const inner = joined.split(START)[1]?.split(END)[0] || '';
          // Store for downstream formatting
          this.latestFullBuffer = joined;
          this.latestIsolatedPayload = inner;
          if (params.debug) console.error('RT analysis RAW (stream):\n', inner);
          resolve(this.pickAnalysisSlice(inner));
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

  /* ----------------------------- Fresh serial ------------------------------ */
  private async collectViaSerial(params: RealTimeAnalysisParams): Promise<string> {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: params.serial_port!, baudRate: params.baud_rate || 115200, autoOpen: false });
      let buf = '';
      console.log('### collectViaSerial ###');
      const writeLn = (s: string) => port.write(s + '\n');
      const id = Math.random().toString(36).slice(2, 8);
      const START = `__RT_START_${id}__`;
      const END = `__RT_END_${id}__`;
      let scriptSent = false;
      port.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('login:')) { writeLn(params.username || 'root'); buf = ''; return; }
        if (buf.toLowerCase().includes('password:')) { writeLn(params.password || ''); buf = ''; return; }
        const lines = buf.split('\n');
        if (!scriptSent && /[#$] $/.test(lines[lines.length - 1]?.trim() || '')) {
          const heredoc = `bash <<'ENDRT${id}'\n` +
            `echo ${START}\n` +
            `${this.buildScript()}\n` +
            `echo ${END}\n` +
            `ENDRT${id}\n`;
          writeLn(heredoc);
          scriptSent = true;
          return;
        }
        if (buf.includes(END)) {
          const payload = buf.split(START)[1]?.split(END)[0] || '';
          this.latestFullBuffer = buf;
          this.latestIsolatedPayload = payload;
          port.close(() => {});
          resolve(this.pickAnalysisSlice(payload));
        }
      });
      port.on('error', reject);
      port.open((err) => {
        if (err) return reject(err);
        writeLn(''); // wake prompt
      });
      setTimeout(() => reject(new Error('Serial timeout')), 60000);
    });
  }

  /* --------------------------------- Local --------------------------------- */
  private async collectLocally(): Promise<string> {
    console.log('### collectLocally ###');
    // We simply execute the script via bash and return the captured stdout.
    const script = this.buildScript();
    const cmd = `bash -c "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`;
    const raw = safeExec(cmd);
    this.latestFullBuffer = raw;
    this.latestIsolatedPayload = raw;
    return this.pickAnalysisSlice(raw);
  }

  /* ------------------------- Analysis block picker ------------------------- */
  /**
   * Extracts the diagnostics between the *second* RT_ANALYSIS_BEGIN/END pair
   * when present. Some consoles echo the script lines first (which contain a
   * quoted copy of the marker). The second pair is the real device output.
   */
  private pickAnalysisSlice(raw: string): string {
    console.log('### pickAnalysisSlice ###');
    const beginTag = '===== RT_ANALYSIS_BEGIN';
    const endTag = '===== RT_ANALYSIS_END';

    const firstBegin = raw.indexOf(beginTag);
    if (firstBegin === -1) return raw.trim();
    const firstEnd = raw.indexOf(endTag, firstBegin + beginTag.length);
    if (firstEnd === -1) return raw.trim();

    const secondBegin = raw.indexOf(beginTag, firstEnd + endTag.length);
    const secondEnd = secondBegin !== -1 ? raw.indexOf(endTag, secondBegin + beginTag.length) : -1;

    if (secondBegin !== -1 && secondEnd !== -1) {
      return raw.substring(secondBegin, secondEnd + endTag.length).trim();
    }
    // Fallback to first block if second not found
    return raw.substring(firstBegin, firstEnd + endTag.length).trim();
  }

  /* --------------------------- Output formatting --------------------------- */
  private formatMarkdown(raw: string, _debug: boolean, source?: string): string {
    const lines: string[] = ['### Real-Time Analysis Results'];
    if (source) {
      lines.push(`Collected via **${source}**`);
    }
    lines.push(`Captured ${raw.split('\n').length} lines of diagnostics.`);
    // Include full raw output
    const nonEmptyLines = raw.split('\n').filter(l => l.trim());
    lines.push('\n---');
    lines.push('#### Full Diagnostics');
    lines.push('```');
    lines.push(nonEmptyLines.join('\n'));
    lines.push('```');

    //lines.push('\nRaw output has been saved to `real_time_analysis.log` for detailed inspection.');

    const output = lines.join('\n');

    // Append the narrative summary to the same log file for completeness
    try {
      const logPath = path.resolve(process.cwd(), 'real_time_analysis.log');
      fs.appendFileSync(logPath, `\n=== ${new Date().toISOString()} (narrative) ===\n${output}\n`);
    } catch (e) {
      console.error('Failed to write narrative to real_time_analysis.log', e);
    }

    return output;
  }
}
