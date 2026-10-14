// Workspace Composio module tests. Service behaviour (key validation before
// commit, personal/shared link isolation, callback identity verification) runs
// against the isolated in-memory fixtures; two HTTP tests prove the extension
// factory mounts in front of the platform handler and that no raw key is ever
// returned. No provider network call is made — the provider is a fake.
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformRole } from "../../../shared/colonie-platform.ts";
import { createPlatformApp } from "./app.ts";
import { MemoryPlatformAuth } from "./auth.ts";
import type { ComposioAccess, ComposioCallbackResult, ComposioKeyValidation, ComposioLinkStart, ComposioProvider } from "./composio.ts";
import { WorkspaceComposioService, personalComposioUserId, platformAccess, serviceComposioUserId } from "./composio.ts";
import { createComposioRoutes } from "./composio-routes.ts";
import { MemoryComposioStore } from "./composio-store.ts";
import { httpComposioProvider } from "./composio-provider.ts";
import { MemoryPlatformRepository } from "./memory-repository.ts";
import { SecretBox, generateSecretKey, maskSecret } from "./secrets.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

// ── fakes ────────────────────────────────────────────────────────────────

class FakeAccess implements ComposioAccess {
  private readonly members = new Map<string, { role: PlatformRole; principalId: string }>();
  set(workspaceId: string, accountId: string, role: PlatformRole, principalId = `principal-${accountId}`): void {
    this.members.set(`${workspaceId}:${accountId}`, { role, principalId });
  }
  clear(workspaceId: string, accountId: string): void {
    this.members.delete(`${workspaceId}:${accountId}`);
  }
  async describe(accountId: string, workspaceId: string): Promise<{ role: PlatformRole; principalId: string } | null> {
    return this.members.get(`${workspaceId}:${accountId}`) ?? null;
  }
}

class FakeProvider implements ComposioProvider {
  validateResult: ComposioKeyValidation = { ok: true, sessionId: "sess_1" };
  readonly validateCalls: Array<{ apiKey: string; userId: string }> = [];
  linkResult: ComposioLinkStart = { redirectUrl: "https://connect.composio.dev/link/ln_1", linkId: "ln_1" };
  readonly linkCalls: Array<{ userId: string; toolkit: string; callbackUrl: string }> = [];
  callbackResult: ComposioCallbackResult = { active: true, connectedAccountId: "ca_1", toolkit: "gmail" };
  provisionResult = { apiKey: "ak_provisioned_9999", projectId: "proj_1" };

  async validateProjectKey(input: { apiKey: string; userId: string }): Promise<ComposioKeyValidation> {
    this.validateCalls.push(input);
    return this.validateResult;
  }
  async provisionProject(): Promise<{ apiKey: string; projectId?: string }> {
    return this.provisionResult;
  }
  async createLink(input: { userId: string; toolkit: string; callbackUrl: string }): Promise<ComposioLinkStart> {
    this.linkCalls.push({ userId: input.userId, toolkit: input.toolkit, callbackUrl: input.callbackUrl });
    return this.linkResult;
  }
  async verifyCallback(_input: { apiKey: string; userId: string; sessionUri: string }): Promise<ComposioCallbackResult> {
    return this.callbackResult;
  }
}

