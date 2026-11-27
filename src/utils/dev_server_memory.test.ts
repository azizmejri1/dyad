import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEV_SERVER_SAMPLE_INTERVAL_MS,
  getDevServerMemorySample,
  parsePsCpuProcessTable,
  parseWindowsProcessTable,
  processDisplayName,
  resetDevServerMemoryForTesting,
  summarizeDevServerCpu,
  summarizeDevServerMemory,
} from "@/utils/dev_server_memory";
import {
  parsePsProcessTable,
  type PsProcessEntry,
} from "@/utils/process_memory_diagnostics";

describe("parseWindowsProcessTable", () => {
  it("parses pid, parent pid, private bytes, CPU time and name per line", () => {
    const entries = parseWindowsProcessTable(
      [
        "",
        "4 0 0 5000000 System",
        "1234 4 104857600 123450000 Dyad.exe",
        "not a row",
        "5678 1234 52428800 0 node.exe",
        "700 4 1024 20000000 Memory Compression",
        "800 4 2048 0",
        "",
      ].join("\r\n"),
    );
    expect(entries).toEqual([
      { pid: 4, ppid: 0, rssKb: 0, command: "System", cpuSeconds: 0.5 },
      {
        pid: 1234,
        ppid: 4,
        rssKb: 102400,
        command: "Dyad.exe",
        cpuSeconds: 12.345,
      },
      {
        pid: 5678,
        ppid: 1234,
        rssKb: 51200,
        command: "node.exe",
        cpuSeconds: 0,
      },
      {
        pid: 700,
        ppid: 4,
        rssKb: 1,
        command: "Memory Compression",
        cpuSeconds: 2,
      },
      { pid: 800, ppid: 4, rssKb: 2, command: "", cpuSeconds: 0 },
    ]);
  });

  it("skips the System Idle Process, whose CPU time is idle time", () => {
    expect(
      parseWindowsProcessTable("0 0 8192 99999999999 System Idle Process"),
    ).toEqual([]);
  });
});

describe("parsePsCpuProcessTable", () => {
  it("parses pid, parent pid, RSS, CPU time and command", () => {
    const entries = parsePsCpuProcessTable(
      [
        "  PID  PPID    RSS      TIME COMM",
        "    1     0   5860   0:01.50 /sbin/launchd",
        "  100     1  10240  12:00.25 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "  200     1   2048  01:00:00 node",
        "  300     1   1024      ?:?? weird",
      ].join("\n"),
    );
    expect(entries).toEqual([
      {
        pid: 1,
        ppid: 0,
        rssKb: 5860,
        command: "/sbin/launchd",
        cpuSeconds: 1.5,
      },
      {
        pid: 100,
        ppid: 1,
        rssKb: 10240,
        command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        cpuSeconds: 720.25,
      },
      { pid: 200, ppid: 1, rssKb: 2048, command: "node", cpuSeconds: 3600 },
      // Still counted for memory; just no CPU figure.
      { pid: 300, ppid: 1, rssKb: 1024, command: "weird" },
    ]);
  });
});

describe("processDisplayName", () => {
  it("drops the directory of an absolute path, which can name the user", () => {
    expect(
      processDisplayName("/Users/someone/Library/Application Support/x/helper"),
    ).toBe("helper");
    expect(processDisplayName("MsMpEng.exe")).toBe("MsMpEng.exe");
    // A Linux kernel thread name is not a path.
    expect(processDisplayName("kworker/0:1")).toBe("kworker/0:1");
    expect(processDisplayName("x".repeat(100))).toHaveLength(64);
  });
});

describe("summarizeDevServerCpu", () => {
  // Dyad's main process 10 has an Electron helper (11), git (12) and a dev
  // server rooted at 100 (npm -> node -> esbuild). 300 and 301 are another
  // program; 400 is idle.
  const entries = [
    { pid: 10, ppid: 1, rssKb: 0, command: "Dyad.exe" },
    { pid: 11, ppid: 10, rssKb: 0, command: "Dyad.exe" },
    { pid: 12, ppid: 10, rssKb: 0, command: "git.exe" },
    { pid: 100, ppid: 10, rssKb: 0, command: "cmd.exe" },
    { pid: 101, ppid: 100, rssKb: 0, command: "node.exe" },
    { pid: 102, ppid: 101, rssKb: 0, command: "esbuild.exe" },
    { pid: 300, ppid: 1, rssKb: 0, command: "MsMpEng.exe" },
    { pid: 301, ppid: 1, rssKb: 0, command: "MsMpEng.exe" },
    { pid: 400, ppid: 1, rssKb: 0, command: "idle.exe" },
  ];
  const sharesByPid = new Map([
    [10, 1],
    [11, 4],
    [12, 0.5],
    [100, 0],
    [101, 20],
    [102, 5.556],
    [300, 30],
    [301, 15],
    [400, 0],
  ]);

  it("sums dev server trees and names the top consumers by owner", () => {
    expect(
      summarizeDevServerCpu({
        rootPids: [100],
        dyadPid: 10,
        entries,
        sharesByPid,
      }),
    ).toEqual({
      cpuSharePct: 25.56,
      maxCpuSharePct: 25.56,
      topCpuProcesses: [
        {
          name: "MsMpEng.exe",
          owner: "other",
          processCount: 2,
          cpuSharePct: 45,
        },
        {
          name: "node.exe",
          owner: "dev_server",
          processCount: 1,
          cpuSharePct: 20,
        },
        {
          name: "esbuild.exe",
          owner: "dev_server",
          processCount: 1,
          cpuSharePct: 5.56,
        },
        { name: "Dyad.exe", owner: "dyad", processCount: 2, cpuSharePct: 5 },
        { name: "git.exe", owner: "dyad", processCount: 1, cpuSharePct: 0.5 },
      ],
    });
  });

  it("reports zero dev server CPU when the root has exited", () => {
    const result = summarizeDevServerCpu({
      rootPids: [999],
      dyadPid: 10,
      entries,
      sharesByPid,
    });
    expect(result.cpuSharePct).toBe(0);
    expect(result.maxCpuSharePct).toBe(0);
    // The orphaned tree is still under Dyad's main process.
    expect(result.topCpuProcesses).toContainEqual({
      name: "node.exe",
      owner: "dyad",
      processCount: 1,
      cpuSharePct: 20,
    });
  });
});

