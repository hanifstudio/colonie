/** Isolated packaged-app check. --real adds two bounded native Codex requests. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ElectronApplication, Page, Browser } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { freePortBlock } from "../../server/testing/ports.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { editProfileThroughUi, editSharedInstructionsThroughUi, enableDeveloperInspector } from "./profile-ui.ts";
import { parallelConversationUi, resumedConversationUi } from "./conversations-ui.ts";
import { fakeComposio } from "../../server/colonie/connections/testing/fake-composio.ts";
import { configureConnectedToolsUi, connectedToolPermissionUi } from "../colonie/connected-tools-ui.ts";
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".colonie-dev/browsers");
const { _electron, chromium } = await import("playwright");

const real = process.argv.includes("--real");
const claude = process.argv.includes("--claude");
const provider = claude ? "claude-acp" : "codex-acp";
const agentName = claude ? "Claude" : "Codex";
const upgrade = process.argv.includes("--upgrade");
const scopedContext = process.argv.includes("--context");
const profileFlow = process.argv.includes("--profile");
const conversations = process.argv.includes("--conversations");
const connected = process.argv.includes("--connected-tools");
if (connected && (upgrade || conversations || scopedContext || profileFlow)) throw new Error("Connected tools verification uses its own bounded recipe.");
if (connected && real && !process.env.COMPOSIO_API_KEY) throw new Error("Real connected-tools verification requires an explicit COMPOSIO_API_KEY");
const composioFixture = connected && !real ? await fakeComposio() : null;
if (conversations && (real || upgrade || scopedContext)) throw new Error("The parallel-conversation recipe requires a disposable SDK fixture and default context.");
if (upgrade && profileFlow) throw new Error("The legacy upgrade recipe does not support profile-default checks.");
if (upgrade && scopedContext) throw new Error("The upgrade recipe preserves the original plain baseline.");
if (upgrade && (real || claude)) throw new Error("The Colonie upgrade fixture is offline Codex only.");
const root = mkdtempSync(join(tmpdir(), "colonie-package-check-"));
const data = join(root, upgrade ? ".colonie-dev" : "data");
const workspace = join(root, "workspace");
mkdirSync(data);
mkdirSync(workspace);
const app = resolve("release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie");
const oldResources = resolve("release/colonie/mac-arm64/Colonie.app/Contents/Resources");
const fake = real ? {} : {
  config: { cli: process.execPath, args: [resolve("server/acp/testing/fake-agent.ts")] },
  environment: { COLONIE_FAKE_STATE: join(root, "fake-state.json"), COLONIE_FAKE_DELAY_MS: "500", COLONIE_FAKE_PROVIDER: claude ? "claude" : "codex" },
};
writeFileSync(join(data, "config.json"), JSON.stringify({
  language: "en", defaultModelSelection: { instanceId: provider, model: "agent-default" },
  features: { showToolCalls: true, llmThreadTitles: false, autoRecall: false, skillAuthoring: false },
  onboarding: { completedAt: new Date().toISOString(), version: 1, hintsSeen: [
    "tour.composer", "tour.model", "tour.computer", "tour.computer-browser", "tour.tools",
    "tour.apps", "tour.apps-panel", "tour.automations", "tour.automations-page", "tour.done",
  ] },
  instances: { [provider]: { driver: provider, displayName: `${agentName} · ACP`, ...fake } },
  ...(connected && real ? { composio: { userId: `colonie_fixture_${crypto.randomUUID()}` } } : {}),
}), { mode: 0o600 });
const port = await freePortBlock([0, 1]);
const environment: NodeJS.ProcessEnv = { ...process.env, COLONIE_USER_DATA: join(root, "profile"), COLONIE_DATA_DIR: data,
  COLONIE_PORT: String(port), COLONIE_WEBHOOK_PORT: String(port + 1), COLONIE_PROFILE: "1" };
if (!real) { environment.HOME = root; environment.USERPROFILE = root; delete environment.COMPOSIO_API_KEY; delete environment.COLONIE_COMPOSIO_API_KEY; }
if (composioFixture) { environment.COLONIE_COMPOSIO_API = `${composioFixture.origin}/api/v3.1`; environment.COLONIE_COMPOSIO_TOOLKITS_API = `${composioFixture.origin}/api/v3`; environment.COMPOSIO_API_KEY = composioFixture.key; }
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.ELECTRON_START_URL;
const evidence = resolve(".colonie-dev/evidence");
mkdirSync(evidence, { recursive: true });
const label = upgrade ? "colonie-upgrade" : `${claude ? "claude-" : ""}${real ? "packaged-real" : "packaged-fixture"}${connected ? "-connected-tools" : conversations ? "-conversations" : profileFlow ? "-profile-defaults" : scopedContext ? "-scoped-context" : ""}`;
const result: Record<string, unknown> = { real, executable: app, dataDir: data, workspace };
let electron: ElectronApplication | undefined;
let page: Page | undefined;
let legacyBrowser: Browser | undefined;
let legacyServer: ChildProcess | undefined;
const errors: string[] = [];
const desktopLog: string[] = [];
let launches = 0;
async function closeOwnedApp() {
  if (legacyBrowser) { await legacyBrowser.close(); legacyBrowser = undefined; }
  if (legacyServer) { await waitForExit(legacyServer, { signal: "SIGTERM" }); legacyServer = undefined; }
  const owned = electron;
  if (!owned) return;
  const child = owned.process();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, 8_000); });
  try { await Promise.race([owned.close(), deadline]); }
  finally { clearTimeout(timer!); await waitForExit(child, { signal: "SIGTERM" }); electron = undefined; }
}
async function launch() {
  if (upgrade && launches === 0) {
    launches++;
    const origin = `http://127.0.0.1:${port}`;
    legacyServer = spawn(process.execPath, [join(oldResources, "server", "index.js")], {
      env: { ...environment, COLONIE_STATIC_DIR: join(oldResources, "ui"), ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    legacyServer.stdout?.on("data", (chunk) => desktopLog.push(String(chunk)));
    legacyServer.stderr?.on("data", (chunk) => desktopLog.push(String(chunk)));
    const until = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < until) {
      if (legacyServer.exitCode !== null) throw new Error("Legacy bundled server exited during upgrade fixture");
      try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Legacy bundled server did not become ready");
    legacyBrowser = await chromium.launch({ headless: true });
    page = await legacyBrowser.newPage({ viewport: { width: 1300, height: 900 } });
    await page.goto(origin);
    result.runtimeState = { name: "Colonie", packaged: true, dataDir: data, legacySource: "original bundled server + production UI" };
    page.on("pageerror", (error) => errors.push(error.message));
    return origin;
  }
  const executable = app;
  if (upgrade && launches > 0) delete environment.COLONIE_DATA_DIR;
  launches++;
  electron = await _electron.launch({ executablePath: executable, args: [], env: environment, timeout: 30_000 });
  electron.process().stdout?.on("data", (chunk) => desktopLog.push(String(chunk)));
  electron.process().stderr?.on("data", (chunk) => desktopLog.push(String(chunk)));
  result.runtimeState = await electron.evaluate(({ app }) => ({
    name: app.getName(), packaged: app.isPackaged, ready: app.isReady(), appPath: app.getAppPath(),
    userData: app.getPath("userData"), argv: process.argv, profile: process.env.COLONIE_PROFILE, dataDir: process.env.COLONIE_DATA_DIR,
  }));
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    page = electron.windows().find((window) => /^http:\/\/127\.0\.0\.1:\d+\//.test(window.url()));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!page) {
    result.windows = await Promise.all(electron.windows().map(async (window) => ({ url: window.url(), body: await window.locator("body").innerText().catch(() => "unavailable") })));
    throw new Error("Packaged desktop did not load its bundled renderer/server");
  }
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  return new URL(page.url()).origin;
}
async function call(origin: string, method: string, path: string, body?: unknown) {
  return page!.evaluate(async ({ origin, method, path, body }) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
    return value;
  }, { origin, method, path, body });
}
async function settledInput(origin: string, botId: string, text: string) {
  const until = Date.now() + (real ? 90_000 : 15_000);
  while (Date.now() < until) {
    const receipts = (await call(origin, "GET", `/api/bots/${botId}/acp-inputs`)).receipts;
    const current = (await call(origin, "GET", "/api/bots")).bots.find((entry: any) => entry.id === botId);
    const latest = receipts.at(-1);
    if (latest?.prompt.at(-1)?.text === text && latest.status !== "dispatching" && !current.busy) {
      if (latest.status !== "completed") throw new Error(latest.error ?? `Provider input ended as ${latest.status}`);
      await page!.getByTestId("acp-live-reply").waitFor({ state: "hidden" });
      return receipts;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Reply arrived, but the native turn did not settle");
}
try {
  let origin = await launch();
  const instances = (await call(origin, "GET", "/api/instances")).instances;
  if (!instances.some((entry: any) => entry.driverKind === provider) || instances.some((entry: any) => !["codex-acp", "claude-acp"].includes(entry.driverKind))) throw new Error("Package selected a legacy engine");
  if ((result.runtimeState as { name: string }).name !== (upgrade ? "Colonie" : "Colonie")) throw new Error("Unexpected packaged product identity");
  const starter = (await call(origin, "GET", "/api/bots")).bots[0];
  const bot = (await call(origin, "PATCH", `/api/bots/${starter.id}`, { name: agentName, cwd: workspace, computer: "off", soul: "UNWANTED LEGACY SOUL", modelSelection: { instanceId: provider, model: "agent-default" } })).bot;
  const composer = () => page!.getByRole("textbox", { name: `Message ${agentName}`, exact: true });
  await composer().waitFor({ state: "visible", timeout: 20_000 });
  if (!upgrade && await page!.getByRole("button", { name: "Inspect ACP context", exact: true }).count()) throw new Error("Developer inspector is visible by default");
  if (connected) {
    await configureConnectedToolsUi(page!, { agentName, includeLocal: !real,
      capture: async (stage) => { await page!.screenshot({ path: join(evidence, `${label}-${stage}.png`), animations: "disabled" }); } });
    const policy = await call(origin, "GET", `/api/bots/${bot.id}/connected-tools`);
    if (!policy.toolkits.includes("hackernews") || (!real && !policy.customServers.includes("custom_local"))) throw new Error("Normal bot profile did not save connected tool access");
    result.connectedToolSelection = { toolkits: policy.toolkits, customServers: policy.customServers, configuredThroughUi: true };
    result.credentialSource = "Explicit fixture/runtime environment; macOS secure-store write is separate evidence";
  }
  if (profileFlow) {
    await editProfileThroughUi(page!, agentName);
    await editSharedInstructionsThroughUi(page!, "This is a bounded context verification fixture. Keep responses concise and do not use tools unless explicitly requested.");
    result.profileFlow = { inspectorHiddenByDefault: true, profileEditedThroughUi: true, sharedInstructionsEditedThroughUi: true };
    await page!.screenshot({ path: join(evidence, `${label}-default-chat.png`) });
  }
  if (!upgrade && process.argv.includes("--native")) {
    await page!.getByRole("button", { name: "Open native settings", exact: true }).click();
    const settings = page!.getByRole("dialog", { name: "Native agent settings", exact: true });
    await settings.getByRole("combobox", { name: "Native mode", exact: true }).waitFor();
    await page!.waitForFunction(() => !(document.querySelector('select[aria-label="Native mode"]') as HTMLSelectElement | null)?.disabled);
    if ((await call(origin, "GET", `/api/bots/${bot.id}/acp-inputs`)).receipts.length) throw new Error("Native discovery sent an unintended prompt");
    const effort = settings.locator('[data-native-category="thought_level"] select');
    let effortChoice: { id: string; value: string } | null = null;
    if (await effort.count()) {
      const target = effort.first();
      const options = await target.locator("option").evaluateAll((rows) => rows.map((row) => ({ value: (row as HTMLOptionElement).value, name: row.textContent ?? "" })));
      const value = options.find((option) => /^(low|minimal|none)$/i.test(option.value))?.value ?? options[0]?.value;
      if (value) {
        const id = (await target.getAttribute("aria-label"))!.replace(/^Native /, "");
        await target.selectOption(value);
        await page!.waitForFunction(() => !(document.querySelector('select[aria-label="Native mode"]') as HTMLSelectElement | null)?.disabled);
        effortChoice = { id, value };
      }
    }
    const modes = await settings.getByRole("combobox", { name: "Native mode", exact: true }).locator("option").evaluateAll((rows) => rows.map((row) => (row as HTMLOptionElement).value));
    const originalMode = await settings.getByRole("combobox", { name: "Native mode", exact: true }).inputValue();
    if (modes.includes("plan")) {
      await settings.getByRole("combobox", { name: "Native mode", exact: true }).selectOption("plan");
      await page!.waitForFunction(() => !(document.querySelector('select[aria-label="Native mode"]') as HTMLSelectElement | null)?.disabled);
      await settings.getByRole("combobox", { name: "Native mode", exact: true }).selectOption(originalMode);
      await page!.waitForFunction(() => !(document.querySelector('select[aria-label="Native mode"]') as HTMLSelectElement | null)?.disabled);
    }
    if (await settings.getByRole("alert").count()) throw new Error(await settings.getByRole("alert").innerText());
    await page!.screenshot({ path: join(evidence, `${label}-native-settings.png`) });
    await settings.getByRole("button", { name: "Close native settings" }).click();
    result.nativeControls = { discoveryPromptCount: 0, offeredModes: modes, restoredMode: originalMode, effortChoice };
  }
  if (scopedContext) {
    await enableDeveloperInspector(page!);
    await call(origin, "PATCH", `/api/bots/${bot.id}`, { title: "Context verifier", description: "Verify scoped application context in this disposable workspace.", soul: "Your standing verification label is CONTEXT_SOUL_471. When asked for it, use that label." });
    await page!.getByRole("button", { name: "Inspect ACP context", exact: true }).click();
    const context = page!.getByRole("dialog", { name: "ACP context", exact: true });
    await context.getByRole("checkbox", { name: "Include Colonie awareness and shared instructions" }).check();
    await context.getByRole("textbox", { name: "Shared app instructions" }).fill("This is a bounded context verification fixture. Keep responses concise and do not use tools unless explicitly requested.");
    await context.getByRole("button", { name: "Save app-wide context", exact: true }).click();
    await page!.waitForFunction(() => !(document.querySelector('section[aria-label="ACP context"] fieldset') as HTMLFieldSetElement | null)?.disabled);
    await context.getByRole("checkbox", { name: "Include this bot's persona" }).check();
    await context.getByRole("checkbox", { name: "Include this bot's SOUL" }).check();
    await context.getByRole("button", { name: "Save bot context", exact: true }).click();
    await page!.waitForFunction(() => !(document.querySelector('section[aria-label="ACP context"] fieldset') as HTMLFieldSetElement | null)?.disabled);
    const view = await call(origin, "GET", `/api/bots/${bot.id}/acp-context?threadId=${bot.threadId}`);
    if (!view.app.enabled || !view.bot.persona || !view.bot.soul || view.pinned) throw new Error("Packaged context controls failed or discovery pinned context early");
    result.contextPreview = view;
    await page!.screenshot({ path: join(evidence, `${label}-preview.png`) });
    await context.getByRole("button", { name: "Close ACP context" }).click();
  }
  const firstPrompt = connected ? real
    ? "This is a bounded integration fixture. Remember marker COLONIE_PACKAGE_471. Use only the app-selected Composio MCP tools: search for HACKERNEWS_GET_TOP_STORIES, then execute that public read-only tool once with empty arguments and no workbench syncing. Do not connect any accounts, access personal services, use native file/shell tools, or execute other app tools. If either request fails, report the failure and stop. If both succeed, reply with exactly COLONIE_TOOLS_OK."
    : "mcp list" : real ? scopedContext || profileFlow
    ? "Remember this temporary marker: COLONIE_PACKAGE_471. Reply with only the application name, your configured role, and your standing verification label, separated by |. Do not use tools."
    : "Remember this temporary marker: COLONIE_PACKAGE_471. Reply with exactly COLONIE_PACKAGED_OK. Do not use tools." : "packaged hello";
  const firstAnswer = connected ? real ? "COLONIE_TOOLS_OK" : "MCP tools: custom_local:read_fixture, colonie_composio:COMPOSIO_SEARCH_TOOLS, colonie_composio:COMPOSIO_MULTI_EXECUTE_TOOL, colonie_composio:HACKERNEWS_READ" : real ? scopedContext || profileFlow ? "Colonie|Context verifier|CONTEXT_SOUL_471" : "COLONIE_PACKAGED_OK" : "1: packaged hello";
  await composer().fill(firstPrompt);
  await composer().press("Enter");
  if (connected && real) {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const current = (await call(origin, "GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
      if (!current.busy) break;
      const messages = (await call(origin, "GET", `/api/threads/${bot.threadId}/messages`)).messages;
      const approval = messages.find((message: any) => message.card?.requestId && !message.card.answered);
      if (approval) {
        const description = JSON.stringify(approval.card);
        if (!/COMPOSIO_SEARCH_TOOLS|COMPOSIO_GET_TOOL_SCHEMAS|COMPOSIO_MULTI_EXECUTE_TOOL|HACKERNEWS_GET_TOP_STORIES/i.test(description)) throw new Error("Real fixture asked for an out-of-scope permission");
        await page!.getByRole("button", { name: "Allow once", exact: true }).click();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  await page!.getByRole("log", { name: `Conversation with ${agentName}` }).locator("p").filter({ hasText: new RegExp(`^${firstAnswer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).waitFor({ state: "visible", timeout: real ? 90_000 : 15_000 });
  const receipts = await settledInput(origin, bot.id, firstPrompt);
  if (upgrade && JSON.stringify(receipts[0].prompt) !== JSON.stringify([{ type: "text", text: firstPrompt }])) throw new Error("Legacy package altered application input");
  if (!upgrade && (receipts[0].prompt.at(-1)?.text !== firstPrompt || receipts[0].context?.sections.find((section: any) => section.id === "app.identity")?.status !== "active")) throw new Error("Default app awareness or exact user input is missing");
  if ((scopedContext || profileFlow) && (!receipts[0].context?.snapshotHash || receipts[0].prompt.at(-1)?.text !== firstPrompt
    || !receipts[0].context.sections.find((section: any) => section.id === "bot.soul")?.text.includes("CONTEXT_SOUL_471"))) throw new Error("Package did not record scoped context");
  result.first = receipts;
  if (connected) {
    if (!receipts[0].connectedTools?.composioToolkits.includes("hackernews")) throw new Error("Composio was not mounted on dispatched input");
    if (real && (!receipts[0].connectedToolCalls?.some((call: any) => call.tool === "COMPOSIO_SEARCH_TOOLS" && call.status === "completed")
      || !receipts[0].connectedToolCalls.some((call: any) => call.targets.includes("HACKERNEWS_GET_TOP_STORIES") && call.status === "completed"))) throw new Error("The real provider did not complete the bounded Composio search/read");
    if (!real) {
      await connectedToolPermissionUi(page!, { agentName, server: "colonie_composio", tool: "HACKERNEWS_READ", behavior: "allow", wait: (text) => settledInput(origin, bot.id, text) });
      if (composioFixture!.calls.length !== 1) throw new Error("Composio Allow did not execute the fixture tool");
      await connectedToolPermissionUi(page!, { agentName, server: "colonie_composio", tool: "HACKERNEWS_READ", behavior: "deny", wait: (text) => settledInput(origin, bot.id, text) });
      if (composioFixture!.calls.length !== 1) throw new Error("Composio Deny still executed the tool");
      await connectedToolPermissionUi(page!, { agentName, server: "custom_local", tool: "read_fixture", behavior: "allow", wait: (text) => settledInput(origin, bot.id, text) });
    }
    result.connectedToolMessages = (await call(origin, "GET", `/api/threads/${bot.threadId}/messages`)).messages;
    if (JSON.stringify(result.connectedToolMessages).includes(process.env.COMPOSIO_API_KEY ?? "__no_live_key__")) throw new Error("A Composio key reached the transcript");
  }
  const parallel = conversations ? await parallelConversationUi(page!, (method, path, body) => call(origin, method, path, body), bot,
    async (stage) => { await page!.screenshot({ path: join(evidence, `${label}-${stage}.png`), animations: "disabled" }); }) : null;
  if (parallel) {
    result.parallelConversations = parallel;
    await page!.screenshot({ path: join(evidence, `${label}-conversations.png`) });
  }
  if (!scopedContext && !upgrade) await enableDeveloperInspector(page!);
  await page!.getByRole("button", { name: "Inspect ACP context" }).click();
  await page!.getByRole("dialog", { name: "ACP context" }).locator('[data-testid="acp-input-text"]:visible').last().waitFor();
  if (scopedContext || profileFlow) {
    const context = page!.getByRole("dialog", { name: "ACP context" });
    await context.getByText("Dispatched context manifest", { exact: true }).click();
    await context.getByText("Bot · SOUL · active", { exact: true }).last().click();
    await context.getByRole("textbox", { name: "Shared app instructions" }).fill("UPDATED_APP_CONTEXT_FOR_NEW_CONVERSATIONS");
    await context.getByRole("button", { name: "Save app-wide context", exact: true }).click();
    await context.getByText(/Settings\/profile changed/).waitFor();
    await call(origin, "PATCH", `/api/bots/${bot.id}`, { soul: "UPDATED_SOUL_FOR_NEW_CONVERSATIONS" });
  }
  await page!.screenshot({ path: join(evidence, `${label}-context.png`) });
  await closeOwnedApp(); page = undefined;
  origin = await launch();
  if ((result.runtimeState as { name: string; dataDir: string }).name !== "Colonie" || (result.runtimeState as { dataDir: string }).dataDir !== data) throw new Error("Renamed app did not preserve its data directory");
  await composer().waitFor({ state: "visible", timeout: 20_000 });
  const secondPrompt = real ? "What temporary marker did I ask you to remember? Reply with only the marker. Do not use tools." : "after package restart";
  const secondAnswer = real ? "COLONIE_PACKAGE_471" : `${conversations || connected ? 5 : 2}: after package restart`;
  await composer().fill(secondPrompt);
  await composer().press("Enter");
  await page!.getByRole("log", { name: `Conversation with ${agentName}` }).locator("p").filter({ hasText: new RegExp(`^${secondAnswer}$`) }).waitFor({ state: "visible", timeout: real ? 90_000 : 15_000 });
  const final = await settledInput(origin, bot.id, secondPrompt);
  if (final.length !== (conversations || (connected && !real) ? 5 : 2) || final[0].sessionId !== final.at(-1).sessionId) throw new Error("Package did not load the persisted native session");
  if (connected && final.at(-1).connectedTools?.policyHash !== final[0].connectedTools.policyHash) throw new Error("Connected-tool selection did not survive application restart");
  if (parallel) result.resumedSibling = await resumedConversationUi(page!, (method, path, body) => call(origin, method, path, body), bot, parallel);
  if ((scopedContext || profileFlow) && (final[1].context?.snapshotHash !== final[0].context.snapshotHash
    || !final[1].context.sections.find((section: any) => section.id === "bot.soul")?.text.includes("CONTEXT_SOUL_471"))) throw new Error("Pinned context did not survive packaged restart/profile updates");
  if (errors.length) throw new Error(`Packaged renderer errors: ${errors.join("\n")}`);
  result.receipts = final;
  if (result.nativeControls) {
    const choice = (result.nativeControls as { effortChoice: { id: string; value: string } | null }).effortChoice;
    if (choice && final[1].nativeSettings?.[choice.id] !== choice.value) throw new Error("Native effort choice did not survive application restart");
  }
  if (real && process.argv.includes("--tools")) {
    const outcomes: unknown[] = [];
    for (const behavior of ["allow", "deny"] as const) {
      const filename = `${behavior}-packaged-fixture.txt`;
      const prompt = `This is a bounded integration fixture. Create only ./${filename} in the current working directory with exactly COLONIE_PACKAGED_TOOL followed by a newline using your native file editing tool. Do not inspect other directories, access the network, modify other files or run unrelated commands. If permission is denied, stop this request without retrying or finding another way to create the file. Finish with one short sentence.`;
      await composer().fill(prompt); await composer().press("Enter");
      await page!.getByRole("button", { name: behavior === "allow" ? "Allow once" : "Deny", exact: true }).click({ timeout: 60_000 });
      const deadline = Date.now() + 90_000;
      let settled = false;
      while (Date.now() < deadline) {
        const receipts = (await call(origin, "GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
        const current = (await call(origin, "GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
        if (receipts.at(-1)?.prompt.at(-1)?.text === prompt && receipts.at(-1).status !== "dispatching" && !current.busy) { settled = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!settled) throw new Error("Packaged native tool turn did not settle");
      const file = join(workspace, filename);
      const present = existsSync(file);
      const content = present ? readFileSync(file, "utf8") : null;
      if (behavior === "allow" && content !== "COLONIE_PACKAGED_TOOL\n") throw new Error("Packaged Allow did not produce the fixture file");
      if (behavior === "deny" && present) throw new Error("Packaged Deny still produced the fixture file");
      outcomes.push({ behavior, present, content });
    }
    result.nativeTools = outcomes;
    result.receipts = (await call(origin, "GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
  }
  if (await page!.locator('svg[data-mascot="bloub"]').count() === 0) throw new Error("Packaged artwork is not Bloub-based");
  result.runtime = JSON.parse(readFileSync(resolve(`release/colonie/mac-arm64/Colonie.app/Contents/Resources/${provider}/${claude ? "colonie" : "colonie"}-runtime.json`), "utf8"));
  await page!.screenshot({ path: join(evidence, `${label}-chat.png`) });
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = (error as Error).message; process.exitCode = 1;
  if (page) {
    result.body = await page.locator("body").innerText().catch(() => "unavailable");
    await page.screenshot({ path: join(evidence, `${label}-failure.png`) }).catch(() => {});
  }
} finally {
  result.errors = errors;
  result.desktopLog = desktopLog.join("");
  const ownedLog = join(root, "profile", "logs", "server.log");
  if (existsSync(ownedLog)) result.serverLog = readFileSync(ownedLog, "utf8").slice(-20_000);
  writeFileSync(join(evidence, `${label}-check.json`), JSON.stringify(result, null, 2));
  await closeOwnedApp();
  await composioFixture?.close();
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: join(evidence, `${label}-check.json`) }));
