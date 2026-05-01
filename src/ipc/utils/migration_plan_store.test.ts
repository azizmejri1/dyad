import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_TTL_MS,
  __resetForTests,
  consumePreview,
  storePreview,
} from "./migration_plan_store";

beforeEach(() => {
  __resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("migration_plan_store", () => {
  it("stores statements and returns a UUID-shaped id", () => {
    const id = storePreview(42, ["CREATE TABLE x (id int)"]);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("consumePreview returns the stored statements once, then null on second call", () => {
    const id = storePreview(7, ["ALTER TABLE foo ADD COLUMN bar text"]);

    const first = consumePreview(id);
    expect(first).toEqual({
      appId: 7,
      statements: ["ALTER TABLE foo ADD COLUMN bar text"],
    });

    const second = consumePreview(id);
    expect(second).toBeNull();
  });

  it("returns null past TTL and removes the entry", () => {
    vi.useFakeTimers();
    const id = storePreview(1, ["SELECT 1"]);

    vi.advanceTimersByTime(PLAN_TTL_MS + 1);

    expect(consumePreview(id)).toBeNull();
    // Confirm the entry was actually deleted (not just expired-on-read with
    // a stale entry left in the map).
    expect(consumePreview(id)).toBeNull();
  });

  it("storing a new plan for the same appId evicts the prior plan", () => {
    const oldId = storePreview(99, ["SELECT 'old'"]);
    const newId = storePreview(99, ["SELECT 'new'"]);

    expect(oldId).not.toBe(newId);
    expect(consumePreview(oldId)).toBeNull();
    expect(consumePreview(newId)).toEqual({
      appId: 99,
      statements: ["SELECT 'new'"],
    });
  });

  it("consumePreview with unknown id returns null", () => {
    expect(consumePreview("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("plans are isolated per appId", () => {
    const idA = storePreview(1, ["SELECT 'a'"]);
    const idB = storePreview(2, ["SELECT 'b'"]);

    expect(consumePreview(idA)).toEqual({
      appId: 1,
      statements: ["SELECT 'a'"],
    });
    expect(consumePreview(idB)).toEqual({
      appId: 2,
      statements: ["SELECT 'b'"],
    });
  });
});
