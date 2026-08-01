/**
 * Places the visual-editing toolbar relative to the selected component.
 *
 * The subtlety is coordinate spaces. `coordinates` arrive from inside the
 * preview and are in the iframe's viewport space, but the toolbar is absolutely
 * positioned in the preview container. In tablet and mobile the iframe is a
 * fixed-width child centred by `flex justify-center` in a wider container, so
 * the two spaces differ by the gutter — which is why the toolbar used to sit
 * to the left of the element it belonged to in two of the three device modes.
 */

export interface ToolbarPositionInput {
  coordinates: { top: number; left: number; width: number; height: number };
  container: { width: number; height: number };
  /** Rendered width of the preview surface; null in desktop (fills container). */
  deviceWidth: number | null;
  toolbar: { width: number; height: number };
}

export interface ToolbarPosition {
  top: number;
  left: number;
  /** Which side of the element the toolbar ended up on. */
  placement: "below" | "above";
}

const GAP = 4;
const EDGE_MARGIN = 8;

/** Horizontal offset from the container's left edge to the preview's. */
export function previewGutter(
  containerWidth: number,
  deviceWidth: number | null,
): number {
  if (deviceWidth == null) return 0;
  return Math.max(0, (containerWidth - deviceWidth) / 2);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export function positionVisualEditingToolbar(
  input: ToolbarPositionInput,
): ToolbarPosition {
  const { coordinates, container, deviceWidth, toolbar } = input;
  const gutter = previewGutter(container.width, deviceWidth);

  const left = clamp(
    coordinates.left + gutter,
    EDGE_MARGIN,
    container.width - toolbar.width - EDGE_MARGIN,
  );

  // Prefer below the element. The container clips its overflow, so falling off
  // the bottom would hide the toolbar entirely rather than just look untidy.
  const below = coordinates.top + coordinates.height + GAP;
  const fitsBelow = below + toolbar.height + EDGE_MARGIN <= container.height;
  if (fitsBelow) return { top: below, left, placement: "below" };

  const above = coordinates.top - toolbar.height - GAP;
  if (above >= EDGE_MARGIN) return { top: above, left, placement: "above" };

  // Neither side fits: pin inside the container rather than clipping.
  return {
    top: clamp(
      below,
      EDGE_MARGIN,
      Math.max(EDGE_MARGIN, container.height - toolbar.height - EDGE_MARGIN),
    ),
    left,
    placement: "below",
  };
}
