import { describe, it, expect } from "vitest";
import {
  cpuSharesBetween,
  parsePsCpuTime,
  type CpuTimeSnapshot,
  type ProcessCpuTime,
} from "@/utils/process_cpu";

function snapshot(
  takenAt: number,
  processes: Record<string, ProcessCpuTime>,
): CpuTimeSnapshot {
  return { takenAt, processes: new Map(Object.entries(processes)) };
}

describe("cpuSharesBetween", () => {
  it("reports each process as a share of the whole machine", () => {
    // 30s on 4 CPUs is 120 CPU-seconds of capacity.
    const shares = cpuSharesBetween(
      snapshot(0, { busy: { cpuSeconds: 10 }, idle: { cpuSeconds: 5 } }),
      snapshot(30_000, { busy: { cpuSeconds: 70 }, idle: { cpuSeconds: 5 } }),
      4,
    );
    expect(shares.get("busy")).toBeCloseTo(50);
    expect(shares.get("idle")).toBe(0);
  });

  it("counts all CPU time of a process that started in the window", () => {
    const shares = cpuSharesBetween(
      snapshot(0, {}),
      snapshot(10_000, {
        unknownStart: { cpuSeconds: 2 },
        startedAfter: { cpuSeconds: 3, startedAt: 5_000 },
      }),
      1,
    );
    expect(shares.get("unknownStart")).toBeCloseTo(20);
    expect(shares.get("startedAfter")).toBeCloseTo(30);
  });

  it("leaves out a process that was already running but has no baseline", () => {
    // Its lifetime CPU time would otherwise land in a 10s window.
    const shares = cpuSharesBetween(
      snapshot(10_000, {}),
      snapshot(20_000, { old: { cpuSeconds: 3_600, startedAt: 0 } }),
      8,
    );
    expect(shares.has("old")).toBe(false);
  });

  it("treats a count that went backwards as a reused pid", () => {
    const shares = cpuSharesBetween(
      snapshot(0, { "42": { cpuSeconds: 500 } }),
      snapshot(10_000, { "42": { cpuSeconds: 1 } }),
      1,
    );
    expect(shares.get("42")).toBeCloseTo(10);
  });

  it("returns nothing for an empty or backwards window", () => {
    const reading = snapshot(1_000, { a: { cpuSeconds: 1 } });
    expect(cpuSharesBetween(reading, reading, 4).size).toBe(0);
    expect(
      cpuSharesBetween(reading, snapshot(0, { a: { cpuSeconds: 2 } }), 4).size,
    ).toBe(0);
  });
});

describe("parsePsCpuTime", () => {
  it("parses the Linux format", () => {
    expect(parsePsCpuTime("00:00:07")).toBe(7);
    expect(parsePsCpuTime("01:02:03")).toBe(3_723);
    expect(parsePsCpuTime("2-00:00:01")).toBe(172_801);
  });

  it("parses the macOS format", () => {
    expect(parsePsCpuTime("0:00.03")).toBeCloseTo(0.03);
    expect(parsePsCpuTime("12:34.56")).toBeCloseTo(754.56);
    // Minutes are not wrapped into hours.
    expect(parsePsCpuTime("125:00.00")).toBe(7_500);
  });

  it("rejects anything else", () => {
    expect(parsePsCpuTime("TIME")).toBeNull();
    expect(parsePsCpuTime("")).toBeNull();
    expect(parsePsCpuTime("1:2:3:4")).toBeNull();
  });
});
