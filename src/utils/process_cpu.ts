/**
 * CPU usage per process, worked out from two readings of each process's
 * cumulative CPU time. Shares are of the whole machine: 100 means every
 * logical CPU was busy for the whole window, the same scale as the
 * performance monitor's systemCpuPercent, so the two can be compared
 * directly.
 */

/** Cumulative CPU time of every process, read at one moment. */
export interface CpuTimeSnapshot<K = string> {
  // Milliseconds since epoch.
  takenAt: number;
  // Keyed by process identity: a pid, or better a pid plus start time
  // where the source reports one, so a reused pid reads as a new process.
  processes: ReadonlyMap<K, ProcessCpuTime>;
}

export interface ProcessCpuTime {
  // CPU time used since the process started, user plus kernel.
  cpuSeconds: number;
  // When the process started (ms since epoch), if the source reports it.
  startedAt?: number;
}

/**
 * Each process's share of the machine's CPU between two snapshots, keyed
 * like the snapshots and unrounded so callers can sum before rounding.
 *
 * A process missing from the previous snapshot started since, so all of
 * its CPU time falls in the window, unless its start time says it was
 * already running: then the previous reading just lacked it and there is
 * no baseline, so it is left out. A count that went backwards is a reused
 * pid, so also a new process. Processes that started and exited between
 * the snapshots are not seen at all.
 */
export function cpuSharesBetween<K>(
  previous: CpuTimeSnapshot<K>,
  current: CpuTimeSnapshot<K>,
  cpuCount: number,
): Map<K, number> {
  const shares = new Map<K, number>();
  const elapsedSeconds = (current.takenAt - previous.takenAt) / 1000;
  if (elapsedSeconds <= 0 || cpuCount <= 0) {
    return shares;
  }
  const capacitySeconds = elapsedSeconds * cpuCount;
  for (const [key, now] of current.processes) {
    const before = previous.processes.get(key);
    let usedSeconds: number;
    if (before === undefined) {
      if (now.startedAt !== undefined && now.startedAt < previous.takenAt) {
        continue;
      }
      usedSeconds = now.cpuSeconds;
    } else if (now.cpuSeconds < before.cpuSeconds) {
      usedSeconds = now.cpuSeconds;
    } else {
      usedSeconds = now.cpuSeconds - before.cpuSeconds;
    }
    shares.set(key, (usedSeconds / capacitySeconds) * 100);
  }
  return shares;
}

/**
 * Parses the TIME column of `ps -o time`: `[[dd-]hh:]mm:ss` on Linux,
 * `mmm:ss.ss` on macOS. Returns null for anything else.
 */
export function parsePsCpuTime(text: string): number | null {
  const match = text.match(/^(?:(\d+)-)?((?:\d+:){0,2})(\d+(?:\.\d+)?)$/);
  if (!match) {
    return null;
  }
  const days = match[1] ? Number(match[1]) : 0;
  let seconds = 0;
  for (const part of match[2].split(":").filter(Boolean)) {
    seconds = (seconds + Number(part)) * 60;
  }
  return days * 86_400 + seconds + Number(match[3]);
}

export function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}
