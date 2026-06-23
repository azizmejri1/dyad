import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/ipc/handlers/tests_handlers", () => ({
  runAppTestsCore: vi.fn(),
}));

import { runTestTool } from "./run_test";
import { runAppTestsCore } from "@/ipc/handlers/tests_handlers";

const mockedRun = vi.mocked(runAppTestsCore);

function ctx() {
  return {
    appId: 42,
    onXmlStream: vi.fn(),
    onXmlComplete: vi.fn(),
  } as any;
}

describe("runTestTool", () => {
  beforeEach(() => {
    mockedRun.mockReset();
  });

  it("is a run-only tool (does not modify state)", () => {
    expect(runTestTool.modifiesState).toBe(false);
  });

  it("normalizes and forwards the test path to runAppTestsCore", async () => {
    mockedRun.mockResolvedValue({
      appId: 42,
      results: [{ file: "tests/a.spec.ts", status: "passed", durationMs: 1200 }],
    });
    await runTestTool.execute({ path: "a.spec.ts" }, ctx());
    expect(mockedRun).toHaveBeenCalledWith({
      appId: 42,
      testFile: "tests/a.spec.ts",
    });
  });

  it("runs all tests when no path is given", async () => {
    mockedRun.mockResolvedValue({ appId: 42, results: [] });
    await runTestTool.execute({}, ctx());
    expect(mockedRun).toHaveBeenCalledWith({ appId: 42, testFile: undefined });
  });

  it("reports an infra error as un-runnable", async () => {
    mockedRun.mockResolvedValue({
      appId: 42,
      results: [],
      infraError: { message: "dev server isn't running" },
    });
    const result = await runTestTool.execute({ path: "tests/a.spec.ts" }, ctx());
    expect(result).toContain("could not be run");
    expect(result).toContain("dev server isn't running");
  });

  it("summarizes a passing run", async () => {
    mockedRun.mockResolvedValue({
      appId: 42,
      results: [
        { file: "tests/a.spec.ts", status: "passed", durationMs: 1000 },
      ],
    });
    const result = await runTestTool.execute({ path: "tests/a.spec.ts" }, ctx());
    expect(result).toContain("All 1 test(s) passed.");
    expect(result).toContain("tests/a.spec.ts: PASSED");
  });

  it("summarizes failures with error text", async () => {
    mockedRun.mockResolvedValue({
      appId: 42,
      results: [
        { file: "tests/a.spec.ts", status: "passed" },
        {
          file: "tests/b.spec.ts",
          status: "failed",
          error: "expected button to be visible",
        },
      ],
    });
    const result = await runTestTool.execute({}, ctx());
    expect(result).toContain("1 of 2 test(s) passed.");
    expect(result).toContain("tests/b.spec.ts: FAILED");
    expect(result).toContain("expected button to be visible");
  });
});
