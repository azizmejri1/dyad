import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import log from "electron-log";
import {
  findPreviewTarget,
  parseDevToolsActivePort,
  type DevToolsEndpoint,
  type TargetDescription,
} from "./preview_devtools_endpoint";
import { PreviewCdpProxy, type CdpInputEvent } from "./preview_cdp_proxy";

const logger = log.scope("preview_test_window");

/**
 * Hosts the app under test in a hidden BrowserWindow.
 *
 * This is the whole reason the E2E story works: a separate BrowserWindow is a
 * separate WebContents, which Chromium exposes as a CDP target of type "page" —
 * and Playwright promotes exactly those into `Page` objects. An iframe is only a
 * Frame of Dyad's renderer, so `page.goto` and friends could never address it.
 *
 * Hidden rather than composited into the panel: the panel shows a screencast of
 * this window, which keeps the live preview iframe mounted and lets every Dyad
 * overlay keep painting normally.
 */

/**
 * Opens Chromium's debugging port on an ephemeral port. Must run before the app
 * is ready — command-line switches are read at browser-process startup.
 */
export function enablePreviewDebugging(): void {
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  // Bind explicitly so the port is never exposed off the loopback interface.
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

function readDevToolsEndpoint(): DevToolsEndpoint | null {
  try {
    const file = path.join(app.getPath("userData"), "DevToolsActivePort");
    return parseDevToolsActivePort(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function fetchTargets(port: number): Promise<TargetDescription[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets: unknown = await response.json();
  return Array.isArray(targets) ? (targets as TargetDescription[]) : [];
}

/** Polls /json/list until the preview page registers, or the deadline passes. */
async function waitForPreviewTarget(
  port: number,
  previewUrl: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const id = findPreviewTarget(await fetchTargets(port), previewUrl);
      if (id) return id;
    } catch {
      // Port not answering yet; fall through to the retry delay.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

export interface PreviewTestSession {
  /** Endpoint to hand the test process as DYAD_CDP_ENDPOINT. */
  cdpEndpoint: string;
  webContentsId: number;
  window: BrowserWindow;
  dispose(): Promise<void>;
}

export interface StartPreviewTestSessionOptions {
  previewUrl: string;
  width?: number;
  height?: number;
  onInputEvent?: (event: CdpInputEvent) => void | Promise<void>;
}

/**
 * Brings up the hidden window, waits for it to appear as a CDP target, and
 * fronts it with the filtering proxy. Returns null when debugging is
 * unavailable — the caller falls back to launching a browser the old way rather
 * than failing the run.
 */
export async function startPreviewTestSession(
  options: StartPreviewTestSessionOptions,
): Promise<PreviewTestSession | null> {
  const endpoint = readDevToolsEndpoint();
  if (!endpoint) {
    logger.warn("No DevToolsActivePort; Watch-in-Dyad is unavailable.");
    return null;
  }

  const window = new BrowserWindow({
    show: false,
    width: options.width ?? 1280,
    height: options.height ?? 800,
    webPreferences: {
      // The app under test is untrusted user code; keep it out of Node.
      nodeIntegration: false,
      contextIsolation: true,
      // A hidden window is throttled by default, which would stall both the
      // screencast and the app's own timers mid-test.
      backgroundThrottling: false,
    },
  });

  try {
    await window.loadURL(options.previewUrl);
    const targetId = await waitForPreviewTarget(
      endpoint.port,
      options.previewUrl,
    );
    if (!targetId) {
      logger.warn(`Preview target never appeared for ${options.previewUrl}`);
      window.destroy();
      return null;
    }

    const proxy = new PreviewCdpProxy({
      browserWsEndpoint: endpoint.browserWsEndpoint,
      allowedTargetId: targetId,
      ...(options.onInputEvent ? { onInputEvent: options.onInputEvent } : {}),
    });
    const cdpEndpoint = await proxy.start();

    return {
      cdpEndpoint,
      webContentsId: window.webContents.id,
      window,
      async dispose() {
        await proxy.stop();
        if (!window.isDestroyed()) window.destroy();
      },
    };
  } catch (error) {
    logger.error("Failed to start preview test session", error);
    if (!window.isDestroyed()) window.destroy();
    return null;
  }
}