function harness(options: { orgKey?: string; now?: () => Date } = {}) {
  const repository = new MemoryPlatformRepository();
  const store = new MemoryComposioStore();
  const secrets = new SecretBox(generateSecretKey());
  const provider = new FakeProvider();
  const access = new FakeAccess();
  const service = new WorkspaceComposioService({
    store,
    repository,
    secrets,
    provider,
    access,
    callbackUrl: "https://cloud.test/composio/callback",
    ...(options.orgKey ? { orgKey: options.orgKey } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { repository, store, secrets, provider, access, service };
}

/** Start and verify a link, returning the active view. */
async function activate(h: ReturnType<typeof harness>, accountId: string, workspaceId: string, toolkit: string, shared = false) {
  h.provider.callbackResult = { active: true, connectedAccountId: "ca_1", toolkit };
  const started = shared
    ? await h.service.startSharedLink(accountId, workspaceId, toolkit)
    : await h.service.startPersonalLink(accountId, workspaceId, toolkit);
  return h.service.completeLink(accountId, workspaceId, { state: started.state, sessionUri: `uri_${toolkit}` });
}

const KEY = "ak_live_zzzz9876";

async function seedKey(h: ReturnType<typeof harness>, workspaceId: string, accountId: string, role: PlatformRole = "owner"): Promise<void> {
  h.access.set(workspaceId, accountId, role);
  await h.service.setProjectKey(accountId, workspaceId, KEY);
}

// ── stable identities ────────────────────────────────────────────────────

describe("stable Composio identities", () => {
  it("derives personal ids from workspace + principal, never from email", () => {
    const first = personalComposioUserId("ws_1", "principal_1");
    const again = personalComposioUserId("ws_1", "principal_1");
    const other = personalComposioUserId("ws_1", "principal_2");
    const elsewhere = personalComposioUserId("ws_2", "principal_1");
    expect(first).toBe(again);
    expect(new Set([first, other, elsewhere]).size).toBe(3);
    expect(first).toMatch(/^colonie_h_[0-9a-f]{24}$/);
    expect(first).not.toContain("@");
  });

  it("keeps the shared service identity separate from every personal id", () => {
    const service = serviceComposioUserId("ws_1");
    expect(service).toMatch(/^colonie_s_[0-9a-f]{24}$/);
    expect(service).not.toBe(personalComposioUserId("ws_1", "principal_1"));
    expect(service).toBe(serviceComposioUserId("ws_1"));
  });
});

// ── setup status and key management ──────────────────────────────────────

describe("workspace project key", () => {
  it("reports unset setup with a reason when no org key is configured", async () => {
    const h = harness();
    h.access.set("ws_1", "acct_owner", "owner");
    const status = await h.service.status("acct_owner", "ws_1");
    expect(status.configured).toBe(false);
    expect(status.keyStatus).toBe("unset");
    expect(status.canProvision).toBe(false);
    expect(status.setupUnavailableReason).toBeTruthy();
    expect(status.maskedHint).toBeUndefined();
    expect(status.serviceUserId).toBe(serviceComposioUserId("ws_1"));
  });

  it("lets an owner save a validated key and never echoes the raw key", async () => {
    const h = harness();
    h.access.set("ws_1", "acct_owner", "owner");
    const status = await h.service.setProjectKey("acct_owner", "ws_1", KEY);
    expect(status.configured).toBe(true);
    expect(status.keyStatus).toBe("active");
    expect(status.maskedHint).toBe(maskSecret(KEY));
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(h.provider.validateCalls).toEqual([{ apiKey: KEY, userId: serviceComposioUserId("ws_1") }]);
  });

  it("stores the key encrypted and readable only through the secret service", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const record = await h.store.getKey("ws_1");
    expect(record).not.toBeNull();
    const reference = await h.repository.getSecretReference(record!.secretRefId);
    expect(reference).not.toBeNull();
    expect(reference!.ciphertext).not.toContain(KEY);
    expect(h.secrets.open(reference!)).toBe(KEY);
  });

  it("refuses a member and a malformed key without calling the provider", async () => {
    const h = harness();
    h.access.set("ws_1", "acct_member", "member");
    await expect(h.service.setProjectKey("acct_member", "ws_1", KEY)).rejects.toMatchObject({ status: 403 });
    h.access.set("ws_1", "acct_owner", "owner");
    await expect(h.service.setProjectKey("acct_owner", "ws_1", "not-a-key")).rejects.toMatchObject({ status: 422, code: "composio_key_rejected" });
    expect(h.provider.validateCalls).toHaveLength(0);
  });

  it("keeps the previous key when validation fails", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const before = await h.store.getKey("ws_1");
    h.provider.validateResult = { ok: false, code: "session_write_required", message: "This key needs session_management Write access." };
    await expect(h.service.setProjectKey("acct_owner", "ws_1", "ak_live_newwwww1111")).rejects.toMatchObject({ status: 422, code: "composio_session_write_required" });
    const after = await h.store.getKey("ws_1");
    expect(after!.secretRefId).toBe(before!.secretRefId);
    expect(after!.maskedHint).toBe(maskSecret(KEY));
    const status = await h.service.status("acct_owner", "ws_1");
    expect(status.maskedHint).toBe(maskSecret(KEY));
  });

  it("removes the key and its secret reference", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const referenceId = (await h.store.getKey("ws_1"))!.secretRefId;
    await h.service.removeProjectKey("acct_owner", "ws_1");
    expect(await h.store.getKey("ws_1")).toBeNull();
    expect(await h.repository.getSecretReference(referenceId)).toBeNull();
  });

  it("provisions a project only when an org key is configured server-side", async () => {
    const without = harness();
    without.access.set("ws_1", "acct_owner", "owner");
    await expect(without.service.provisionProjectKey("acct_owner", "ws_1")).rejects.toMatchObject({ status: 501, code: "composio_org_key_unconfigured" });

    const h = harness({ orgKey: "org_secret_key" });
    h.access.set("ws_1", "acct_owner", "owner");
    const status = await h.service.provisionProjectKey("acct_owner", "ws_1", "Team project");
    expect(status.configured).toBe(true);
    expect(h.provider.validateCalls.at(-1)?.apiKey).toBe("ak_provisioned_9999");
    const reference = await h.repository.getSecretReference((await h.store.getKey("ws_1"))!.secretRefId);
    expect(h.secrets.open(reference!)).toBe("ak_provisioned_9999");
  });

  it("leaves the setup status unset when provisioning fails", async () => {
    const h = harness({ orgKey: "org_secret_key" });
    h.access.set("ws_1", "acct_owner", "owner");
    h.provider.provisionProject = async () => {
      throw new Error("provisioning down");
    };
    await expect(h.service.provisionProjectKey("acct_owner", "ws_1")).rejects.toMatchObject({ status: 502, code: "composio_provision_failed" });
    expect(await h.store.getKey("ws_1")).toBeNull();
    const status = await h.service.status("acct_owner", "ws_1");
    expect(status.configured).toBe(false);
  });
});

