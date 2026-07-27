import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  debuggingEnabled: false,
  previewUrl: null as string | null,
  cdpEndpoint: null as string | null,
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/dyad-test-userdata" },
  BrowserWindow: class {},
  WebContentsView: class {},
}));

vi.mock("@/main/settings", () => ({
  readSettings: () => mocks.settings,
}));

vi.mock("@/main/preview_debugging", () => ({
  PREVIEW_CDP_ENDPOINT_ENV: "DYAD_PREVIEW_CDP_ENDPOINT",
  isPreviewDebuggingEnabled: () => mocks.debuggingEnabled,
  getPreviewCdpEndpoint: () => mocks.cdpEndpoint,
}));

vi.mock("@/main/preview_web_contents_view", () => ({
  getPreviewViewUrl: () => mocks.previewUrl,
  navigatePreviewView: vi.fn(),
}));

vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => "/tmp/dyad-test-userdata",
  getDyadAppPath: (p: string) => p,
}));

import { resolvePreviewRunEndpoint } from "./tests_handlers";

const BASE_URL = "http://localhost:32100";

beforeEach(() => {
  mocks.settings = { enablePreviewPanelE2E: true };
  mocks.debuggingEnabled = true;
  mocks.previewUrl = `${BASE_URL}/dashboard`;
  mocks.cdpEndpoint = "http://127.0.0.1:42031";
});

describe("resolvePreviewRunEndpoint", () => {
  it("selects preview-panel mode when everything lines up", () => {
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBe(
      "http://127.0.0.1:42031",
    );
  });

  // Each of these falls back to the normal launch mode. The experiment must
  // never be the reason a test run fails.
  it("falls back when the experiment is off", () => {
    mocks.settings = { enablePreviewPanelE2E: false };
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBeNull();
  });

  it("falls back when the process started without the debugging port", () => {
    // The switch is applied before app.whenReady(), so a mid-session toggle
    // leaves the setting on while the port is closed.
    mocks.debuggingEnabled = false;
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBeNull();
  });

  it("falls back when no preview view is live for the app", () => {
    mocks.previewUrl = null;
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBeNull();
  });

  it("falls back when the preview is showing a different origin", () => {
    // e.g. the user navigated the preview to an external site; that page is
    // not the app under test.
    mocks.previewUrl = "https://example.com/";
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBeNull();
  });

  it("falls back when the preview URL is not parseable", () => {
    mocks.previewUrl = "about:blank";
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBeNull();
  });

  it("falls back when Chromium has not published a port yet", () => {
    mocks.cdpEndpoint = null;
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBeNull();
  });

  it("matches on origin, not exact URL", () => {
    mocks.previewUrl = `${BASE_URL}/deep/route?q=1`;
    expect(resolvePreviewRunEndpoint(1, BASE_URL)).toBe(
      "http://127.0.0.1:42031",
    );
  });
});
