import { atom } from "jotai";

// Define atom for tracking the last log timestamp per project (for incremental log loading)
export const lastLogTimestampAtom = atom<Record<string, number>>({});

/**
 * Apps where the user dismissed the offer to switch off the legacy Supabase
 * key. Session-scoped: the key is still legacy next launch, and the offer is
 * worth making again rather than silently dropping.
 */
export const dismissedLegacySupabaseKeyAppIdsAtom = atom<Set<number>>(
  new Set<number>(),
);