// ── connection links ─────────────────────────────────────────────────────

describe("connection links", () => {
  it("keeps a started link pending until the provider verifies the callback", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.provider.callbackResult = { active: false, code: "pending", message: "Waiting for Composio." };
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    expect(started.link.status).toBe("pending");
    expect(started.redirectUrl).toContain("connect.composio.dev");
    expect(started.state).toBeTruthy();

    const still = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "sess_uri_1" });
    expect(still.status).toBe("pending");
    expect(still.providerAccountId).toBeUndefined();
  });

  it("activates a link only after identity verification succeeds", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    const done = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "sess_uri_1" });
    expect(done.status).toBe("active");
    expect(done.providerAccountId).toBe("ca_1");
    expect(JSON.stringify(done)).not.toContain(KEY);
  });

  it("marks a link failed on an identity mismatch", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.provider.callbackResult = { active: false, code: "identity_mismatch", message: "That connection belongs to a different member." };
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    const failed = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "sess_uri_1" });
    expect(failed.status).toBe("failed");
    expect(failed.providerAccountId).toBeUndefined();
  });

  it("binds a personal link to workspace + principal, not the account email", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    expect(h.provider.linkCalls[0]!.userId).toBe(personalComposioUserId("ws_1", "principal-acct_owner"));
    expect(h.provider.linkCalls[0]!.callbackUrl).toContain("colonieState=");
  });

  it("refuses a shared link for a member and allows it for an admin", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.access.set("ws_1", "acct_member", "member");
    await expect(h.service.startSharedLink("acct_member", "ws_1", "github")).rejects.toMatchObject({ status: 403 });
    h.access.set("ws_1", "acct_admin", "admin");
    const shared = await h.service.startSharedLink("acct_admin", "ws_1", "github");
    expect(shared.link.audience).toBe("shared");
    expect(h.provider.linkCalls.at(-1)?.userId).toBe(serviceComposioUserId("ws_1"));
  });

  it("shows a member only their own personal links plus shared ones", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.access.set("ws_1", "acct_other", "member");
    await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    await h.service.startSharedLink("acct_owner", "ws_1", "github");

    const mine = await h.service.listLinks("acct_owner", "ws_1");
    expect(mine.map((link) => link.audience).sort()).toEqual(["personal", "shared"]);

    const theirs = await h.service.listLinks("acct_other", "ws_1");
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.audience).toBe("shared");
  });

  it("does not let another member complete or disconnect a personal link", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.access.set("ws_1", "acct_other", "member");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    await expect(h.service.completeLink("acct_other", "ws_1", { state: started.state, sessionUri: "sess_uri_1" })).rejects.toMatchObject({ status: 403 });
    await expect(h.service.disconnectLink("acct_other", "ws_1", started.link.id)).rejects.toMatchObject({ status: 403 });
  });

  it("requires a configured key before any link can start", async () => {
    const h = harness();
    h.access.set("ws_1", "acct_owner", "owner");
    await expect(h.service.startPersonalLink("acct_owner", "ws_1", "gmail")).rejects.toMatchObject({ status: 409, code: "composio_unconfigured" });
  });

  it("passes the verified session URI and the link's own user id to the provider", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const seen: Array<{ apiKey: string; userId: string; sessionUri: string }> = [];
    h.provider.verifyCallback = async (input) => {
      seen.push(input);
      return { active: true, connectedAccountId: "ca_real" };
    };
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    const done = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_verified" });
    expect(done.status).toBe("active");
    expect(done.providerAccountId).toBe("ca_real");
    expect(seen).toEqual([{ apiKey: KEY, userId: personalComposioUserId("ws_1", "principal-acct_owner"), sessionUri: "uri_verified" }]);
  });

  it("keeps a link pending when the provider returns pending", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.provider.callbackResult = { active: false, code: "pending", message: "Not verified yet." };
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    const still = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_pending" });
    expect(still.status).toBe("pending");
    expect(still.providerAccountId).toBeUndefined();
  });

  it("leaves a link pending when the provider cannot be reached", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    h.provider.verifyCallback = async () => {
      throw new Error("network down");
    };
    await expect(h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "sess_uri_1" })).rejects.toMatchObject({ status: 503 });
    const links = await h.service.listLinks("acct_owner", "ws_1");
    expect(links.find((link) => link.id === started.link.id)!.status).toBe("pending");
  });
});

