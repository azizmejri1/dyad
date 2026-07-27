import { z } from "zod";
import {
  createClient,
  createEventClient,
  defineContract,
  defineEvent,
} from "../contracts/core";

// =============================================================================
// Preview WebContentsView (experimental)
//
// Behind the `enablePreviewPanelE2E` experiment, the preview panel renders the
// running app in a native Electron `WebContentsView` layered over the window
// instead of an `<iframe>`. The renderer still owns layout: it reports the
// rectangle its placeholder occupies and the main process positions the view
// there.
//
// The reason it is a `WebContentsView` and not an iframe: a view has its own
// `webContents`, so it shows up as a real CDP page target that a Playwright run
// can attach to. An iframe does not.
// =============================================================================

export const PreviewViewBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type PreviewViewBounds = z.infer<typeof PreviewViewBoundsSchema>;

export const SyncPreviewViewParamsSchema = z.object({
  appId: z.number(),
  /** Absolute http(s) URL of the running dev server. */
  url: z.string(),
  /** Placeholder rectangle in CSS pixels, relative to the window content. */
  bounds: PreviewViewBoundsSchema,
  /** False parks the view off-screen (panel hidden, annotator open, …). */
  visible: z.boolean(),
  /** Bump to force a reload of an unchanged URL. */
  reloadToken: z.number().optional(),
});

export const SetPreviewViewVisibleParamsSchema = z.object({
  appId: z.number(),
  visible: z.boolean(),
});

export const ReleasePreviewViewParamsSchema = z.object({
  appId: z.number(),
});

// =============================================================================
// Events (main -> renderer)
// =============================================================================

/**
 * The view's lifecycle, mirrored back to the renderer. With an iframe the
 * renderer observed these directly (`onLoad`, `postMessage`); a native view has
 * no DOM handle, so main forwards them.
 */
export const PreviewViewEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ appId: z.number(), type: z.literal("loaded"), url: z.string() }),
  z.object({
    appId: z.number(),
    type: z.literal("navigated"),
    url: z.string(),
  }),
  z.object({
    appId: z.number(),
    type: z.literal("failed"),
    url: z.string(),
    message: z.string(),
  }),
  z.object({
    appId: z.number(),
    type: z.literal("console"),
    level: z.string(),
    message: z.string(),
  }),
]);
export type PreviewViewEventPayload = z.infer<
  typeof PreviewViewEventPayloadSchema
>;

// =============================================================================
// Contracts
// =============================================================================

export const previewViewContracts = {
  syncPreviewView: defineContract({
    channel: "preview-view:sync",
    input: SyncPreviewViewParamsSchema,
    output: z.object({ ok: z.literal(true) }),
  }),
  /**
   * Park or restore the view without discarding the page. The preview panel
   * unmounts on every tab switch; releasing there would reload the app each
   * time and delete the CDP target a test run attaches to.
   */
  setPreviewViewVisible: defineContract({
    channel: "preview-view:set-visible",
    input: SetPreviewViewVisibleParamsSchema,
    output: z.object({ ok: z.literal(true) }),
  }),
  releasePreviewView: defineContract({
    channel: "preview-view:release",
    input: ReleasePreviewViewParamsSchema,
    output: z.object({ ok: z.literal(true) }),
  }),
} as const;

export const previewViewEvents = {
  event: defineEvent({
    channel: "preview-view:event",
    payload: PreviewViewEventPayloadSchema,
  }),
} as const;

export const previewViewClient = createClient(previewViewContracts);
export const previewViewEventClient = createEventClient(previewViewEvents);
