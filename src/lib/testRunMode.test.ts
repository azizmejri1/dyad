import { describe, expect, it } from "vitest";
import {
  isHeadedMode,
  nextTestRunMode,
  resolveTestRunMode,
  TEST_RUN_MODES,
  testRunModeLabel,
  usesDyadPreview,
} from "./testRunMode";

describe("resolveTestRunMode", () => {
  it("prefers an explicit mode", () => {
    expect(resolveTestRunMode({ testRunMode: "watch" })).toBe("watch");
    // An explicit mode wins even when the legacy flag disagrees.
    expect(
      resolveTestRunMode({ testRunMode: "headless", testHeaded: true }),
    ).toBe("headless");
  });

  it("keeps an existing headed user on a real window", () => {
    // Migrating them onto the screencast would silently change what they see.
    expect(resolveTestRunMode({ testHeaded: true })).toBe("external");
  });

  it("defaults to headless", () => {
    expect(resolveTestRunMode({})).toBe("headless");
    expect(resolveTestRunMode({ testHeaded: false })).toBe("headless");
  });
});

describe("mode predicates", () => {
  it("treats only external as headed", () => {
    expect(isHeadedMode("external")).toBe(true);
    expect(isHeadedMode("watch")).toBe(false);
    expect(isHeadedMode("headless")).toBe(false);
  });

  it("treats only watch as using Dyad's preview", () => {
    expect(usesDyadPreview("watch")).toBe(true);
    expect(usesDyadPreview("external")).toBe(false);
    expect(usesDyadPreview("headless")).toBe(false);
  });
});

describe("nextTestRunMode", () => {
  it("cycles through every mode and returns to the start", () => {
    let mode = TEST_RUN_MODES[0];
    const seen = [mode];
    for (let i = 0; i < TEST_RUN_MODES.length - 1; i++) {
      mode = nextTestRunMode(mode);
      seen.push(mode);
    }
    expect(new Set(seen).size).toBe(TEST_RUN_MODES.length);
    expect(nextTestRunMode(mode)).toBe(TEST_RUN_MODES[0]);
  });
});

describe("testRunModeLabel", () => {
  it("names every mode distinctly", () => {
    const labels = TEST_RUN_MODES.map(testRunModeLabel);
    expect(new Set(labels).size).toBe(TEST_RUN_MODES.length);
  });
});
