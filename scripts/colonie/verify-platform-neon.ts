/** Explicit opt-in PostgreSQL workflow verification. Uses a fresh, disposable
 * schema, fake identities and one private temp directory; never production
 * conversations. Optional --real adds exactly one bounded native AI request. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { directDatabaseUrl, startPlatformHost, type PlatformHostConfig } from "../../server/colonie/platform/host.ts";
import type { ComposioProvider } from "../../server/colonie/platform/composio.ts";

const arg = (key: string) => { const at = process.argv.indexOf(key); return at < 0 ? undefined : process.argv[at + 1]; };
const infraFile = arg("--infra-file");
if (!infraFile) throw new Error("An explicit private --infra-file is required.");
const real = process.argv.includes("--real");
const authRoot = arg("--auth-root");
if (real && !authRoot) throw new Error("A real check needs an explicit read-only native --auth-root.");
const infra = JSON.parse(await readFile(infraFile, "utf8")) as { databaseUrl: string };
const root = await mkdtemp(join(tmpdir(), "colonie-platform-neon-"));
const schema = `colonie_fixture_${randomBytes(8).toString("hex")}`;
const port = await new Promise<number>((done, fail) => { const server = createServer(); server.on("error", fail); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => done(port)); }); });
const origin = `http://127.0.0.1:${port}`;
const publicOrigin = arg("--public-origin") ?? origin;
const config: PlatformHostConfig = {
  databaseUrl: infra.databaseUrl, schema, publicOrigin, authSecret: randomBytes(32).toString("hex"), secretKey: randomBytes(32).toString("base64"),
  runtimeRoot: join(root, "runtime"), claudeConfigDir: join(root, "native-claude"), port,
  staticDir: resolve("dist"), disableRuntime: !real,
  ...(arg("--adapter") ? { claudeAdapterEntry: resolve(arg("--adapter")!) } : {}),
  ...(arg("--native-cli") ? { claudeExecutable: resolve(arg("--native-cli")!) } : {}),
};
let host: Awaited<ReturnType<typeof startPlatformHost>> | undefined;
const result = (check: string, evidence: unknown) => console.log(JSON.stringify({ check, evidence }));
const API = "/api/colonie/platform";
const AUTH = "/api/colonie/auth";
const fixtureComposio: ComposioProvider = {
  validateProjectKey: async ({ apiKey }) => apiKey === "ak_SYNTHETIC_READ_ONLY"
    ? { ok: false, code: "session_write_required", message: "This key requires session_management write access." }
    : { ok: true },
  createLink: async () => ({ redirectUrl: "https://connect.composio.dev/isolated-fixture" }),
  verifyCallback: async ({ userId, sessionUri }) => sessionUri === `SYNTHETIC_VERIFIER:${userId}`
    ? { active: true, connectedAccountId: `synthetic-connection-${userId}`, toolkit: "gmail" }
    : { active: false, code: "identity_mismatch", message: "Fixture identity mismatch." },
};
type Client = { cookie: string; id: string; ip?: string };
let clientNumber = 0;

async function call(client: Client | null, method: string, path: string, body?: unknown, expected = 200) {
  if (path.includes("/composio")) result("fixture-app-request", { method, endpoint: path.split("/composio")[1] });
  const response = await fetch(origin + path, { method, headers: { origin: publicOrigin, host: new URL(publicOrigin).host,
    ...(client?.ip ? { "x-forwarded-for": client.ip } : {}), ...(client?.cookie ? { cookie: client.cookie } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
    .catch(() => { throw new Error(`Isolated request ${method} ${path} did not complete.`); });
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, received ${response.status}`);
  if (path.includes("/composio")) result("fixture-app-response", { status: response.status });
  const cookies = response.headers.getSetCookie();
  if (path === `${AUTH}/sign-up/email` && publicOrigin.startsWith("https:")) {
    assert.ok(cookies.some((cookie) => /;\s*Secure(?:;|$)/i.test(cookie) && /;\s*HttpOnly(?:;|$)/i.test(cookie)), "HTTPS accounts must set a Secure HttpOnly session cookie");
  }
  if (client && cookies.length) client.cookie = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  return response.status === 204 ? {} : response.json();
}

async function signup(label: string): Promise<Client> {
  // Separate synthetic clients reproduce the HTTPS gateway's per-client IP
  // header; four hot signups from one IP correctly hit the production limit.
  const client = { cookie: "", id: "", ip: `198.51.100.${++clientNumber}` };
  const value = await call(client, "POST", `${AUTH}/sign-up/email`, { email: `${label}-${schema}@example.test`, name: label, password: "Fixture-only-password-2026" });
  client.id = value.user.id;
  assert.ok(client.cookie, "Signup must set an HttpOnly session cookie");
  assert.equal((await call(client, "GET", `${AUTH}/get-session`)).user.id, client.id);
  return client;
}

async function joinWorkspace(owner: Client, person: Client, workspaceId: string, role = "member") {
  const invitation = await call(owner, "POST", `${API}/workspaces/${workspaceId}/invitations`, { role });
  assert.ok(invitation.token && invitation.url);
  await call(person, "POST", `${API}/invitations/accept`, { token: invitation.token });
  return invitation;
}

async function replay(client: Client, workspaceId: string) {
  return host!.app.service.replay(client.id, workspaceId, null, 0, 500);
}

try {
  if (real) {
    await mkdir(config.claudeConfigDir);
    // Only the native CLI follows this link. Credential bytes are never read,
    // copied, logged or handled by this script. The donor must be read-only.
    await symlink(join(resolve(authRoot!), ".credentials.json"), join(config.claudeConfigDir, ".credentials.json"));
  }
  host = await startPlatformHost(config, { composioProvider: fixtureComposio, toolResolver: async () => [] });
  const accept = host.app.service.acceptInvitation.bind(host.app.service);
  host.app.service.acceptInvitation = async (...args) => {
    try { return await accept(...args); }
    catch (error) {
      const failure = error as { code?: string; constraint?: string; message?: string };
      result("fixture-invitation-error", {
        code: failure.code, constraint: failure.constraint,
        message: failure.message?.replace(/postgres(?:ql)?:\/\/\S+/gi, "[private database connection]").slice(0, 250),
      });
      throw error;
    }
  };
  const owner = await signup("Owner");
  const member = await signup("Member");
  const admin = await signup("Admin");
  const outsider = await signup("Outsider");
  result("real-auth", { signupWithoutEmailVerification: true, fourIndependentAccounts: true, nativeEngineLoginPerformed: false });
  await call(null, "GET", `${API}/workspaces`, undefined, 401);
  const workspace = (await call(owner, "POST", `${API}/workspaces`, { name: "Disposable shared workplace", kind: "cloud" }, 200)).workspace;
  const otherWorkspace = (await call(outsider, "POST", `${API}/workspaces`, { name: "Separate workplace", kind: "cloud" }, 200)).workspace;
  await joinWorkspace(owner, member, workspace.id);
  await joinWorkspace(owner, admin, workspace.id, "admin");
  const list = (await call(member, "GET", `${API}/workspaces`)).workspaces;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, workspace.id);
  await call(outsider, "GET", `${API}/workspaces/${workspace.id}`, undefined, 403);
  await call(member, "GET", `${API}/workspaces/${otherWorkspace.id}`, undefined, 403);
  result("workspace-and-invites", { inviteAcceptedIntoCorrectWorkspace: true, crossWorkspaceDenied: true });
  const dm = (await call(member, "POST", `${API}/workspaces/${workspace.id}/conversations/open`, { kind: "dm", withAccountId: admin.id }, 200)).conversation;
  await call(member, "POST", `${API}/conversations/${dm.id}/messages`, { body: "PRIVATE_DM_FIXTURE" }, 200);
  assert.equal((await call(admin, "GET", `${API}/conversations/${dm.id}`)).messages[0].body, "PRIVATE_DM_FIXTURE");
  await call(owner, "GET", `${API}/conversations/${dm.id}`, undefined, 403);
  assert.ok(!(JSON.stringify(await replay(owner, workspace.id))).includes("PRIVATE_DM_FIXTURE"), "Workspace replay must not leak another person's DM to an owner");
  result("human-dm-privacy", { participantRead: true, workspaceOwnerReadDenied: true, ownerReplayHasNoPrivateDm: true });
  const members = (await call(owner, "GET", `${API}/workspaces/${workspace.id}/members`)).members;
  const group = (await call(member, "POST", `${API}/workspaces/${workspace.id}/groups`, { title: "Private Group", memberPrincipalIds: members.filter((person: { accountId: string }) => person.accountId === admin.id).map((person: { principalId: string }) => person.principalId) }, 200)).conversation;
  await call(member, "POST", `${API}/conversations/${group.id}/messages`, { body: "GROUP_FIXTURE" }, 200);
  await call(owner, "GET", `${API}/conversations/${group.id}`, undefined, 403);
  const connection = (await call(member, "POST", `${API}/workspaces/${workspace.id}/connections`, { toolkit: "fixture", audience: "personal", secret: "SYNTHETIC_SECRET_123456" }, 200)).connection;
  assert.equal(connection.hasSecret, true);
  assert.ok(!JSON.stringify(connection).includes("SYNTHETIC_SECRET_123456"));
  assert.ok(!(await call(owner, "GET", `${API}/workspaces/${workspace.id}/connections`)).connections.some((item: { id: string }) => item.id === connection.id));
  result("group-and-connections", { privateGroupDeniedToNonParticipantOwner: true, memberPersonalConnectionStoredMasked: true, personalConnectionHiddenFromOwner: true });
  const apps = `${API}/workspaces/${workspace.id}/composio`;
  const configured = await call(owner, "PUT", `${apps}/key`, { apiKey: "ak_SYNTHETIC_WORKSPACE_KEY" });
  assert.equal(configured.configured, true);
  assert.ok(!JSON.stringify(configured).includes("ak_SYNTHETIC_WORKSPACE_KEY"));
  await call(member, "PUT", `${apps}/key`, { apiKey: "ak_SYNTHETIC_FORBIDDEN_KEY" }, 403);
  await call(owner, "PUT", `${apps}/key`, { apiKey: "ak_SYNTHETIC_READ_ONLY" }, 422);
  assert.equal((await call(owner, "GET", apps)).maskedHint, configured.maskedHint);
  const started = await call(member, "POST", `${apps}/connections`, { toolkit: "gmail", audience: "personal" });
  const sessionUri = `SYNTHETIC_VERIFIER:${started.link.userId}`;
  await call(owner, "POST", `${apps}/connections/complete`, { state: started.state, sessionUri }, 403);
  const completed = await call(member, "POST", `${apps}/connections/complete`, { state: started.state, sessionUri });
  assert.equal(completed.link.status, "active");
  assert.equal((await call(owner, "GET", `${apps}/connections`)).links.length, 0);
  const shared = await call(owner, "POST", `${apps}/connections`, { toolkit: "gmail", audience: "shared" });
  await call(owner, "POST", `${apps}/connections/complete`, { state: shared.state, sessionUri: `SYNTHETIC_VERIFIER:${shared.link.userId}` });
  const sharedAccess = await host.composioService.resolveToolAccess(member.id, workspace.id, "shared");
  assert.equal(sharedAccess.connections.length, 1);
  const storedReference = await host.repository.getSecretReference(sharedAccess.keyRef);
  assert.ok(storedReference?.ciphertext && storedReference.iv && storedReference.authTag);
  assert.notEqual(storedReference.ciphertext, "ak_SYNTHETIC_WORKSPACE_KEY");
  assert.equal(sharedAccess.key, "ak_SYNTHETIC_WORKSPACE_KEY");
  assert.equal(await host.composioService.checkToolAccess(sharedAccess, sharedAccess.connections[0]!), true);
  result("workspace-composio-storage", { encryptedProjectKeyStored: true, failedKeyReplacementPreservesPrevious: true, personalCallbackOwnerChecked: true,
    sharedReadIdentityAvailableToMembers: true, providerSimulated: true, realOAuthVerified: false });
  const snapshot = await call(member, "GET", `${API}/conversations/${dm.id}`);
  await host.close(); host = undefined;
  host = await startPlatformHost(config, { composioProvider: fixtureComposio, toolResolver: async () => [] });
  assert.equal((await call(member, "GET", `${AUTH}/get-session`)).user.id, member.id);
  assert.deepEqual((await call(member, "GET", `${API}/conversations/${dm.id}`)).messages, snapshot.messages);
  assert.equal((await call(owner, "GET", apps)).maskedHint, configured.maskedHint);
  assert.equal((await call(member, "GET", `${apps}/connections`)).links.find((link: { id: string }) => link.id === completed.link.id).status, "active");
  await call(member, "DELETE", `${apps}/connections/${completed.link.id}`);
  await call(member, "POST", `${apps}/connections/complete`, { state: started.state, sessionUri }, 410);
  result("restart-persistence", { sessionStillValid: true, messageHistoryUnchanged: true });
  const recovery = await call(outsider, "POST", `${API}/account/recovery-key`, {});
  assert.ok(recovery.recoveryKey && !JSON.stringify(await call(owner, "GET", `${API}/workspaces/${workspace.id}`)).includes(recovery.recoveryKey));
  await call(null, "POST", `${API}/account/recover`, { recoveryKey: recovery.recoveryKey, newPassword: "Recovered-fixture-password-2026" });
  await call(outsider, "GET", `${API}/workspaces`, undefined, 401);
  await call(null, "POST", `${AUTH}/sign-in/email`, { email: `Outsider-${schema}@example.test`, password: "Fixture-only-password-2026" }, 401);
  await call(outsider, "POST", `${AUTH}/sign-in/email`, { email: `Outsider-${schema}@example.test`, password: "Recovered-fixture-password-2026" });
  await call(null, "POST", `${API}/account/recover`, { recoveryKey: recovery.recoveryKey, newPassword: "Another-fixture-password-2026" }, 410);
  result("account-recovery", { oneTimeKey: true, passwordChanged: true, previousSessionsRevoked: true, emailDeliveryRequired: false });
  if (real) {
    const bot = (await call(owner, "POST", `${API}/workspaces/${workspace.id}/bots`, { name: "Bounded AI fixture" }, 200)).bot;
    const conversation = (await call(owner, "POST", `${API}/workspaces/${workspace.id}/conversations/open`, { kind: "dm", withBotId: bot.id }, 200)).conversation;
    await call(owner, "POST", `${API}/conversations/${conversation.id}/messages`, { body: "Reply with exactly COLONIE_PLATFORM_CLAUDE_OK. Do not use tools or take any actions. This is one bounded connectivity check." }, 200);
    const deadline = Date.now() + 130_000;
    let reply = "";
    while (Date.now() < deadline) {
      const rows = (await call(owner, "GET", `${API}/conversations/${conversation.id}`)).messages;
      reply = rows.filter((message: { senderKind: string }) => message.senderKind === "bot").map((message: { body: string }) => message.body).join("\n");
      if (reply) break;
      await new Promise((done) => setTimeout(done, 500));
    }
    assert.equal(reply, "COLONIE_PLATFORM_CLAUDE_OK");
    result("real-provider-turn", { provider: "claude-acp", reply, persisted: true, paidRequests: 1, nativeEngineLoginPerformed: false });
  }
  await call(owner, "DELETE", `${API}/workspaces/${workspace.id}/members/${member.id}`, undefined, 200);
  await call(member, "GET", `${API}/conversations/${dm.id}`, undefined, 403);
  result("revocation", { removedMemberDenied: true });
  result("complete", { simulatedProvider: !real, postgresWorkflow: true, rendererVerified: false, desktopVerified: false, phoneVerified: false });
} finally {
  await host?.close();
  const cleanup = new Pool({ connectionString: directDatabaseUrl(infra.databaseUrl), max: 1 });
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); result("cleanup", { disposableSchemaRemoved: true }); }
  finally { await cleanup.end(); await rm(root, { recursive: true, force: true }); }
}
