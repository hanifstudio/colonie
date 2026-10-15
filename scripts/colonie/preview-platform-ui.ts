/** Disposable, loopback-only owner review of an already-built renderer.
 * No real accounts, native authentication, database or provider calls. */
import { createServer } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createPlatformApp } from "../../server/colonie/platform/app.ts";
import { MemoryPlatformAuth } from "../../server/colonie/platform/auth.ts";
import { MemoryPlatformRepository } from "../../server/colonie/platform/memory-repository.ts";
import { json } from "../../server/harness/http.ts";

const staticRoot = resolve(".devone/ui-preview-dist");
await stat(resolve(staticRoot, "index.html"));
const auth = new MemoryPlatformAuth();
const owner = auth.seed("owner@preview.test", "colonie-preview-only", "Preview Owner");
const teammate = auth.seed("avery@preview.test", "colonie-preview-only", "Avery");
const app = createPlatformApp({ repository: new MemoryPlatformRepository(), auth,
  runtime: { onTurn: async (request) => {
    await app.service.postBotMessage({ botPrincipalId: request.botPrincipalId,
      conversationId: request.conversationId, initiatorAccountId: request.initiatorAccountId,
      body: "This is a simulated reply for the UI preview. You can explore the restored interface here; no AI provider is connected." });
  } },
});
const workspace = await app.service.createWorkspace(owner.id, owner, { name: "Colonie UI Review", kind: "cloud" });
const invite = await app.service.createInvitation(owner.id, workspace.id, {});
await app.service.acceptInvitation(teammate.id, teammate, invite.token);
const atlas = await app.service.createBot(owner.id, workspace.id, { name: "Atlas", title: "Research partner",
  description: "Helps the team explore ideas and find useful information.",
  soul: "Be clear, thoughtful, and concise. Ask before taking actions on behalf of the team.", color: "purple" });
await app.service.createBot(owner.id, workspace.id, { name: "Nova", title: "Writing partner", description: "Helps the team write and refine ideas.", color: "orange" });
const dm = await app.service.openDm(owner.id, workspace.id, { withBotId: atlas.id });
await app.service.sendMessage(owner.id, dm.id, "Let's review the original Colonie interface.");
await app.service.postBotMessage({ botPrincipalId: atlas.principalId, conversationId: dm.id,
  initiatorAccountId: owner.id, body: "Welcome to the UI review. Open my profile to explore Identity and Soul, or open workspace settings to try Appearance. This workspace uses example data." });
const members = await app.service.listMembers(owner.id, workspace.id);
const group = await app.service.createGroup(owner.id, workspace.id, { title: "Design review",
  memberPrincipalIds: members.filter((member) => member.accountId === teammate.id).map((member) => member.principalId) });
await app.service.sendMessage(teammate.id, group.id, "We can review the restored layout, settings, shortcuts, and search here.");
const humanDm = await app.service.openDm(owner.id, workspace.id, { withAccountId: teammate.id });
await app.service.sendMessage(teammate.id, humanDm.id, "Hi! This is an example private conversation between teammates.");

let origin = "";
let cookies: string[] = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__fixture/review") {
      res.writeHead(302, { "set-cookie": cookies, location: "/" });
      return res.end();
    }
    if (url.pathname === "/api/colonie/bootstrap") return json(res, 200, { mode: "platform", origin });
    if (await app.handle(req, res)) return;
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "This example workspace does not provide that feature." });
    const path = resolve(staticRoot, `.${url.pathname}`);
    if (path !== staticRoot && !path.startsWith(staticRoot + sep)) return json(res, 404, {});
    const file = (await stat(path).catch(() => null))?.isFile() ? path : resolve(staticRoot, "index.html");
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    if (!res.headersSent) json(res, 500, { error: "The preview could not serve this request." });
    else res.end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const login = await fetch(`${origin}/api/colonie/auth/sign-in/email`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ email: owner.email, password: "colonie-preview-only" }) });
if (!login.ok) throw new Error("The example account could not be opened.");
cookies = login.headers.getSetCookie();
if (!cookies.length) throw new Error("The example account has no session.");
const reviewUrl = `${origin}/__fixture/review`;
await mkdir(resolve(".devone/evidence"), { recursive: true });
await writeFile(resolve(".devone/evidence/ui-recovery-review.json"), JSON.stringify({ url: reviewUrl,
  pid: process.pid, isolated: true, syntheticAccount: true, simulatedProvider: true, staticRoot }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ reviewUrl, pid: process.pid, ready: true, simulatedProvider: true }));
await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
server.closeAllConnections();
await new Promise<void>((done) => server.close(() => done()));
await app.close();
