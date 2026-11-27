import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import log from "electron-log";
import {
  collectProcessTree,
  type PsProcessEntry,
} from "./process_memory_diagnostics";
import {
  cpuSharesBetween,
  parsePsCpuTime,
  roundPct,
  type CpuTimeSnapshot,
} from "./process_cpu";

const logger = log.scope("dev_server_memory");

const KB_PER_MB = 1024;
const BYTES_PER_KB = 1024;
// Win32_Process reports CPU time in 100-nanosecond units.
const WINDOWS_CPU_TICKS_PER_SECOND = 10_000_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// `ps` returns at once; PowerShell needs a few seconds just to start.
const PS_TIMEOUT_MS = 3_000;
const POWERSHELL_TIMEOUT_MS = 15_000;

// A full process-table snapshot costs a shell-out (and on Windows a
// PowerShell start-up), so it is taken every few minutes rather than on
// every 30s heartbeat. The cadence does not change under memory pressure:
// the extra load would land exactly when the machine can least afford
// it, and os.freemem() is not a usable pressure signal on macOS anyway.
export const DEV_SERVER_SAMPLE_INTERVAL_MS = 5 * 60_000;

// CPU figures average over the time since the previous snapshot. When that
// one is older than this (no dev server ran for a while in between), the
// average would say little about the moment, so the snapshot only becomes
// the next baseline.
const MAX_CPU_WINDOW_MS = 2 * DEV_SERVER_SAMPLE_INTERVAL_MS;
const TOP_CPU_PROCESS_COUNT = 5;
const MAX_PROCESS_NAME_LENGTH = 64;

/**
 * Who a process belongs to: Dyad itself (the Electron processes and
 * anything else it spawned, such as git or MCP servers), a dev server Dyad
 * launched, or some other program on the machine.
 */
export type CpuProcessOwner = "dyad" | "dev_server" | "other";

export interface TopCpuProcess {
  // Executable name without its path, e.g. "node.exe" or "MsMpEng.exe".
  name: string;
  owner: CpuProcessOwner;
  // Processes with this name and owner that used CPU, summed into one entry.
  processCount: number;
  // Share of the whole machine's CPU, 0-100.
  cpuSharePct: number;
}

/**
 * Memory of the dev servers Dyad launched, each measured as the whole
 * process tree under the spawned root (npm, node, vite, esbuild, ...).
 * On Windows the metric is private commit (Win32_Process.PrivatePageCount);
 * on macOS and Linux it is RSS, the closest analog ps offers.
 *
 * CPU comes from the same snapshot, compared with the previous one, so it
 * is an average over the last few minutes, as a share of the whole
 * machine. Because the snapshot covers every process, it also names the
 * machine's top CPU consumers, whoever owns them. The CPU fields are
 * absent until two snapshots close enough together exist.
 */
export interface DevServerMemorySample {
  sampledAt: number;
  // Dev servers with a live root pid at sample time.
  count: number;
  totalMB: number;
  // The largest single dev server, and how many processes it had grown to.
  maxMB: number;
  maxProcessCount: number;
  // All dev servers together, and the busiest single one.
  cpuSharePct?: number;
  maxCpuSharePct?: number;
  topCpuProcesses?: TopCpuProcess[];
}

// =============================================================================
// Pure helpers (exported for testing)
// =============================================================================

/**
 * Parses `<pid> <ppid> <privateBytes> <cpuTime> <name>` lines, the shape
 * the PowerShell Win32_Process query below prints. cpuTime is user plus
 * kernel time in 100ns units; the name may contain spaces. Tolerates blank
 * and malformed lines. Skips pid 0, the System Idle Process, whose "CPU
 * time" is the time the machine spent idle.
 */
export function parseWindowsProcessTable(output: string): PsProcessEntry[] {
  const entries: PsProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/,
    );
    if (!match || match[1] === "0") continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      // Reuse the ps entry shape; rssKb holds private commit here.
      rssKb: Math.round(Number(match[3]) / BYTES_PER_KB),
      command: match[5] ?? "",
      cpuSeconds: Number(match[4]) / WINDOWS_CPU_TICKS_PER_SECOND,
    });
  }
  return entries;
}

/**
 * Parses `ps -axo pid,ppid,rss,time,comm` output. Tolerates the header row
 * and malformed lines; comm may contain spaces (macOS prints the full
 * executable path). A TIME value that does not parse leaves cpuSeconds
 * unset rather than dropping the row, so the memory figures still count.
 */
export function parsePsCpuProcessTable(output: string): PsProcessEntry[] {
  const entries: PsProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) continue;
    const cpuSeconds = parsePsCpuTime(match[4]);
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[5],
      ...(cpuSeconds !== null && { cpuSeconds }),
    });
  }
  return entries;
}

