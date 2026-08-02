import fs from "node:fs";
import net from "node:net";
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
 * Port Chromium's debugging server was told to listen on. Chrome writes the
 * chosen port to a DevToolsActivePort file when asked for port 0; Electron does
 * not reliably do the same, so we pick a free port ourselves and remember it
 * rather than depending on that file existing.
 */
let debuggingPort: number | null = null;

/** Reserves a free loopback port by binding and immediately releasing it. */
function reserveLoopbackPort(): number | null {
  // Binding to port 0 makes the OS pick a free one; we close straight away and
  // hand the number to Chromium. The race window is tiny and the alternative
  // (a fixed port) collides between two running Dyad instances.
  const server = net.createServer();
  try {
    server.listen(0, "127.0.0.1");
    const address = server.address();
    return typeof address === "object" && address ? address.port : null;
  } catch {
    return null;
  } finally {
    server.close();
  }
}

/**
 * Opens Chromium's debugging port on loopback. Must run before the app is
 * ready — command-line switches are read at browser-process startup.
 */
export function enablePreviewDebugging(): void {
  const port = reserveLoopbackPort();
  if (port == null) {
    logger.warn("Could not reserve a debugging port; Watch-in-Dyad disabled.");
    return;
  }
  debuggingPort = port;
  app.commandLine.appendSwitch("remote-debugging-port", String(port));
  // Bind explicitly so the port is never exposed off the loopback interface.
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  logger.info(`Preview debugging port reserved on 127.0.0.1:${port}`);
}

/**
 * Resolves the browser-level WebSocket endpoint.
 *
 * Prefers asking the port directly (/json/version), which works regardless of
 * whether Electron writes a DevToolsActivePort file; falls back to that file
 * for the case where the port was assigned rather than reserved.
 */
async function readDevToolsEndpoint(): Promise<DevToolsEndpoint | null> {
  if (debuggingPort != null) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${debuggingPort}/json/version`,
      );
      const info = (await response.json()) as {
        webSocketDebuggerUrl?: string;
      };
      if (typeof info.webSocketDebuggerUrl === "string") {
        return {
          port: debuggingPort,
          browserWsEndpoint: info.webSocketDebuggerUrl,
        };
      }
      logger.warn("/json/version returned no webSocketDebuggerUrl");
    } catch (error) {
      logger.warn(`Debugging port ${debuggingPort} is not answering`, error);
    }
  }

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
  /**
   * Reports why the session could not start, in words meant for the test
   * output pane. Degrading to a normal run silently is what made the first two
   * attempts at this impossible to diagnose.
   */
  onDiagnostic?: (reason: string) => void;
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
  const fail = (reason: string): null => {
    logger.warn(`Watch-in-Dyad unavailable: ${reason}`);
    options.onDiagnostic?.(reason);
    return null;
  };

  const endpoint = await readDevToolsEndpoint();
  if (!endpoint) {
    return fail(
      debuggingPort == null
        ? "no debugging port was reserved at startup"
        : `Chromium's debugging port (${debuggingPort}) did not respond`,
    );
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
      window.destroy();
      return fail(
        `the preview page never registered as a CDP target for ${options.previewUrl}`,
      );
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
    return fail(error instanceof Error ? error.message : String(error));
  }
}