// ── callback hardening ───────────────────────────────────────────────────

describe("callback hardening", () => {
  it("refuses a callback without a nonempty verified session URI", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    await expect(h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "" })).rejects.toMatchObject({ status: 400, code: "missing_session_uri" });
    await expect(h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "   " })).rejects.toMatchObject({ status: 400, code: "missing_session_uri" });
    expect((await h.service.listLinks("acct_owner", "ws_1"))[0]!.status).toBe("pending");
  });

  it("rejects a disconnected link and never reactivates it by replay", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    await h.service.disconnectLink("acct_owner", "ws_1", started.link.id);
    await expect(h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_late" })).rejects.toMatchObject({ status: 410, code: "link_expired" });
    expect((await h.service.listLinks("acct_owner", "ws_1")).find((link) => link.id === started.link.id)!.status).toBe("expired");
  });

  it("rejects a failed link and never reactivates it by replay", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.provider.callbackResult = { active: false, code: "identity_mismatch", message: "Not this member." };
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    const failed = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_first" });
    expect(failed.status).toBe("failed");
    h.provider.callbackResult = { active: true, connectedAccountId: "ca_1", toolkit: "gmail" };
    await expect(h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_replay" })).rejects.toMatchObject({ status: 410, code: "link_failed" });
    expect((await h.service.listLinks("acct_owner", "ws_1")).find((link) => link.id === started.link.id)!.status).toBe("failed");
  });

  it("expires a pending link older than the verification window", async () => {
    let clock = Date.parse("2026-10-14T09:00:00.000Z");
    const h = harness({ now: () => new Date(clock) });
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");

    clock += 9 * 60 * 1000;
    const fresh = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_fresh" });
    expect(fresh.status).toBe("active");

    const stale = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    clock += 10 * 60 * 1000;
    await expect(h.service.completeLink("acct_owner", "ws_1", { state: stale.state, sessionUri: "uri_stale" })).rejects.toMatchObject({ status: 410, code: "link_expired" });
    expect((await h.service.listLinks("acct_owner", "ws_1")).find((link) => link.id === stale.link.id)!.status).toBe("expired");
  });

  it("fails the link when Composio verifies a different toolkit", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.provider.callbackResult = { active: true, connectedAccountId: "ca_1", toolkit: "github" };
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    const done = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_mismatch" });
    expect(done.status).toBe("failed");
    expect(done.providerAccountId).toBeUndefined();
  });

  it("does not activate when the key is swapped during verification", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    h.provider.verifyCallback = async () => {
      await h.service.setProjectKey("acct_owner", "ws_1", "ak_live_rotated0001");
      return { active: true, connectedAccountId: "ca_rot", toolkit: "gmail" };
    };
    const done = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_swap" });
    expect(done.status).toBe("failed");
    expect(done.providerAccountId).toBeUndefined();
    expect(done.statusReason).toContain("key changed");
  });

  it("does not activate when the key is removed during verification", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    h.provider.verifyCallback = async () => {
      await h.service.removeProjectKey("acct_owner", "ws_1");
      return { active: true, connectedAccountId: "ca_1", toolkit: "gmail" };
    };
    const done = await h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_removed" });
    expect(done.status).toBe("failed");
    expect(done.providerAccountId).toBeUndefined();
  });

  it("refuses activation when the actor loses membership during verification", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const started = await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    h.provider.verifyCallback = async () => {
      h.access.clear("ws_1", "acct_owner");
      return { active: true, connectedAccountId: "ca_1", toolkit: "gmail" };
    };
    await expect(h.service.completeLink("acct_owner", "ws_1", { state: started.state, sessionUri: "uri_removed_member" })).rejects.toMatchObject({ status: 403 });
    h.access.set("ws_1", "acct_owner", "owner");
    expect((await h.service.listLinks("acct_owner", "ws_1")).find((link) => link.id === started.link.id)!.status).toBe("pending");
  });
});

