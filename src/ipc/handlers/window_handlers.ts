import { BrowserWindow } from "electron";
import log from "electron-log";
import { platform } from "os";
import { createTypedHandler } from "./base";
import { systemContracts } from "../types/system";
import { getInitialLoadIsFirstSession } from "@/main/settings";
import { windowRegistry } from "@/window_infrastructure/main/window_registry";

const logger = log.scope("window-handlers");

export function registerWindowHandlers() {
  logger.debug("Registering window control handlers");

  createTypedHandler(systemContracts.minimizeWindow, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      logger.error("Failed to get BrowserWindow instance for minimize command");
      return;
    }
    window.minimize();
  });

  createTypedHandler(systemContracts.maximizeWindow, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      logger.error("Failed to get BrowserWindow instance for maximize command");
      return;
    }
    if (window.isMaximized()) {
      window.restore();
    } else {
      window.maximize();
    }
  });

  createTypedHandler(systemContracts.closeWindow, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      logger.error("Failed to get BrowserWindow instance for close command");
      return;
    }
    window.close();
  });

  createTypedHandler(systemContracts.focusWindow, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      logger.error("Failed to get BrowserWindow instance for focus command");
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show(); // Ensures window is visible on macOS
    window.focus();
  });

  createTypedHandler(systemContracts.getSystemPlatform, async () => {
    return platform();
  });

  createTypedHandler(
    systemContracts.getInitialLoadTelemetryContext,
    async (event) => {
      return {
        isFirstSession: getInitialLoadIsFirstSession(),
        // Registered product windows, not `BrowserWindow.getAllWindows()`,
        // which also counts preview popups — those hold no chats.
        openWindowCount: windowRegistry.liveEndpoints().length,
        // The renderer configures its own window session off the bootstrap
        // round trip, which can settle after this one; supplying the session
        // here lets the caller read its own tabs without racing that.
        windowSessionId: windowRegistry.ensureRegistered(event.sender),
      };
    },
  );
}
