// Screenshots of the real interface, so a change to it can be seen and compared, by a person or an agent.
//
//   pnpm ui:shots                       build if stale, then save every screen to .ui-shots/current
//   pnpm ui:shots --out .ui-shots/before
//   pnpm ui:shots --compare .ui-shots/before     list the screens that differ from an earlier run
//   pnpm ui:shots --only panel-screen-off,chat   just these screens
//
// It runs the built web app (dist/) in headless Chromium against a throwaway local server with a stand-in
// engine: nothing of the owner's is touched. Each screen is saved in the dark skin and the light one.
// Things that change from run to run (clock times) are held still, and the computer's state is a fixture,
// so two runs of unchanged code give identical files; that is what makes a difference mean something.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const out = join(root, option("--out") ?? ".ui-shots/current");
const compare = option("--compare");
const only = option("--only")?.split(",");
const web = join(root, "dist");

const newest = (dir) => {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
};
const built = existsSync(join(web, "index.html")) ? statSync(join(web, "index.html")).mtimeMs : 0;
if (args.includes("--build") || !built || built < Math.max(newest(join(root, "src")), newest(join(root, "shared")))) {
  console.log("Building the web app (dist/ is missing or older than src/)...");
  if (spawnSync("pnpm", ["exec", "vite", "build"], { cwd: root, stdio: "inherit" }).status !== 0) throw new Error("vite build failed");
}

const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright");
const { startSharedWorkspace } = await import(join(root, "server/testing/shared-workspace.ts"));
const { completionPatch } = await import(join(root, "src/lib/onboarding.ts"));

/** What the computer reports, as fixtures: the real answer depends on this machine's Docker. */
const computer = (state, extra = {}) => ({ state, message: null, screens: [], idleMinutes: 30, ...extra });
const COMPUTER = { off: computer("off"), preparing: computer("preparing"), noRuntime: computer("no-runtime", { message: "Colonie needs Docker or Podman to run a computer. Install one, then check again." }), unsupported: computer("unsupported"), on: computer("on", { screens: [] }) };

const wait = (page, ms) => page.waitForTimeout(ms);
const tab = (page, name) => page.locator('[aria-label="Bot panel view"]').getByRole("button", { name, exact: true }).click();
async function openBotPanel(page, state, view) {
  await page.route("**/api/computer", (route) => route.fulfill({ json: COMPUTER[state] }));
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith("colonie-bot-panel-view")) localStorage.removeItem(key); });
  await page.locator('main [data-tour="computer"]').click();
  await wait(page, 700);
  if (view) await tab(page, view);
  await wait(page, 500);
}

/** Every screen worth keeping an eye on: a name and how to reach it from the app's first screen. */
const SCREENS = [
  { name: "chat", go: async () => {} },
  { name: "panel-screen-off", go: (page) => openBotPanel(page, "off") },
  { name: "panel-screen-starting", go: (page) => openBotPanel(page, "preparing") },
  { name: "panel-screen-no-runtime", go: (page) => openBotPanel(page, "noRuntime") },
  { name: "panel-screen-unsupported", go: (page) => openBotPanel(page, "unsupported", "Screen") },
  { name: "panel-browser", go: (page) => openBotPanel(page, "off", "Browser") },
  { name: "panel-browser-computer-on", go: (page) => openBotPanel(page, "on", "Browser") },
  { name: "panel-files", go: (page) => openBotPanel(page, "off", "Files") },
].filter((screen) => !only || only.includes(screen.name));

/** Times and dates change on every run; one fixed wording keeps two runs of the same code identical. */
const hold = (page) => page.evaluate(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    node.nodeValue = node.nodeValue.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)\b/gi, "9:41 AM");
  }
});

mkdirSync(out, { recursive: true });
const ws = await startSharedWorkspace([], completionPatch(new Date("2026-01-01T00:00:00Z")), () => ({ COLONIE_STATIC_DIR: web }));
// a new workspace names its first bot at random; a fixed name keeps two runs identical
const first = (await (await fetch(`${ws.url}/api/bots`)).json()).bots[0];
const renamed = await fetch(`${ws.url}/api/bots/${first.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Scout" }) });
if (!renamed.ok) throw new Error(`could not name the bot: ${renamed.status} ${await renamed.text()}`);
const browser = await chromium.launch({ headless: true });
const written = {};
try {
  for (const skin of [undefined, "daylight"]) {
    for (const screen of SCREENS) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce", deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(ws.url);
      await page.locator("main").first().waitFor({ timeout: 20_000 });
      if (skin) await page.evaluate((value) => { document.documentElement.dataset.skin = value; }, skin);
      await wait(page, 800);
      await screen.go(page);
      await hold(page);
      const file = `${screen.name}.${skin ? "light" : "dark"}.png`;
      await page.screenshot({ path: join(out, file), animations: "disabled", caret: "hide" });
      written[file] = createHash("sha256").update(readFileSync(join(out, file))).digest("hex");
      if (errors.length) console.log(`  page error on ${file}: ${errors[0].slice(0, 160)}`);
      await context.close();
    }
  }
} finally { await browser.close(); await ws.stop(); }
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(written, null, 2)}\n`);
console.log(`Saved ${Object.keys(written).length} screens to ${relative(root, out)}`);

if (compare) {
  const base = JSON.parse(readFileSync(join(root, compare, "manifest.json"), "utf8"));
  const changed = Object.keys(written).filter((file) => base[file] && base[file] !== written[file]);
  const added = Object.keys(written).filter((file) => !base[file]);
  const gone = only ? [] : Object.keys(base).filter((file) => !written[file]);
  console.log(changed.length || added.length || gone.length
    ? `Compared with ${compare}:\n${[...changed.map((file) => `  changed  ${file}`), ...added.map((file) => `  new      ${file}`), ...gone.map((file) => `  missing  ${file}`)].join("\n")}`
    : `Compared with ${compare}: every screen is identical.`);
}
