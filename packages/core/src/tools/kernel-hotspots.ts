/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseTool, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import { EventEmitter } from 'events';

/** Convenience wrapper that never throws. */
function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

/** Snapshot helpers for /proc files */
interface CpuTimes {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

function parseProcStat(lines: string[]): Map<string, CpuTimes> {
  const m = new Map<string, CpuTimes>();
  for (const line of lines) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const label = parts[0]; // cpu / cpu0 / cpu1 ..
    if (parts.length < 8) continue;
    const [user, nice, system, idle, iowait, irq, softirq, steal] = parts
      .slice(1, 9)
      .map((v) => parseInt(v, 10) || 0);
    m.set(label, { user, nice, system, idle, iowait, irq, softirq, steal });
  }
  return m;
}

function readProcStat(): Map<string, CpuTimes> {
  try {
    const text = readFileSync('/proc/stat', 'utf8');
    return parseProcStat(text.trim().split(/\n/));
  } catch {
    return new Map();
  }
}

interface IrqSnapshot { label: string; count: number; }
function readProcInterrupts(): Map<string, IrqSnapshot> {
  const map = new Map<string, IrqSnapshot>();
  try {
    const text = readFileSync('/proc/interrupts', 'utf8');
    const lines = text.trim().split(/\n/);
    for (const line of lines) {
      const m = line.match(/^(\S+):\s+([0-9\s]+)\s+(.*)$/);
      if (!m) continue;
      const irq = m[1];
      const counts = m[2]
        .trim()
        .split(/\s+/)
        .map((v) => parseInt(v, 10) || 0);
      const total = counts.reduce((a, b) => a + b, 0);
      const label = m[3].trim();
      map.set(irq, { label, count: total });
    }
  } catch {
    /* ignore */
  }
  return map;
}

interface SoftIrqSnapshot { count: number; }
function readProcSoftirqs(): Map<string, SoftIrqSnapshot> {
  const map = new Map<string, SoftIrqSnapshot>();
  try {
    const text = readFileSync('/proc/softirqs', 'utf8');
    const lines = text.trim().split(/\n/);
    for (const line of lines) {
      const m = line.match(/^(\S+):\s+([0-9\s]+)/);
      if (!m) continue;
      const name = m[1];
      const counts = m[2]
        .trim()
        .split(/\s+/)
        .map((v) => parseInt(v, 10) || 0);
      const total = counts.reduce((a, b) => a + b, 0);
      map.set(name, { count: total });
    }
  } catch {
    /* ignore */
  }
  return map;
}

function parseInterruptsText(text: string): Map<string, IrqSnapshot> {
  const map = new Map<string, IrqSnapshot>();
  const lines = text.trim().split(/\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\S+):\s+([0-9\s]+)\s+(.*)$/);
    if (!m) continue;
    const irq = m[1];
    const counts = m[2].trim().split(/\s+/).map((v) => parseInt(v, 10) || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const label = m[3].trim();
    map.set(irq, { label, count: total });
  }
  return map;
}

function parseSoftirqsText(text: string): Map<string, SoftIrqSnapshot> {
  const map = new Map<string, SoftIrqSnapshot>();
  const lines = text.trim().split(/\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\S+):\s+([0-9\s]+)/);
    if (!m) continue;
    const name = m[1];
    const counts = m[2].trim().split(/\s+/).map((v) => parseInt(v, 10) || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    map.set(name, { count: total });
  }
  return map;
}

function diffNumericMaps<T extends { count: number }>(a: Map<string, T>, b: Map<string, T>): Map<string, number> {
  const res = new Map<string, number>();
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const av = a.get(k)?.count ?? 0;
    const bv = b.get(k)?.count ?? 0;
    res.set(k, Math.max(0, bv - av));
  }
  return res;
}