describe("summarizeDevServerMemory", () => {
  // Two dev servers: pid 100 (npm -> node -> esbuild) and pid 200 (npm ->
  // node), plus an unrelated process the trees must not pick up.
  const entries = parsePsProcessTable(
    [
      "  PID  PPID   RSS COMM",
      "  100     1 10240 npm",
      "  101   100 204800 node",
      "  102   101 51200 esbuild",
      "  200     1 10240 npm",
      "  201   200 102400 node",
      "  300     1 999999 chrome",
    ].join("\n"),
  );

  it("sums each dev server's whole process tree", () => {
    expect(summarizeDevServerMemory([100, 200], entries, 1234)).toEqual({
      sampledAt: 1234,
      count: 2,
      totalMB: 370,
      maxMB: 260,
      maxProcessCount: 3,
    });
  });

  it("skips a root that has already exited", () => {
    expect(summarizeDevServerMemory([100, 999], entries, 1234)).toEqual({
      sampledAt: 1234,
      count: 1,
      totalMB: 260,
      maxMB: 260,
      maxProcessCount: 3,
    });
  });

  it("reports zeros with no dev servers", () => {
    expect(summarizeDevServerMemory([], entries, 1234)).toEqual({
      sampledAt: 1234,
      count: 0,
      totalMB: 0,
      maxMB: 0,
      maxProcessCount: 0,
    });
  });
});

describe("summarizeDevServerMemory with a vanished root", () => {
  it("does not count an orphaned child as a live dev server", () => {
    // The root exited but its child survived and still names it as
    // parent; the tree walk alone would find that child.
    const entries = parsePsProcessTable(
      ["  101   100 204800 node", "  300     1 999999 chrome"].join("\n"),
    );
    expect(summarizeDevServerMemory([100], entries, 1).count).toBe(0);
  });
});

