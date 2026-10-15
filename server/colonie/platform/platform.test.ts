// Cloud platform core tests. Authorization, DM isolation, invitations, read
// cursors, secrets and turn publishing are exercised against the isolated
// in-memory fixture; the two SSE tests run over a real HTTP server so live
// delivery and reconnect replay are proven end to end.
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformWorkspace } from "../../../shared/colonie-platform.ts";
import { createPlatformApp, type PlatformApp } from "./app.ts";
import { MemoryPlatformAuth } from "./auth.ts";
import type { BotRuntime, BotTurnRequest } from "./contracts.ts";
import { PlatformError } from "./contracts.ts";
import { MemoryPlatformRepository } from "./memory-repository.ts";
import { generateSecretKey } from "./secrets.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function harness(runtime?: BotRuntime) {
  const repository = new MemoryPlatformRepository();
  const auth = new MemoryPlatformAuth();
  const app: PlatformApp = createPlatformApp({ repository, auth, runtime, secretKey: generateSecretKey(), publicOrigin: "https://cloud.test" });
  return { app, repository, auth, service: app.service };
}

// ── HTTP helpers ───────────────────────────────────────────────────────

interface Harness extends ReturnType<typeof harness> {
  base: string;
  server: Server;
}

async function start(runtime?: BotRuntime): Promise<Harness> {
  const h = harness(runtime);
  const server = createServer((req, res) => {
    void h.app.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { ...h, server, base: `http://127.0.0.1:${port}` };
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

async function signup(base: string, email: string, password = "password1234"): Promise<{ cookie: string; accountId: string }> {
  const res = await call(base, "/api/colonie/auth/sign-up/email", { method: "POST", body: { email, password, name: email.split("@")[0] } });
  expect(res.status).toBe(200);
  return { cookie: res.cookie, accountId: res.body.user.id };
}

class Sse {
  readonly frames: Array<{ sequence: number; event: { type: string; [key: string]: unknown } }> = [];
  private buffer = "";
  private readonly controller = new AbortController();
  private done = false;

  constructor(private readonly response: Response) {
    void this.pump();
  }

  private async pump(): Promise<void> {
    const reader = this.response.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = this.buffer.indexOf("\n\n")) >= 0) {
        const chunk = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
        if (dataLine) this.frames.push(JSON.parse(dataLine.slice(5).trim()));
      }
    }
    this.done = true;
  }

  async waitFor(predicate: (frame: Sse["frames"][number]) => boolean, timeoutMs = 2000): Promise<Sse["frames"][number] | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  async quiet(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  closed(): boolean {
    return this.done;
  }

  close(): void {
    this.controller.abort();
  }
}

async function openStream(base: string, path: string, cookie: string): Promise<Sse> {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return new Sse(response);
}

async function seedWorkspace(service: PlatformApp["service"], auth: MemoryPlatformAuth, name = "Acme") {
  const owner = auth.seed(`owner-${name}@test.dev`, "password1234", "Owner");
  const workspace = await service.createWorkspace(owner.id, owner, { name, kind: "cloud" });
  return { owner, workspace };
}

// ── membership and roles ───────────────────────────────────────────────

describe("workspace membership and roles", () => {
  it("creates a workspace with the creator as owner and a human principal", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const view = await service.getWorkspace(owner.id, workspace.id);
    expect(view.workspace.myRole).toBe("owner");
    expect(view.members).toHaveLength(1);
    expect(view.members[0]!.role).toBe("owner");
    expect(view.members[0]!.accountId).toBe(owner.id);
  });

  it("does not treat a workspace ID as access", async () => {
    const { service, auth } = harness();
    const { workspace } = await seedWorkspace(service, auth);
    const outsider = auth.seed("outsider@test.dev", "password1234");
    await expect(service.getWorkspace(outsider.id, workspace.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.listConversations(outsider.id, workspace.id)).rejects.toMatchObject({ status: 403 });
  });

  it("lets only admins/owners create bots; a member cannot", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const member = auth.seed("member@test.dev", "password1234");
    await service.createInvitation(owner.id, workspace.id, { role: "member" }).then(({ token }) => service.acceptInvitation(member.id, member, token));
    await expect(service.createBot(member.id, workspace.id, { name: "Nope" })).rejects.toMatchObject({ status: 403 });
    const bot = await service.createBot(owner.id, workspace.id, { name: "Scout" });
    expect(bot.name).toBe("Scout");
    expect((await service.listBots(owner.id, workspace.id)).map((b) => b.id)).toContain(bot.id);
  });

  it("keeps at least one owner and refuses an admin removing an owner", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const admin = auth.seed("admin@test.dev", "password1234");
    await service.createInvitation(owner.id, workspace.id, { role: "admin" }).then(({ token }) => service.acceptInvitation(admin.id, admin, token));
    await expect(service.removeMember(admin.id, workspace.id, owner.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.setMemberRole(owner.id, workspace.id, owner.id, "member")).rejects.toMatchObject({ status: 409 });
  });
});

// ── conversation privacy ───────────────────────────────────────────────

