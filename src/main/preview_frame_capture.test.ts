import { describe, expect, it } from "vitest";
import {
  capturePreviewFrame,
  type CapturableContents,
} from "./preview_frame_capture";

function contents(overrides: {
  destroyed?: boolean;
  empty?: boolean;
  size?: { width: number; height: number };
  throws?: boolean;
}): CapturableContents {
  return {
    isDestroyed: () => overrides.destroyed ?? false,
    capturePage: async () => {
      if (overrides.throws) throw new Error("capture failed");
      return {
        isEmpty: () => overrides.empty ?? false,
        getSize: () => overrides.size ?? { width: 375, height: 812 },
        toDataURL: () => "data:image/png;base64,AAAA",
      };
    },
  };
}

describe("capturePreviewFrame", () => {
  it("returns the frame and its dimensions", async () => {
    expect(await capturePreviewFrame(contents({}))).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
      width: 375,
      height: 812,
    });
  });

  it("returns null for a destroyed surface without capturing", async () => {
    expect(await capturePreviewFrame(contents({ destroyed: true }))).toBeNull();
  });

  it("returns null when nothing has painted yet", async () => {
    expect(await capturePreviewFrame(contents({ empty: true }))).toBeNull();
  });

  it("treats a zero-sized frame as no frame", async () => {
    const zeroWidth = contents({ size: { width: 0, height: 812 } });
    expect(await capturePreviewFrame(zeroWidth)).toBeNull();
  });

  it("swallows capture failures so callers keep their current frame", async () => {
    expect(await capturePreviewFrame(contents({ throws: true }))).toBeNull();
  });

  it("returns null when there is no surface at all", async () => {
    expect(await capturePreviewFrame(null)).toBeNull();
  });
});
