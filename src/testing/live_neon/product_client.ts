// The Neon client Dyad's own code receives during a live run.
//
// Each live suite routes `getNeonClient` here with:
//
//   vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
//     (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
//       await importOriginal(),
//     ),
//   );
//
// This replaces production credential acquisition (OAuth tokens in settings,
// refresh) with an API key. OAuth login, callback, refresh and credential
// storage are therefore NOT covered by live runs and are reported as gaps.
import type { Api } from "@neondatabase/api-client";

interface Slot {
  client: () => Api<unknown>;
  orgId: () => string;
}

let slot: Slot | undefined;

export function setProductNeonClient(next: Slot | undefined): void {
  slot = next;
}

function current(): Slot {
  if (!slot) {
    throw new Error(
      "Live Neon product client is not installed; call setupLiveNeonHarness() first",
    );
  }
  return slot;
}

export function mockNeonManagementClient<T extends object>(actual: T): T {
  return {
    ...actual,
    getNeonClient: async () => current().client(),
    getNeonOrganizationId: async () => current().orgId(),
  };
}