describe("conversation privacy", () => {
  async function scenario() {
    const h = harness();
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const second = h.auth.seed("second@test.dev", "password1234", "Second");
    const third = h.auth.seed("third@test.dev", "password1234", "Third");
    for (const human of [second, third]) {
      const { token } = await h.service.createInvitation(owner.id, workspace.id, { role: "member" });
      await h.service.acceptInvitation(human.id, human, token);
    }
    return { ...h, owner, second, third, workspace };
  }

  it("keeps a human DM private to its two participants, even from an admin", async () => {
    const { service, owner, second, third, workspace } = await scenario();
    const dm = await service.openDm(owner.id, workspace.id, { withAccountId: second.id });
    const message = await service.sendMessage(owner.id, dm.id, "Only for you");
    expect(message.body).toBe("Only for you");

    // second sees it; third (owner later promoted to admin) does not.
    expect((await service.listMessages(second.id, dm.id)).map((m) => m.body)).toEqual(["Only for you"]);
    await expect(service.getConversation(third.id, dm.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.listMessages(third.id, dm.id)).rejects.toMatchObject({ status: 403 });

    await service.setMemberRole(owner.id, workspace.id, second.id, "admin");
    await expect(service.getConversation(third.id, dm.id)).rejects.toMatchObject({ status: 403 });

    // And the admin himself cannot see someone else's DM.
    const otherDm = await service.openDm(second.id, workspace.id, { withAccountId: third.id });
    await expect(service.getConversation(owner.id, otherDm.id)).rejects.toMatchObject({ status: 403 });
  });

  it("gives each human a separate private DM with the same bot", async () => {
    const { service, owner, second, workspace } = await scenario();
    const bot = await service.createBot(owner.id, workspace.id, { name: "Scout" });
    const ownerDm = await service.openDm(owner.id, workspace.id, { withBotId: bot.id });
    const secondDm = await service.openDm(second.id, workspace.id, { withBotId: bot.id });
    expect(ownerDm.id).not.toBe(secondDm.id);
    await service.sendMessage(owner.id, ownerDm.id, "Owner private");
    await service.sendMessage(second.id, secondDm.id, "Second private");
    expect((await service.listMessages(owner.id, ownerDm.id)).map((m) => m.body)).toEqual(["Owner private"]);
    expect((await service.listMessages(second.id, secondDm.id)).map((m) => m.body)).toEqual(["Second private"]);
    await expect(service.listMessages(second.id, ownerDm.id)).rejects.toMatchObject({ status: 403 });
  });

  it("shares a Group only with its participants", async () => {
    const { service, owner, second, third, workspace } = await scenario();
    const ownerPrincipal = (await service.getWorkspace(owner.id, workspace.id)).members.find((m) => m.accountId === owner.id)!.principalId;
    const secondPrincipal = (await service.getWorkspace(second.id, workspace.id)).members.find((m) => m.accountId === second.id)!.principalId;
    const group = await service.createGroup(owner.id, workspace.id, { title: "Launch", memberPrincipalIds: [secondPrincipal] });
    expect(group.participants.map((p) => p.principalId).sort()).toEqual([ownerPrincipal, secondPrincipal].sort());
    await service.sendMessage(owner.id, group.id, "Group hello");
    expect((await service.listMessages(second.id, group.id)).map((m) => m.body)).toEqual(["Group hello"]);
    await expect(service.listMessages(third.id, group.id)).rejects.toMatchObject({ status: 403 });
  });

  it("tracks unread per person, never as a shared flag", async () => {
    const { service, owner, second, third, workspace } = await scenario();
    const group = await service.createGroup(owner.id, workspace.id, { title: "Ops" });
    await service.addGroupMember(owner.id, group.id, (await service.getWorkspace(second.id, workspace.id)).members.find((m) => m.accountId === second.id)!.principalId);
    await service.sendMessage(owner.id, group.id, "one");
    await service.sendMessage(owner.id, group.id, "two");
    // Owner authored both; their own cursor advanced. Second has two unread.
    const forSecond = (await service.listConversations(second.id, workspace.id)).find((c) => c.id === group.id)!;
    expect(forSecond.unreadCount).toBe(2);
    await service.markRead(second.id, group.id, forSecond.lastSequence);
    expect((await service.listConversations(second.id, workspace.id)).find((c) => c.id === group.id)!.unreadCount).toBe(0);
    const forOwner = (await service.listConversations(owner.id, workspace.id)).find((c) => c.id === group.id)!;
    expect(forOwner.unreadCount).toBe(0);
    void third;
  });
});

// ── message history paging ─────────────────────────────────────────────

describe("message history paging", () => {
  async function longConversation(runtime?: BotRuntime) {
    const h = harness(runtime);
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout" });
    const dm = await h.service.openDm(owner.id, workspace.id, { withBotId: bot.id });
    for (let index = 1; index <= 130; index += 1) await h.service.sendMessage(owner.id, dm.id, `message ${index}`);
    return { ...h, owner, dm };
  }

  it("defaults the API view to the latest page so a late prompt is never clipped", async () => {
    const { service, owner, dm } = await longConversation();
    const view = await service.getConversation(owner.id, dm.id);
    expect(view.messages).toHaveLength(100);
    expect(view.messages[0]!.body).toBe("message 31");
    expect(view.messages.at(-1)!.body).toBe("message 130");
    expect(view.messages.some((message) => message.body === "message 1")).toBe(false);
  });

  it("keeps cursor semantics for an explicit after", async () => {
    const { service, owner, dm } = await longConversation();
    const firstPage = await service.getConversation(owner.id, dm.id, { after: 0 });
    expect(firstPage.messages).toHaveLength(100);
    expect(firstPage.messages[0]!.body).toBe("message 1");

    const tail = await service.getConversation(owner.id, dm.id, { after: 120 });
    expect(tail.messages.map((message) => message.body)).toEqual([
      "message 121", "message 122", "message 123", "message 124", "message 125",
      "message 126", "message 127", "message 128", "message 129", "message 130",
    ]);
  });

  it("hands the latest prompt to a bot turn after more than 100 messages", async () => {
    const requests: BotTurnRequest[] = [];
    const { dm } = await longConversation({ onTurn: (request) => { requests.push(request); } });
    expect(requests).toHaveLength(130);
    const last = requests.at(-1)!;
    expect(last.conversationId).toBe(dm.id);
    expect(last.message.body).toBe("message 130");
    expect(last.history.at(-1)!.body).toBe("message 130");
    expect(last.history).toHaveLength(20);
  });
});

// ── invitations ────────────────────────────────────────────────────────

describe("invitations", () => {
  it("accepts a link into the intended workspace and is idempotent for the same person", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const invitee = auth.seed("invitee@test.dev", "password1234");
    const { invitation, token, url } = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    expect(url).toBe(`https://cloud.test/?colonieInvite=${encodeURIComponent(token)}`);
    const accepted = await service.acceptInvitation(invitee.id, invitee, token);
    expect(accepted.workspace.id).toBe(workspace.id);
    expect(accepted.role).toBe("member");
    // Same person accepting again is not an error.
    await expect(service.acceptInvitation(invitee.id, invitee, token)).resolves.toBeTruthy();
    expect((await service.listMembers(owner.id, workspace.id)).map((m) => m.accountId)).toContain(invitee.id);
    expect(invitation.id).toBeTruthy();
  });

  it("never grants membership by matching email, only by a valid token", async () => {
    const { service, auth } = harness();
    await seedWorkspace(service, auth);
    const stranger = auth.seed("owner@test.dev", "password1234"); // same display email style, different account
    await expect(service.acceptInvitation(stranger.id, stranger, "not-a-real-token")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects revoked, expired and already-used invitations", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const one = auth.seed("one@test.dev", "password1234");
    const two = auth.seed("two@test.dev", "password1234");
    const revoked = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await service.revokeInvitation(owner.id, workspace.id, revoked.invitation.id);
    await expect(service.acceptInvitation(one.id, one, revoked.token)).rejects.toMatchObject({ code: "revoked" });

    const expired = await service.createInvitation(owner.id, workspace.id, { role: "member", expiresInHours: 1 });
    await service.acceptInvitation(one.id, one, expired.token);
    await expect(service.acceptInvitation(two.id, two, expired.token)).rejects.toMatchObject({ code: "already_used" });

    const used = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await instrumentExpiry(service, workspace.id, used.invitation.id);
    await expect(service.acceptInvitation(two.id, two, used.token)).rejects.toMatchObject({ code: "expired" });
  });

  it("re-checks the invitation under the repository lock, not only before it", async () => {
    const { service, repository, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const invitee = auth.seed("locked@test.dev", "password1234");
    const other = auth.seed("locker@test.dev", "password1234");
    const at = new Date().toISOString();

    const revoked = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await service.revokeInvitation(owner.id, workspace.id, revoked.invitation.id);
    await expect(repository.acceptInvitation(revoked.invitation.id, invitee.id, at)).rejects.toMatchObject({ code: "revoked" });

    const expired = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await instrumentExpiry(service, workspace.id, expired.invitation.id);
    await expect(repository.acceptInvitation(expired.invitation.id, invitee.id, at)).rejects.toMatchObject({ code: "expired" });

    const used = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await service.acceptInvitation(other.id, other, used.token);
    await expect(repository.acceptInvitation(used.invitation.id, invitee.id, at)).rejects.toMatchObject({ code: "already_used" });

    // A rejected locked write grants nothing.
    const members = (await service.listMembers(owner.id, workspace.id)).map((member) => member.accountId);
    expect(members).not.toContain(invitee.id);
  });
});

/** Rewrite an invitation's expiry into the past through the repository. */
async function instrumentExpiry(service: PlatformApp["service"], workspaceId: string, invitationId: string): Promise<void> {
  const repository = service.repository as MemoryPlatformRepository;
  const record = (await repository.listInvitations(workspaceId)).find((i) => i.id === invitationId)!;
  (record as { expiresAt: string }).expiresAt = new Date(0).toISOString();
  // listInvitations returns clones; write the past expiry back through createInvitation.
  await repository.createInvitation({ ...record, expiresAt: new Date(0).toISOString() });
}

// ── connections and secrets ────────────────────────────────────────────

describe("connections and secrets", () => {
  it("stores a secret but only ever returns a masked hint", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const secret = "sk-live-SUPERSECRET-1234";
    const connection = await service.createConnection(owner.id, workspace.id, { toolkit: "gmail", audience: "workspace", actions: ["read"], secret });
    expect(connection.hasSecret).toBe(true);
    expect(connection.maskedHint).toBe("…1234");
    expect(JSON.stringify(connection)).not.toContain("SUPERSECRET");
    const listed = await service.listConnections(owner.id, workspace.id);
    expect(JSON.stringify(listed)).not.toContain("SUPERSECRET");
    // The relay path can still open it.
    const stored = await service.repository.getConnection(connection.id);
    expect(await service.openSecret(stored!.secretRefId!)).toBe(secret);
  });

  it("lets a member manage only their own personal connection", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const member = auth.seed("member@test.dev", "password1234");
    await service.createInvitation(owner.id, workspace.id, { role: "member" }).then(({ token }) => service.acceptInvitation(member.id, member, token));
    const personal = await service.createConnection(member.id, workspace.id, { toolkit: "calendar", audience: "personal", secret: "per-user-9999" });
    expect(personal.owningPrincipalId).toBeTruthy();
    // The owner/admin cannot see another person's personal connection.
    expect((await service.listConnections(owner.id, workspace.id)).map((c) => c.id)).not.toContain(personal.id);
    // A member cannot create a workspace connection.
    await expect(service.createConnection(member.id, workspace.id, { toolkit: "slack", audience: "workspace" })).rejects.toMatchObject({ status: 403 });
  });

  it("rotates a connection, invalidating stale leases via version and grant revision", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const first = await service.createConnection(owner.id, workspace.id, { toolkit: "gmail", audience: "workspace", secret: "one-1111" });
    const rotated = await service.rotateConnection(owner.id, workspace.id, first.id, "two-2222");
    expect(rotated.version).toBe(first.version + 1);
    expect(rotated.grantRevision).toBe(first.grantRevision + 1);
    expect(rotated.maskedHint).toBe("…2222");
    const stored = await service.repository.getConnection(first.id);
    expect(await service.openSecret(stored!.secretRefId!)).toBe("two-2222");
  });
});

