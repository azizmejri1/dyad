// Independent, provider-only checks of what Dyad did: branch trees, markers,
// endpoints, Auth. Uses its own journaled client (actor "verifier") so
// verification never shares state with the Dyad code under test.
import type { Api, Branch } from "@neondatabase/api-client";
import { neon } from "@neondatabase/serverless";
import { CAMPAIGN_LIMITS } from "./config";
import {
  branchExists,
  listBranches,
  projectExists,
  waitForOperations,
} from "./neon_ops";
import { retryOnLocked } from "@/ipc/utils/retryOnLocked";

export const TRUSTED_ORIGIN = "http://localhost:3999";
export const AUTH_PASSWORD = "Password123!x";

export interface BranchTreeEntry {
  name: string;
  parent: string | null;
}

export class NeonVerifier {
  constructor(readonly client: Api<unknown>) {}

  waitForOperations(
    projectId: string,
    options?: { since?: Date; timeoutMs?: number },
  ) {
    return waitForOperations(this.client, projectId, {
      timeoutMs: CAMPAIGN_LIMITS.providerReadinessMs,
      ...options,
    });
  }

  async branches(projectId: string): Promise<Branch[]> {
    await this.waitForOperations(projectId);
    return listBranches(this.client, projectId);
  }

  describeTree(list: Branch[]): BranchTreeEntry[] {
    const nameOf = (id?: string) =>
      id ? (list.find((b) => b.id === id)?.name ?? id) : null;
    return list
      .map((b) => ({ name: b.name, parent: nameOf(b.parent_id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async tree(projectId: string): Promise<BranchTreeEntry[]> {
    return this.describeTree(await this.branches(projectId));
  }

  projectExists(projectId: string) {
    return projectExists(this.client, projectId);
  }

  branchExists(projectId: string, branchId: string) {
    return branchExists(this.client, projectId, branchId);
  }

  async connectionUri(
    projectId: string,
    branchId: string,
    { pooled }: { pooled?: boolean } = {},
  ): Promise<string> {
    await this.waitForOperations(projectId);
    const [{ data: roles }, { data: dbs }] = await Promise.all([
      this.client.listProjectBranchRoles(projectId, branchId),
      this.client.listProjectBranchDatabases(projectId, branchId),
    ]);
    const role =
      roles.roles.find((r) => r.name === "neondb_owner") ??
      roles.roles.find((r) => !r.protected) ??
      roles.roles[0];
    const { data } = await this.client.getConnectionUri({
      projectId,
      branch_id: branchId,
      database_name: dbs.databases[0].name,
      role_name: role.name,
      ...(pooled !== undefined ? { pooled } : {}),
    });
    return data.uri;
  }

  /** Direct SQL on a branch, bypassing Dyad. */
  async sql(projectId: string, branchId: string) {
    return neon(await this.connectionUri(projectId, branchId));
  }

  /** Compute host of the branch's read-write endpoint (no `-pooler`). */
  async endpointHost(projectId: string, branchId: string): Promise<string> {
    const { data } = await this.client.listProjectBranchEndpoints(
      projectId,
      branchId,
    );
    const endpoint =
      data.endpoints.find((e) => e.type === "read_write") ?? data.endpoints[0];
    if (!endpoint) throw new Error(`branch ${branchId} has no endpoint`);
    return endpoint.host;
  }

  async authBaseUrl(projectId: string, branchId: string): Promise<string> {
    const { data } = await this.client.getNeonAuth(projectId, branchId);
    if (!data.base_url)
      throw new Error(`Neon Auth on branch ${branchId} has no base URL`);
    return data.base_url;
  }

  /** Better Auth email sign-up/sign-in as a browser app on TRUSTED_ORIGIN would. */
  async authRequest(
    projectId: string,
    branchId: string,
    route: "sign-up" | "sign-in",
    email: string,
  ): Promise<number> {
    const baseUrl = await this.authBaseUrl(projectId, branchId);
    await retryOnLocked(
      () =>
        this.client.addBranchNeonAuthTrustedDomain(projectId, branchId, {
          domain: TRUSTED_ORIGIN,
          auth_provider: "better_auth" as never,
        }),
      "live verifier trusted domain",
    ).catch(() => {
      // Already trusted.
    });
    const response = await fetch(`${baseUrl}/${route}/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TRUSTED_ORIGIN },
      body: JSON.stringify({ email, password: AUTH_PASSWORD, name: email }),
    });
    await response.arrayBuffer().catch(() => {});
    return response.status;
  }
}

/** Neon IDs look like `br-cool-river-a1b2c3d4`; fakes look like `test-…`. */
export function assertRealNeonIds(ids: {
  projectId?: string | null;
  branchIds?: Array<string | null | undefined>;
  hosts?: Array<string | null | undefined>;
}): void {
  const problems: string[] = [];
  if (ids.projectId !== undefined) {
    if (
      !ids.projectId ||
      /^test-/.test(ids.projectId) ||
      !/^[a-z0-9-]{6,60}$/.test(ids.projectId)
    ) {
      problems.push(
        `project id ${ids.projectId} does not look like a real Neon id`,
      );
    }
  }
  for (const branchId of ids.branchIds ?? []) {
    if (!branchId || !/^br-[a-z0-9-]+$/.test(branchId)) {
      problems.push(
        `branch id ${branchId} does not look like a real Neon branch id`,
      );
    }
  }
  for (const host of ids.hosts ?? []) {
    if (!host || !/\.neon\.(tech|build)$/.test(host) || /^test-/.test(host)) {
      problems.push(`host ${host} is not a real Neon endpoint`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Live run touched fake or simulated Neon resources:\n- ${problems.join("\n- ")}`,
    );
  }
}
