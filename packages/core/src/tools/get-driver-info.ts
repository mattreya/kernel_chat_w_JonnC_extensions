/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { EventEmitter } from 'events';
import { BaseTool, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';
import fs from 'node:fs';
import path from 'node:path';

// Utility to run shell commands safely.
function safe(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function readText(p: string): string | undefined {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return undefined; }
}
function readLinkBase(p: string): string | undefined {
  try { return path.basename(fs.realpathSync(p)); } catch { return undefined; }
}
interface SysfsDevice {
  path: string;
  bus: string;
  driver?: string;
  module?: string;
  builtIn: boolean;
  modalias?: string;
  ids?: {
    pci?: { vendor: string; device: string };
    usb?: { vid: string; pid: string };
    acpi?: string;
  };
  identity?: string; // friendly description after enrichment
  candidates?: string[]; // suggested modules (from serial payload or local resolution)
}

interface FirmwareHint { line: string; }

interface TaintInfo { raw: number; flags: string[]; }

export interface GetDriverInfoParams {
  /** Subsystem filter: "pci", "usb", "platform" */
  subsystem?: string;
  /** Only show unbound devices */
  only_unbound?: boolean;
  /** Target device path or VID:PID / PCI-ID */
  target?: string;
  /** Debug raw payload */
  debug?: boolean;
}

export class GetDriverInfoTool extends BaseTool<GetDriverInfoParams, ToolResult> {
  static readonly Name = 'get_driver_info';

  constructor() {
    super(
      GetDriverInfoTool.Name,
      'DriverInfo',
      'Scans driver bindings on a Linux system (PCI, USB, platform) and summarises which devices are bound/unbound and which modules could handle them.',
      {
        type: 'object',
        properties: {
          subsystem: {
            type: 'string',
            description: 'Optional subsystem filter: "pci" | "usb" | "platform"',
          },
          only_unbound: { type: 'boolean', description: 'If true, list only unbound devices.' },
          target: { type: 'string', description: 'Specific device path or VID:PID / PCI-ID to explain.' },
          debug: { type: 'boolean', description: 'Include raw command payloads.' },
        },
      },
    );
  }

  validateToolParams(params: GetDriverInfoParams): string | null {
    if (
      this.schema.parameters &&
      !SchemaValidator.validate(this.schema.parameters as Record<string, unknown>, params)
    ) {
      return 'Parameters failed schema validation.';
    }
    return null;
  }

  getDescription(params: GetDriverInfoParams): string {
    if (params.target) return `Explaining driver info for ${params.target}`;
    return 'Scanning driver bindings';
  }

  async execute(params: GetDriverInfoParams): Promise<ToolResult> {
    const invalid = this.validateToolParams(params);
    if (invalid) {
      return { llmContent: invalid, returnDisplay: invalid };
    }

    try {
      const hasSerial = (globalThis as any).GEMINI_ACTIVE_SERIAL;
      let info: string;
      if (hasSerial) {
        info = await this.scanViaSerialLogBuffer(params);
      } else {
        info = params.target
          ? this.explainDevice(params.target, params)
          : this.scanSystem(params);
      }

      const output = info;
      return { llmContent: output, returnDisplay: output };
    } catch (err) {
      const msg = `Failed to get driver info: ${getErrorMessage(err)}`;
      return { llmContent: msg, returnDisplay: msg };
    }
  }

  /** Collects driver info from target over existing serial log buffer. */
  private async scanViaSerialLogBuffer(params: GetDriverInfoParams): Promise<string> {
    const serial = (globalThis as any).GEMINI_ACTIVE_SERIAL as EventEmitter & { send?: (d: string) => void };
    const logs: string[] | undefined = (globalThis as any).GEMINI_SERIAL_LOGS as string[] | undefined;
    if (!serial || typeof serial.send !== 'function' || !logs) {
      return 'Serial logging not available.';
    }

    const runId = Math.random().toString(36).slice(2, 8);
    const START = `__DRV_START_${runId}__`;
    const END = `__DRV_END_${runId}__`;

    const cmd = `\ncat <<'__DRVSCR__' > /tmp/drvscan.sh
START='${START}'
END='${END}'
echo "$START"
# 1) Authoritative sysfs sweep with per-device candidate resolution
echo "---SYSFS---"
# enumerate device paths
while IFS= read -r d; do
  [ -e "$d" ] || continue
  sub=""; [ -L "$d/subsystem" ] && sub="$(basename "$(readlink -f "$d/subsystem")")"
  drv=""; [ -L "$d/driver" ] && drv="$(basename "$(readlink -f "$d/driver")")"
  mod=""; [ -L "$d/driver/module" ] && mod="$(basename "$(readlink -f "$d/driver/module")")"
  alias=""; [ -f "$d/modalias" ] && alias="$(cat "$d/modalias" 2>/dev/null)"
  builtin="no"; if [ -n "$drv" ] && [ -z "$mod" ]; then builtin="yes"; fi
  # bus-specific IDs
  pci_vendor=""; pci_device=""; usb_vid=""; usb_pid=""; acpi_id=""
  if [ "$sub" = "pci" ]; then
    pci_vendor="$(cat "$d/vendor" 2>/dev/null | sed 's/^0x//')"
    pci_device="$(cat "$d/device" 2>/dev/null | sed 's/^0x//')"
  elif [ "$sub" = "usb" ]; then
    usb_vid="$(cat "$d/idVendor" 2>/dev/null)"; usb_pid="$(cat "$d/idProduct" 2>/dev/null)"
  else
    acpi_id="$(cat "$d/hid" 2>/dev/null || cat "$d/modalias" 2>/dev/null)"
  fi
  cands=""
  if [ -z "$drv" ] && [ -n "$alias" ]; then
    cands="$(modprobe -R "$alias" 2>/dev/null | tr '\\n' ',' | sed 's/,$//')"
  fi
  printf 'D|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$d" "$sub" "$drv" "$mod" "$builtin" "$alias" "$cands" \
    "$pci_vendor" "$pci_device" "$usb_vid" "$usb_pid" \
    | sed 's/\\r//g'
done <<__DEVLIST__
$(find /sys/bus -type l -path '/sys/bus/*/devices/*' -printf '%p\\n' 2>/dev/null | sort -u)
__DEVLIST__

# 2) Human-friendly identities
echo "---LSPCI---"
lspci -k 2>/dev/null || true

echo "---LSUSB---"
lsusb 2>/dev/null || true

# 3) Firmware hints
echo "---FW---"
if command -v journalctl >/dev/null 2>&1; then
  journalctl -k -n 400 --no-pager | grep -Ei 'firmware|request_firmware' | tail -n 80 | sed 's/^/F|/'
else
  dmesg 2>/dev/null | grep -Ei 'firmware|request_firmware' | tail -n 80 | sed 's/^/F|/'
fi

# 4) Kernel taint
echo "---TAINT---"
cat /proc/sys/kernel/tainted 2>/dev/null || echo 0

echo "$END"
__DRVSCR__
sh /tmp/drvscan.sh 2>/dev/null
rm -f /tmp/drvscan.sh
`.trim();

    const startLen = logs.length;
    serial.send?.(cmd);

    const result = await new Promise<{sysfs: string[]; lspci: string[]; lsusb: string[]; fw: string[]; taint: string}>(resolve => {
      const timeoutMs = 30000;
      const deadline = Date.now() + timeoutMs;
      const sysfs: string[] = []; const lspci: string[] = []; const lsusb: string[] = []; const fw: string[] = [];
      let taint = '0'; let mode: 'none'|'sysfs'|'pci'|'usb'|'fw'|'taint' = 'none';
      const timer = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(timer); resolve({ sysfs, lspci, lsusb, fw, taint }); return;
        }
        const slice = logs.slice(startLen);
        const iStart = slice.findIndex(l => l.trim() === START);
        if (iStart === -1) return;
        const iEnd = slice.findIndex((l, i) => i > iStart && l.trim() === END);
        if (iEnd === -1) return;
        clearInterval(timer);
        const payload = slice.slice(iStart + 1, iEnd);
        for (const raw of payload) {
          const line = raw.replace(/\r$/, '');
          if (line.includes('---SYSFS---')) { mode = 'sysfs'; continue; }
          if (line.includes('---LSPCI---')) { mode = 'pci'; continue; }
          if (line.includes('---LSUSB---')) { mode = 'usb'; continue; }
          if (line.includes('---FW---')) { mode = 'fw'; continue; }
          if (line.includes('---TAINT---')) { mode = 'taint'; continue; }
          if (mode === 'sysfs') sysfs.push(line);
          else if (mode === 'pci') lspci.push(line);
          else if (mode === 'usb') lsusb.push(line);
          else if (mode === 'fw') fw.push(line);
          else if (mode === 'taint') taint = (line || '0').trim();
        }
        resolve({ sysfs, lspci, lsusb, fw, taint });
      }, 150);
    });

    // Parse sections
    const sysDevices = this.parseSysfsLines(result.sysfs);
    const pciEntries = this.parseLspci(result.lspci.join('\n'));
    const usbEntries = this.parseLsusbFromString(result.lsusb.join('\n'));
    const fwHints = result.fw.filter(l => l.startsWith('F|')).map(l => ({ line: l.slice(2) }));
    const taintInfo = this.decodeTaint(parseInt(result.taint || '0', 10) || 0);

    // Enrich identities from lspci/lsusb maps
    this.enrichIdentity(sysDevices, pciEntries, usbEntries);

    // Apply filters
    let devices = sysDevices as SysfsDevice[];
    if (params.subsystem) devices = devices.filter(d => d.bus === params.subsystem);
    if (params.only_unbound) devices = devices.filter(d => !d.driver);

    // If explain mode requested, produce a focused narrative
    if (params.target) {
      const match = this.findTarget(devices, params.target);
      if (!match) return `Could not find device ${params.target}.`;
      return this.formatExplainFromSysfs(match, fwHints);
    }

    // Summary narrative
    const total = devices.length;
    const unbound = devices.filter(d => !d.driver).length;
    let md = 'Driver scan summary\n';
    md += `- Devices inspected: ${total} (${Array.from(new Set(devices.map(d => d.bus))).join(', ')})\n`;
    md += `- Unbound devices: ${unbound}\n`;
    if (taintInfo.raw) md += `- Kernel taint: ${taintInfo.flags.join(', ') || taintInfo.raw}\n`;
    md += '\n';

    const unboundDevices = devices.filter(d => !d.driver);
    if (unboundDevices.length) {
      md += 'Unbound devices\n';
      let idx = 1;
      for (const d of unboundDevices) {
        const fwLines = this.filterFirmwareForDevice(d, fwHints).slice(0, 2);
        md += `${idx}) ${d.path}  [${d.bus}]\n`;
        md += `   Identity: ${d.identity || d.modalias || d.path}\n`;
        if (d.modalias) md += `   Modalias: ${d.modalias}\n`;
        md += `   Candidates: ${(d.candidates || []).join(', ') || 'none'}\n`;
        md += `   Firmware: ${fwLines.length ? fwLines.join(' | ') : 'none reported'}\n\n`;
        idx++;
      }
    } else {
      md += 'No unbound devices found.\n\n';
    }

    const highlights = devices.filter(d => !!d.driver).slice(0, 3);
    if (highlights.length) {
      md += 'Bound highlights\n';
      for (const d of highlights) {
        const bits: string[] = [`driver ${d.driver}`];
        if (d.module) bits.push(`module ${d.module}`);
        if (d.builtIn) bits.push('built-in');
        md += `- ${d.path} → ${bits.join(', ')} — ${d.identity || ''}`.trim() + '\n';
      }
    }

    return md.trim();
  }

  private scanSystem(params: GetDriverInfoParams): string {
    // Local fallback: also sweep sysfs for authoritative binding
    const sys = this.collectSysfsDevicesLocal();
    const lspci = safe('lspci -k');
    const pciEntries = this.parseLspci(lspci);
    const usbEntries = this.parseLsusb();
    this.enrichIdentity(sys, pciEntries, usbEntries);

    let devices: SysfsDevice[] = sys;
    if (params.subsystem) devices = devices.filter(d => d.bus === params.subsystem);
    if (params.only_unbound) devices = devices.filter(d => !d.driver);

    const total = devices.length;
    const unbound = devices.filter((d) => !d.driver).length;
    const taints = this.decodeTaint(parseInt(readText('/proc/sys/kernel/tainted') || '0', 10) || 0);
    const fw = (safe('journalctl -k -n 400 --no-pager') || safe('dmesg'))
      .split(/\r?\n/).filter(l => /firmware|request_firmware/i.test(l)).slice(-50).map(line => ({ line }));

    let md = 'Driver scan summary\n';
    md += `- Devices inspected: ${total} (${Array.from(new Set(devices.map(d => d.bus))).join(', ')})\n`;
    md += `- Unbound devices: ${unbound}\n`;
    if (taints.raw) md += `- Kernel taint: ${taints.flags.join(', ') || taints.raw}\n`;
    md += '\n';

    const unboundDevices = devices.filter(d => !d.driver);
    if (unboundDevices.length) {
      md += 'Unbound devices\n';
      let idx = 1;
      for (const d of unboundDevices) {
        const fwLines = this.filterFirmwareForDevice(d, fw).slice(0, 2);
        md += `${idx}) ${d.path}  [${d.bus}]\n`;
        md += `   Identity: ${d.identity || d.modalias || d.path}\n`;
        if (d.modalias) md += `   Modalias: ${d.modalias}\n`;
        md += `   Candidates: ${(d.candidates || []).join(', ') || 'none'}\n`;
        md += `   Firmware: ${fwLines.length ? fwLines.join(' | ') : 'none reported'}\n\n`;
        idx++;
      }
    } else {
      md += 'No unbound devices found.\n\n';
    }

    const highlights = devices.filter(d => !!d.driver).slice(0, 3);
    if (highlights.length) {
      md += 'Bound highlights\n';
      for (const d of highlights) {
        const bits: string[] = [`driver ${d.driver}`];
        if (d.module) bits.push(`module ${d.module}`);
        if (d.builtIn) bits.push('built-in');
        md += `- ${d.path} → ${bits.join(', ')} — ${d.identity || ''}`.trim() + '\n';
      }
    }

    if (params.debug) {
      md += '\nDebug raw blocks:\n';
      md += '```\n' + lspci + '\n---\n' + usbEntries.map((e) => e.raw).join('\n---\n') + '\n```';
    }

    return md.trim();
  }

  private explainDevice(target: string, _params: GetDriverInfoParams): string {
    const sys = this.collectSysfsDevicesLocal();
    const lspci = safe('lspci -k');
    const pciEntries = this.parseLspci(lspci);
    const usbEntries = this.parseLsusb();
    this.enrichIdentity(sys, pciEntries, usbEntries);
    const match = this.findTarget(sys, target);
    if (match) {
      // Build firmware hints locally
      const fw = (safe('journalctl -k -n 400 --no-pager') || safe('dmesg'))
        .split(/\r?\n/).filter(l => /firmware|request_firmware/i.test(l)).slice(-50).map(line => ({ line }));
      return this.formatExplainFromSysfs(match, fw);
    }
    // fallback to previous simplistic path
    const pci = pciEntries.find((d) => d.path === target || d.id.toLowerCase() === target.toLowerCase());
    if (pci) return this.formatExplain(pci);
    const usb = usbEntries.find((d) => d.path === target || d.id.toLowerCase() === target.toLowerCase());
    if (usb) return this.formatExplain(usb);
    return `Could not find device ${target}.`;
  }
  // ---- sysfs helpers and enrichment ----
  private parseSysfsLines(lines: string[]): SysfsDevice[] {
    const out: SysfsDevice[] = [];
    for (const line of lines) {
      if (!line.startsWith('D|')) continue;
      const parts = line.split('|');
      // D|path|bus|driver|module|builtin|modalias|cands|pci_vendor|pci_device|usb_vid|usb_pid
      const path = parts[1] || '';
      const bus = parts[2] || '';
      const driver = parts[3] || '';
      const module = parts[4] || '';
      const builtin = (parts[5] || '') === 'yes';
      const modalias = parts[6] || '';
      const cands = (parts[7] || '').split(',').map(s => s.trim()).filter(Boolean);
      const pci_vendor = (parts[8] || '').toLowerCase();
      const pci_device = (parts[9] || '').toLowerCase();
      const usb_vid = (parts[10] || '').toLowerCase();
      const usb_pid = (parts[11] || '').toLowerCase();
      const dev: SysfsDevice = {
        path, bus, driver: driver || undefined, module: module || undefined, builtIn: builtin,
        modalias: modalias || undefined, ids: {}, candidates: cands,
      };
      if (pci_vendor || pci_device) dev.ids!.pci = { vendor: pci_vendor, device: pci_device };
      if (usb_vid || usb_pid) dev.ids!.usb = { vid: usb_vid, pid: usb_pid };
      out.push(dev);
    }
    return out;
  }

  private enrichIdentity(sys: SysfsDevice[], pci: DriverEntry[], usb: DriverEntry[]): void {
    const pciMap = new Map(pci.map(p => [p.id?.toLowerCase(), p.idStr]));
    const usbMap = new Map(usb.map(u => [u.id?.toLowerCase(), u.idStr]));
    for (const d of sys) {
      if (d.bus === 'pci' && d.ids?.pci) {
        const key = `${d.ids.pci.vendor}:${d.ids.pci.device}`.toLowerCase();
        d.identity = pciMap.get(key) || `pci ${key}`;
      } else if (d.bus === 'usb' && d.ids?.usb) {
        const key = `${d.ids.usb.vid}:${d.ids.usb.pid}`.toLowerCase();
        d.identity = usbMap.get(key) || `usb ${key}`;
      } else if (d.modalias) {
        d.identity = d.modalias;
      } else {
        d.identity = d.path;
      }
    }
  }

  private decodeTaint(raw: number): TaintInfo {
    const flags: string[] = [];
    if (raw & 1) flags.push('PROPRIETARY');
    if (raw & 2) flags.push('FORCED');
    if (raw & 4) flags.push('UNSAFE');
    if (raw & 8) flags.push('ODD_BUG');
    if (raw & 16) flags.push('USER');
    if (raw & 32) flags.push('MODULE_UNSIGNED');
    return { raw, flags };
  }

  private filterFirmwareForDevice(d: SysfsDevice, fw: FirmwareHint[]): string[] {
    const names = new Set<string>();
    if (d.driver) names.add(d.driver);
    for (const c of d.candidates || []) names.add(c);
    const arr = Array.from(names);
    if (!arr.length) return [];
    return fw.filter(h => arr.some(n => h.line.includes(n))).map(h => h.line);
  }

  private findTarget(devices: SysfsDevice[], target: string): (SysfsDevice & { identity?: string }) | undefined {
    const t = target.toLowerCase();
    return devices.find(d => d.path === target ||
      (d.ids?.usb && `${d.ids.usb.vid}:${d.ids.usb.pid}`.toLowerCase() === t) ||
      (d.ids?.pci && `${d.ids.pci.vendor}:${d.ids.pci.device}`.toLowerCase() === t));
  }

  private formatExplainFromSysfs(d: SysfsDevice, fwHints: FirmwareHint[]): string {
    const bound = !!d.driver;
    const fwLines = this.filterFirmwareForDevice(d, fwHints).slice(0, 3);
    let md = `Device explanation — ${d.path}\n`;
    md += `Subsystem: ${d.bus}\n\n`;
    md += 'Binding\n';
    md += `- ${bound ? `BOUND: ${d.driver}` : 'UNBOUND'}\n`;
    if (bound && d.builtIn) md += `- Driver appears built-in (no module link).\n`;
    if (d.module) md += `- Module: ${d.module}\n`;
    md += '\nIdentification\n';
    md += `- ${d.identity || d.modalias || d.path}\n`;
    if (d.modalias) md += `- Modalias: ${d.modalias}\n`;
    md += '\nCandidates\n';
    md += `- ${(d.candidates || []).join(', ') || 'none'}\n`;
    md += '\nFirmware hints\n';
    md += fwLines.length ? fwLines.map(x => `- ${x}`).join('\n') : '- none reported\n';
    md += '\n\nSuggested action\n';
    if (!bound && (d.candidates?.length || 0) > 0) {
      md += `- Try: load \`${d.candidates![0]}\` and replug, then recheck logs.\n`;
    } else if (!bound) {
      md += `- No candidates found; capture fresh logs and verify device IDs.\n`;
    } else {
      md += `- Device appears correctly bound.\n`;
    }
    return md.trim();
  }

  private collectSysfsDevicesLocal(max = 5000): SysfsDevice[] {
    const out: SysfsDevice[] = [];
    const cmd = `find /sys/bus -type l -path '/sys/bus/*/devices/*' -printf '%p\n' 2>/dev/null`;
    const list = safe(cmd).split('\n').filter(Boolean).slice(0, max);
    for (const p of list) {
      const bus = readLinkBase(path.join(p, 'subsystem')) || '';
      const driver = readLinkBase(path.join(p, 'driver'));
      const moduleName = readLinkBase(path.join(p, 'driver/module'));
      const modalias = readText(path.join(p, 'modalias'));
      const dev: SysfsDevice = { path: p, bus, driver, module: moduleName, builtIn: !!(driver && !moduleName), modalias, ids: {} };
      if (bus === 'pci') {
        const vendor = (readText(path.join(p, 'vendor')) || '').replace(/^0x/, '');
        const device = (readText(path.join(p, 'device')) || '').replace(/^0x/, '');
        if (vendor || device) dev.ids!.pci = { vendor: vendor.toLowerCase(), device: device.toLowerCase() };
      } else if (bus === 'usb') {
        const vid = (readText(path.join(p, 'idVendor')) || '').toLowerCase();
        const pid = (readText(path.join(p, 'idProduct')) || '').toLowerCase();
        if (vid || pid) dev.ids!.usb = { vid, pid };
      } else {
        const acpi = readText(path.join(p, 'hid')) || readText(path.join(p, 'modalias')) || '';
        if (acpi) dev.ids!.acpi = acpi;
      }
      // No modprobe -R locally to keep behaviour aligned; we could add later if desired.
      out.push(dev);
    }
    return out;
  }

  private formatExplain(dev: DriverEntry): string {
    let md = `Device explanation — ${dev.path || dev.id}\n`;
    md += `Subsystem: ${dev.bus}\n\n`;
    md += 'Binding\n';
    md += `- ${dev.driver ? 'BOUND: ' + dev.driver : 'UNBOUND'}\n\n`;
    md += 'Identification\n';
    md += `- ${dev.idStr}\n\n`;
    md += 'Candidates\n';
    md += `- ${dev.candidates.join(', ') || 'none'}\n`;
    return md;
  }

  // ---- parsers ----
  private parseLspci(out: string): DriverEntry[] {
    const entries: DriverEntry[] = [];
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^(\S+).*?: (.*)/);
      if (!match) continue;
      const path = `0000:${match[1]}`;
      const descr = match[2];
      const driverMatch = line.match(/Kernel driver in use: (\S+)/);
      const driver = driverMatch ? driverMatch[1] : '';
      const idMatch = line.match(/\[(\w{4}:\w{4})]/);
      const id = idMatch ? idMatch[1] : '';
      entries.push({
        bus: 'pci',
        path,
        id,
        idStr: descr,
        driver,
        candidates: driver ? [driver] : this.guessModules(id, 'pci'),
        raw: line,
      });
    }
    return entries;
  }

  private parseLsusb(): DriverEntry[] {
    const out = safe('lsusb');
    return this.parseLsusbFromString(out);
  }

  private parseLsusbFromString(out: string): DriverEntry[] {
    const lines = out.split(/\r?\n/);
    const entries: DriverEntry[] = [];
    for (const l of lines) {
      const m = l.match(/^Bus (\d+) Device (\d+): ID (\w{4}:\w{4}) (.*)/);
      if (!m) continue;
      const id = m[3];
      entries.push({
        bus: 'usb',
        path: '',
        id,
        idStr: m[4] || '',
        driver: '',
        candidates: this.guessModules(id, 'usb'),
        raw: l,
      });
    }
    return entries;
  }

  private guessModules(id: string, bus: string): string[] {
    // Very naive heuristic mapping.
    if (bus === 'usb' && id.startsWith('0bda')) return ['uvcvideo', 'snd-usb-audio'];
    if (bus === 'pci' && id.startsWith('10de')) return ['snd_hda_intel'];
    return [];
  }
}

interface DriverEntry {
  bus: string;
  path: string; // sysfs-style path if available
  id: string;
  idStr: string;
  driver: string;
  candidates: string[];
  raw: string;
} 