// ── key mutation serialization ───────────────────────────────────────────

describe("key mutation serialization", () => {
  it("never crosses references when two sets run at once", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const before = await h.store.getKey("ws_1");
    const [first, second] = await Promise.all([
      h.service.setProjectKey("acct_owner", "ws_1", "ak_live_aaaa1111"),
      h.service.setProjectKey("acct_owner", "ws_1", "ak_live_bbbb2222"),
    ]);
    const record = await h.store.getKey("ws_1");
    const reference = await h.repository.getSecretReference(record!.secretRefId);
    expect(reference).not.toBeNull();
    // The surviving hint must describe the key the surviving reference decrypts to.
    expect(maskSecret(h.secrets.open(reference!))).toBe(record!.maskedHint);
    expect([first.maskedHint, second.maskedHint]).toContain(record!.maskedHint);
    expect(await h.repository.getSecretReference(before!.secretRefId)).toBeNull();
  });

  it("keeps a set and a concurrent remove consistent", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await Promise.allSettled([
      h.service.setProjectKey("acct_owner", "ws_1", "ak_live_cccc3333"),
      h.service.removeProjectKey("acct_owner", "ws_1"),
    ]);
    const record = await h.store.getKey("ws_1");
    if (record) {
      const reference = await h.repository.getSecretReference(record.secretRefId);
      expect(reference).not.toBeNull();
      expect(reference!.status).toBe("active");
    }
  });
});

// ── server-only tool access ──────────────────────────────────────────────

