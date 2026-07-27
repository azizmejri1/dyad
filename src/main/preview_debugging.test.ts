import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appendSwitch = vi.fn();
vi.mock("electron", () => ({
  app: {
    commandLine: {
      appendSwitch: (...args: unknown[]) => appendSwitch(...args),
    },
  },
}));

import {
  enablePreviewDebuggingPort,
  getPreviewCdpEndpoint,
  isPreviewDebuggingEnabled,
  readPreviewPanelE2EFlagPreReady,
  resetPreviewDebuggingForTests,
  setPreviewDebuggingEnabledForTests,
} from "./preview_debugging";

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "dyad-preview-debug-"));
  appendSwitch.mockClear();
  resetPreviewDebuggingForTests();
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

function writeSettings(contents: string) {
  fs.writeFileSync(path.join(userData, "user-settings.json"), contents);
}

describe("readPreviewPanelE2EFlagPreReady", () => {
  it("is off when there is no settings file", () => {
    expect(readPreviewPanelE2EFlagPreReady(userData)).toBe(false);
  });

  it("is off when the settings file is malformed", () => {
    writeSettings("{ not json");
    expect(readPreviewPanelE2EFlagPreReady(userData)).toBe(false);
  });

  it("is off when the flag is absent or not exactly true", () => {
    writeSettings(JSON.stringify({ selectedTemplateId: "react" }));
    expect(readPreviewPanelE2EFlagPreReady(userData)).toBe(false);
    writeSettings(JSON.stringify({ enablePreviewPanelE2E: "yes" }));
    expect(readPreviewPanelE2EFlagPreReady(userData)).toBe(false);
  });

  it("is on when the flag is true", () => {
    writeSettings(JSON.stringify({ enablePreviewPanelE2E: true }));
    expect(readPreviewPanelE2EFlagPreReady(userData)).toBe(true);
  });
});

describe("enablePreviewDebuggingPort", () => {
  it("does not open a debugging port when the experiment is off", () => {
    writeSettings(JSON.stringify({ enablePreviewPanelE2E: false }));
    expect(enablePreviewDebuggingPort(userData)).toBe(false);
    expect(appendSwitch).not.toHaveBeenCalled();
    expect(isPreviewDebuggingEnabled()).toBe(false);
  });

  it("opens an ephemeral port when the experiment is on", () => {
    writeSettings(JSON.stringify({ enablePreviewPanelE2E: true }));
    expect(enablePreviewDebuggingPort(userData)).toBe(true);
    // Port 0 = let the OS pick, so we never collide with a real Chrome on
    // 9222 and the port is not guessable.
    expect(appendSwitch).toHaveBeenCalledWith("remote-debugging-port", "0");
    expect(isPreviewDebuggingEnabled()).toBe(true);
  });

  it("removes a stale port file so it cannot be read as this run's port", () => {
    const portFile = path.join(userData, "DevToolsActivePort");
    fs.writeFileSync(portFile, "12345\n/devtools/browser/old\n");
    writeSettings(JSON.stringify({ enablePreviewPanelE2E: true }));
    enablePreviewDebuggingPort(userData);
    expect(fs.existsSync(portFile)).toBe(false);
  });
});

describe("getPreviewCdpEndpoint", () => {
  it("is null when debugging was never enabled, even if a port file exists", () => {
    fs.writeFileSync(
      path.join(userData, "DevToolsActivePort"),
      "42031\n/devtools/browser/abc\n",
    );
    expect(getPreviewCdpEndpoint(userData)).toBeNull();
  });

  it("is null before Chromium has written the port file", () => {
    setPreviewDebuggingEnabledForTests(true);
    expect(getPreviewCdpEndpoint(userData)).toBeNull();
  });

  it("reads the port Chromium actually bound", () => {
    setPreviewDebuggingEnabledForTests(true);
    fs.writeFileSync(
      path.join(userData, "DevToolsActivePort"),
      "42031\n/devtools/browser/abc\n",
    );
    expect(getPreviewCdpEndpoint(userData)).toBe("http://127.0.0.1:42031");
  });

  it("is null when the port file is not a port", () => {
    setPreviewDebuggingEnabledForTests(true);
    fs.writeFileSync(path.join(userData, "DevToolsActivePort"), "nope\n");
    expect(getPreviewCdpEndpoint(userData)).toBeNull();
  });
});
