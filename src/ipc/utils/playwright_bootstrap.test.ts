import { describe, expect, it } from "vitest";
import {
  buildCursorFixtures,
  buildPlaywrightConfig,
  detectSystemBrowserChannel,
  TEST_BASE_URL_ENV,
  TEST_RESULTS_JSON,
} from "./playwright_bootstrap";

describe("buildPlaywrightConfig", () => {
  it("drives the system browser via channel when provided (no download)", () => {
    const config = buildPlaywrightConfig("chrome");
    expect(config).toContain('channel: "chrome"');
    expect(config).toContain("no extra browser download");
  });

  it("omits channel for bundled chromium", () => {
    const config = buildPlaywrightConfig(null);
    expect(config).not.toContain("channel:");
    expect(config).toContain("bundled Chromium");
  });

  it("wires baseURL from env and the json reporter output path", () => {
    const config = buildPlaywrightConfig(null);
    expect(config).toContain(`process.env.${TEST_BASE_URL_ENV}`);
    expect(config).toContain(TEST_RESULTS_JSON);
    // baseURL points at the running proxy, never a webServer config block.
    expect(config).not.toContain("webServer:");
  });

  it("records video on every run so tests are replayable", () => {
    expect(buildPlaywrightConfig(null)).toContain('video: "on"');
    expect(buildPlaywrightConfig("chrome")).toContain('video: "on"');
  });
});

describe("buildCursorFixtures", () => {
  it("re-exports test/expect and injects a cursor via addInitScript", () => {
    const source = buildCursorFixtures();
    expect(source).toContain('from "@playwright/test"');
    expect(source).toContain("export const test");
    expect(source).toContain("export { expect }");
    // Injects an init script that draws and moves a cursor dot.
    expect(source).toContain("addInitScript");
    expect(source).toContain("mousemove");
    expect(source).toContain("transition:left");
  });
});

describe("detectSystemBrowserChannel", () => {
  it("returns a supported channel or null", () => {
    const channel = detectSystemBrowserChannel();
    expect([null, "chrome", "msedge"]).toContain(channel);
  });
});