interface PerfEntry { percent: number; symbol: string; module: string; }
function runPerfSample(duration: number, top: number): PerfEntry[] {
  // Requires perf and sufficient permissions.
  const perfPath = safeExec('which perf');
  if (!perfPath) return [];

  const dataFile = path.join(os.tmpdir(), `perf_${Date.now()}.data`);
  try {
    // Record sample silently
    safeExec(`perf record -q -o ${dataFile} -g -a -- sleep ${duration}`);
    const report = safeExec(
      `perf report -n --stdio -i ${dataFile} --header none --percent-limit 0.5 | head -n ${top + 5}`,
    );
    const lines = report.split(/\n/);
    const entries: PerfEntry[] = [];
    for (const l of lines) {
      const m = l.match(/\s*([0-9.]+)%\s+[^\s]+\s+[^\s]+\s+(.+)/);
      if (!m) continue;
      const percent = parseFloat(m[1]);
      let rest = m[2].trim();
      // Separate module token if like "[kernel.kallsyms]" or "[i915]"
      let module = 'kernel';
      const modMatch = rest.match(/\[([^]]+)\]/);
      if (modMatch) {
        module = modMatch[1];
        rest = rest.replace(/\[[^]]+\]\s*/, '');
      }
      entries.push({ percent, symbol: rest, module });
      if (entries.length >= top) break;
    }
    return entries;
  } finally {
    try { safeExec(`rm -f ${dataFile}`); } catch {}
  }
}

export interface KernelHotspotsParams {
  /** Sampling window in seconds (default 5) */
  duration?: number;
  /** Number of top functions to list (default 8) */
  top?: number;
  /** Return JSON instead of markdown */
  json?: boolean;
  /** Include debug/raw data */
  debug?: boolean;
}

export class KernelHotspotsTool extends BaseTool<KernelHotspotsParams, ToolResult> {
  static readonly Name = 'kernel_hotspots';

  constructor() {
    super(
      KernelHotspotsTool.Name,
      'KernelHotspots',
      'Samples kernel activity for a short window and summarises where CPU time was spent (top functions, IRQ/softirq load, per-CPU utilisation, latency hints).',
      {
        type: 'object',
        properties: {
          duration: { type: 'number', description: 'Sampling window in seconds. Defaults to 5.' },
          top: { type: 'number', description: 'Number of top functions to list. Defaults to 8.' },
          json: { type: 'boolean', description: 'Return JSON payload instead of markdown.' },
          debug: { type: 'boolean', description: 'Include raw payload/debug info (appends extracted serial slice to output).' },
        },
      },
    );
  }

  validateToolParams(params: KernelHotspotsParams): string | null {
    if (
      this.schema.parameters &&
      !SchemaValidator.validate(this.schema.parameters as Record<string, unknown>, params)
    ) {
      return 'Parameters failed schema validation.';
    }
    if (params.duration !== undefined && params.duration <= 0) return 'duration must be >0';
    if (params.top !== undefined && params.top <= 0) return 'top must be >0';
    return null;
  }

  getDescription(params: KernelHotspotsParams): string {
    return `Sampling kernel hotspots for ${(params.duration ?? 5)}s window (will wait full duration)`;
  }

