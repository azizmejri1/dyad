import { z } from "zod";
import {
  createClient,
  createEventClient,
  defineContract,
  defineEvent,
} from "../contracts/core";

// =============================================================================
// Tests Schemas
// =============================================================================

export const TestSpecSchema = z.object({
  /** Path relative to the app root, e.g. "tests/signup.spec.ts". */
  file: z.string(),
});
export type TestSpec = z.infer<typeof TestSpecSchema>;

/**
 * On-disk run statuses. "running"/"not-run" are UI-only and never returned
 * by the handler.
 */
export const TestRunStatusSchema = z.enum(["passed", "failed", "inconclusive"]);
export type TestRunStatus = z.infer<typeof TestRunStatusSchema>;

export const TestResultSchema = z.object({
  file: z.string(),
  status: TestRunStatusSchema,
  durationMs: z.number().optional(),
  /** Error text on failure (assertion or infra). */
  error: z.string().optional(),
  /** Best-effort absolute path to a failure screenshot. */
  screenshotPath: z.string().optional(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

// =============================================================================
// Recorded actions (preview "record a test" feature)
// =============================================================================

/**
 * A single user action captured while recording a flow in the preview. The
 * recorder captures *actions only* — the AI is responsible for turning these
 * into a Playwright test and adding assertions. `selector` holds robust locator
 * hints (in rough order of preference) so the AI can pick the best one.
 */
export const RecordedActionSchema = z.object({
  kind: z.enum(["click", "fill", "press", "navigate", "select", "check"]),
  selector: z
    .object({
      role: z.string().optional(),
      name: z.string().optional(),
      label: z.string().optional(),
      placeholder: z.string().optional(),
      text: z.string().optional(),
      testId: z.string().optional(),
      dyadId: z.string().optional(),
      dyadName: z.string().optional(),
      tag: z.string().optional(),
    })
    .optional(),
  /** For fill/select: the entered value. For press: the key. */
  value: z.string().optional(),
  /** For navigate: the destination URL (or path). */
  url: z.string().optional(),
  timestamp: z.number(),
});
export type RecordedAction = z.infer<typeof RecordedActionSchema>;

export const ListAppTestsParamsSchema = z.object({
  appId: z.number(),
});

export const ListAppTestsResultSchema = z.object({
  specs: z.array(TestSpecSchema),
});

export const RunAppTestsParamsSchema = z.object({
  appId: z.number(),
  /** When set, runs a single spec file (relative path); otherwise runs all. */
  testFile: z.string().optional(),
});

export const RunAppTestsResultSchema = z.object({
  appId: z.number(),
  results: z.array(TestResultSchema),
  /**
   * Set when the entire run failed before producing per-test results (e.g.
   * Playwright/browser missing and bootstrap declined, dev server down, spawn
   * error). Renders as an amber, panel-level "inconclusive" banner.
   */
  infraError: z
    .object({
      message: z.string(),
    })
    .optional(),
});
export type RunAppTestsResult = z.infer<typeof RunAppTestsResultSchema>;

export const StopAppTestsParamsSchema = z.object({
  appId: z.number(),
});

export const GetTestScreenshotParamsSchema = z.object({
  appId: z.number(),
  /** Absolute path to the screenshot, as reported by Playwright. */
  path: z.string(),
});

export const GetTestScreenshotResultSchema = z.object({
  /** PNG data URL, or null if unavailable. */
  dataUrl: z.string().nullable(),
});

// =============================================================================
// Tests Contracts
// =============================================================================

export const testsContracts = {
  listAppTests: defineContract({
    channel: "tests:list",
    input: ListAppTestsParamsSchema,
    output: ListAppTestsResultSchema,
  }),

  runAppTests: defineContract({
    channel: "tests:run",
    input: RunAppTestsParamsSchema,
    output: RunAppTestsResultSchema,
  }),

  stopAppTests: defineContract({
    channel: "tests:stop",
    input: StopAppTestsParamsSchema,
    output: z.object({ ok: z.literal(true) }),
  }),

  getTestScreenshot: defineContract({
    channel: "tests:screenshot",
    input: GetTestScreenshotParamsSchema,
    output: GetTestScreenshotResultSchema,
  }),
} as const;

// =============================================================================
// Tests Events (main -> renderer streamed output)
// =============================================================================

export const TestOutputPayloadSchema = z.object({
  appId: z.number(),
  /** A chunk of raw bootstrap/runner output. */
  chunk: z.string(),
  /** Phase the run is in, so the panel can switch between setup/running copy. */
  phase: z.enum(["setup", "running"]),
});
export type TestOutputPayload = z.infer<typeof TestOutputPayloadSchema>;

export const testsEvents = {
  output: defineEvent({
    channel: "tests:output",
    payload: TestOutputPayloadSchema,
  }),
} as const;

// =============================================================================
// Tests Client
// =============================================================================

export const testsClient = createClient(testsContracts);
export const testsEventClient = createEventClient(testsEvents);
