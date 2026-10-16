/** Production Electron/renderer/server memory workflow; SDK provider simulation
 * only, with new disposable data, profile, workspace and owned cleanup. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import type { ElectronApplication, Page } from "playwright";
import { freePortBlock } from "../../server/testing/ports.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";

const { _electron } = await import("playwright");
const claude = process.argv.includes("--claude");
const provider = claude ? "claude-acp" : "codex-acp";
const root = mkdtempSync(join(tmpdir(), "colonie-memory-package-"));
const data = join(root, "data"); mkdirSync(data);
const workspace = join(root, "workspace"); mkdirSync(workspace);
const executable = resolve("release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie");
const port = await freePortBlock([0, 1]);
writeFileSync(join(data, "config.json"), JSON.stringify({ language: "en",
  defaultModelSelection: { instanceId: provider, model: "agent-default" },
  features: { llmThreadTitles: false }, onboarding: { completedAt: new Date().toISOString(), version: 1 },
  instances: { [provider]: { driver: provider, config: { cli: process.execPath, args: [resolve("server/acp/testing/fake-agent.ts")] },
    environment: { COLONIE_FAKE_STATE: join(root, "sdk-state.json"), COLONIE_FAKE_DELAY_MS: "150", COLONIE_FAKE_PROVIDER: claude ? "claude" : "codex" } } },
}), { mode: 0o600 });
const env = { ...process.env, HOME: root, USERPROFILE: root, COLONIE_DATA_DIR: data,
  COLONIE_USER_DATA: join(root, "profile"), COLONIE_PROFILE: "1", COLONIE_PORT: String(port), COLONIE_WEBHOOK_PORT: String(port + 1) };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_START_URL; delete env.COMPOSIO_API_KEY; delete env.COLONIE_COMPOSIO_API_KEY;
const evidence = resolve(".colonie-dev/evidence"); mkdirSync(evidence, { recursive: true });
const label = `${claude ? "claude-" : ""}memory-packaged-fixture`;
const result: Record<string, unknown> = { simulatedProvider: true, desktop: true, packaged: true, executable, data, workspace };
const errors: string[] = [];
let app: ElectronApplication | undefined;
let page: Page | undefined;
const waitFor = async (check: () => Promise<boolean>, description: string) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(description);
};
const close = async () => {
  const owned = app; if (!owned) return;
  const child = owned.process();
  const timer = setTimeout(() => child.kill("SIGTERM"), 8000);
  try { await owned.close(); } finally { clearTimeout(timer); await waitForExit(child, { signal: "SIGTERM" }); app = undefined; page = undefined; }
};
const launch = async () => {
  app = await _electron.launch({ executablePath: executable, args: [], env, timeout: 30_000 });
  await waitFor(async () => { page = app!.windows().find((window) => window.url().startsWith(`http://127.0.0.1:${port}/`)); return Boolean(page); }, "Packaged renderer did not open.");
  page!.on("pageerror", (error) => errors.push(error.message));
  result.runtime = await app.evaluate(({ app }) => ({ name: app.getName(), packaged: app.isPackaged, profile: app.getPath("userData") }));
  assert.equal((result.runtime as any).name, "Colonie"); assert.equal((result.runtime as any).packaged, true);
};
const api = async (method: string, path: string, body?: unknown) => page!.evaluate(async ({ method, path, body }) => {
  const response = await fetch(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`); return value;
}, { method, path, body });
try {
  await launch();
  const bot = (await api("GET", "/api/bots")).bots[0];
  await api("PATCH", `/api/bots/${bot.id}`, { name: "Memory Bot", cwd: workspace, computer: "off", memoryEnabled: true, memoryUpkeep: true,
    modelSelection: { instanceId: provider, model: "agent-default" } });
  const composer = () => page!.getByRole("textbox", { name: "Message Memory Bot", exact: true });
  const view = () => api("GET", `/api/bots/${bot.id}/colonie-memory`);
  const send = async (text: string, threadId: string) => {
    await composer().waitFor(); await composer().fill(text); await composer().press("Enter");
    await waitFor(async () => {
      const receipts = (await api("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${threadId}`)).receipts;
      const memory = await view();
      return receipts.at(-1)?.status === "completed" && receipts.at(-1).prompt.at(-1)?.text === text && !memory.status.running && !memory.status.pending;
    }, "Packaged memory turn did not finish.");
    return (await api("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${threadId}`)).receipts.at(-1);
  };
  const first = await send("I prefer concise replies. Project Nebula launches on October 20.", bot.threadId);
  assert.equal((await view()).entries.length, 2);
  await page!.getByRole("button", { name: "Open Memory Bot's profile", exact: true }).click();
  let profile = page!.locator("aside[role=dialog]");
  await profile.getByRole("region", { name: "Bot memory", exact: true }).getByText("The user prefers concise replies.", { exact: true }).waitFor();
  await profile.getByText("The user prefers concise replies.", { exact: true }).scrollIntoViewIfNeeded();
  await page!.screenshot({ path: join(evidence, `${label}-profile.png`), animations: "disabled" });
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();
  await page!.locator("[data-conversation-navigation]").getByRole("button", { name: "New conversation", exact: true }).click();
  await waitFor(async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).threadId !== bot.threadId, "New conversation did not switch.");
  await page!.getByText("Send a message to start the conversation.", { exact: true }).waitFor();
  const freshThread = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).threadId;
  const fresh = await send("When does Project Nebula launch?", freshThread);
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert(fresh.context.sections.some((entry: any) => entry.id === "memory.recall" && entry.text.includes("October 20")));
  await close(); await launch();
  const resumed = await send("Continue about Project Nebula.", freshThread);
  assert.equal(resumed.sessionId, fresh.sessionId); assert.equal(resumed.context.snapshotHash, fresh.context.snapshotHash);
  assert(resumed.context.sections.some((entry: any) => entry.id === "memory.recall" && entry.text.includes("October 20")));
  profile = page!.locator("aside[role=dialog]");
  await page!.getByRole("button", { name: "Open Memory Bot's profile", exact: true }).click();
  await profile.getByRole("switch", { name: "Use memory", exact: true }).click();
  await waitFor(async () => (await view()).bot.enabled === false, "Memory off was not saved.");
  await profile.getByText("Project Nebula launches on October 20.", { exact: true }).waitFor();
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();
  await close(); await launch();
  assert.equal((await view()).bot.enabled, false);
  const off = await send("When does Project Nebula launch?", freshThread);
  assert(!off.context.sections.some((entry: any) => entry.id === "memory.recall"));
  result.receipts = { first, fresh, resumed, off }; result.memory = await view();
  result.ok = errors.length === 0;
  result.verified = ["automatic capture", "normal profile", "fresh native session recall", "full app restart continuity", "off survives restart", "off keeps stored review"];
  await page!.screenshot({ path: join(evidence, `${label}-chat.png`), animations: "disabled" });
} catch (error) {
  result.ok = false; result.error = (error as Error).message; process.exitCode = 1;
  if (page) { result.body = await page.locator("body").innerText().catch(() => "unavailable"); await page.screenshot({ path: join(evidence, `${label}-failure.png`) }).catch(() => {}); }
} finally {
  result.errors = errors;
  const log = join(root, "profile", "logs", "server.log");
  if (existsSync(log)) result.serverLog = readFileSync(log, "utf8").slice(-20_000);
  writeFileSync(join(evidence, `${label}-check.json`), JSON.stringify(result, null, 2));
  await close(); rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: join(evidence, `${label}-check.json`) }));
