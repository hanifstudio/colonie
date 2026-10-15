// Focused transcript-search tests. They prove the one promise search must keep:
// results come only from conversations the signed-in account's workspace
// principal participates in. A private human DM stays private from the owner
// and from other members; a second workspace never leaks in; revoked
// membership and non-membership are refused; the query is matched literally
// (no LIKE wildcard) and bounded. Everything runs over real HTTP against the
// isolated in-memory service, so it touches no production data.
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformSearchHit } from "../../../shared/colonie-platform.ts";
import { createPlatformApp, type PlatformApp } from "./app.ts";
import { MemoryPlatformAuth } from "./auth.ts";
import { MemoryPlatformRepository } from "./memory-repository.ts";
import { generateSecretKey } from "./secrets.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

interface Person {
  cookie: string;
  id: string;
  email: string;
  name: string;
}

async function start(): Promise<{ service: PlatformApp["service"]; base: string }> {
  const repository = new MemoryPlatformRepository();
  const auth = new MemoryPlatformAuth();
  const app = createPlatformApp({ repository, auth, secretKey: generateSecretKey(), publicOrigin: "https://cloud.test" });
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { service: app.service, base: `http://127.0.0.1:${port}` };
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

async function signup(base: string, email: string, name: string): Promise<Person> {
  const res = await call(base, "/api/colonie/auth/sign-up/email", { method: "POST", body: { email, password: "password1234", name } });
  expect(res.status).toBe(200);
  return { cookie: res.cookie, id: res.body.user.id, email: res.body.user.email, name: res.body.user.name };
}

async function search(base: string, workspaceId: string, q: string, cookie?: string, limit?: number, conversationId?: string): Promise<{ status: number; body: { hits?: PlatformSearchHit[]; error?: string } }> {
  const params = new URLSearchParams({ q });
  if (limit !== undefined) params.set("limit", String(limit));
  if (conversationId) params.set("conversationId", conversationId);
  return call(base, `/api/colonie/platform/workspaces/${workspaceId}/search?${params}`, cookie ? { cookie } : {});
}

/** One workspace with an owner plus three members and one outsider. */
async function scenario() {
  const { service, base } = await start();
  const owner = await signup(base, "owner@test.dev", "Owner");
  const alice = await signup(base, "alice@test.dev", "Alice");
  const bob = await signup(base, "bob@test.dev", "Bob");
  const carol = await signup(base, "carol@test.dev", "Carol");
  const dave = await signup(base, "dave@test.dev", "Dave");
  const workspace = await service.createWorkspace(owner.id, owner, { name: "Acme", kind: "cloud" });
  for (const person of [alice, bob, carol]) {
    const { token } = await service.createInvitation(owner.id, workspace.id, { role: "member" });
    await service.acceptInvitation(person.id, person, token);
  }
  return { service, base, workspace, owner, alice, bob, carol, dave };
}

describe("workspace transcript search", () => {
  it("filters the requested conversation before limiting and checks its audience", async () => {
    const s = await scenario();
    const dm = await s.service.openDm(s.alice.id, s.workspace.id, { withAccountId: s.bob.id });
    await s.service.sendMessage(s.alice.id, dm.id, "beacon in the private conversation");
    const group = await s.service.createGroup(s.alice.id, s.workspace.id, { title: "Bulk", memberPrincipalIds: [] });
    for (let i = 0; i < 55; i++) await s.service.sendMessage(s.alice.id, group.id, `newer beacon ${i}`);
    const found = await search(s.base, s.workspace.id, "beacon", s.alice.cookie, 1.8, dm.id);
    expect(found.status).toBe(200);
    expect(found.body.hits).toHaveLength(1);
    expect(found.body.hits![0]!.conversationId).toBe(dm.id);
    expect((await search(s.base, s.workspace.id, "beacon", s.owner.cookie, 20, dm.id)).status).toBe(403);
    const other = await s.service.createWorkspace(s.alice.id, s.alice, { name: "Other", kind: "cloud" });
    expect((await search(s.base, other.id, "beacon", s.alice.cookie, 20, dm.id)).status).toBe(403);
  });
  it("shows a private human DM hit to its participants, and not to the owner or another member", async () => {
    const s = await scenario();
    const dm = await s.service.openDm(s.alice.id, s.workspace.id, { withAccountId: s.bob.id });
    await s.service.sendMessage(s.alice.id, dm.id, "dinner plan for friday");

    const asAlice = await search(s.base, s.workspace.id, "dinner", s.alice.cookie);
    expect(asAlice.status).toBe(200);
    expect(asAlice.body.hits).toHaveLength(1);
    const hit = asAlice.body.hits![0]!;
    expect(hit.conversationId).toBe(dm.id);
    expect(hit.conversationKind).toBe("dm");
    expect(hit.title).toBe("Bob");
    expect(hit.senderKind).toBe("human");
    expect(hit.senderName).toBe("Alice");
    // A human DM is never dressed up as a bot identity.
    expect(hit.botId).toBeUndefined();
    expect(hit.sequence).toBeGreaterThan(0);
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe("dinner");

    expect((await search(s.base, s.workspace.id, "dinner", s.bob.cookie)).body.hits).toHaveLength(1);
    // The owner and an uninvolved member see nothing of this DM.
    expect((await search(s.base, s.workspace.id, "dinner", s.owner.cookie)).body.hits).toHaveLength(0);
    expect((await search(s.base, s.workspace.id, "dinner", s.carol.cookie)).body.hits).toHaveLength(0);
  });

  it("returns the sequence so the caller can load the conversation around the hit", async () => {
    const s = await scenario();
    const dm = await s.service.openDm(s.alice.id, s.workspace.id, { withAccountId: s.bob.id });
    for (const body of ["first note", "second note", "find the beacon"]) await s.service.sendMessage(s.alice.id, dm.id, body);

    const { body } = await search(s.base, s.workspace.id, "beacon", s.alice.cookie);
    const hit = body.hits![0]!;
    expect(hit.sequence).toBe(3);
    const page = await call(s.base, `/api/colonie/platform/conversations/${dm.id}?after=${hit.sequence - 2}&limit=10`, { cookie: s.alice.cookie });
    expect(page.status).toBe(200);
    expect(page.body.messages.map((m: { body: string }) => m.body)).toContain("find the beacon");
  });

  it("keeps a Group hit inside its participants and names the Group", async () => {
    const s = await scenario();
    const group = await s.service.createGroup(s.alice.id, s.workspace.id, { title: "Launch Room", memberPrincipalIds: [] });
    await s.service.sendMessage(s.alice.id, group.id, "roadmap review at three");

    const asAlice = await search(s.base, s.workspace.id, "roadmap", s.alice.cookie);
    expect(asAlice.body.hits).toHaveLength(1);
    expect(asAlice.body.hits![0]!.conversationKind).toBe("group");
    expect(asAlice.body.hits![0]!.title).toBe("Launch Room");
    // Carol is a workspace member but not a participant of this Group.
    expect((await search(s.base, s.workspace.id, "roadmap", s.carol.cookie)).body.hits).toHaveLength(0);
  });

  it("carries the bot id for a bot DM but keeps a human sender human", async () => {
    const s = await scenario();
    const bot = await s.service.createBot(s.owner.id, s.workspace.id, { name: "Atlas" });
    const dm = await s.service.openDm(s.alice.id, s.workspace.id, { withBotId: bot.id });
    await s.service.sendMessage(s.alice.id, dm.id, "atlas please draft the note");
    await s.service.postBotMessage({ botPrincipalId: bot.principalId, conversationId: dm.id, body: "Here is a draft of the note.", initiatorAccountId: s.alice.id });

    const { body } = await search(s.base, s.workspace.id, "draft", s.alice.cookie);
    expect(body.hits!.length).toBeGreaterThanOrEqual(2);
    const fromHuman = body.hits!.find((h) => h.senderKind === "human")!;
    const fromBot = body.hits!.find((h) => h.senderKind === "bot")!;
    expect(fromHuman.botId).toBe(bot.id);
    expect(fromBot.botId).toBe(bot.id);
    expect(fromBot.senderName).toBe("Atlas");
    // The bot's DM stays hidden from a member who is not a participant.
    expect((await search(s.base, s.workspace.id, "draft", s.carol.cookie)).body.hits).toHaveLength(0);
  });

  it("separates tenants: another workspace never leaks in", async () => {
    const s = await scenario();
    const dm = await s.service.openDm(s.alice.id, s.workspace.id, { withAccountId: s.bob.id });
    await s.service.sendMessage(s.alice.id, dm.id, "dinner plan for friday");
    const other = await s.service.createWorkspace(s.owner.id, s.owner, { name: "Other Co", kind: "cloud" });

    // The owner belongs to both workspaces, yet the hit never crosses over.
    expect((await search(s.base, other.id, "dinner", s.owner.cookie)).body.hits).toHaveLength(0);
    // Someone who is not a member at all is refused, not shown an empty list.
    expect((await search(s.base, s.workspace.id, "dinner", s.dave.cookie)).status).toBe(403);
  });

  it("refuses search once membership is revoked", async () => {
    const s = await scenario();
    const dm = await s.service.openDm(s.alice.id, s.workspace.id, { withAccountId: s.bob.id });
    await s.service.sendMessage(s.alice.id, dm.id, "dinner plan for friday");
    expect((await search(s.base, s.workspace.id, "dinner", s.alice.cookie)).status).toBe(200);

    await s.service.removeMember(s.owner.id, s.workspace.id, s.alice.id);
    expect((await search(s.base, s.workspace.id, "dinner", s.alice.cookie)).status).toBe(403);
    // The other participant still sees it.
    expect((await search(s.base, s.workspace.id, "dinner", s.bob.cookie)).body.hits).toHaveLength(1);
  });

  it("matches literally, so LIKE wildcards cannot widen a query", async () => {
    const s = await scenario();
    const group = await s.service.createGroup(s.alice.id, s.workspace.id, { title: "Literal", memberPrincipalIds: [] });
    await s.service.sendMessage(s.alice.id, group.id, "alphabet soup");
    await s.service.sendMessage(s.alice.id, group.id, "progress is 100% done");
    await s.service.sendMessage(s.alice.id, group.id, "snake_case name");

    // Percent, underscore and the LIKE wildcards are ordinary characters.
    expect((await search(s.base, s.workspace.id, "100%", s.alice.cookie)).body.hits).toHaveLength(1);
    expect((await search(s.base, s.workspace.id, "%", s.alice.cookie)).body.hits).toHaveLength(1);
    expect((await search(s.base, s.workspace.id, "snake_case", s.alice.cookie)).body.hits).toHaveLength(1);
    expect((await search(s.base, s.workspace.id, "alp%", s.alice.cookie)).body.hits).toHaveLength(0);
    expect((await search(s.base, s.workspace.id, "%100", s.alice.cookie)).body.hits).toHaveLength(0);
    // `_` is not a single-character wildcard.
    expect((await search(s.base, s.workspace.id, "snake case", s.alice.cookie)).body.hits).toHaveLength(0);
    expect((await search(s.base, s.workspace.id, "ALPHABET", s.alice.cookie)).body.hits).toHaveLength(1);
  });

  it("bounds the query and the limit", async () => {
    const s = await scenario();
    const group = await s.service.createGroup(s.alice.id, s.workspace.id, { title: "Bulk", memberPrincipalIds: [] });
    for (let i = 0; i < 60; i += 1) await s.service.sendMessage(s.alice.id, group.id, `bulk message number ${i}`);

    expect((await search(s.base, s.workspace.id, "   ", s.alice.cookie)).status).toBe(400);
    expect((await search(s.base, s.workspace.id, "x".repeat(201), s.alice.cookie)).status).toBe(400);
    // An over-large limit is clamped to the server maximum, not obeyed.
    expect((await search(s.base, s.workspace.id, "bulk", s.alice.cookie, 1000)).body.hits).toHaveLength(50);
    // A zero/negative limit is clamped to one hit.
    expect((await search(s.base, s.workspace.id, "bulk", s.alice.cookie, 0)).body.hits).toHaveLength(1);
    // The default stays modest.
    expect((await search(s.base, s.workspace.id, "bulk", s.alice.cookie)).body.hits).toHaveLength(20);
  });

  it("refuses an unauthenticated request", async () => {
    const s = await scenario();
    const res = await search(s.base, s.workspace.id, "anything");
    expect(res.status).toBe(401);
  });
});
