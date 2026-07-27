import { describe, expect, it } from "vitest";
import { VALID_INVOKE_CHANNELS, VALID_RECEIVE_CHANNELS } from "./channels";
import { previewViewContracts, previewViewEvents } from "../types/preview_view";
import { ipc } from "../types";

/**
 * The preload allowlist is the difference between the preview view working and
 * the panel silently rendering an empty placeholder: an unlisted channel makes
 * every `ipc.previewView.*` call reject in the renderer, with no native view
 * ever created and nothing on screen to explain it.
 */
describe("preview view preload channels", () => {
  it("allows every preview-view invoke channel", () => {
    for (const contract of Object.values(previewViewContracts)) {
      expect(VALID_INVOKE_CHANNELS as readonly string[]).toContain(
        contract.channel,
      );
    }
  });

  it("allows the preview-view event channel", () => {
    for (const event of Object.values(previewViewEvents)) {
      expect(VALID_RECEIVE_CHANNELS as readonly string[]).toContain(
        event.channel,
      );
    }
  });

  it("exposes the client on the ipc namespace the panel calls through", () => {
    // Forgetting the namespace entry is the other way this feature does
    // nothing visible: the panel renders its placeholder and every sync call
    // throws on an undefined method.
    expect(typeof ipc.previewView.syncPreviewView).toBe("function");
    expect(typeof ipc.previewView.setPreviewViewVisible).toBe("function");
    expect(typeof ipc.previewView.releasePreviewView).toBe("function");
    expect(typeof ipc.previewView.getPreviewViewStatus).toBe("function");
    expect(typeof ipc.events.previewView.onEvent).toBe("function");
  });
});
