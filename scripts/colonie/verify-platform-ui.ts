/** Real Chromium/Electron renderer, isolated HTTP platform and synthetic
 * identities/provider replies. Never visits or mutates the live deployment. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { createPlatformApp } from "../../server/colonie/platform/app.ts";
import { MemoryPlatformRepository } from "../../server/colonie/platform/memory-repository.ts";
import { MemoryPlatformAuth } from "../../server/colonie/platform/auth.ts";
import { json } from "../../server/harness/http.ts";
import type { Page, Browser, ElectronApplication } from "playwright";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".devone/browsers");
const { chromium, _electron } = await import("playwright");
const desktop = process.argv.includes("--desktop");
const root = await mkdtemp(join(tmpdir(), "colonie-platform-ui-"));
const evidenceDir = resolve(".devone/evidence");
await mkdir(evidenceDir, { recursive: true });
const app = createPlatformApp({ repository: new MemoryPlatformRepository(), auth: new MemoryPlatformAuth(),
  runtime: { onTurn: async (request) => {
    if (request.message.body === "UI_AUTH_ERROR_FIXTURE") {
      await app.service.publishTurnState({ botPrincipalId: request.botPrincipalId, conversationId: request.conversationId,
        state: "error", error: "The workspace AI connection needs attention. Your workspace owner can reconnect it; your message is saved." });
      return;
    }
    await app.service.postBotMessage({ botPrincipalId: request.botPrincipalId, conversationId: request.conversationId,
      initiatorAccountId: request.initiatorAccountId, body: "UI_PROVIDER_FIXTURE_REPLY" });
  } },
});
const staticRoot = resolve("dist");
let origin = "";
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/api/colonie/bootstrap") return json(res, 200, { mode: "platform", origin });
    if (await app.handle(req, res)) return;
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Fixture has no such endpoint." });
    const requested = resolve(staticRoot, `.${url.pathname}`);
    if (requested !== staticRoot && !requested.startsWith(staticRoot + sep)) return json(res, 404, {});
    const file = (await stat(requested).catch(() => null))?.isFile() ? requested : join(staticRoot, "index.html");
    res.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".html": "text/html", ".woff2": "font/woff2" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { if (!res.headersSent) json(res, 500, { error: "Fixture failed." }); else res.end(); }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let browser: Browser | undefined;
let electron: ElectronApplication | undefined;
let activePage: Page | undefined;
const errors: string[] = [];
const report: Record<string, unknown> = { completed: false, simulatedProvider: true, isolated: true, desktop, physicalPhone: false };

async function nativeWindow(predicate: (page: Page) => boolean, timeout = 30_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = electron?.windows().find(predicate);
    if (match) return match;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("The isolated native app did not open its expected window.");
}

async function signup(page: Page, name: string, invited = false) {
  if (invited) await page.getByRole("button", { name: "Create one", exact: true }).click();
  await page.getByLabel("Your name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(`${name.toLowerCase()}@example.test`);
  await page.getByLabel(/^Password/).fill("Synthetic-only-password-2026");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  // Signup now offers a real returned recovery key without email delivery.
  const continued = page.getByRole("button", { name: "Continue", exact: true });
  await continued.waitFor({ state: "visible", timeout: 15_000 });
  await continued.click();
}

async function cloudWorkspace(page: Page, name: string) {
  await page.getByLabel(/^Workspace name/).fill(name);
  await page.getByRole("button", { name: /^Cloud/ }).click();
  await page.getByRole("button", { name: "Create a bot", exact: true }).first().waitFor();
}

async function firstBot(page: Page) {
  await page.getByRole("button", { name: "Create a bot", exact: true }).first().click();
  await page.getByLabel("Bot name", { exact: true }).fill("Atlas");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Hello from the actual renderer");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("log").getByText("UI_PROVIDER_FIXTURE_REPLY", { exact: true }).waitFor();
}

try {
  let page: Page;
  if (desktop) {
    const packaged = process.argv.indexOf("--executable");
    const executablePath = packaged >= 0 ? process.argv[packaged + 1] : undefined;
    const env = { ...process.env, COLONIE_PROFILE: "1", COLONIE_PLATFORM_DISABLED: "0", COLONIE_DATA_DIR: join(root, "legacy-data"), COLONIE_USER_DATA: join(root, "electron-profile"),
      COLONIE_PLATFORM_ORIGIN: origin, COLONIE_TEST_ACP_FIXTURE: "1", COLONIE_TEST_HIDE_WINDOW: "1",
      DEVONE_ACP_ENTRY: resolve("server/devone/testing/fake-agent.ts"), COLONIE_CLAUDE_ACP_ENTRY: resolve("server/devone/testing/fake-agent.ts") };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve(".")] }), env, timeout: 30_000 });
    electron.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));
    page = await nativeWindow((candidate) => candidate.url().startsWith(origin));
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(origin);
  }
  activePage = page;
  page.on("pageerror", (error) => errors.push(error.message));
  await signup(page, "Owner");
  await cloudWorkspace(page, "Renderer team");
  await firstBot(page);
  // Exercise an actual failure event through the HTTP/SSE/UI boundary: the
  // sent message stays visible and the error must reach the composer.
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("UI_AUTH_ERROR_FIXTURE");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByText(/The workspace AI connection needs attention/).waitFor();
  await page.getByRole("log").getByText("UI_AUTH_ERROR_FIXTURE", { exact: true }).waitFor();
  report.aiErrorShownAndSentMessagePreserved = true;
  await page.reload();
  await page.getByRole("button", { name: /Atlas/ }).first().click();
  await page.getByRole("log").getByText("UI_PROVIDER_FIXTURE_REPLY", { exact: true }).waitFor();
  report.signupCloudBotChatAndReload = true;
  await page.screenshot({ path: join(evidenceDir, desktop ? "platform-native-cloud.png" : "platform-browser-cloud.png") });

  if (browser) {
    const ownerSession = await page.evaluate(async () => (await fetch("/api/colonie/auth/get-session")).json());
    const workspaces = await app.service.listWorkspaces(ownerSession.user.id);
    const workspaceId = workspaces[0]!.id;
    const invitation = await app.service.createInvitation(ownerSession.user.id, workspaceId, {});
    const invitedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const invited = await invitedContext.newPage();
    invited.on("pageerror", (error) => errors.push(error.message));
    await invited.goto(`${origin}/invite/${invitation.token}`);
    await signup(invited, "Member", true);
    await invited.getByRole("button", { name: "Open navigation", exact: true }).click();
    assert.ok(await invited.getByText("Renderer team", { exact: true }).count());
    assert.equal(await invited.getByText("Create your first workspace", { exact: true }).count(), 0);
    await invited.screenshot({ path: join(evidenceDir, "platform-mobile-invited.png") });
    report.invitationSkipsCreationAndEngineSetup = true;
    report.mobileViewport = { width: 390, height: 844 };
    // An ordinary invited member must see the workspace bot before having a
    // DM with it. The rejected shell listed only already-open bot DMs.
    await invited.getByRole("button", { name: /Atlas/ }).first().click();
    await invited.getByRole("textbox", { name: "Message", exact: true }).fill("Invited member can reach the bot");
    await invited.getByRole("button", { name: "Send message", exact: true }).click();
    await invited.getByRole("log").getByText("UI_PROVIDER_FIXTURE_REPLY", { exact: true }).waitFor();
    report.invitedMemberCanOpenAndChatWithExistingBot = true;
    await invited.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "New direct message", exact: true }).first().click();
    await page.getByRole("dialog", { name: "New direct message", exact: true }).getByRole("button", { name: /^Member/ }).click();
    await page.getByPlaceholder("Message Member", { exact: true }).fill("HUMAN_DM_UI_ONLY");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await invited.getByRole("button", { name: /^Owner/ }).first().click();
    await invited.getByText("HUMAN_DM_UI_ONLY", { exact: true }).waitFor();
    await invited.getByPlaceholder("Message Owner", { exact: true }).fill("HUMAN_DM_UI_REPLY");
    await invited.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("HUMAN_DM_UI_REPLY", { exact: true }).waitFor();
    assert.equal(await page.getByRole("log").getByText("UI_PROVIDER_FIXTURE_REPLY", { exact: true }).count(), 0);
    report.humanDmBetweenIndependentBrowserContexts = true;
    await invited.waitForFunction(() => (document.querySelector("[data-sidebar]")?.getBoundingClientRect().right ?? 0) <= 1);
    await invited.screenshot({ path: join(evidenceDir, "platform-mobile-human-dm.png") });
    await invitedContext.close();
  } else if (electron) {
    await page.locator('button[aria-haspopup="menu"]').first().click();
    await page.getByRole("menuitem", { name: "Create workspace", exact: true }).click();
    await page.getByLabel(/^Workspace name/).fill("Private Local fixture");
    await page.getByRole("button", { name: /^Local/ }).click();
    const deadline = Date.now() + 45_000;
    let local: Page | undefined;
    while (Date.now() < deadline) {
      local = electron.windows().find((candidate) => candidate.url().startsWith("http://127.0.0.1:") && !candidate.url().startsWith(origin));
      if (local) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(local, "Native Local creation must open its own loopback server");
    activePage = local;
    local.on("pageerror", (error) => errors.push(error.message));
    await local.getByRole("button", { name: "Workspaces", exact: true }).waitFor();
    const nativeInfo = await local.evaluate(async () => window.ogb!.colonieWorkspaces!.info());
    assert.equal(nativeInfo.local?.name, "Private Local fixture");
    await local.screenshot({ path: join(evidenceDir, "platform-native-local.png") });
    report.nativeLocalCreatedOpenedAndAccountChecked = true;
    report.localEngineSignInPerformed = false;
    await local.getByRole("heading", { name: "Your model providers", exact: true }).waitFor();
    await local.getByText("Ready", { exact: true }).first().waitFor();
    await local.getByRole("button", { name: "Continue", exact: true }).click();
    const botName = local.locator("#welcome-bot-name");
    if (!(await botName.count())) {
      await local.getByRole("heading", { name: "Permissions", exact: true }).waitFor();
      await local.getByRole("button", { name: "Continue", exact: true }).click();
    }
    await botName.fill("Local Atlas");
    await local.getByRole("button", { name: "Start chatting", exact: true }).click();
    const localComposer = local.getByRole("textbox", { name: "Message Local Atlas", exact: true });
    await localComposer.fill("LOCAL_WORKSPACE_UI_OK");
    await localComposer.press("Enter");
    await local.getByRole("log", { name: "Conversation with Local Atlas", exact: true })
      .getByText("1: LOCAL_WORKSPACE_UI_OK", { exact: true }).waitFor({ timeout: 30_000 });
    report.nativeLocalOnboardingAndAcpChat = true;
    await local.screenshot({ path: join(evidenceDir, "platform-native-local-chat.png") });
    await local.getByRole("button", { name: "Workspaces", exact: true }).click();
    const cloudAgain = await nativeWindow((candidate) => candidate.url().startsWith(origin));
    assert.ok(cloudAgain, "Switching back must open the account platform");
    activePage = cloudAgain;
    await cloudAgain.getByRole("button", { name: /Atlas/ }).first().click();
    await cloudAgain.getByRole("log").getByText("UI_PROVIDER_FIXTURE_REPLY", { exact: true }).waitFor();
    assert.equal(await cloudAgain.getByText("LOCAL_WORKSPACE_UI_OK", { exact: true }).count(), 0);
    report.nativeCloudLocalSwitchPreservesSeparateChats = true;
  }
  assert.deepEqual(errors, [], "The renderer must not throw JavaScript errors");
  report.completed = true;
  console.log(JSON.stringify(report));
} catch (error) {
  // Only synthetic accounts and isolated fixture pages are visited here.
  if (activePage && !activePage.isClosed()) {
    report.failureUrl = activePage.url();
    report.failureText = await activePage.locator("body").innerText().catch(() => "Page unavailable");
    await activePage.screenshot({ path: join(evidenceDir, desktop ? "platform-native-failure.png" : "platform-browser-failure.png") }).catch(() => {});
  }
  console.error(JSON.stringify({ ...report, errors }));
  throw error;
} finally {
  if (electron) {
    const child = electron.process();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
    await electron.close().catch(() => {});
    clearTimeout(deadline);
  }
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await app.close();
  await writeFile(join(evidenceDir, desktop ? "platform-native-ui.json" : "platform-browser-ui.json"), JSON.stringify({ ...report, errors }, null, 2), { mode: 0o600 });
  await rm(root, { recursive: true, force: true });
}
