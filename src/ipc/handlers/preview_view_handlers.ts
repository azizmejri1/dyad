import log from "electron-log";
import { createTypedHandler } from "./base";
import { previewViewContracts } from "../types/preview_view";
import {
  destroyPreviewView,
  setPreviewViewVisible,
  syncPreviewView,
} from "@/main/preview_web_contents_view";
import { readSettings } from "@/main/settings";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("preview_view_handlers");

export function registerPreviewViewHandlers() {
  createTypedHandler(
    previewViewContracts.syncPreviewView,
    async (event, params) => {
      // The renderer already gates on this, but the native view (and the
      // debugging port it exists to expose) must never be reachable when the
      // experiment is off.
      if (!readSettings().enablePreviewPanelE2E) {
        throw new DyadError(
          "The preview-panel E2E experiment is not enabled.",
          DyadErrorKind.Precondition,
        );
      }
      syncPreviewView({ ...params, sender: event.sender });
      return { ok: true as const };
    },
  );

  createTypedHandler(
    previewViewContracts.setPreviewViewVisible,
    async (_event, params) => {
      setPreviewViewVisible(params.appId, params.visible);
      return { ok: true as const };
    },
  );

  createTypedHandler(
    previewViewContracts.releasePreviewView,
    async (_event, params) => {
      destroyPreviewView(params.appId);
      return { ok: true as const };
    },
  );

  logger.debug("Registered preview view IPC handlers");
}
