import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";

const { getAppMetrics, writeSettings } = vi.hoisted(() => ({
  getAppMetrics: vi.fn(),
  writeSettings: vi.fn(),
}));

// One product window: its main frame runs in pid 200 (Dyad's UI) and an
// out-of-process preview iframe runs in pid 300.
vi.mock("electron", () => ({
  app: { getAppMetrics },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          id: 1,
          isDestroyed: () => false,
          getOSProcessId: () => 200,
          mainFrame: {
            framesInSubtree: [{ osProcessId: 200 }, { osProcessId: 300 }],
          },
        },
      },
    ],
  },
}));
vi.mock("../main/settings", () => ({ writeSettings }));
vi.mock("./memory_activity", () => ({ isExtractCodebaseActive: () => false }));
vi.mock("../ipc/handlers/chat_stream_handlers", () => ({
  getActiveStreamCount: () => 0,
}));
vi.mock("../ipc/utils/process_manager", () => ({
  getRunningAppProcessPids: () => [],
  runningApps: new Map(),
}));
vi.mock("../ipc/processors/typescript_utility_process_scheduler", () => ({
  typescriptUtilityProcessScheduler: { activeOperationKind: () => null },
}));
vi.mock("../paths/paths", () => ({ getUserDataPath: () => "/tmp" }));
vi.mock("./disk_usage", () => ({ getDiskUsageMB: () => null }));
vi.mock("./system_commit_info", () => ({ getSystemCommitInfoMB: () => null }));
vi.mock("./windows_pagefile", () => ({
  getCachedPagefileSettings: () => null,
}));
vi.mock("./renderer_heap_reports", () => ({
  getLatestRendererHeapReport: () => null,
}));
vi.mock("./dev_server_memory", () => ({
  getDevServerMemorySample: () => null,
}));
vi.mock("../main/preview_web_contents_view", () => ({
  getPreviewViewOSProcessIds: () => [],
}));

import {
  startPerformanceMonitoring,
  stopPerformanceMonitoring,
} from "@/utils/performance_monitor";

function metric(
  type: string,
  pid: number,
  cumulativeCPUUsage: number | undefined,
) {
  return {
    type,
    pid,
    creationTime: 0,
    cpu: { cumulativeCPUUsage, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 1024, peakWorkingSetSize: 1024 },
  };
}

// Four CPUs whose tick counters advance on every read, so the system CPU
// figure is defined from the second heartbeat on.
function mockFourCpus() {
  let ticks = 0;
  vi.spyOn(os, "cpus").mockImplementation(() => {
    ticks += 1000;
    return Array.from({ length: 4 }, () => ({
      model: "test",
      speed: 1000,
      times: { user: ticks, nice: 0, sys: 0, idle: ticks, irq: 0 },
    }));
  });
}

describe("performance monitor CPU attribution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    writeSettings.mockClear();
    mockFourCpus();
  });

  afterEach(() => {
    stopPerformanceMonitoring();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("splits CPU by process type and renderer as a share of the machine", () => {
    getAppMetrics.mockReturnValue([
      metric("Browser", 1, 10),
      metric("Tab", 200, 100),
      metric("Tab", 300, 50),
      metric("GPU", 400, 5),
      // No CPU time reported: left out rather than counted as zero.
      metric("Utility", 500, undefined),
    ]);
    startPerformanceMonitoring({ isProductWebContents: () => true });
    // The first heartbeat only sets the baselines.
    expect(writeSettings).not.toHaveBeenCalled();

    // 30s on 4 CPUs is 120 CPU-seconds of capacity.
    getAppMetrics.mockReturnValue([
      metric("Browser", 1, 11.2),
      metric("Tab", 200, 136),
      metric("Tab", 300, 62),
      metric("GPU", 400, 11),
      metric("Utility", 500, undefined),
    ]);
    vi.advanceTimersByTime(30_000);

    expect(writeSettings).toHaveBeenCalledTimes(1);
    const snapshot = writeSettings.mock.calls[0][0].lastKnownPerformance;
    expect(snapshot).toMatchObject({
      cpuCount: 4,
      processCpuSharePct: { browser: 1, tab: 40, gpu: 5 },
      uiRendererCpuSharePct: 30,
      previewRendererCpuSharePct: 10,
    });
    expect(snapshot.processCpuSharePct).not.toHaveProperty("utility");

    // The final capture on stop lands in the same instant: no time has
    // passed, so there is no CPU figure rather than an empty one.
    stopPerformanceMonitoring();
    expect(writeSettings).toHaveBeenCalledTimes(2);
    const final = writeSettings.mock.calls[1][0].lastKnownPerformance;
    expect(final).not.toHaveProperty("processCpuSharePct");
    expect(final).not.toHaveProperty("uiRendererCpuSharePct");
  });
});
