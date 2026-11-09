// Crash probe for the campaign's cleanup machinery. The supervisor runs this
// file only in crash phases (DYAD_LIVE_NEON_CRASH_PROBE set) with its own
// journal, then invokes the cleanup-only command and checks that a sentinel
// project survived. The worker dies by SIGKILL, so no hook or teardown runs.
//
//   fixture         - test setup creates a project + branch, then the worker dies.
//   product-create  - Dyad's createProject is killed mid-provisioning (after the
//                     project and development branch exist, at the preview
//                     branch request), so Dyad never learns or links the ID.
import { describe, it, vi } from "vitest";

import { LIVE_ENV, liveNeonGate } from "./config";

vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
  (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
    await importOriginal<
      typeof import("@/neon_admin/neon_management_client")
    >(),
  ),
);

import { ipc } from "@/ipc/types";
import { crashNow } from "./faults";
import { setupLiveNeonHarness } from "./live_harness";

const gate = liveNeonGate();
const variant = process.env[LIVE_ENV.crashProbe];

describe.runIf(gate.enabled && !!variant)("live Neon crash probe", () => {
  it(`dies abruptly after remote creation (${variant})`, async () => {
    const live = await setupLiveNeonHarness({ suite: `crash-${variant}` });
    if (variant === "fixture") {
      await live.createFixtureProject("crash-fixture", { development: true });
      crashNow();
    } else if (variant === "product-create") {
      const { appId } = await live.createGitApp("crash-product");
      // createProject: POST /projects, POST branches (development), auth on
      // main and development, then POST branches (preview) <- die here.
      live.faults.add({
        id: "crash-at-preview-branch",
        transport: "management",
        method: "POST",
        path: /^\/projects\/[^/]+\/branches$/,
        skip: 1,
        action: { kind: "crash" },
      });
      await ipc.neon.createProject({
        name: live.projectName("crash-product"),
        appId,
      });
    } else {
      throw new Error(`unknown crash probe variant ${variant}`);
    }
    throw new Error("crash probe survived its crash point");
  }, 600_000);
});
