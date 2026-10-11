/** Actual React Chief + Skills controls against the canonical disposable SDK fixture. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { launchVerificationServer } from "../control-omb.ts";
import { mountPreview } from "../testing/preview-fixture.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".devone/browsers");
const { chromium } = await import("playwright");
const claude = process.argv.includes("--claude");
const provider = claude ? "claude-acp" : "codex-acp";
const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone"]);
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}: ${JSON.stringify(value)}`);
  return value as any;
};
const bot = (await api("GET", "/api/bots")).bots[0];
await api("PATCH", `/api/bots/${bot.id}`, { name: "Chief Bot", computer: "off", memoryEnabled: true, memoryUpkeep: true,
  modelSelection: { instanceId: provider, model: "agent-default" } });
const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__colonie-chief-skills.html", title: "Colonie chief/skills verification", logLevel: "warn" });
const evidence = resolve(".devone/evidence"); mkdirSync(evidence, { recursive: true });
const label = `${claude ? "claude-" : ""}chief-skills-renderer`;
const result: Record<string, unknown> = { simulatedProvider: true, renderer: true, fixture: fixture.info };
const errors: string[] = [];
let browser: Browser | undefined;
let page: Page | undefined;
const waitFor = async (check: () => Promise<boolean>, message: string) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) { if (await check()) return; await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(message);
};
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1450, height: 1050 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(preview.previewUrl);
  const composer = page.getByRole("textbox", { name: "Message Chief Bot", exact: true });
  await composer.waitFor();

  // The seeded first bot is the Chief, and its profile shows the Chief card.
  assert.equal((await api("GET", "/api/colonie/chief")).chief.id, bot.id);
  await page.getByRole("button", { name: "Open Chief Bot's profile", exact: true }).click();
  const profile = page.locator("aside[role=dialog]");
  await profile.getByText(/Chief Bot is the Chief\./).waitFor();

  // Create a guide through the normal profile and see it listed.
  await profile.getByRole("textbox", { name: "New guide name", exact: true }).fill("weekly-report");
  await profile.getByRole("textbox", { name: "New guide description", exact: true }).fill("Use when the user asks for the weekly report.");
  await profile.getByRole("textbox", { name: "New guide instructions", exact: true }).fill("Collect last week's numbers and write a one-page summary.");
  await profile.getByRole("button", { name: "Create guide", exact: true }).click();
  await waitFor(async () => (await api("GET", `/api/bots/${bot.id}/colonie-skills`)).skills.some((skill: any) => skill.name === "weekly-report" && skill.enabled),
    "The created guide was not saved and enabled.");
  await profile.getByText("weekly-report", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, `${label}-profile.png`), animations: "disabled" });
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();

  // An enabled guide reaches a real dispatch as a bounded index.
  const send = async (text: string) => {
    const before = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts.length;
    await composer.fill(text); await composer.press("Enter");
    await waitFor(async () => {
      const rows = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
      return rows.length === before + 1 && rows.at(-1)?.status === "completed";
    }, "The dispatch did not finish.");
    return (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts.at(-1);
  };
  const first = await send("Please write the weekly report.");
  assert(first.context.sections.some((section: any) => section.id === "skills.index" && section.text.includes("weekly-report")));

  // Turn the guide off from the profile; a new dispatch no longer carries it.
  await page.getByRole("button", { name: "Open Chief Bot's profile", exact: true }).click();
  await profile.getByRole("switch", { name: "Disable weekly-report", exact: true }).click();
  await waitFor(async () => !(await api("GET", `/api/bots/${bot.id}/colonie-skills`)).skills.find((skill: any) => skill.name === "weekly-report")?.enabled,
    "The guide did not turn off.");
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();
  const off = await send("Write the weekly report again.");
  assert(!off.context.sections.some((section: any) => section.id === "skills.index" && section.text.includes("weekly-report")), "A disabled guide still reached the prompt.");
  assert(off.prompt.at(-1).text === "Write the weekly report again.");
  result.verified = ["default Chief card", "create guide", "enabled guide index in dispatch", "disable excludes guide", "exact user message"];
  result.ok = errors.length === 0;
} catch (error) {
  result.ok = false; result.error = (error as Error).message; process.exitCode = 1;
  if (page) { result.body = await page.locator("body").innerText().catch(() => "unavailable"); await page.screenshot({ path: join(evidence, `${label}-failure.png`) }).catch(() => {}); }
} finally {
  result.errors = errors;
  writeFileSync(join(evidence, `${label}-check.json`), JSON.stringify(result, null, 2));
  await browser?.close(); await preview.close(); await fixture.close();
}
console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: join(evidence, `${label}-check.json`) }));