describe("getDevServerMemorySample", () => {
  beforeEach(() => {
    resetDevServerMemoryForTesting();
  });

  const entriesFor = (pids: number[], cpuSeconds?: number) =>
    pids.map((pid) => ({
      pid,
      ppid: 1,
      rssKb: 1024 * 100,
      command: "node",
      ...(cpuSeconds !== undefined && { cpuSeconds }),
    }));

  // Lets the sampler's then/finally chain settle after a snapshot resolves.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function deferredSnapshot() {
    let resolve!: (entries: PsProcessEntry[]) => void;
    const promise = new Promise<PsProcessEntry[]>((r) => {
      resolve = r;
    });
    return { snapshot: () => promise, resolve };
  }

  it("answers zeros at once with no dev servers and no shell-out", () => {
    const snapshot = vi.fn();
    expect(
      getDevServerMemorySample({ rootPids: [], now: 1000, snapshot }),
    ).toEqual({
      sampledAt: 1000,
      count: 0,
      totalMB: 0,
      maxMB: 0,
      maxProcessCount: 0,
    });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("samples as soon as the pid set changes, not on the interval", async () => {
    const first = deferredSnapshot();
    expect(
      getDevServerMemorySample({
        rootPids: [100],
        now: 1000,
        snapshot: first.snapshot,
      }),
    ).toBeNull();
    first.resolve(entriesFor([100]));
    await flush();
    expect(
      getDevServerMemorySample({
        rootPids: [100],
        now: 2000,
        snapshot: first.snapshot,
      }),
    ).toMatchObject({ count: 1, totalMB: 100 });

    // A second dev server starts: a fresh sample runs immediately, and the
    // old one is not reported for the new set in the meantime.
    const second = deferredSnapshot();
    expect(
      getDevServerMemorySample({
        rootPids: [100, 200],
        now: 3000,
        snapshot: second.snapshot,
      }),
    ).toBeNull();
    second.resolve(entriesFor([100, 200]));
    await flush();
    expect(
      getDevServerMemorySample({
        rootPids: [100, 200],
        now: 4000,
        snapshot: second.snapshot,
      }),
    ).toMatchObject({ sampledAt: 3000, count: 2, totalMB: 200 });
  });

  it("discards a snapshot that finishes after the pid set moved on", async () => {
    const stale = deferredSnapshot();
    getDevServerMemorySample({
      rootPids: [100],
      now: 1000,
      snapshot: stale.snapshot,
    });
    // The app stopped while the snapshot was running.
    getDevServerMemorySample({
      rootPids: [],
      now: 2000,
      snapshot: stale.snapshot,
    });
    stale.resolve(entriesFor([100]));
    await flush();
    expect(
      getDevServerMemorySample({
        rootPids: [],
        now: 3000,
        snapshot: stale.snapshot,
      }),
    ).toMatchObject({ count: 0 });
  });

  it("resamples an unchanged pid set only after the interval", async () => {
    const snapshot = vi.fn(async () => entriesFor([100]));
    getDevServerMemorySample({ rootPids: [100], now: 0, snapshot });
    await flush();
    getDevServerMemorySample({ rootPids: [100], now: 30_000, snapshot });
    expect(snapshot).toHaveBeenCalledTimes(1);
    getDevServerMemorySample({
      rootPids: [100],
      now: DEV_SERVER_SAMPLE_INTERVAL_MS,
      snapshot,
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("waits for the interval before retrying a failed snapshot", async () => {
    // A broken shell-out (PowerShell blocked, timeout) must not respawn on
    // every heartbeat just because no sample for this set exists yet.
    const snapshot = vi.fn(async () => {
      throw new Error("powershell unavailable");
    });
    expect(
      getDevServerMemorySample({ rootPids: [100], now: 0, snapshot }),
    ).toBeNull();
    await flush();
    getDevServerMemorySample({ rootPids: [100], now: 30_000, snapshot });
    getDevServerMemorySample({ rootPids: [100], now: 60_000, snapshot });
    expect(snapshot).toHaveBeenCalledTimes(1);
    getDevServerMemorySample({
      rootPids: [100],
      now: DEV_SERVER_SAMPLE_INTERVAL_MS,
      snapshot,
    });
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  // Takes one snapshot per call, each reporting the given CPU time for
  // pid 100, and returns the sample it produced.
  async function sampleWithCpu(now: number, cpuSeconds: number) {
    const snapshot = async () => entriesFor([100], cpuSeconds);
    const input = { rootPids: [100], now, snapshot, cpuCount: 2, dyadPid: 1 };
    getDevServerMemorySample(input);
    await flush();
    return getDevServerMemorySample(input);
  }

  it("reports CPU between snapshots as a share of the machine", async () => {
    const first = await sampleWithCpu(0, 10);
    // One snapshot is not enough to say anything about CPU.
    expect(first).not.toHaveProperty("cpuSharePct");
    expect(first).not.toHaveProperty("topCpuProcesses");

    // 60 CPU-seconds in 300s on 2 CPUs: a tenth of the machine.
    const second = await sampleWithCpu(DEV_SERVER_SAMPLE_INTERVAL_MS, 70);
    expect(second).toMatchObject({
      count: 1,
      cpuSharePct: 10,
      maxCpuSharePct: 10,
      topCpuProcesses: [
        { name: "node", owner: "dev_server", processCount: 1, cpuSharePct: 10 },
      ],
    });
  });

  it("does not average CPU over a baseline that is too old", async () => {
    await sampleWithCpu(0, 10);
    const late = await sampleWithCpu(3 * DEV_SERVER_SAMPLE_INTERVAL_MS, 100);
    expect(late).toMatchObject({ count: 1 });
    expect(late).not.toHaveProperty("cpuSharePct");
    // That snapshot is the next baseline.
    const next = await sampleWithCpu(4 * DEV_SERVER_SAMPLE_INTERVAL_MS, 160);
    expect(next).toMatchObject({ cpuSharePct: 10 });
  });

  it("keeps the CPU baseline from a snapshot discarded as stale", async () => {
    const stale = deferredSnapshot();
    getDevServerMemorySample({
      rootPids: [100],
      now: 0,
      snapshot: stale.snapshot,
    });
    // A second dev server starts while the first snapshot runs.
    getDevServerMemorySample({
      rootPids: [100, 200],
      now: 1,
      snapshot: stale.snapshot,
    });
    stale.resolve(entriesFor([100], 10));
    await flush();

    const snapshot = async () => [
      ...entriesFor([100], 70),
      ...entriesFor([200], 0),
    ];
    const input = {
      rootPids: [100, 200],
      now: DEV_SERVER_SAMPLE_INTERVAL_MS,
      snapshot,
      cpuCount: 2,
      dyadPid: 1,
    };
    getDevServerMemorySample(input);
    await flush();
    // pid 200 is new since the baseline, so all 0 of its seconds count.
    expect(getDevServerMemorySample(input)).toMatchObject({
      count: 2,
      cpuSharePct: 10,
      maxCpuSharePct: 10,
    });
  });
});
