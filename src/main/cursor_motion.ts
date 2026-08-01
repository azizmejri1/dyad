/**
 * Timing for the synthetic cursor.
 *
 * Playwright never moves the OS cursor — it synthesizes input straight into the
 * renderer and teleports to the element centre. The pointer a user sees is drawn
 * by Dyad, so its path is a dramatization: the page received one jump, not a
 * glide. That is fine, and deliberate (see the plan's D10) — but it means the
 * motion has to be paced to read as intentional rather than to be faithful to
 * anything.
 */

export const MIN_TRAVEL_MS = 90;
export const MAX_TRAVEL_MS = 320;
/** Beat between arriving and the click, so the two read as separate acts. */
export const SETTLE_MS = 55;

/**
 * Travel time from distance. A fixed duration makes short hops look sluggish and
 * long ones look teleported, so this scales with distance and then clamps.
 */
export function travelDurationMs(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const scaled = MIN_TRAVEL_MS + distance * 0.35;
  return Math.round(Math.min(MAX_TRAVEL_MS, Math.max(MIN_TRAVEL_MS, scaled)));
}

/**
 * Total time the proxy should hold a `mousePressed` frame: the glide plus the
 * settle. Without the hold the click lands before the cursor arrives and the
 * button appears to press itself.
 */
export function holdDurationMs(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number {
  return travelDurationMs(from, to) + SETTLE_MS;
}

/** Ease-out cubic: quick departure, soft arrival. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

export function interpolate(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const eased = easeOutCubic(t);
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
  };
}