describe("server-only tool access", () => {
  it("resolves a personal snapshot with the raw key and only that human's active links", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await activate(h, "acct_owner", "ws_1", "gmail");
    const snapshot = await h.service.resolveToolAccess("acct_owner", "ws_1", "personal");
    expect(snapshot.key).toBe(KEY);
    expect(snapshot.userId).toBe(personalComposioUserId("ws_1", "principal-acct_owner"));
    expect(snapshot.principalId).toBe("principal-acct_owner");
    expect(snapshot.keyRef).toBe((await h.store.getKey("ws_1"))!.secretRefId);
    expect(snapshot.connections.map((connection) => connection.toolkit)).toEqual(["gmail"]);
    expect(snapshot.connections[0]!.providerAccountId).toBe("ca_1");
  });

  it("excludes pending and failed links from a snapshot", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await h.service.startPersonalLink("acct_owner", "ws_1", "gmail");
    const snapshot = await h.service.resolveToolAccess("acct_owner", "ws_1", "personal");
    expect(snapshot.connections).toEqual([]);
  });

  it("lets any member use a deliberately shared active grant", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await activate(h, "acct_owner", "ws_1", "github", true);
    await activate(h, "acct_owner", "ws_1", "gmail");
    h.access.set("ws_1", "acct_member", "member");

    const shared = await h.service.resolveToolAccess("acct_member", "ws_1", "shared");
    expect(shared.userId).toBe(serviceComposioUserId("ws_1"));
    expect(shared.principalId).toBeUndefined();
    expect(shared.connections.map((connection) => connection.toolkit)).toEqual(["github"]);
  });

  it("keeps configuring a shared connection admin-only", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    h.access.set("ws_1", "acct_member", "member");
    await expect(h.service.startSharedLink("acct_member", "ws_1", "github")).rejects.toMatchObject({ status: 403 });
  });

  it("never returns a personal identity through shared scope", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await activate(h, "acct_owner", "ws_1", "gmail");
    const personal = await h.service.resolveToolAccess("acct_owner", "ws_1", "personal");
    const shared = await h.service.resolveToolAccess("acct_owner", "ws_1", "shared");
    expect(shared.userId).not.toBe(personal.userId);
    expect(shared.connections).toEqual([]);
  });

  it("checkToolAccess rechecks the key, the link and the membership", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await activate(h, "acct_owner", "ws_1", "gmail");
    const snapshot = await h.service.resolveToolAccess("acct_owner", "ws_1", "personal");
    const connection = snapshot.connections[0]!;
    expect(await h.service.checkToolAccess(snapshot, connection)).toBe(true);

    // A key swap invalidates the snapshot.
    await h.service.setProjectKey("acct_owner", "ws_1", "ak_live_swapped0001");
    expect(await h.service.checkToolAccess(snapshot, connection)).toBe(false);
  });

  it("checkToolAccess fails after the link is disconnected", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    const active = await activate(h, "acct_owner", "ws_1", "gmail");
    const snapshot = await h.service.resolveToolAccess("acct_owner", "ws_1", "personal");
    const connection = snapshot.connections[0]!;
    await h.service.disconnectLink("acct_owner", "ws_1", active.id);
    expect(await h.service.checkToolAccess(snapshot, connection)).toBe(false);
  });

  it("checkToolAccess fails after the resolver loses membership", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await activate(h, "acct_owner", "ws_1", "gmail");
    const snapshot = await h.service.resolveToolAccess("acct_owner", "ws_1", "personal");
    const connection = snapshot.connections[0]!;
    h.access.clear("ws_1", "acct_owner");
    expect(await h.service.checkToolAccess(snapshot, connection)).toBe(false);
  });

  it("checkToolAccess denies a revoked actor for a shared snapshot", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await activate(h, "acct_owner", "ws_1", "github", true);
    h.access.set("ws_1", "acct_member", "member");
    const snapshot = await h.service.resolveToolAccess("acct_member", "ws_1", "shared");
    const connection = snapshot.connections[0]!;
    expect(await h.service.checkToolAccess(snapshot, connection)).toBe(true);

    h.access.clear("ws_1", "acct_member");
    expect(await h.service.checkToolAccess(snapshot, connection)).toBe(false);
  });

  it("checkToolAccess never falls back from a personal to a shared identity", async () => {
    const h = harness();
    await seedKey(h, "ws_1", "acct_owner");
    await activate(h, "acct_owner", "ws_1", "github", true);
    await activate(h, "acct_owner", "ws_1", "gmail");
    const snapshot = await h.service.resolveToolAccess("acct_owner", "ws_1", "personal");
    const sharedLink = (await h.service.listLinks("acct_owner", "ws_1")).find((link) => link.audience === "shared")!;
    const forged = { id: sharedLink.id, toolkit: "github", userId: serviceComposioUserId("ws_1"), providerAccountId: "ca_1" };
    expect(await h.service.checkToolAccess(snapshot, forged)).toBe(false);
  });
});

// ── http provider seam ───────────────────────────────────────────────────