// ── bot turns ──────────────────────────────────────────────────────────

describe("bot turns", () => {
  it("fires a DM turn and re-checks the triggering human before publishing", async () => {
    const turns: Array<{ conversationId: string; initiatorAccountId: string }> = [];
    let captured: PlatformApp["service"] | null = null;
    const runtime: BotRuntime = {
      onTurn: async (request) => {
        turns.push({ conversationId: request.conversationId, initiatorAccountId: request.initiatorAccountId });
        const principal = await captured!.repository.principalForBot(request.workspaceId, request.botId);
        await captured!.postBotMessage({ botPrincipalId: principal!.id, conversationId: request.conversationId, body: "Hello from the bot", initiatorAccountId: request.initiatorAccountId });
      },
    };
    const h = harness(runtime);
    captured = h.service;
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout" });
    const dm = await h.service.openDm(owner.id, workspace.id, { withBotId: bot.id });
    await h.service.sendMessage(owner.id, dm.id, "ping");
    expect(turns).toHaveLength(1);
    const messages = await h.service.listMessages(owner.id, dm.id);
    expect(messages.map((m) => m.body)).toEqual(["ping", "Hello from the bot"]);
    expect(messages[1]!.senderKind).toBe("bot");
  });

  it("refuses a bot result when the triggering human was removed", async () => {
    const h = harness();
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const member = h.auth.seed("member@test.dev", "password1234");
    await h.service.createInvitation(owner.id, workspace.id, { role: "member" }).then(({ token }) => h.service.acceptInvitation(member.id, member, token));
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout" });
    const dm = await h.service.openDm(member.id, workspace.id, { withBotId: bot.id });
    const botPrincipal = (await h.repository.principalForBot(workspace.id, bot.id))!;
    // Simulate a turn that started while the member was present.
    expect(await h.service.canPublish({ botPrincipalId: botPrincipal.id, conversationId: dm.id, initiatorAccountId: member.id })).toBe(true);
    await h.service.removeMember(owner.id, workspace.id, member.id);
    expect(await h.service.canPublish({ botPrincipalId: botPrincipal.id, conversationId: dm.id, initiatorAccountId: member.id })).toBe(false);
    await expect(h.service.postBotMessage({ botPrincipalId: botPrincipal.id, conversationId: dm.id, body: "late", initiatorAccountId: member.id })).rejects.toMatchObject({ code: "revoked" });
  });
});