  async execute(
    params: KernelHotspotsParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const invalid = this.validateToolParams(params);
    if (invalid) return { llmContent: invalid, returnDisplay: invalid };

    const duration = params.duration ?? 5;
    const top = params.top ?? 8;
    const execStart = Date.now();

    try {
      // Prefer serial sampling only if a valid active serial connection object is present.
      const activeSerial = (globalThis as any).GEMINI_ACTIVE_SERIAL;
      // sampleViaSerial accepts a SerialPort-style object (write()) or the custom wrapper used
      // by the CLI (send()). Ensure at least one of those methods is present before entering the
      // serial path; otherwise fall back to local sampling logic.
      if (activeSerial && (typeof activeSerial.write === 'function' || typeof activeSerial.send === 'function')) {
        return await this.sampleViaSerial(params, undefined as any);
      }

      // Initial snapshots
      const statA = readProcStat();
      const irqA = readProcInterrupts();
      const softA = readProcSoftirqs();

      // Wait
      await new Promise((r) => setTimeout(r, duration * 1000));

      // Final snapshots
      const statB = readProcStat();
      const irqB = readProcInterrupts();
      const softB = readProcSoftirqs();

      // Perf sampling (runs concurrently but after wait to avoid double)
      const perfEntries = runPerfSample(duration, top);

      // Compute CPU deltas and load
      const cpuLoad: Record<string, number> = {};
      let maxCpu = 'cpu0';
      let maxCpuLoad = 0;
      for (const [cpu, aTimes] of statA) {
        if (cpu === 'cpu') continue;
        const bTimes = statB.get(cpu);
        if (!bTimes) continue;
        const busyA = aTimes.user + aTimes.nice + aTimes.system + aTimes.irq + aTimes.softirq + aTimes.steal;
        const busyB = bTimes.user + bTimes.nice + bTimes.system + bTimes.irq + bTimes.softirq + bTimes.steal;
        const idleA = aTimes.idle + aTimes.iowait;
        const idleB = bTimes.idle + bTimes.iowait;

        const busyDelta = busyB - busyA;
        const totalDelta = busyDelta + (idleB - idleA);
        if (totalDelta <= 0) continue;
        const pct = (busyDelta / totalDelta) * 100;
        cpuLoad[cpu] = +pct.toFixed(1);
        if (pct > maxCpuLoad) { maxCpuLoad = pct; maxCpu = cpu; }
      }

      // Aggregate context split from aggregate cpu line
      const aggA = statA.get('cpu');
      const aggB = statB.get('cpu');
      let irqShare = 0, softShare = 0, systemShare = 0, userShare = 0;
      if (aggA && aggB) {
        const busyA = aggA.user + aggA.nice + aggA.system + aggA.irq + aggA.softirq + aggA.steal;
        const busyB = aggB.user + aggB.nice + aggB.system + aggB.irq + aggB.softirq + aggB.steal;
        const irqDelta = aggB.irq - aggA.irq;
        const softDelta = aggB.softirq - aggA.softirq;
        const userDelta = aggB.user + aggB.nice - (aggA.user + aggA.nice);
        const sysDelta = aggB.system - aggA.system;
        const busyDelta = busyB - busyA;
        if (busyDelta > 0) {
          irqShare = +(irqDelta / busyDelta * 100).toFixed(1);
          softShare = +(softDelta / busyDelta * 100).toFixed(1);
          userShare = +(userDelta / busyDelta * 100).toFixed(1);
          systemShare = +(sysDelta / busyDelta * 100).toFixed(1);
        }
      }

      // IRQ & SoftIRQ
      const irqDeltaMap = diffNumericMaps(irqA, irqB);
      let hottestIrq = { irq: '', delta: 0, label: '' };
      for (const [irq, delta] of irqDeltaMap) {
        if (delta > hottestIrq.delta) {
          hottestIrq = { irq, delta, label: irqB.get(irq)?.label || '' };
        }
      }

      const softDeltaMap = diffNumericMaps(softA, softB);
      let hottestSoft = { name: '', delta: 0 };
      for (const [name, delta] of softDeltaMap) {
        if (delta > hottestSoft.delta) {
          hottestSoft = { name, delta };
        }
      }

      // Summarise modules from perf
      const moduleAgg: Record<string, number> = {};
      for (const e of perfEntries) {
        moduleAgg[e.module] = (moduleAgg[e.module] || 0) + e.percent;
      }
      const moduleSummary = Object.entries(moduleAgg)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);

      const result: Record<string, unknown> = {
        window_s: duration,
        top_functions: perfEntries,
        context_split: {
          irq: irqShare,
          softirq: softShare,
          system: systemShare,
          user: userShare,
        },
        hottest_irq: hottestIrq,
        hottest_softirq: hottestSoft,
        modules: moduleSummary.map(([m, pct]) => ({ module: m, percent: +pct.toFixed(1) })),
        per_cpu_load: cpuLoad,
        max_cpu: { cpu: maxCpu, load: +maxCpuLoad.toFixed(1) },
      };
      if (params.debug) {
        result._raw = '';
        result._alwaysDebug = true;
      }
      const md = this.formatText(result);

      // Ensure we do not return before the requested sampling window elapses
      const elapsed = Date.now() - execStart;
      const target = duration * 1000;
      if (elapsed < target) {
        await new Promise((r) => setTimeout(r, target - elapsed));
      }
      return {
        llmContent: params.json ? JSON.stringify(result, null, 2) : md,
        returnDisplay: params.json ? JSON.stringify(result, null, 2) : md,
      };
    } catch (err) {
      const msg = `Failed to sample kernel hotspots: ${getErrorMessage(err)}`;
      return { llmContent: `Error: ${msg}`, returnDisplay: msg };
    }
  }

  private async sampleViaSerial(params: KernelHotspotsParams, _signal?: AbortSignal): Promise<ToolResult> {
    // Access global serial and logs
    const serial = (globalThis as any).GEMINI_ACTIVE_SERIAL as EventEmitter & {
      send?: (d: string) => void;
      write?: (d: string, cb?: (err?: Error) => void) => void;
    };
    // Logs may be stored either as an array of strings (preferred) or a string buffer.
    const logs: any = (globalThis as any).GEMINI_SERIAL_LOGS;
    if (!serial || !(typeof serial.send === 'function' || typeof serial.write === 'function') || !logs) {
      const msg = 'Serial logging not available.';
      return { llmContent: msg, returnDisplay: msg };
    }
    const duration = params.duration ?? 5;
    const execStart = Date.now();
    // Use a unique id for markers
    const id = Math.random().toString(36).slice(2, 10);
    const markerStart = `__KH_START_${id}__`;
    const markerEnd = `__KH_END_${id}__`;
    // Heredoc script
    const script = [
      `echo ${markerStart}`,
      `echo ---STAT_A---`,
      `cat /proc/stat`,
      `echo ---IRQS_A---`,
      `cat /proc/interrupts`,
      `echo ---SOFT_A---`,
      `cat /proc/softirqs`,
      `sleep ${duration}`,
      `echo ---STAT_B---`,
      `cat /proc/stat`,
      `echo ---IRQS_B---`,
      `cat /proc/interrupts`,
      `echo ---SOFT_B---`,
      `cat /proc/softirqs`,
      `echo ${markerEnd}`,
      ''
    ].join('\n');
    // Helper to actually transmit our heredoc script over serial.
    const sendPayload = `bash <<'ENDKH${id}'\n${script}ENDKH${id}\n`;
    if (typeof serial.send === 'function') {
      // Non-blocking custom wrapper
      serial.send(sendPayload);
    } else {
      // SerialPort.write style (expects callback)
      await new Promise<void>((resolve, reject) => {
        (serial.write as (d: string, cb?: (err?: Error) => void) => void)(sendPayload, (err?: Error) => {
          if (err) reject(err); else resolve();
        });
      });
    }

    // Helper: from a buffer, pick the most plausible slice between markers.
    function pickBestSlice(norm: string) {
      const starts: number[] = [];
      const ends: number[] = [];
      let idx = 0;
      while ((idx = norm.indexOf(markerStart, idx)) !== -1) { starts.push(idx); idx += markerStart.length; }
      idx = 0;
      while ((idx = norm.indexOf(markerEnd, idx)) !== -1) { ends.push(idx); idx += markerEnd.length; }

      type Cand = { startIdx: number; endIdx: number; content: string; score: number; pairNo: number };
      const cands: Cand[] = [];
      for (let ei = 0; ei < ends.length; ei++) {
        const endIdx = ends[ei];
        // nearest start before this end
        let startIdx = -1;
        for (const st of starts) if (st < endIdx) startIdx = st;
        if (startIdx === -1) continue;

        const contentStart = startIdx + markerStart.length;
        const content = norm.substring(contentStart, endIdx);

        // Score: expected tags and shapes
        let score = 0;
        if (/---STAT_A---/.test(content)) score += 2;
        if (/---IRQS_A---/.test(content)) score += 2;
        if (/---SOFT_A---/.test(content)) score += 2;
        if (/---STAT_B---/.test(content)) score += 2;
        if (/---IRQS_B---/.test(content)) score += 2;
        if (/---SOFT_B---/.test(content)) score += 2;
        if (/^cpu\s+\d+/m.test(content)) score += 3;      // /proc/stat
        if (/^\s*\d+:\s+\d/m.test(content)) score += 1; // /proc/interrupts-ish
        score += Math.min(3, Math.floor(content.length / 5000)); // small length bonus

        cands.push({ startIdx, endIdx, content, score, pairNo: ei + 1 });
      }

      // Highest score wins; ties broken by later end index.
      cands.sort((a, b) => a.score - b.score || a.endIdx - b.endIdx);
      const best = cands.length ? cands[cands.length - 1] : null;
      return { best, meta: { starts: starts.length, ends: ends.length, candidates: cands.length } };
    }

    // Await response by polling the log buffer/array for our markers.
    // Adapt timeout to requested sampling window: window + grace
    const timeoutMs = Math.max(duration * 1000 + 15000, 30000);
    const pollMs = 150;
    const startTime = Date.now();

    let sliceContent = '';
    while (Date.now() - startTime < timeoutMs) {
      // Get a single text snapshot of logs
      let bufText = '';
      if (Array.isArray(logs)) {
        // Join only the tail to avoid quadratic growth; but for simplicity join all
        bufText = (logs as string[]).join('\n');
      } else if (typeof logs.buffer === 'string') {
        bufText = logs.buffer as string;
      } else if (typeof logs === 'string') {
        bufText = logs as string;
      }

      if (bufText) {
        const norm = bufText.replace(/\r/g, '');
        const { best, meta } = pickBestSlice(norm);
        // Accept only if slice looks complete (tags + at least one data pattern).
        if (best && best.score >= 15) {
          sliceContent = best.content;
          (globalThis as any).KH_LAST_META = { pairNo: best.pairNo, score: best.score, ...meta };
          break;
        }
        // If we already saw two or more END markers, accept the last slice (fallback).
        if (meta.ends >= 2 && best) {
          sliceContent = best.content;
          (globalThis as any).KH_LAST_META = { pairNo: best.pairNo, score: best.score, ...meta, fallback: true };
          break;
        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }

    if (!sliceContent) {
      const msg = 'Timeout waiting for serial output.';
      return { llmContent: msg, returnDisplay: msg };
    }

    const metaInfo = (globalThis as any).KH_LAST_META || {};

    // Parse sections robustly (tolerate leading spaces/CRs)
    function grab(tag: string): string {
      const re = new RegExp(`(^|\n)\\s*---${tag}---\\s*\\n([\\s\\S]*?)(?=\\n\\s*---|$)`, '');
      const m = re.exec(sliceContent);
      return m ? m[2].trim() : '';
    }
    const secSTAT_A = grab('STAT_A');
    const secIRQS_A = grab('IRQS_A');
    const secSOFT_A = grab('SOFT_A');
    const secSTAT_B = grab('STAT_B');
    const secIRQS_B = grab('IRQS_B');
    const secSOFT_B = grab('SOFT_B');

    const statA = parseProcStat(secSTAT_A ? secSTAT_A.split(/\n/) : []);
    const statB = parseProcStat(secSTAT_B ? secSTAT_B.split(/\n/) : []);
    const irqA = parseInterruptsText(secIRQS_A || '');
    const irqB = parseInterruptsText(secIRQS_B || '');
    const softA = parseSoftirqsText(secSOFT_A || '');
    const softB = parseSoftirqsText(secSOFT_B || '');

    // Pre-compute delta maps so they are available for fallback logic below.
    const irqDeltaMap = diffNumericMaps(irqA, irqB);
    const softDeltaMap = diffNumericMaps(softA, softB);

    // Compute CPU deltas and load
    const cpuLoad: Record<string, number> = {};
    let maxCpu = 'cpu0';
    let maxCpuLoad = 0;
    for (const [cpu, aTimes] of statA) {
      if (cpu === 'cpu') continue;
      const bTimes = statB.get(cpu);
      if (!bTimes) continue;
      const busyA = aTimes.user + aTimes.nice + aTimes.system + aTimes.irq + aTimes.softirq + aTimes.steal;
      const busyB = bTimes.user + bTimes.nice + bTimes.system + bTimes.irq + bTimes.softirq + bTimes.steal;
      const idleA = aTimes.idle + aTimes.iowait;
      const idleB = bTimes.idle + bTimes.iowait;
      const busyDelta = busyB - busyA;
      const totalDelta = busyDelta + (idleB - idleA);
      if (totalDelta <= 0) continue;
      const pct = (busyDelta / totalDelta) * 100;
      cpuLoad[cpu] = +pct.toFixed(1);
      if (pct > maxCpuLoad) { maxCpuLoad = pct; maxCpu = cpu; }
    }
    // Aggregate context split from aggregate cpu line
    const aggA = statA.get('cpu');
    const aggB = statB.get('cpu');
    let irqShare = 0, softShare = 0, systemShare = 0, userShare = 0;
    if (aggA && aggB) {
      const busyA = aggA.user + aggA.nice + aggA.system + aggA.irq + aggA.softirq + aggA.steal;
      const busyB = aggB.user + aggB.nice + aggB.system + aggB.irq + aggB.softirq + aggB.steal;
      const irqDelta = aggB.irq - aggA.irq;
      const softDelta = aggB.softirq - aggA.softirq;
      const userDelta = aggB.user + aggB.nice - (aggA.user + aggA.nice);
      const sysDelta = aggB.system - aggA.system;
      const busyDelta = busyB - busyA;
      if (busyDelta > 0) {
        irqShare = +(irqDelta / busyDelta * 100).toFixed(1);
        softShare = +(softDelta / busyDelta * 100).toFixed(1);
        userShare = +(userDelta / busyDelta * 100).toFixed(1);
        systemShare = +(sysDelta / busyDelta * 100).toFixed(1);
      }
    }
    // Fallback: if busyDelta was zero or shares stayed 0/0/0/0, infer activity hints
    if (irqShare === 0 && softShare === 0 && systemShare === 0 && userShare === 0) {
      const totalIrqDelta = Array.from(irqDeltaMap.values()).reduce((a, b) => a + b, 0);
      const totalSoftDelta = Array.from(softDeltaMap.values()).reduce((a, b) => a + b, 0);
      if (totalIrqDelta || totalSoftDelta) {
        // Express as proportions of interrupt activity (not CPU time)
        const total = totalIrqDelta + totalSoftDelta || 1;
        irqShare = +(totalIrqDelta / total * 100).toFixed(1);
        softShare = +(totalSoftDelta / total * 100).toFixed(1);
        systemShare = 0;
        userShare = 0;
      }
    }
    // IRQ & SoftIRQ
    let hottestIrq = { irq: '', delta: 0, label: '' };
    for (const [irq, delta] of irqDeltaMap) {
      if (delta > hottestIrq.delta) {
        hottestIrq = { irq, delta, label: irqB.get(irq)?.label || '' };
      }
    }
    let hottestSoft = { name: '', delta: 0 };
    for (const [name, delta] of softDeltaMap) {
      if (delta > hottestSoft.delta) {
        hottestSoft = { name, delta };
      }
    }
    // No perf sampling in serial mode
    const perfEntries: any[] = [];
    const moduleSummary: any[] = [];
    const result: Record<string, unknown> = {
      window_s: duration,
      top_functions: perfEntries,
      context_split: {
        irq: irqShare,
        softirq: softShare,
        system: systemShare,
        user: userShare,
      },
      hottest_irq: hottestIrq,
      hottest_softirq: hottestSoft,
      modules: moduleSummary,
      per_cpu_load: cpuLoad,
      max_cpu: { cpu: maxCpu, load: +maxCpuLoad.toFixed(1) },
    };
    if (params.debug) {
      result._raw = sliceContent;
      result._alwaysDebug = true;
      result._meta = { ...metaInfo, top_irq_deltas: [...irqDeltaMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([irq, delta]) => ({ irq, delta, label: irqB.get(irq)?.label || '' })) };
    }
    if (params.debug) {
      console.error(
        'Top IRQ deltas',
        [...irqDeltaMap.entries()]
           .sort((a, b) => b[1] - a[1])
           .slice(0, 6)
      );
    }
    const md = this.formatText(result);
    // Ensure we do not return before the requested sampling window elapses
    const elapsed = Date.now() - execStart;
    const target = duration * 1000;
    if (elapsed < target) {
      await new Promise((r) => setTimeout(r, target - elapsed));
    }
    return {
      llmContent: params.json ? JSON.stringify(result, null, 2) : md,
      returnDisplay: params.json ? JSON.stringify(result, null, 2) : md,
    };
  }

  private formatText(info: Record<string, unknown>): string {
    // Extract typed views
    const ctx = (info.context_split || {}) as Record<string, number>;
    const topFns = (info.top_functions || []) as PerfEntry[];
    const hottest = (info.hottest_irq || { irq: '', label: '', delta: 0 }) as {
      irq: string; label: string; delta: number;
    };
    const hotSoft = (info.hottest_softirq || { name: '', delta: 0 }) as { name: string; delta: number };
    const mods = (info.modules || []) as { module: string; percent: number }[];
    const cpu = (info.max_cpu || { cpu: 'cpu0', load: 0 }) as { cpu: string; load: number };
    const perCpu = (info.per_cpu_load || {}) as Record<string, number>;

    const windowS = Number(info.window_s) || 0;

    // ---- Helpers ----
    const to1 = (n: number) => (Number.isFinite(n) ? n : 0);
    const pct1 = (n: number) => to1(n).toFixed(1);

    // Normalise context split to 100% when we have any signal
    const split = {
      user: to1(ctx.user),
      system: to1(ctx.system),
      irq: to1(ctx.irq),
      softirq: to1(ctx.softirq),
    };
    const sum = split.user + split.system + split.irq + split.softirq;
    let norm = { ...split } as typeof split;
    if (sum > 0) {
      norm = {
        user: +(split.user / sum * 100).toFixed(1),
        system: +(split.system / sum * 100).toFixed(1),
        irq: +(split.irq / sum * 100).toFixed(1),
        softirq: +(split.softirq / sum * 100).toFixed(1),
      };
    }
    const normSum = +(norm.user + norm.system + norm.irq + norm.softirq).toFixed(1);

    // Per-CPU stats
    const cpuLoads = Object.values(perCpu).filter((v) => Number.isFinite(v));
    const cpuCount = cpuLoads.length;
    const avgCpu = cpuCount ? cpuLoads.reduce((a, b) => a + b, 0) / cpuCount : 0;
    const hotList = Object.entries(perCpu)
      .filter(([k]) => k !== 'cpu')
      .sort((a, b) => b[1] - a[1]);
    const saturated = hotList.filter(([, v]) => v >= 80).map(([k]) => k.toUpperCase());

    // Top functions summary string (limit to 5 for readability)
    const topFnStr = topFns.slice(0, 5)
      .map((e) => `${e.symbol} ${e.percent.toFixed(1)}% [${e.module}]`)
      .join(' · ');

    // Module aggregate string (limit to 4 kept upstream)
    const modStr = mods.length
      ? mods.map((m) => `${m.module} ${pct1(m.percent)}%`).join(' · ')
      : '';

    // Interrupts per-second rates
    const irqRate = windowS > 0 ? hottest.delta / windowS : 0;
    const softRate = windowS > 0 ? hotSoft.delta / windowS : 0;

    // Load descriptor
    let loadDescr = 'mostly idle';
    if (avgCpu >= 50) loadDescr = 'under heavy CPU load';
    else if (avgCpu >= 20) loadDescr = 'moderately loaded';
    else if (avgCpu >= 5) loadDescr = 'lightly loaded';

    const lines: string[] = [];
    lines.push('Kernel Hotspots Summary');
    lines.push(`Window: ${windowS} s`);
    lines.push(`CPU utilization: avg ${pct1(avgCpu)}% across ${cpuCount} CPUs; peak ${cpu.cpu.toUpperCase()} ${pct1(cpu.load)}%.`);
    if (saturated.length) {
      lines.push(`Cores >=80%: ${saturated.join(', ')} (${saturated.length}).`);
    }
    lines.push(`Time split (normalised): user ${pct1(norm.user)}% · system ${pct1(norm.system)}% · irq ${pct1(norm.irq)}% · softirq ${pct1(norm.softirq)}% (sum ${pct1(normSum)}%).`);

    if (topFns.length) {
      lines.push(`Top path: ${topFns[0].symbol} — ${topFns[0].percent.toFixed(1)}%.`);
    } else {
      lines.push('Top path: n/a (no perf samples — perf not available or insufficient privileges).');
    }

    if (hottest.irq) {
      lines.push(`Hottest IRQ: ${hottest.irq} (${hottest.label || '?'}): ${hottest.delta} hits (~${irqRate.toFixed(1)}/s).`);
    } else {
      lines.push('Hottest IRQ: n/a.');
    }
    if (hotSoft.name) {
      lines.push(`Hottest softirq: ${hotSoft.name}: ${hotSoft.delta} hits (~${softRate.toFixed(1)}/s).`);
    } else {
      lines.push('Hottest softirq: n/a.');
    }

    if (modStr) {
      lines.push(`Modules by samples: ${modStr}.`);
    }
    if (topFnStr) {
      lines.push(`Top functions: ${topFnStr}.`);
    }

    // Per-CPU compact listing (cpu0..)
    if (cpuCount) {
      const perCpuStr = hotList.map(([k, v]) => `${k.toUpperCase()} ${pct1(v)}%`).join(' | ');
      lines.push(`Per-CPU: ${perCpuStr}`);
    }

    // Optional debug payload (plain text)
    if ((info as any)._raw && (info as any)._alwaysDebug) {
      const meta = (info as any)._meta || {};
      if (Object.keys(meta).length) {
        lines.push(`_meta: ${JSON.stringify(meta)}`);
      }
      lines.push('---- DEBUG RAW PAYLOAD ----');
      lines.push(String((info as any)._raw).trim());
    }

    return lines.join('\n');
  }
} 