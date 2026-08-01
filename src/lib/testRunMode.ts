import { z } from "zod";

/**
 * Where a test run's browser lives.
 *
 * - `headless`  — no window at all. Fastest, and what CI does.
 * - `watch`     — Dyad's hidden preview window, screencast into the panel.
 * - `external`  — a real browser window, the pre-existing "headed" behaviour.
 *
 * `external` is retained deliberately: a user who wants to drive the browser
 * themselves should not lose that because Dyad grew a nicer default.
 */
export const TestRunModeSchema = z.enum(["headless", "watch", "external"]);
export type TestRunMode = z.infer<typeof TestRunModeSchema>;

export const TEST_RUN_MODES: readonly TestRunMode[] = [
  "headless",
  "watch",
  "external",
];

/**
 * Resolves the effective mode from settings.
 *
 * `testHeaded` predates this and is still what older builds and the agent's
 * run_tests tool write, so it is honoured when no explicit mode is stored:
 * a user who had "headed" on keeps getting a real window rather than being
 * silently moved onto the screencast.
 */
export function resolveTestRunMode(settings: {
  testRunMode?: TestRunMode | undefined;
  testHeaded?: boolean | undefined;
}): TestRunMode {
  if (settings.testRunMode) return settings.testRunMode;
  return settings.testHeaded ? "external" : "headless";
}

/** True when the run needs a browser window the user can see. */
export function isHeadedMode(mode: TestRunMode): boolean {
  return mode === "external";
}

/** True when Dyad drives its own preview WebContents for the run. */
export function usesDyadPreview(mode: TestRunMode): boolean {
  return mode === "watch";
}

export function nextTestRunMode(mode: TestRunMode): TestRunMode {
  return TEST_RUN_MODES[
    (TEST_RUN_MODES.indexOf(mode) + 1) % TEST_RUN_MODES.length
  ];
}

export function testRunModeLabel(mode: TestRunMode): string {
  switch (mode) {
    case "watch":
      return "Watch in Dyad";
    case "external":
      return "External window";
    default:
      return "Headless";
  }
}

export function testRunModeDescription(mode: TestRunMode): string {
  switch (mode) {
    case "watch":
      return "Tests run in Dyad's preview panel so you can watch them";
    case "external":
      return "Tests open a visible browser window";
    default:
      return "Tests run without a visible window";
  }
}
