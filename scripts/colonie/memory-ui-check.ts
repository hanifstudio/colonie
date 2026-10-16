/** Actual React memory controls against the canonical disposable SDK fixture. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import type { Browser, ElectronApplication, Page } from "playwright";
import { launchVerificationServer, verificationServerEnvironment } from "../control-colonie.ts";
import { mountPreview } from "../testing/preview-fixture.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".colonie-dev/browsers");
const { chromium, _electron } = await import("playwright");
const claude = process.argv.includes("--claude");
const desktop = process.argv.includes("--desktop");
const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["colonie"]);
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}: ${JSON.stringify(value)}`);
  return value as any;
};
const bot = (await api("GET", "/api/bots")).bots[0];
await api("PATCH", `/api/bots/${bot.id}`, { name: "Memory Bot", memoryEnabled: true, memoryUpkeep: true,
  modelSelection: { instanceId: claude ? "claude-acp" : "codex-acp", model: "agent-default" }, computer: "off" });
const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__colonie-memory.html", title: "Colonie memory verification", logLevel: "warn" });
const evidence = resolve(".colonie-dev/evidence"); mkdirSync(evidence, { recursive: true });
const label = `${claude ? "claude-" : ""}memory-${desktop ? "desktop" : "renderer"}`;
const result: Record<string, unknown> = { simulatedProvider: true, renderer: true, desktop, fixture: fixture.info };
const errors: string[] = [];
let browser: Browser | undefined;
let electron: ElectronApplication | undefined;
let page: Page | undefined;
const waitFor = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Memory UI condition did not settle within 30 seconds.");
};
try {
  if (desktop) {
    const env = { ...process.env, ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      COLONIE_PROFILE: "1", COLONIE_USER_DATA: join(fixture.info.dataDir, "electron-profile"), ELECTRON_START_URL: preview.previewUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ args: [resolve(".")], env, timeout: 30_000 });
    await waitFor(async () => { page = electron!.windows().find((window) => window.url().includes("__colonie-memory.html")); return Boolean(page); });
  } else {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1450, height: 1050 } });
    await page.goto(preview.previewUrl);
  }
  page!.on("pageerror", (error) => errors.push(error.message));
  const composer = page!.getByRole("textbox", { name: "Message Memory Bot", exact: true });
  await composer.waitFor();
  const send = async (text: string) => {
    const count = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts.length;
    await composer.fill(text); await composer.press("Enter");
    await waitFor(async () => {
      const rows = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
      const memory = await api("GET", `/api/bots/${bot.id}/colonie-memory`);
      return rows.length === count + 1 && rows.at(-1)?.status === "completed" && !memory.status.running && !memory.status.pending;
    });
  };
  await send("I prefer concise replies. Project Nebula launches on October 20.");
  await page!.getByRole("button", { name: "Open Memory Bot's profile", exact: true }).click();
  const profile = page!.locator("aside[role=dialog]");
  await profile.getByRole("switch", { name: "Use memory", exact: true }).waitFor();
  await profile.getByText("The user prefers concise replies.", { exact: true }).waitFor();
  await profile.getByText("Project Nebula launches on October 20.", { exact: true }).waitFor();
  assert.equal(await page!.getByRole("button", { name: "Inspect ACP context", exact: true }).count(), 0);
  await page!.screenshot({ path: join(evidence, `${label}-automatic.png`), animations: "disabled" });
  const sharedRow = profile.locator("div.rounded-lg.bg-inset").filter({ hasText: "The user prefers concise replies." });
  await sharedRow.getByRole("button", { name: "Edit", exact: true }).click();
  const draft = profile.getByRole("textbox", { name: "Edit memory text", exact: true });
  await draft.fill("The user prefers precise replies.");
  // Real competing edit: the UI must preserve its draft and refuse stale save.
  const current = await api("GET", `/api/bots/${bot.id}/colonie-memory`);
  const shared = current.entries.find((entry: any) => entry.scope === "shared");
  await api("PATCH", `/api/bots/${bot.id}/colonie-memory/entries/${shared.id}`, { text: "The user prefers structured replies.", expectedRevision: current.revision });
  await profile.getByRole("button", { name: "Save", exact: true }).click();
  await profile.getByText(/Memory changed elsewhere\. Your draft is kept/).waitFor();
  assert.equal(await draft.inputValue(), "The user prefers precise replies.");
  await profile.getByRole("region", { name: "Bot memory", exact: true }).getByRole("button", { name: "Refresh", exact: true }).click();
  await profile.getByText("The user prefers structured replies.", { exact: true }).waitFor();
  await profile.getByRole("button", { name: "Save", exact: true }).click();
  await profile.getByText("The user prefers precise replies.", { exact: true }).waitFor();
  const row = profile.locator("div.rounded-lg.bg-inset").filter({ hasText: "The user prefers precise replies." });
  await row.getByRole("button", { name: "Forget", exact: true }).click();
  const confirmation = page!.getByRole("alertdialog", { name: "Forget this memory?", exact: true });
  await confirmation.getByRole("button", { name: "Forget", exact: true }).click();
  await waitFor(async () => !(await api("GET", `/api/bots/${bot.id}/colonie-memory`)).entries.some((entry: any) => entry.scope === "shared"));
  await profile.getByRole("button", { name: "Add a memory", exact: true }).click();
  await profile.getByRole("textbox", { name: "New memory text", exact: true }).fill("Project Quartz uses the blue palette.");
  await profile.getByRole("button", { name: "Add", exact: true }).click();
  await profile.getByText("Project Quartz uses the blue palette.", { exact: true }).waitFor();
  const memorySwitch = profile.getByRole("switch", { name: "Use memory", exact: true });
  await memorySwitch.click();
  await waitFor(async () => (await api("GET", `/api/bots/${bot.id}/colonie-memory`)).bot.enabled === false);
  assert.equal(await profile.getByText("Project Quartz uses the blue palette.", { exact: true }).count(), 1);
  await page!.screenshot({ path: join(evidence, `${label}-off-review.png`), animations: "disabled" });
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();
  await send("What is the palette for Project Quartz?");
  const offReceipt = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts.at(-1);
  assert(!offReceipt.context.sections.some((section: any) => section.id === "memory.recall"));
  await page!.getByRole("button", { name: "Open Memory Bot's profile", exact: true }).click();
  await memorySwitch.waitFor(); await memorySwitch.click();
  await waitFor(async () => (await api("GET", `/api/bots/${bot.id}/colonie-memory`)).bot.enabled === true);
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();
  result.stage = "create new conversation";
  await page!.getByRole("main").getByRole("button", { name: "New conversation", exact: true }).click();
  await waitFor(async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id)?.threadId !== bot.threadId);
  await page!.getByText("Send a message to start the conversation.", { exact: true }).waitFor();
  result.stage = "send in new conversation";
  await composer.fill("What is the palette for Project Quartz?"); await composer.press("Enter");
  await waitFor(async () => {
    const now = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    if (now.busy || now.threadId === bot.threadId) return false;
    const inputs = (await api("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${now.threadId}`)).receipts;
    return inputs.at(-1)?.status === "completed" && inputs.at(-1).context.sections.some((section: any) => section.id === "memory.recall" && section.text.includes("blue palette"));
  });
  result.ok = errors.length === 0;
  result.memory = await api("GET", `/api/bots/${bot.id}/colonie-memory`);
  result.verified = ["automatic capture", "normal profile access", "source display", "conflicting edit preserves draft", "edit", "forget", "add", "off keeps review", "enable saved-off bot", "new-conversation recall"];
} catch (error) {
  result.ok = false; result.error = (error as Error).message; process.exitCode = 1;
  if (page) { result.body = await page.locator("body").innerText().catch(() => "unavailable"); await page.screenshot({ path: join(evidence, `${label}-failure.png`) }).catch(() => {}); }
  result.bot = (await api("GET", "/api/bots").catch(() => ({ bots: [] }))).bots.find((entry: any) => entry.id === bot.id);
  result.memory = await api("GET", `/api/bots/${bot.id}/colonie-memory`).catch(() => null);
} finally {
  result.errors = errors;
  writeFileSync(join(evidence, `${label}-check.json`), JSON.stringify(result, null, 2));
  await electron?.close(); await browser?.close(); await preview.close(); await fixture.close();
}
console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: join(evidence, `${label}-check.json`) }));
