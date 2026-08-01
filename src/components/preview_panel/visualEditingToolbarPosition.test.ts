import { describe, expect, it } from "vitest";
import {
  positionVisualEditingToolbar,
  previewGutter,
} from "./visualEditingToolbarPosition";

const container = { width: 1000, height: 700 };
const toolbar = { width: 320, height: 44 };
const element = { top: 100, left: 40, width: 120, height: 30 };

describe("previewGutter", () => {
  it("is zero in desktop, where the preview fills the container", () => {
    expect(previewGutter(1000, null)).toBe(0);
  });

  it("centres a narrower device inside the container", () => {
    expect(previewGutter(1000, 375)).toBe(312.5);
    expect(previewGutter(1000, 768)).toBe(116);
  });

  it("never goes negative when the device is wider than the container", () => {
    expect(previewGutter(320, 768)).toBe(0);
  });
});

describe("positionVisualEditingToolbar", () => {
  it("sits just below the element in desktop", () => {
    const position = positionVisualEditingToolbar({
      coordinates: element,
      container,
      deviceWidth: null,
      toolbar,
    });
    expect(position).toEqual({ top: 134, left: 40, placement: "below" });
  });

  it("shifts by the gutter in mobile so it tracks its element", () => {
    // The bug this fixes: without the gutter the toolbar rendered 312.5px to
    // the left of the component it belonged to.
    const position = positionVisualEditingToolbar({
      coordinates: element,
      container,
      deviceWidth: 375,
      toolbar,
    });
    expect(position.left).toBe(40 + 312.5);
  });

  it("shifts by the gutter in tablet too", () => {
    const position = positionVisualEditingToolbar({
      coordinates: element,
      container,
      deviceWidth: 768,
      toolbar,
    });
    expect(position.left).toBe(40 + 116);
  });

  it("flips above the element rather than clipping below the fold", () => {
    const nearBottom = { ...element, top: 640 };
    const position = positionVisualEditingToolbar({
      coordinates: nearBottom,
      container,
      deviceWidth: null,
      toolbar,
    });
    expect(position.placement).toBe("above");
    expect(position.top).toBe(640 - 44 - 4);
    expect(position.top).toBeGreaterThanOrEqual(0);
  });

  it("keeps the toolbar inside the right edge", () => {
    const nearRight = { ...element, left: 960 };
    const position = positionVisualEditingToolbar({
      coordinates: nearRight,
      container,
      deviceWidth: null,
      toolbar,
    });
    expect(position.left + toolbar.width).toBeLessThanOrEqual(container.width);
  });

  it("keeps the toolbar inside the left edge", () => {
    const offLeft = { ...element, left: -50 };
    const position = positionVisualEditingToolbar({
      coordinates: offLeft,
      container,
      deviceWidth: null,
      toolbar,
    });
    expect(position.left).toBeGreaterThanOrEqual(0);
  });

  it("stays inside a container too small for either placement", () => {
    const tiny = { width: 400, height: 80 };
    const position = positionVisualEditingToolbar({
      coordinates: { top: 30, left: 10, width: 50, height: 20 },
      container: tiny,
      deviceWidth: null,
      toolbar,
    });
    expect(position.top).toBeGreaterThanOrEqual(0);
    expect(position.top + toolbar.height).toBeLessThanOrEqual(tiny.height);
  });

  it("never produces a NaN from a zero-sized container", () => {
    const position = positionVisualEditingToolbar({
      coordinates: element,
      container: { width: 0, height: 0 },
      deviceWidth: 375,
      toolbar,
    });
    expect(Number.isFinite(position.top)).toBe(true);
    expect(Number.isFinite(position.left)).toBe(true);
  });
});
