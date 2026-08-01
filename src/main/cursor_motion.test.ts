import { describe, expect, it } from "vitest";
import {
  easeOutCubic,
  holdDurationMs,
  interpolate,
  MAX_TRAVEL_MS,
  MIN_TRAVEL_MS,
  SETTLE_MS,
  travelDurationMs,
} from "./cursor_motion";
import { HOLD_CEILING_MS } from "./preview_cdp_proxy";

const origin = { x: 0, y: 0 };

describe("travelDurationMs", () => {
  it("scales with distance", () => {
    const near = travelDurationMs(origin, { x: 40, y: 0 });
    const far = travelDurationMs(origin, { x: 400, y: 0 });
    expect(far).toBeGreaterThan(near);
  });

  it("clamps both ends so hops are not sluggish nor sweeps teleported", () => {
    expect(travelDurationMs(origin, origin)).toBe(MIN_TRAVEL_MS);
    expect(travelDurationMs(origin, { x: 5000, y: 5000 })).toBe(MAX_TRAVEL_MS);
  });

  it("measures diagonal distance, not just an axis", () => {
    const diagonal = travelDurationMs(origin, { x: 300, y: 300 });
    const horizontal = travelDurationMs(origin, { x: 300, y: 0 });
    expect(diagonal).toBeGreaterThanOrEqual(horizontal);
  });
});

describe("holdDurationMs", () => {
  it("covers the glide plus the settle", () => {
    const to = { x: 200, y: 100 };
    expect(holdDurationMs(origin, to)).toBe(
      travelDurationMs(origin, to) + SETTLE_MS,
    );
  });

  it("never exceeds the proxy's hold ceiling", () => {
    // If it could, a long sweep would be silently truncated by the proxy and
    // the click would land before the cursor arrived anyway.
    expect(MAX_TRAVEL_MS + SETTLE_MS).toBeLessThanOrEqual(HOLD_CEILING_MS);
    expect(holdDurationMs(origin, { x: 9999, y: 9999 })).toBeLessThanOrEqual(
      HOLD_CEILING_MS,
    );
  });
});

describe("easeOutCubic", () => {
  it("pins both ends", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it("decelerates: past the midpoint by half the time", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it("clamps out-of-range input", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("interpolate", () => {
  it("starts at the origin and lands exactly on the target", () => {
    const to = { x: 100, y: 50 };
    expect(interpolate(origin, to, 0)).toEqual(origin);
    expect(interpolate(origin, to, 1)).toEqual(to);
  });

  it("moves monotonically toward the target", () => {
    const to = { x: 100, y: 0 };
    const samples = [0, 0.25, 0.5, 0.75, 1].map(
      (t) => interpolate(origin, to, t).x,
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThan(samples[i - 1]);
    }
  });
});