describe("http Composio provider seam", () => {
  const base = "https://api.test/api/v3.1";

  function provider(handler: (url: string, init: RequestInit) => Response | Promise<Response>): ComposioProvider {
    const fetchImpl = (async (input: unknown, init: unknown) => handler(String(input), (init ?? {}) as RequestInit)) as unknown as typeof fetch;
    return httpComposioProvider({ baseUrl: base, fetchImpl });
  }

  it("maps a session_management Write error without leaking the key", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const seam = provider((url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body ?? "{}") });
      return new Response(JSON.stringify({ message: "This API key requires session_management Write access" }), { status: 400 });
    });
    const result = await seam.validateProjectKey({ apiKey: "ak_secret_value", userId: "colonie_s_x" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("session_write_required");
    expect(result.message).not.toContain("ak_secret_value");
    expect(calls[0]!.url).toBe(`${base}/tool_router/session`);
    expect(calls[0]!.headers["x-api-key"]).toBe("ak_secret_value");
    expect(calls[0]!.body).not.toContain("ak_secret_value");
  });

  it("returns the session id on a successful validation", async () => {
    const seam = provider(() => new Response(JSON.stringify({ session_id: "sess_9" }), { status: 200 }));
    await expect(seam.validateProjectKey({ apiKey: "ak_ok", userId: "u" })).resolves.toEqual({ ok: true, sessionId: "sess_9" });
  });

  it("activates only when complete_auth returns an active account", async () => {
    const seam = provider((url) => url.endsWith("/connected_accounts/complete_auth")
      ? new Response(JSON.stringify({ connected_account_id: "ca_9", toolkit_slug: "gmail" }), { status: 200 })
      : new Response("{}", { status: 500 }));
    await expect(seam.verifyCallback({ apiKey: "ak_ok", userId: "u", sessionUri: "uri_1" })).resolves.toEqual({ active: true, connectedAccountId: "ca_9", toolkit: "gmail" });
  });

  it("treats a 400 from complete_auth as an identity mismatch, not success", async () => {
    const seam = provider(() => new Response(JSON.stringify({ message: "Callback identity verification failed" }), { status: 400 }));
    const result = await seam.verifyCallback({ apiKey: "ak_ok", userId: "u", sessionUri: "uri_1" });
    expect(result.active).toBe(false);
    expect(result).toMatchObject({ code: "identity_mismatch" });
  });

  it("never activates without a verified session URI", async () => {
    const seam = provider(() => new Response(JSON.stringify({ status: "ACTIVE", user_id: "me" }), { status: 200 }));
    const result = await seam.verifyCallback({ apiKey: "ak_ok", userId: "me", sessionUri: "" });
    expect(result.active).toBe(false);
    expect(result).toMatchObject({ code: "pending" });
  });

  it("creates a project with the org key and the documented request shape", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const seam = provider((url, init) => {
      calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "proj_1", name: "colonie-ws_1", api_key: "ak_provisioned_9999" }), { status: 200 });
    });
    await expect(seam.provisionProject!({ orgKey: "org_secret_key", workspaceId: "ws_1", name: "colonie-ws_1" })).resolves.toEqual({ apiKey: "ak_provisioned_9999", projectId: "proj_1" });
    expect(calls[0]!.url).toBe(`${base}/org/owner/project/new`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["x-org-api-key"]).toBe("org_secret_key");
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
    expect(calls[0]!.body).toEqual({ name: "colonie-ws_1", should_create_api_key: true });
  });

  it("mints a Connect Link from a resolved auth config", async () => {
    const seen: string[] = [];
    const seam = provider((url) => {
      seen.push(url);
      if (url.includes("/auth_configs")) return new Response(JSON.stringify({ items: [{ id: "ac_1", is_enabled_for_tool_router: true }] }), { status: 200 });
      return new Response(JSON.stringify({ redirect_url: "https://connect.composio.dev/link/ln_9", link_token: "ln_9" }), { status: 201 });
    });
    await expect(seam.createLink({ apiKey: "ak_ok", userId: "u", toolkit: "gmail", callbackUrl: "https://app.test/cb" })).resolves.toEqual({ redirectUrl: "https://connect.composio.dev/link/ln_9", linkId: "ln_9" });
    expect(seen.some((url) => url.includes("toolkit_slug=gmail"))).toBe(true);
  });
});

// ── HTTP extension ───────────────────────────────────────────────────────

interface HttpHarness {
  base: string;
  service: WorkspaceComposioService;
  provider: FakeProvider;
}

