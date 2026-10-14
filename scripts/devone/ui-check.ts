import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, ElectronApplication, Page } from "playwright";
import { launchVerificationServer, verificationServerEnvironment } from "../control-omb.ts";
import { mountPreview } from "../testing/preview-fixture.ts";
import { editProfileThroughUi, editSharedInstructionsThroughUi, enableDeveloperInspector } from "./profile-ui.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".devone/browsers");
const { chromium, _electron } = await import("playwright");
const claude = process.argv.includes("--claude");
const agentName = claude ? "Claude" : "Codex";
const scopedContext = process.argv.includes("--context");
const profileFlow = process.argv.includes("--profile");
const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone"]);
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method,
    headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(value)}`);
  return value as any;
};
await api("PATCH", "/api/config", { language: "en", features: { showToolCalls: true } });
const bots = (await api("GET", "/api/bots")).bots;
const bot = bots[0];
await api("PATCH", `/api/bots/${bot.id}`, { name: agentName, computer: "off", modelSelection: { instanceId: profileFlow && claude ? "claude-acp" : "codex-acp", model: "agent-default" } });
if (scopedContext) await api("PATCH", `/api/bots/${bot.id}`, { title: "Context fixture", description: "BOT_SPECIFIC_PERSONA", soul: "BOT_SPECIFIC_SOUL" });
const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__devone.html", title: "DevOne verification", logLevel: "warn" });
const desktop = process.argv.includes("--desktop");
const evidenceDir = resolve(".devone/evidence");
mkdirSync(evidenceDir, { recursive: true });
const label = `${claude ? "claude-" : ""}${desktop ? "desktop" : "renderer"}${profileFlow ? "-profile-defaults" : scopedContext ? "-scoped-context" : ""}`;
let browser: Browser | undefined;
let electron: ElectronApplication | undefined;
let page: Page | undefined;
const errors: string[] = [];
const results: Record<string, unknown> = { desktop, fixture: fixture.info, preview: preview.previewUrl };
try {
  if (desktop) {
    const env = { ...process.env, ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      DEVONE_PROFILE: "1", COLONIE_PLATFORM_DISABLED: "1", DEVONE_USER_DATA: join(fixture.info.dataDir, "electron-profile"), ELECTRON_START_URL: preview.previewUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ args: [resolve(".")], env, timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      page = electron.windows().find((window) => window.url().includes("__devone.html"));
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error("Electron did not open the DevOne fixture renderer");
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    await page.goto(preview.previewUrl);
  }
  page.on("pageerror", (error) => errors.push(error.message));
  const composer = page.getByRole("textbox", { name: `Message ${agentName}`, exact: true });
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  if (claude && !profileFlow) {
    await page.locator('button[aria-haspopup="dialog"]').filter({ hasText: "Codex default" }).first().click();
    const picker = page.locator("[data-model-picker-content]");
    await picker.locator('[data-simple-provider="claude-acp"]').click();
    await picker.getByRole("button", { name: /Claude default/ }).click();
    results.providerSelectedThroughUi = true;
  }
  const transcript = page.getByRole("log", { name: `Conversation with ${agentName}` });
  if (await page.getByRole("button", { name: "Inspect ACP context", exact: true }).count()) throw new Error("Inspector is visible without opting into Developer tools");
  if (profileFlow) {
    await editProfileThroughUi(page, agentName);
    await editSharedInstructionsThroughUi(page, "SHARED_PROFILE_DEFAULTS");
    results.profileFlow = { profileEditedThroughUi: true, inspectorHiddenByDefault: true, sharedInstructionsEditedThroughUi: true };
    await page.screenshot({ path: join(evidenceDir, `${label}-default-chat.png`) });
  }
  if (await page.locator('svg[data-mascot="bloub"]').count() === 0) throw new Error("New Bloub artwork was not mounted");
  if (process.argv.includes("--native")) {
    await page.getByRole("button", { name: "Open native settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Native agent settings", exact: true });
    await settings.getByRole("combobox", { name: "Native effort", exact: true }).waitFor();
    if ((await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts.length !== 0) throw new Error("Discovery dispatched an unintended prompt");
    await settings.getByRole("combobox", { name: "Native effort", exact: true }).selectOption("high");
    await settings.getByRole("combobox", { name: "Native model", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !(document.querySelector('select[aria-label="Native model"]') as HTMLSelectElement | null)?.disabled);
    await settings.getByRole("combobox", { name: "Native model", exact: true }).selectOption("fixture-alt");
    await settings.getByText(/Override 'effort'/).waitFor();
    await settings.getByRole("button", { name: "Apply native effort", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector('select[aria-label="Native mode"]') as HTMLSelectElement | null)?.disabled);
    await settings.getByRole("combobox", { name: "Native mode", exact: true }).selectOption("plan");
    await page.waitForFunction(() => !(document.querySelector('select[aria-label="Native mode"]') as HTMLSelectElement | null)?.disabled);
    await page.screenshot({ path: join(evidenceDir, `${label}-native-settings.png`) });
    await settings.getByRole("button", { name: "Close native settings" }).click();
    results.nativeControls = { discoveryPromptCount: 0, model: "fixture-alt", effort: "low", mode: "plan", staleOverrideRepaired: true };
  }
  const send = async (text: string) => { await composer.fill(text); await composer.press("Enter"); };
  if (scopedContext) {
    await enableDeveloperInspector(page);
    await page.getByRole("button", { name: "Inspect ACP context", exact: true }).click();
    const context = page.getByRole("dialog", { name: "ACP context", exact: true });
    await context.getByRole("checkbox", { name: "Include Colonie awareness and shared instructions" }).check();
    await context.getByRole("textbox", { name: "Shared app instructions" }).fill("APP_WIDE_CONTEXT_V1");
    await context.getByRole("button", { name: "Save app-wide context", exact: true }).click();
    await page.waitForFunction(() => !(document.querySelector('section[aria-label="ACP context"] fieldset') as HTMLFieldSetElement | null)?.disabled);
    await context.getByRole("checkbox", { name: "Include this bot's persona" }).check();
    await context.getByRole("checkbox", { name: "Include this bot's SOUL" }).check();
    await context.getByRole("button", { name: "Save bot context", exact: true }).click();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const view = await api("GET", `/api/bots/${bot.id}/acp-context?threadId=${bot.threadId}`);
      if (view.bot.persona && view.bot.soul) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const view = await api("GET", `/api/bots/${bot.id}/acp-context?threadId=${bot.threadId}`);
    if (!view.bot.persona || !view.bot.soul || view.pinned) throw new Error("Context controls failed or preview pinned before dispatch");
    await page.screenshot({ path: join(evidenceDir, `${label}-preview.png`) });
    await context.getByRole("button", { name: "Close ACP context" }).click();
  }
  const waitReply = async (text: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const current = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
      if (!current.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if ((await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).busy) throw new Error("Reply text arrived, but the turn did not settle");
    await page.getByTestId("acp-live-reply").waitFor({ state: "hidden", timeout: 15_000 });
    const paragraph = transcript.locator("p").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
    await paragraph.waitFor({ state: "visible", timeout: 15_000 });
    if (await paragraph.count() !== 1) throw new Error("Duplicate finalized reply");
  };
  await send("hello from UI");
  await page.getByTestId("acp-live-reply").waitFor({ state: "visible", timeout: 15_000 });
  results.streaming = await page.getByTestId("acp-live-reply").innerText();
  await page.reload();
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  results.reconnectedDuringStream = true;
  await waitReply("1: hello from UI");
  if (!scopedContext) await enableDeveloperInspector(page);
  await page.getByTestId("acp-live-reply").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Inspect ACP context", exact: true }).click();
  const context = page.getByRole("dialog", { name: "ACP context", exact: true });
  await context.getByTestId("acp-input-text").last().waitFor();
  if (await context.getByTestId("acp-input-text").last().innerText() !== "hello from UI") throw new Error("Unexpected application prompt");
  if (scopedContext) {
    await context.getByTestId("acp-context-pin").waitFor();
    await context.getByText("Dispatched context manifest", { exact: true }).click();
    await context.getByText("Bot · SOUL · active", { exact: true }).last().click();
    await context.getByText("BOT_SPECIFIC_SOUL", { exact: true }).last().waitFor();
    await context.getByRole("textbox", { name: "Shared app instructions" }).fill("APP_WIDE_CONTEXT_V2");
    await context.getByRole("button", { name: "Save app-wide context", exact: true }).click();
    await context.getByText(/Settings\/profile changed/).waitFor();
    results.scopedContext = { controls: true, previewDidNotPin: true, manifestVisible: true, pinnedChangeNotice: true };
  }
  await page.screenshot({ path: join(evidenceDir, `${label}-context.png`) });
  await context.getByRole("button", { name: "Close ACP context" }).click();
  await send("continue");
  await waitReply("2: continue");
  await send("permission");
  await page.getByRole("button", { name: "Allow once", exact: true }).click({ timeout: 15_000 });
  await waitReply("Permission: yes-once");
  await send("permission deny");
  await page.getByRole("button", { name: "Deny", exact: true }).click({ timeout: 15_000 });
  await waitReply("Permission: no");
  await send("hang");
  const admitted = Date.now() + 15_000;
  while (Date.now() < admitted) {
    const receipts = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
    if (receipts.at(-1)?.prompt.at(-1)?.text === "hang") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stop = page.getByRole("button", { name: /Stop/, exact: false });
  await stop.first().click({ timeout: 15_000 });
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const current = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    if (!current.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if ((await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).busy) throw new Error("Stop did not settle the turn");
  await send("after stop");
  await waitReply("6: after stop");
  results.receipts = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
  if (profileFlow) {
    const first = (results.receipts as any[])[0];
    if (first.context.sections.find((section: any) => section.id === "app.identity")?.status !== "active"
      || !first.context.sections.find((section: any) => section.id === "bot.persona")?.text.includes("Context verifier")
      || !first.context.sections.find((section: any) => section.id === "bot.soul")?.text.includes("CONTEXT_SOUL_471")
      || first.context.sections.find((section: any) => section.id === "app.instructions")?.text !== "SHARED_PROFILE_DEFAULTS") throw new Error("Normal profile edits were not used automatically");
  }
  if (scopedContext) {
    const receipts = results.receipts as any[];
    if (!receipts[0].context.snapshotHash || receipts.some((receipt) => receipt.context.snapshotHash !== receipts[0].context.snapshotHash
      || receipt.context.sections.find((section: any) => section.id === "app.instructions")?.text !== "APP_WIDE_CONTEXT_V1"
      || receipt.context.sections.find((section: any) => section.id === "bot.soul")?.text !== "BOT_SPECIFIC_SOUL")) throw new Error("Context pin changed during the UI workflow");
  }
  if (process.argv.includes("--native")) {
    const latest = (results.receipts as any[]).at(-1);
    if (latest.mode !== "plan" || latest.nativeSettings.model !== "fixture-alt" || latest.nativeSettings.effort !== "low") throw new Error("Native controls were not preserved on dispatched input");
  }
  await page.screenshot({ path: join(evidenceDir, `${label}-chat.png`) });
  if (errors.length) throw new Error(`Renderer errors: ${errors.join("\n")}`);
  results.ok = true;
} catch (error) {
  results.ok = false;
  results.error = (error as Error).message;
  if (page) {
    results.body = await page.locator("body").innerText().catch(() => "unavailable");
    await page.screenshot({ path: join(evidenceDir, `${label}-failure.png`) }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  results.errors = errors;
  writeFileSync(join(evidenceDir, `${label}-check.json`), JSON.stringify(results, null, 2));
  await electron?.close();
  await browser?.close();
  await preview.close();
  await fixture.close();
}
console.log(JSON.stringify({ ok: results.ok, error: results.error, evidence: join(evidenceDir, `${label}-check.json`) }));