/**
 * The executable's name without its directory (macOS ps prints a full
 * path, which can include the user's home folder), cut to a sane length.
 * Only an absolute path is cut: a Linux kernel thread name such as
 * "kworker/0:1" contains a slash too.
 */
export function processDisplayName(command: string): string {
  const name = command.startsWith("/")
    ? command.slice(command.lastIndexOf("/") + 1)
    : command;
  return name.slice(0, MAX_PROCESS_NAME_LENGTH);
}

export function summarizeDevServerMemory(
  rootPids: number[],
  entries: PsProcessEntry[],
  sampledAt: number,
): DevServerMemorySample {
  let count = 0;
  let totalKb = 0;
  let maxKb = 0;
  let maxProcessCount = 0;
  for (const pid of rootPids) {
    // A root missing from the snapshot exited between the pid list and
    // the snapshot, so it is not a running dev server any more. Checked
    // explicitly: the tree walk still finds the children of a vanished
    // root through their parent pid.
    if (!entries.some((entry) => entry.pid === pid)) {
      continue;
    }
    const tree = collectProcessTree(pid, entries);
    count++;
    const treeKb = tree.reduce((sum, entry) => sum + entry.rssKb, 0);
    totalKb += treeKb;
    if (treeKb > maxKb) {
      maxKb = treeKb;
      maxProcessCount = tree.length;
    }
  }
  return {
    sampledAt,
    count,
    totalMB: Math.round(totalKb / KB_PER_MB),
    maxMB: Math.round(maxKb / KB_PER_MB),
    maxProcessCount,
  };
}

/**
 * CPU of the dev servers, and the machine's top CPU consumers grouped by
 * name and owner, from each pid's share of the machine since the previous
 * snapshot. Dev server trees are found the same way as for memory;
 * everything else under Dyad's main process is Dyad's.
 */
export function summarizeDevServerCpu(input: {
  rootPids: number[];
  dyadPid: number;
  entries: PsProcessEntry[];
  sharesByPid: ReadonlyMap<number, number>;
}): Required<
  Pick<
    DevServerMemorySample,
    "cpuSharePct" | "maxCpuSharePct" | "topCpuProcesses"
  >
> {
  const { rootPids, dyadPid, entries, sharesByPid } = input;
  const owners = new Map<number, CpuProcessOwner>();
  // Dev servers are children of Dyad's main process too, so they are
  // marked after it and override.
  for (const entry of collectProcessTree(dyadPid, entries)) {
    owners.set(entry.pid, "dyad");
  }
  let total = 0;
  let max = 0;
  for (const pid of rootPids) {
    if (!entries.some((entry) => entry.pid === pid)) {
      continue;
    }
    let tree = 0;
    for (const entry of collectProcessTree(pid, entries)) {
      owners.set(entry.pid, "dev_server");
      tree += sharesByPid.get(entry.pid) ?? 0;
    }
    total += tree;
    max = Math.max(max, tree);
  }

  const groups = new Map<string, TopCpuProcess>();
  for (const entry of entries) {
    const share = sharesByPid.get(entry.pid);
    if (share === undefined || share <= 0) {
      continue;
    }
    const owner = owners.get(entry.pid) ?? "other";
    const name = processDisplayName(entry.command);
    const key = `${owner}\0${name}`;
    const group = groups.get(key);
    if (group) {
      group.processCount++;
      group.cpuSharePct += share;
    } else {
      groups.set(key, { name, owner, processCount: 1, cpuSharePct: share });
    }
  }
  const topCpuProcesses = [...groups.values()]
    .sort((a, b) => b.cpuSharePct - a.cpuSharePct)
    .slice(0, TOP_CPU_PROCESS_COUNT)
    .map((group) => ({ ...group, cpuSharePct: roundPct(group.cpuSharePct) }));
  return {
    cpuSharePct: roundPct(total),
    maxCpuSharePct: roundPct(max),
    topCpuProcesses,
  };
}

function toCpuTimeSnapshot(
  entries: PsProcessEntry[],
  takenAt: number,
): CpuTimeSnapshot<number> {
  const processes = new Map<number, { cpuSeconds: number }>();
  for (const entry of entries) {
    if (entry.cpuSeconds !== undefined) {
      processes.set(entry.pid, { cpuSeconds: entry.cpuSeconds });
    }
  }
  return { takenAt, processes };
}

// =============================================================================
// Collector
// =============================================================================