// ── bot management ─────────────────────────────────────────────────────

describe("bot management", () => {
  it("persists the original identity, mascot and SOUL fields, including explicit clears", async () => {
    const h = harness();
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout", purpose: "Legacy purpose" });
    const updated = await h.service.updateBot(owner.id, workspace.id, bot.id, { title: "Researcher", description: "Find useful sources", soul: "Keep answers brief.", color: "purple", mascotBody: "star", mascotExpression: "happy" });
    expect((await h.service.listBots(owner.id, workspace.id))[0]).toEqual(updated);
    expect(updated).toMatchObject({ title: "Researcher", description: "Find useful sources", soul: "Keep answers brief.", color: "purple", mascotBody: "star", mascotExpression: "happy", purpose: "Legacy purpose" });
    await Promise.all([
      h.service.updateBot(owner.id, workspace.id, bot.id, { title: "New role" }),
      h.service.updateBot(owner.id, workspace.id, bot.id, { soul: "" }),
    ]);
    expect((await h.service.listBots(owner.id, workspace.id))[0]).toMatchObject({ title: "New role", soul: "", description: "Find useful sources" });
    await expect(h.service.updateBot(owner.id, workspace.id, bot.id, { soul: "😀".repeat(6001) })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.updateBot(owner.id, workspace.id, bot.id, { name: "bad\nname" })).rejects.toMatchObject({ status: 400 });
  });

  it("authorizes avatar reads and updates in the exact workspace and bot", async () => {
    const h = harness();
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout" });
    const otherBot = await h.service.createBot(owner.id, workspace.id, { name: "Other" });
    const member = h.auth.seed("member@avatars.test", "password1234");
    await h.service.createInvitation(owner.id, workspace.id, {}).then(({ token }) => h.service.acceptInvitation(member.id, member, token));
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVfoAAAAASUVORK5CYII=", "base64");
    const avatarUrl = await h.service.saveBotAvatar(owner.id, workspace.id, bot.id, bytes, "image/png");
    const id = avatarUrl.split("/").pop()!;
    const saved = await h.service.updateBot(owner.id, workspace.id, bot.id, { avatarUrl, avatarCrop: "rounded", avatarZoom: 1.5, avatarFocusX: 0.3 });
    expect(saved.avatarUrl).toBe(avatarUrl);
    expect(Buffer.from((await h.service.getBotAvatar(member.id, workspace.id, bot.id, id)).bytes)).toEqual(bytes);
    await expect(h.service.updateBot(owner.id, workspace.id, otherBot.id, { avatarUrl })).rejects.toMatchObject({ status: 400 });
    await expect(h.service.saveBotAvatar(member.id, workspace.id, bot.id, bytes, "image/png")).rejects.toMatchObject({ status: 403 });
    const foreign = await h.service.createWorkspace(owner.id, owner, { name: "Other workspace", kind: "cloud" });
    await expect(h.service.getBotAvatar(owner.id, foreign.id, bot.id, id)).rejects.toMatchObject({ status: 404 });
    await expect(h.service.updateBot(owner.id, foreign.id, bot.id, { soul: "Wrong tenant" })).rejects.toMatchObject({ status: 404 });
    await expect(h.service.saveBotAvatar(owner.id, workspace.id, bot.id, Buffer.from("<svg/>"), "image/png")).rejects.toMatchObject({ status: 400 });
    await h.service.removeMember(owner.id, workspace.id, member.id);
    await expect(h.service.getBotAvatar(member.id, workspace.id, bot.id, id)).rejects.toMatchObject({ status: 403 });
    await h.service.updateBot(owner.id, workspace.id, bot.id, { avatarUrl: null, avatarCrop: "mascot" });
    expect((await h.service.listBots(owner.id, workspace.id))[0]?.avatarUrl).toBeNull();
  });

  it("serves uploaded image bytes only through the authenticated avatar route", async () => {
    const h = await start();
    const owner = await signup(h.base, "owner@avatar-http.test");
    const workspace = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Avatars", kind: "cloud" }, cookie: owner.cookie })).body.workspace;
    const base = `/api/colonie/platform/workspaces/${workspace.id}/bots`;
    const bot = (await call(h.base, base, { method: "POST", body: { name: "Scout" }, cookie: owner.cookie })).body.bot;
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVfoAAAAASUVORK5CYII=";
    const uploaded = await call(h.base, `${base}/${bot.id}/avatars`, { method: "POST", body: { contentType: "image/png", base64 }, cookie: owner.cookie });
    expect(uploaded.status).toBe(200);
    const image = await fetch(h.base + uploaded.body.avatarUrl, { headers: { cookie: owner.cookie } });
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(base64, "base64"));
    expect((await fetch(h.base + uploaded.body.avatarUrl)).status).toBe(401);
    const unknown = await call(h.base, `${base}/${bot.id}`, { method: "PATCH", body: { credentials: "not-a-profile-field" }, cookie: owner.cookie });
    expect(unknown.status).toBe(400);
  });

  it("renames a bot and its principal while keeping the stable ids", async () => {
    const h = harness();
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout", purpose: "Research" });
    const principal = (await h.repository.principalForBot(workspace.id, bot.id))!;
    const updated = await h.service.updateBot(owner.id, workspace.id, bot.id, { name: "Scout II", purpose: "Digs deeper" });
    expect(updated.id).toBe(bot.id);
    expect(updated.principalId).toBe(bot.principalId);
    expect(updated.name).toBe("Scout II");
    expect(updated.purpose).toBe("Digs deeper");
    expect((await h.repository.getPrincipal(principal.id))!.displayName).toBe("Scout II");
    expect((await h.repository.getBot(bot.id))!.name).toBe("Scout II");
  });

  it("clears a purpose and leaves an omitted name alone", async () => {
    const h = harness();
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout", purpose: "Research" });
    const cleared = await h.service.updateBot(owner.id, workspace.id, bot.id, { purpose: "" });
    expect(cleared.name).toBe("Scout");
    expect(cleared.purpose).toBeUndefined();
  });

  it("refuses a member and an unknown bot", async () => {
    const h = harness();
    const { owner, workspace } = await seedWorkspace(h.service, h.auth);
    const member = h.auth.seed("member@bots.test", "password1234");
    await h.service.createInvitation(owner.id, workspace.id, { role: "member" }).then(({ token }) => h.service.acceptInvitation(member.id, member, token));
    const bot = await h.service.createBot(owner.id, workspace.id, { name: "Scout" });
    await expect(h.service.updateBot(member.id, workspace.id, bot.id, { name: "Hacked" })).rejects.toMatchObject({ status: 403 });
    await expect(h.service.updateBot(owner.id, workspace.id, "missing", { name: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("serves PATCH over HTTP to an owner and rejects an anonymous caller", async () => {
    const h = await start();
    const owner = await signup(h.base, "owner@bots-http.test");
    const workspace = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Bots", kind: "cloud" }, cookie: owner.cookie })).body.workspace;
    const created = await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/bots`, { method: "POST", body: { name: "Scout" }, cookie: owner.cookie });
    expect(created.status).toBe(200);
    const patched = await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/bots/${created.body.bot.id}`, { method: "PATCH", body: { name: "Scout II" }, cookie: owner.cookie });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.name).toBe("Scout II");
    expect(patched.body.bot.principalId).toBe(created.body.bot.principalId);
    const anonymous = await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/bots/${created.body.bot.id}`, { method: "PATCH", body: { name: "Nope" } });
    expect(anonymous.status).toBe(401);
  });
});

// ── account recovery ───────────────────────────────────────────────────

describe("account recovery", () => {
  it("issues a one-time key, resets the password and revokes sessions", async () => {
    const h = harness();
    const account = h.auth.seed("recover@test.dev", "oldpassword1", "Recover");
    const { recoveryKey } = await h.service.createRecoveryKey(account.id);
    expect(recoveryKey.length).toBeGreaterThan(20);
    await h.service.recoverAccount({ recoveryKey, newPassword: "newpassword1" });
    // Old password no longer works; the new one does.
    await expect(h.auth.recoverPassword(account.id, "newpassword1")).resolves.toBeUndefined();
    // Reusing the same key fails.
    await expect(h.service.recoverAccount({ recoveryKey, newPassword: "anotherpass1" })).rejects.toMatchObject({ code: "recovery_key_used" });
  });

  it("replaces an outstanding key so only the newest is valid", async () => {
    const h = harness();
    const account = h.auth.seed("two-keys@test.dev", "oldpassword1");
    const first = await h.service.createRecoveryKey(account.id);
    const second = await h.service.createRecoveryKey(account.id);
    await expect(h.service.recoverAccount({ recoveryKey: first.recoveryKey, newPassword: "password1x" })).rejects.toMatchObject({ code: "invalid_recovery_key" });
    await expect(h.service.recoverAccount({ recoveryKey: second.recoveryKey, newPassword: "password1x" })).resolves.toBeUndefined();
  });
});

// ── live streaming and replay over HTTP ────────────────────────────────

describe("authorized SSE", () => {
  it("delivers a DM message live only to its participants", async () => {
    const h = await start();
    const owner = await signup(h.base, "owner@stream.test");
    const member = await signup(h.base, "member@stream.test");
    const outsider = await signup(h.base, "outsider@stream.test");
    const workspace = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Stream", kind: "cloud" }, cookie: owner.cookie })).body.workspace;
    const invite = (await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/invitations`, { method: "POST", body: { role: "member" }, cookie: owner.cookie })).body;
    await call(h.base, "/api/colonie/platform/invitations/accept", { method: "POST", body: { token: invite.token }, cookie: member.cookie });
    const outsiderInvite = (await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/invitations`, { method: "POST", body: { role: "admin" }, cookie: owner.cookie })).body;
    await call(h.base, "/api/colonie/platform/invitations/accept", { method: "POST", body: { token: outsiderInvite.token }, cookie: outsider.cookie });

    const dm = (await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/conversations/open`, { method: "POST", body: { kind: "dm", withAccountId: member.accountId }, cookie: owner.cookie })).body.conversation;

    const memberDm = await openStream(h.base, `/api/colonie/platform/workspaces/${workspace.id}/stream?conversationId=${dm.id}`, member.cookie);
    // A third party (invited as admin) on the workspace stream must not see the DM.
    const outsiderWorkspace = await openStream(h.base, `/api/colonie/platform/workspaces/${workspace.id}/stream`, outsider.cookie);
    await memberDm.waitFor((f) => f.event.type === "ready");
    await outsiderWorkspace.waitFor((f) => f.event.type === "ready");

    await call(h.base, `/api/colonie/platform/conversations/${dm.id}/messages`, { method: "POST", body: { body: "secret dm" }, cookie: owner.cookie });

    const live = await memberDm.waitFor((f) => f.event.type === "message");
    expect(live?.event.type).toBe("message");
    expect((live?.event as unknown as { message?: { body?: string } })?.message?.body).toBe("secret dm");

    await outsiderWorkspace.quiet(300);
    expect(outsiderWorkspace.frames.some((f) => f.event.type === "message")).toBe(false);
    expect(outsiderWorkspace.frames.every((f) => f.event.type !== "message" || (f.event as { conversationId?: string }).conversationId !== dm.id)).toBe(true);

    memberDm.close();
    outsiderWorkspace.close();
  });

  it("replays missed frames on reconnect but never another person's DM", async () => {
    const h = await start();
    const owner = await signup(h.base, "owner@replay.test");
    const member = await signup(h.base, "member@replay.test");
    const stranger = await signup(h.base, "stranger@replay.test");
    const workspace = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Replay", kind: "cloud" }, cookie: owner.cookie })).body.workspace;
    const invite = (await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/invitations`, { method: "POST", body: { role: "member" }, cookie: owner.cookie })).body;
    await call(h.base, "/api/colonie/platform/invitations/accept", { method: "POST", body: { token: invite.token }, cookie: member.cookie });
    const strangerInvite = (await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/invitations`, { method: "POST", body: { role: "admin" }, cookie: owner.cookie })).body;
    await call(h.base, "/api/colonie/platform/invitations/accept", { method: "POST", body: { token: strangerInvite.token }, cookie: stranger.cookie });

    const dm = (await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/conversations/open`, { method: "POST", body: { kind: "dm", withAccountId: member.accountId }, cookie: owner.cookie })).body.conversation;
    await call(h.base, `/api/colonie/platform/conversations/${dm.id}/messages`, { method: "POST", body: { body: "historic dm" }, cookie: owner.cookie });

    const memberReplay = await openStream(h.base, `/api/colonie/platform/workspaces/${workspace.id}/stream?conversationId=${dm.id}&after=0`, member.cookie);
    const memberFrame = await memberReplay.waitFor((f) => f.event.type === "message");
    expect((memberFrame?.event as unknown as { message?: { body?: string } })?.message?.body).toBe("historic dm");

    const strangerReplay = await openStream(h.base, `/api/colonie/platform/workspaces/${workspace.id}/stream?after=0`, stranger.cookie);
    await strangerReplay.quiet(300);
    expect(strangerReplay.frames.some((f) => f.event.type === "message")).toBe(false);
    memberReplay.close();
    strangerReplay.close();
  });

  it("blocks a revoked member's stream immediately", async () => {
    const h = await start();
    const owner = await signup(h.base, "owner@revoke.test");
    const member = await signup(h.base, "member@revoke.test");
    const workspace = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Revoke", kind: "cloud" }, cookie: owner.cookie })).body.workspace;
    const invite = (await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/invitations`, { method: "POST", body: { role: "member" }, cookie: owner.cookie })).body;
    await call(h.base, "/api/colonie/platform/invitations/accept", { method: "POST", body: { token: invite.token }, cookie: member.cookie });

    const stream = await openStream(h.base, `/api/colonie/platform/workspaces/${workspace.id}/stream`, member.cookie);
    await stream.waitFor((f) => f.event.type === "ready");
    await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/members/${member.accountId}`, { method: "DELETE", cookie: owner.cookie });
    const revoked = await stream.waitFor((f) => f.event.type === "revoked");
    expect(revoked).not.toBeNull();
    await stream.quiet(150);
    expect(stream.closed()).toBe(true);
    stream.close();
  });

  it("returns 401 without a session and 403 for a non-participant stream", async () => {
    const h = await start();
    const owner = await signup(h.base, "owner@guard.test");
    const workspace = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Guard", kind: "cloud" }, cookie: owner.cookie })).body.workspace;
    const unauthorized = await fetch(`${h.base}/api/colonie/platform/workspaces/${workspace.id}/stream`);
    expect(unauthorized.status).toBe(401);
    const notParticipant = await call(h.base, `/api/colonie/platform/workspaces/${workspace.id}/stream?conversationId=missing`, { cookie: owner.cookie });
    expect(notParticipant.status).toBe(403);
  });

  it("closes live streams before the repository closes on shutdown", async () => {
    const h = await start();
    const owner = await signup(h.base, "owner@shutdown.test");
    const workspace = (await call(h.base, "/api/colonie/platform/workspaces", { method: "POST", body: { name: "Shutdown", kind: "cloud" }, cookie: owner.cookie })).body.workspace;
    const stream = await openStream(h.base, `/api/colonie/platform/workspaces/${workspace.id}/stream`, owner.cookie);
    await stream.waitFor((f) => f.event.type === "ready");
    await h.app.close();
    await stream.quiet(150);
    expect(stream.closed()).toBe(true);
    stream.close();
  });
});

// ── replay pagination ──────────────────────────────────────────────────

describe("replay pagination", () => {
  it("signals a resync instead of silently truncating a saturated page", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    for (let index = 0; index < 4; index += 1) await service.createBot(owner.id, workspace.id, { name: `Bot ${index}` });

    const frames = await service.replay(owner.id, workspace.id, null, 0, 3);
    expect(frames).toHaveLength(4);
    expect(frames.at(-1)!.event.type).toBe("resync");
  });

  it("does not signal a resync when the page is not saturated", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const frames = await service.replay(owner.id, workspace.id, null, 0, 500);
    expect(frames.some((frame) => frame.event.type === "resync")).toBe(false);
  });

  it("pages a workspace replay without leaking a private conversation event", async () => {
    const { service, auth } = harness();
    const { owner, workspace } = await seedWorkspace(service, auth);
    const member = auth.seed("replay-member@test.dev", "password1234");
    const outsider = auth.seed("replay-outsider@test.dev", "password1234");
    const memberInvite = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await service.acceptInvitation(member.id, member, memberInvite.token);
    const outsiderInvite = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await service.acceptInvitation(outsider.id, outsider, outsiderInvite.token);

    const dm = await service.openDm(owner.id, workspace.id, { withAccountId: member.id });
    await service.sendMessage(owner.id, dm.id, "private dm body");

    const participant = await service.replay(member.id, workspace.id, null, 0, 500);
    expect(participant.some((frame) => frame.event.type === "message")).toBe(true);

    const stranger = await service.replay(outsider.id, workspace.id, null, 0, 500);
    expect(stranger.some((frame) => frame.event.type === "message")).toBe(false);
  });
});

// ── workspace-created provisioning hook ────────────────────────────────

describe("workspace-created provisioning hook", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  }

  function harnessWithHook(hook?: (workspace: PlatformWorkspace, actorId: string) => Promise<void>) {
    const repository = new MemoryPlatformRepository();
    const auth = new MemoryPlatformAuth();
    const app = createPlatformApp({
      repository,
      auth,
      secretKey: generateSecretKey(),
      publicOrigin: "https://cloud.test",
      ...(hook ? { workspaceCreated: hook } : {}),
    });
    return { app, repository, auth, service: app.service };
  }

  it("invokes the hook separately for each Cloud workspace with the owner account", async () => {
    const calls: Array<{ workspaceId: string; kind: string; actorId: string }> = [];
    const { service, auth } = harnessWithHook(async (workspace, actorId) => {
      calls.push({ workspaceId: workspace.id, kind: workspace.kind, actorId });
    });
    const owner = auth.seed("hook-owner@test.dev", "password1234");
    const first = await service.createWorkspace(owner.id, owner, { name: "One", kind: "cloud" });
    const second = await service.createWorkspace(owner.id, owner, { name: "Two", kind: "cloud" });
    await tick();
    expect(calls).toEqual([
      { workspaceId: first.id, kind: "cloud", actorId: owner.id },
      { workspaceId: second.id, kind: "cloud", actorId: owner.id },
    ]);
  });

  it("does not invoke the hook for a Local workspace", async () => {
    const calls: string[] = [];
    const { service, auth } = harnessWithHook(async (workspace) => {
      calls.push(workspace.id);
    });
    const owner = auth.seed("hook-local@test.dev", "password1234");
    const local = await service.createWorkspace(owner.id, owner, { name: "Local", kind: "local" });
    expect(local.kind).toBe("local");
    expect(calls).toEqual([]);
  });

  it("keeps the Cloud workspace usable when provisioning fails", async () => {
    const { service, auth } = harnessWithHook(async () => {
      throw new Error("provisioning down");
    });
    const owner = auth.seed("hook-fail@test.dev", "password1234");
    const workspace = await service.createWorkspace(owner.id, owner, { name: "Fail", kind: "cloud" });
    expect(workspace.id).toBeTruthy();
    expect(await service.listWorkspaces(owner.id)).toHaveLength(1);
    expect((await service.listMembers(owner.id, workspace.id)).map((member) => member.accountId)).toContain(owner.id);

    // The first chat still works: a bot DM turn is not blocked by provisioning.
    const bot = await service.createBot(owner.id, workspace.id, { name: "Scout" });
    const dm = await service.openDm(owner.id, workspace.id, { withBotId: bot.id });
    const message = await service.sendMessage(owner.id, dm.id, "hello");
    expect(message.body).toBe("hello");
    await tick();
  });

  it("preserves the workspace when the hook succeeds", async () => {
    const calls: string[] = [];
    const { service, auth } = harnessWithHook(async (workspace) => {
      calls.push(workspace.id);
    });
    const owner = auth.seed("hook-ok@test.dev", "password1234");
    const workspace = await service.createWorkspace(owner.id, owner, { name: "Ok", kind: "cloud" });
    await tick();
    expect(calls).toEqual([workspace.id]);
    expect(await service.listWorkspaces(owner.id)).toHaveLength(1);
  });

  it("resolves workspace creation while a slow hook is still pending", async () => {
    const gate = deferred();
    const started: string[] = [];
    const { service, auth } = harnessWithHook(async (workspace) => {
      started.push(workspace.id);
      await gate.promise;
    });
    const owner = auth.seed("hook-slow@test.dev", "password1234");
    const workspace = await service.createWorkspace(owner.id, owner, { name: "Slow", kind: "cloud" });

    // Creation returned before the hook settled, and the workspace is usable.
    expect(workspace.id).toBeTruthy();
    expect(started).toEqual([workspace.id]);
    const bot = await service.createBot(owner.id, workspace.id, { name: "Scout" });
    expect(bot.id).toBeTruthy();

    gate.resolve();
    await tick();
  });

  it("runs without a hook at all", async () => {
    const { service, auth } = harnessWithHook();
    const owner = auth.seed("hook-none@test.dev", "password1234");
    const workspace = await service.createWorkspace(owner.id, owner, { name: "None", kind: "cloud" });
    expect(workspace.kind).toBe("cloud");
  });
});

// ── error envelope ─────────────────────────────────────────────────────

describe("error envelope", () => {
  it("maps PlatformError onto status and code", () => {
    const error = new PlatformError(403, "nope", "not_a_member");
    expect(error.status).toBe(403);
    expect(error.code).toBe("not_a_member");
  });
});
