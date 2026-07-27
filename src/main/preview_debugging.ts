import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import { app } from "electron";

const logger = log.scope("preview_debugging");

/**
 * Chromium writes this file into the user-data dir once the remote debugging
 * server is listening. Line 1 is the port it actually bound, line 2 the
 * browser-level DevTools path. With `--remote-debugging-port=0` it is the only
 * way to learn the ephemeral port.
 */
const DEVTOOLS_PORT_FILE = "DevToolsActivePort";

/** Env var the generated preview Playwright fixture reads. */
export const PREVIEW_CDP_ENDPOINT_ENV = "DYAD_PREVIEW_CDP_ENDPOINT";

let debuggingRequested = false;

/**
 * Reads the preview-panel E2E experiment flag straight off disk.
 *
 * `readSettings()` can decrypt secrets through `safeStorage`, which throws
 * before `app.whenReady()` — and the remote-debugging switch has to be appended
 * before then. So this deliberately does a raw, un-decrypted JSON read of the
 * one boolean it needs and treats any problem as "off".
 */
export function readPreviewPanelE2EFlagPreReady(userDataPath: string): boolean {
  try {
    const raw = fs.readFileSync(
      path.join(userDataPath, "user-settings.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { enablePreviewPanelE2E?: unknown };
    return parsed?.enablePreviewPanelE2E === true;
  } catch {
    // No settings file yet, unreadable, or malformed — the experiment is off.
    return false;
  }
}

/**
 * Opt into Chromium's remote debugging server so a Playwright run can attach to
 * the preview `WebContentsView` instead of launching its own browser.
 *
 * MUST be called before `app.whenReady()`; Chromium reads the switch during
 * startup and there is no runtime equivalent.
 *
 * Port `0` is deliberate: the OS picks a free port (no collision with a real
 * Chrome running `--remote-debugging-port=9222`, and no guessable port), and we
 * recover it from `DevToolsActivePort` when a test run needs it. Chromium binds
 * the debugging server to localhost only.
 */
export function enablePreviewDebuggingPort(userDataPath: string): boolean {
  if (!readPreviewPanelE2EFlagPreReady(userDataPath)) {
    return false;
  }
  // Stale file from a previous run would otherwise be read as this run's port.
  try {
    fs.rmSync(path.join(userDataPath, DEVTOOLS_PORT_FILE), { force: true });
  } catch {
    // Best effort; a stale read is caught by the connect attempt failing.
  }
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  debuggingRequested = true;
  logger.info(
    "Preview-panel E2E experiment is on: enabled remote debugging on an ephemeral localhost port",
  );
  return true;
}

/** Whether this process was started with the debugging port enabled. */
export function isPreviewDebuggingEnabled(): boolean {
  return debuggingRequested;
}

/**
 * The browser-level CDP endpoint for this process, or null when the experiment
 * is off or Chromium hasn't written the port file yet.
 */
export function getPreviewCdpEndpoint(userDataPath: string): string | null {
  if (!debuggingRequested) {
    return null;
  }
  try {
    const contents = fs.readFileSync(
      path.join(userDataPath, DEVTOOLS_PORT_FILE),
      "utf8",
    );
    const port = Number.parseInt(contents.split("\n")[0]!.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      return null;
    }
    return `http://127.0.0.1:${port}`;
  } catch (error) {
    logger.warn(`Could not read ${DEVTOOLS_PORT_FILE}: ${error}`);
    return null;
  }
}

/** Test seam: reset the module's memory of the startup switch. */
export function resetPreviewDebuggingForTests(): void {
  debuggingRequested = false;
}

/** Test seam: pretend the startup switch was appended. */
export function setPreviewDebuggingEnabledForTests(enabled: boolean): void {
  debuggingRequested = enabled;
}
