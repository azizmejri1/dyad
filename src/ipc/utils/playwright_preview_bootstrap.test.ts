import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_RESULTS_JSON } from "./playwright_bootstrap";
import {
  buildPreviewConfig,
  buildPreviewFixture,
  buildPreviewTsconfig,
  PREVIEW_JSON_OUTPUT_NAME,
} from "./playwright_preview_bootstrap";

describe("preview-panel Playwright runner files", () => {
  it("aliases @playwright/test at the fixture so specs need no Dyad import", () => {
    const tsconfig = JSON.parse(buildPreviewTsconfig());
    expect(tsconfig.compilerOptions.paths["@playwright/test"]).toEqual([
      "./fixture.ts",
    ]);
    expect(buildPreviewConfig()).toContain('tsconfig: "./tsconfig.json"');
  });

  it("does not let the fixture alias itself", () => {
    const fixture = buildPreviewFixture();
    // The alias above rewrites "@playwright/test" in EVERY file the config
    // loads, this one included. Importing the same API under its other
    // specifier is what breaks the cycle.
    expect(fixture).not.toContain('from "@playwright/test"');
    expect(fixture).toContain('from "playwright/test"');
    expect(fixture).toContain('export * from "playwright/test"');
  });

  it("reads its endpoint and base URL from the env Dyad passes to the runner", () => {
    const fixture = buildPreviewFixture();
    expect(fixture).toContain("process.env.DYAD_PREVIEW_CDP_ENDPOINT");
    expect(fixture).toContain("process.env.DYAD_TEST_BASE_URL");
  });

  it("attaches to an existing browser rather than launching one", () => {
    const fixture = buildPreviewFixture();
    expect(fixture).toContain("chromium.connectOverCDP");
    expect(fixture).not.toContain("chromium.launch");
  });

  it("resolves relative navigations itself", () => {
    // A CDP-attached context has no `baseURL` option, so Playwright cannot
    // resolve `page.goto("/")` on its own the way it does for a launched
    // browser.
    const fixture = buildPreviewFixture();
    expect(fixture).toContain("page.goto =");
    expect(fixture).toContain("page.waitForURL =");
    // The preview Page outlives the test, so patching must be idempotent or
    // each test wraps the previous test's wrapper.
    expect(fixture).toContain("__dyadBaseUrlPatched");
  });

  it("never lets Playwright screenshot or trace the whole context", () => {
    // The attached context also holds Dyad's own window, so the context-wide
    // options would capture the user's chat and code — which the Tests panel
    // would show and the agent would upload to the model.
    const config = buildPreviewConfig();
    expect(config).toContain('screenshot: "off"');
    expect(config).toContain('trace: "off"');
  });

  it("attaches a failure screenshot of the preview page by path", () => {
    const fixture = buildPreviewFixture();
    expect(fixture).toContain("testInfo.status !== testInfo.expectedStatus");
    expect(fixture).toContain("page.screenshot({ path: file })");
    // By path, not by body: the JSON reporter inlines a body as base64 and
    // leaves `path` undefined, and Dyad's parser only reads attachments with a
    // path.
    expect(fixture).toContain('testInfo.attach("screenshot", {');
    expect(fixture).toContain("path: file,");
  });

  it("runs strictly serially against the single preview view", () => {
    const config = buildPreviewConfig();
    expect(config).toContain("workers: 1");
    expect(config).toContain("fullyParallel: false");
  });

  it("writes every artifact to the app's own test-results/", () => {
    // Playwright resolves reporter output and outputDir against the CONFIG's
    // directory, so the plain value would bury them in `.dyad-e2e/`: the run
    // would report "the test runner didn't produce a report", and screenshots
    // would fail `readTestScreenshotDataUrl`'s `test-results` segment check.
    expect(path.posix.normalize(`.dyad-e2e/${PREVIEW_JSON_OUTPUT_NAME}`)).toBe(
      TEST_RESULTS_JSON,
    );
    expect(buildPreviewConfig()).toContain('outputDir: "../test-results"');
  });

  it("targets the app's e2e-tests dir from inside .dyad-e2e/", () => {
    const config = buildPreviewConfig();
    expect(config).toContain('testDir: "../e2e-tests"');
    expect(config).toContain('outputFile: "../test-results/results.json"');
  });
});
