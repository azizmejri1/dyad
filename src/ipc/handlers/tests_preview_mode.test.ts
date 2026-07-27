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

import { resolvePreviewRunTarget } from "./tests_handlers";

const BASE_URL = "http://localhost:32100";

beforeEach(() => {
  mocks.settings = { enablePreviewPanelE2E: true };
  mocks.debuggingEnabled = true;
  mocks.previewUrl = `${BASE_URL}/dashboard`;
  mocks.cdpEndpoint = "http://127.0.0.1:42031";
});

describe("resolvePreviewRunTarget", () => {
  it("selects preview-panel mode when everything lines up", () => {
    expect(resolvePreviewRunTarget(1, BASE_URL)).toEqual({
      available: true,
      cdpEndpoint: "http://127.0.0.1:42031",
    });
  });

  it("matches on origin, not exact URL", () => {
    mocks.previewUrl = `${BASE_URL}/deep/route?q=1`;
    expect(resolvePreviewRunTarget(1, BASE_URL).available).toBe(true);
  });

  // Every fallback below is safe, but must never be silent: an unexplained
  // Chromium window is the symptom that makes this mode look broken.
  it("says nothing when the experiment is off", () => {
    mocks.settings = { enablePreviewPanelE2E: false };
    const target = resolvePreviewRunTarget(1, BASE_URL);
    expect(target).toMatchObject({
      available: false,
      experimentEnabled: false,
    });
  });

  it("explains that a mid-session toggle needs a restart", () => {
    // The debugging switch is applied before app.whenReady(), so enabling the
    // setting leaves the port closed until Dyad restarts.
    mocks.debuggingEnabled = false;
    const target = resolvePreviewRunTarget(1, BASE_URL);
    expect(target).toMatchObject({ available: false, experimentEnabled: true });
    expect(target).toHaveProperty("reason", expect.stringContaining("Restart"));
  });

  it("explains that no preview view is open", () => {
    mocks.previewUrl = null;
    const target = resolvePreviewRunTarget(1, BASE_URL);
    expect(target).toMatchObject({ available: false, experimentEnabled: true });
    expect(target).toHaveProperty(
      "reason",
      expect.stringContaining("Preview tab"),
    );
  });

  it("explains an origin mismatch, naming both origins", () => {
    mocks.previewUrl = "https://example.com/";
    const target = resolvePreviewRunTarget(1, BASE_URL);
    expect(target).toMatchObject({ available: false, experimentEnabled: true });
    expect(target).toHaveProperty(
      "reason",
      expect.stringContaining("https://example.com"),
    );
    expect(target).toHaveProperty("reason", expect.stringContaining(BASE_URL));
  });

  it("explains an unparseable preview URL", () => {
    mocks.previewUrl = "about:blank";
    const target = resolvePreviewRunTarget(1, BASE_URL);
    expect(target).toMatchObject({ available: false, experimentEnabled: true });
  });

  it("explains a missing published port", () => {
    mocks.cdpEndpoint = null;
    const target = resolvePreviewRunTarget(1, BASE_URL);
    expect(target).toMatchObject({ available: false, experimentEnabled: true });
    expect(target).toHaveProperty("reason", expect.stringContaining("Restart"));
  });
});
