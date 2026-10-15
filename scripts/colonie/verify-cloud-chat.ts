/** Disposable real-provider check of an invited member, default connected-app
 * resolution, human DM and AI DM. No production conversations or auth writes. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { directDatabaseUrl, startPlatformHost } from "../../server/colonie/platform/host.ts";

const arg = (key: string) => { const at = process.argv.indexOf(key); return at < 0 ? undefined : process.argv[at + 1]; };
const infraFile = arg("--infra-file");
const authRoot = arg("--auth-root");
if (!infraFile || !authRoot || !process.argv.includes("--real")) throw new Error("Explicit --infra-file, read-only --auth-root and --real are required.");
const { databaseUrl } = JSON.parse(await readFile(infraFile, "utf8")) as { databaseUrl: string };
const schema = `colonie_chat_fixture_${randomBytes(6).toString("hex")}`;
const root = await mkdtemp(join(tmpdir(), "colonie-cloud-chat-"));
const nativeHome = join(root, "native");
await mkdir(nativeHome, { mode: 0o700 });
await symlink(join(resolve(authRoot), ".credentials.json"), join(nativeHome, ".credentials.json"));
let host: Awaited<ReturnType<typeof startPlatformHost>> | undefined;
type Person = { cookie: string; id: string };
const API = "/api/colonie/platform";

try {
  host = await startPlatformHost({ databaseUrl, schema, publicOrigin: "http://127.0.0.1", port: 0,
    authSecret: randomBytes(32).toString("hex"), secretKey: randomBytes(32).toString("base64"),
    runtimeRoot: join(root, "runtime"), claudeConfigDir: nativeHome,
    claudeAdapterEntry: arg("--adapter"), claudeExecutable: arg("--native-cli"),
  });
  async function call(person: Person, path: string, body?: unknown) {
    const response = await fetch(host!.origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { cookie: person.cookie, origin: "http://127.0.0.1", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `Isolated ${path.split("/").at(-1)}: HTTP ${response.status}`);
    if (response.headers.getSetCookie().length) person.cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    return response.json();
  }
  async function signup(label: string): Promise<Person> {
    const person = { cookie: "", id: "" };
    const result = await call(person, "/api/colonie/auth/sign-up/email", { email: `${label}-${schema}@example.test`, name: label, password: "Disposable-only-password-2026" });
    person.id = result.user.id;
    return person;
  }
  const owner = await signup("Owner");
  const member = await signup("Member");
  const { workspace } = await call(owner, `${API}/workspaces`, { name: "Disposable invited-team check", kind: "cloud" });
  const invitation = await call(owner, `${API}/workspaces/${workspace.id}/invitations`, {});
  await call(member, `${API}/invitations/accept`, { token: invitation.token });
  const human = await call(member, `${API}/workspaces/${workspace.id}/conversations/open`, { kind: "dm", withAccountId: owner.id });
  await call(member, `${API}/conversations/${human.conversation.id}/messages`, { body: "INVITED_HUMAN_DM_OK" });
  const received = await call(owner, `${API}/conversations/${human.conversation.id}`);
  assert.equal(received.messages.at(-1).body, "INVITED_HUMAN_DM_OK");
  await call(owner, `${API}/conversations/${human.conversation.id}/messages`, { body: "INVITED_HUMAN_REPLY_OK" });
  assert.equal((await call(member, `${API}/conversations/${human.conversation.id}`)).messages.at(-1).body, "INVITED_HUMAN_REPLY_OK");
  console.log(JSON.stringify({ check: "invited-human-dm", sentAndReplied: true, isolated: true }));
  const { bot } = await call(owner, `${API}/workspaces/${workspace.id}/bots`, { name: "Bounded bot" });
  const { conversation } = await call(member, `${API}/workspaces/${workspace.id}/conversations/open`, { kind: "dm", withBotId: bot.id });
  await call(member, `${API}/conversations/${conversation.id}/messages`, { body: "Reply with exactly COLONIE_INVITED_CHAT_OK. No tools, no other actions. This is one bounded connectivity check." });
  const deadline = Date.now() + 130_000;
  let reply = "";
  while (Date.now() < deadline) {
    const { messages } = await call(member, `${API}/conversations/${conversation.id}`);
    reply = messages.filter((message: { senderKind: string }) => message.senderKind === "bot").map((message: { body: string }) => message.body).join("\n");
    if (reply) break;
    const replay = await host.app.service.replay(member.id, workspace.id, conversation.id, 0, 500);
    const failed = replay.map((frame) => frame.event).find((event) => event.type === "turn" && event.state === "error");
    if (failed && failed.type === "turn") throw new Error(failed.error ?? "The isolated AI turn failed.");
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.equal(reply, "COLONIE_INVITED_CHAT_OK");
  console.log(JSON.stringify({ check: "invited-real-ai-dm", reply, defaultToolResolver: true, noComposioSetup: true, paidRequests: 1, nativeLoginPerformed: false }));
} finally {
  await host?.close();
  const cleanup = new Pool({ connectionString: directDatabaseUrl(databaseUrl), max: 1 });
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await cleanup.end(); await rm(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ check: "cleanup", disposableSchemaRemoved: true, productionConversationsTouched: false }));
}