async function startHttp(options: { orgKey?: string } = {}): Promise<HttpHarness> {
  const repository = new MemoryPlatformRepository();
  const auth = new MemoryPlatformAuth();
  const app = createPlatformApp({ repository, auth, secretKey: generateSecretKey(), publicOrigin: "https://cloud.test" });
  const store = new MemoryComposioStore();
  const provider = new FakeProvider();
  const service = new WorkspaceComposioService({
    store,
    repository,
    secrets: new SecretBox(generateSecretKey()),
    provider,
    access: platformAccess(app.service),
    callbackUrl: "https://cloud.test/composio/callback",
    ...(options.orgKey ? { orgKey: options.orgKey } : {}),
  });
  const routes = createComposioRoutes({ service, auth });
  const server = createServer((req, res) => {
    void routes(req, res).then((handled) => (handled ? undefined : app.handle(req, res)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, service, provider };
}

async function call(base: string, path: string, options: { method?: string; body?: unknown; cookie?: string } = {}): Promise<{ status: number; body: any; cookie: string }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookie = options.cookie ?? (setCookie[0] ? setCookie[0].split(";")[0]! : "");
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, cookie };
}

async function signup(base: string, email: string): Promise<{ cookie: string; accountId: string }> {
  const res = await call(base, "/api/colonie/auth/sign-up/email", { method: "POST", body: { email, password: "password1234", name: email.split("@")[0] } });
  expect(res.status).toBe(200);
  return { cookie: res.cookie, accountId: res.body.user.id };
}

describe("composio HTTP extension", () => {
  it("rejects an unauthenticated request", async () => {
    const h = await startHttp();
    const res = await call(h.base, "/api/colonie/platform/workspaces/ws_1/composio");
    expect(res.status).toBe(401);
  });

  it("saves a key and completes a personal connection without echoing the key", async () => {
    const h = await startHttp();
    const owner = await signup(h.base, "owner@test.dev");
    const created = await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Acme", kind: "cloud" }, cookie: owner.cookie });
    expect(created.status).toBe(200);
    const workspaceId: string = created.body.workspace.id;

    const saved = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/key`, { method: "PUT", body: { apiKey: KEY }, cookie: owner.cookie });
    expect(saved.status).toBe(200);
    expect(saved.body.configured).toBe(true);
    expect(saved.body.maskedHint).toBe(maskSecret(KEY));
    expect(JSON.stringify(saved.body)).not.toContain(KEY);

    const started = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/connections`, { method: "POST", body: { toolkit: "gmail" }, cookie: owner.cookie });
    expect(started.status).toBe(200);
    expect(started.body.link.status).toBe("pending");
    expect(JSON.stringify(started.body)).not.toContain(KEY);

    const completed = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/connections/complete`, { method: "POST", body: { state: started.body.state, sessionUri: "sess_uri_1" }, cookie: owner.cookie });
    expect(completed.status).toBe(200);
    expect(completed.body.link.status).toBe("active");
    expect(completed.body.link.providerAccountId).toBe("ca_1");

    const status = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio`, { cookie: owner.cookie });
    expect(status.status).toBe(200);
    expect(status.body.maskedHint).toBe(maskSecret(KEY));
    expect(JSON.stringify(status.body)).not.toContain(KEY);
  });

  it("rejects a completion without a verified session URI and leaves the link pending", async () => {
    const h = await startHttp();
    const owner = await signup(h.base, "owner@composio-guard.test");
    const workspaceId = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Guard", kind: "cloud" }, cookie: owner.cookie })).body.workspace.id;
    await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/key`, { method: "PUT", body: { apiKey: KEY }, cookie: owner.cookie });
    const started = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/connections`, { method: "POST", body: { toolkit: "gmail" }, cookie: owner.cookie });
    const bare = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/connections/complete`, { method: "POST", body: { state: started.body.state }, cookie: owner.cookie });
    expect(bare.status).toBe(400);
    const links = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/connections`, { cookie: owner.cookie });
    expect(links.body.links[0].status).toBe("pending");
  });

  it("never exposes the server-only tool access through a route", async () => {
    const h = await startHttp();
    const owner = await signup(h.base, "owner@composio-access.test");
    const workspaceId = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Access", kind: "cloud" }, cookie: owner.cookie })).body.workspace.id;
    await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/key`, { method: "PUT", body: { apiKey: KEY }, cookie: owner.cookie });
    for (const path of ["tool-access", "tools", "access"]) {
      const res = await call(h.base, `/api/colonie/platform/workspaces/${workspaceId}/composio/${path}`, { cookie: owner.cookie });
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(KEY);
    }
  });
});