function execCapture(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

async function snapshotProcessTable(): Promise<PsProcessEntry[]> {
  if (process.platform === "win32") {
    const systemRoot =
      process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    const powershell = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    // execFile hands the whole command to PowerShell as one argument, so
    // its single quotes need no escaping. The array `-join` avoids a
    // format string with double quotes inside. The name goes last because
    // it can contain spaces; the casts turn a missing CPU time into 0.
    const output = await execCapture(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,PrivatePageCount,KernelModeTime,UserModeTime,Name | ForEach-Object { $_.ProcessId, $_.ParentProcessId, $_.PrivatePageCount, ([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime), $_.Name -join ' ' }",
      ],
      POWERSHELL_TIMEOUT_MS,
    );
    return parseWindowsProcessTable(output);
  }
  const output = await execCapture(
    "ps",
    ["-axo", "pid,ppid,rss,time,comm"],
    PS_TIMEOUT_MS,
  );
  return parsePsCpuProcessTable(output);
}

// Samples are keyed by the set of root pids they measured, so a sample for
// dev servers that have since stopped or restarted is never reported as
// if it described the current ones.
let latestSample: DevServerMemorySample | null = null;
let latestSampleKey: string | null = null;
// The pid set of the most recent heartbeat; a snapshot that finishes
// after the set moved on is discarded.
let requestedKey: string | null = null;
// The pid set of the last snapshot started, successful or not. A changed
// set starts a snapshot at once; after a failure the interval applies, so
// a broken shell-out cannot respawn on every heartbeat.
let attemptedKey: string | null = null;
let sampleInFlight = false;
let lastSampleStartedAt = 0;
// CPU times from the last successful snapshot, whatever its pid set: CPU
// is compared per pid, so a changed set of dev servers does not reset it.
let cpuBaseline: CpuTimeSnapshot<number> | null = null;

function pidSetKey(pids: number[]): string {
  return [...pids].sort((a, b) => a - b).join(",");
}

/**
 * The most recent dev-server memory (and CPU) sample for the current set
 * of root pids, starting a new one in the background when that set changed
 * or the previous attempt is old enough. Never blocks the heartbeat: the
 * shell-out runs asynchronously and lands in a later heartbeat. Null until
 * a sample for the current set exists.
 *
 * With no dev server running, the answer is immediate and no process is
 * spawned.
 */
export function getDevServerMemorySample(input: {
  rootPids: number[];
  now: number;
  snapshot?: () => Promise<PsProcessEntry[]>;
  cpuCount?: number;
  dyadPid?: number;
}): DevServerMemorySample | null {
  const {
    rootPids,
    now,
    snapshot = snapshotProcessTable,
    cpuCount = os.cpus().length,
    dyadPid = process.pid,
  } = input;
  const key = pidSetKey(rootPids);
  requestedKey = key;
  if (rootPids.length === 0) {
    latestSample = {
      sampledAt: now,
      count: 0,
      totalMB: 0,
      maxMB: 0,
      maxProcessCount: 0,
    };
    latestSampleKey = key;
    return latestSample;
  }

  const pidSetChanged = key !== attemptedKey;
  if (
    !sampleInFlight &&
    (pidSetChanged ||
      now - lastSampleStartedAt >= DEV_SERVER_SAMPLE_INTERVAL_MS)
  ) {
    sampleInFlight = true;
    attemptedKey = key;
    lastSampleStartedAt = now;
    void snapshot()
      .then((entries) => {
        // Timed by the heartbeat that started each snapshot. The shell-out's
        // own start-up delay is about the same every time, so it mostly
        // cancels out of a window several minutes long.
        const previousCpu = cpuBaseline;
        const currentCpu = toCpuTimeSnapshot(entries, now);
        if (currentCpu.processes.size > 0) {
          cpuBaseline = currentCpu;
        }
        if (requestedKey !== key) {
          logger.debug("Discarding dev server memory sample for stale pids");
          return;
        }
        const sample = summarizeDevServerMemory(rootPids, entries, now);
        if (
          previousCpu &&
          currentCpu.processes.size > 0 &&
          now - previousCpu.takenAt <= MAX_CPU_WINDOW_MS
        ) {
          const sharesByPid = cpuSharesBetween(
            previousCpu,
            currentCpu,
            cpuCount,
          );
          Object.assign(
            sample,
            summarizeDevServerCpu({ rootPids, dyadPid, entries, sharesByPid }),
          );
        }
        latestSample = sample;
        latestSampleKey = key;
        logger.debug("Dev server memory:", latestSample);
      })
      .catch((error) => {
        logger.warn("Failed to sample dev server memory:", error);
      })
      .finally(() => {
        sampleInFlight = false;
      });
  }
  return latestSampleKey === key ? latestSample : null;
}

export function resetDevServerMemoryForTesting(): void {
  latestSample = null;
  latestSampleKey = null;
  requestedKey = null;
  attemptedKey = null;
  sampleInFlight = false;
  lastSampleStartedAt = 0;
  cpuBaseline = null;
}
