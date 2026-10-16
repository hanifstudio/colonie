/** Actual React Markdown file preview against the disposable fake-engine fixture. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { launchVerificationServer, runControlColonie } from "../control-colonie.ts";
import { mountPreview } from "../testing/preview-fixture.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".colonie-dev/browsers");
const { chromium } = await import("playwright");
const fixture = await launchVerificationServer();
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}: ${JSON.stringify(value)}`);
  return value as any;
};
const waitFor = async (condition: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`${label} did not settle within 30 seconds.`);
};
let browser: Browser | undefined;
let page: Page | undefined;
let preview: { previewUrl: string; close(): Promise<void> } | undefined;
const errors: string[] = [];
try {
  const control = (args: string[]) => runControlColonie([...args, "--url", fixture.info.url]);
  await control(["new-bot", "--name", "Preview Probe"]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const bot = bots.find((item: { name: string }) => item.name === "Preview Probe");
  // The reply carries a workspace Markdown link plus a PDF control: only the
  // Markdown link may gain a preview button; both keep their save buttons.
  const workspace = join(fixture.info.dataDir, "workspaces", bot.id);
  mkdirSync(workspace, { recursive: true });
  const mdPath = join(workspace, "field-notes.md");
  writeFileSync(mdPath, "# Field notes\n\n- first finding\n- second finding\n", "utf8");
  const pdfPath = join(workspace, "field-report.pdf");
  writeFileSync(pdfPath, "%PDF-1.4 synthetic fixture, not a real document\n", "utf8");
  const reply = [
    "Here are the two files for review. They are isolated test artifacts.",
    `[field-notes.md](${mdPath})`,
    `[field-report.pdf](${pdfPath})`,
  ].join("\n\n");
  const wrapper = join(fixture.info.dataDir, "preview-fake-claude.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([reply]))};`,
    `await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  await api("PATCH", "/api/instances/claude", { cli: wrapper });
  await control(["send", "--bot", bot.id, "--text", "share the two fixture files"]);
  await control(["wait", "--bot", bot.id, "--timeout", "30"]);
  const previewRoute = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__file-preview.html", title: "File preview verification", logLevel: "warn" });
  preview = previewRoute;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1450, height: 1050 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(preview.previewUrl);
  // One Markdown link renders two preview buttons (the gallery card and the
  // inline link), the same way the table preview button already does: both
  // open the same panel.
  const previewButtons = page.getByRole("button", { name: "Preview field-notes.md", exact: true });
  await previewButtons.first().waitFor();
  assert.equal(await previewButtons.count(), 2);
  assert.equal(await page.getByRole("button", { name: "Preview field-report.pdf", exact: true }).count(), 0);
  await previewButtons.first().click();
  const panel = page.getByRole("complementary", { name: "Preview field-notes.md" });
  await panel.waitFor();
  await waitFor(async () => (await panel.textContent())?.includes("first finding") ?? false, "panel renders the Markdown body");
  const panelText = await panel.textContent();
  assert.match(panelText ?? "", /first finding/);
  // The panel is a sibling of chat, like Activity: opening Activity closes it.
  await page.getByRole("button", { name: "Close preview", exact: true }).click();
  await waitFor(async () => (await panel.count()) === 0, "panel closes");
  console.log(JSON.stringify({ ok: true, rendererErrors: errors, fixture: { url: fixture.info.url, dataDir: fixture.info.dataDir, logPath: fixture.info.logPath } }));
  if (errors.length > 0) throw new Error(`renderer errors: ${errors.join("; ")}`);
} finally {
  await browser?.close();
  await preview?.close();
  await fixture.close();
}
