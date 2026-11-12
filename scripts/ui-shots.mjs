// Screenshots of the real interface, so a change to it can be seen and compared, by a person or an agent.
//
//   pnpm ui:shots                       build if stale, then save every screen to .ui-shots/current
//   pnpm ui:shots --out .ui-shots/before
//   pnpm ui:shots --compare .ui-shots/before     list the screens that differ from an earlier run
//   pnpm ui:shots --only panel-screen-off,chat   just these screens
//   node scripts/ui-compare.mjs <before folder> <after folder>   compare two saved runs without shooting again
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
import { compareFolders } from "./ui-compare.mjs";

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

async function openGroupPanel(page, view) {
  await page.route("**/api/computer", (route) => route.fulfill({ json: COMPUTER.off }));
  await page.locator('section[aria-label="Groups and people"] button', { hasText: "Launch" }).first().click();
  await wait(page, 800);
  await page.getByRole("button", { name: "Show conversation details", exact: true }).click();
  await wait(page, 500);
  if (view) await page.locator('[aria-label="Group panel view"]').getByRole("button", { name: view, exact: true }).click();
  await wait(page, 500);
}

const click = (locator) => locator.click({ timeout: 5000 });

async function openAppSettings(page, section) {
  // the profile row at the bottom left of the sidebar opens a small menu; "Settings" is in it
  await click(page.locator('aside [aria-haspopup="menu"]').last());
  await click(page.getByRole("menuitem", { name: "Settings", exact: true }));
  await wait(page, 700);
  if (section) await click(page.locator(`[data-settings-page="${section}"], [data-settings-section="${section}"]`).first());
  await wait(page, 500);
}
const settingsPage = (id) => ({ name: `app-settings-${id}`, go: (page) => openAppSettings(page, id) });

/** The bot's own settings: "Open Scout's profile" in the chat header opens the Details tab. */
async function openBotDetails(page) {
  await click(page.getByRole("button", { name: "Open Scout's profile" }).first());
  await wait(page, 700);
}
async function openRoutines(page, webhooks) {
  // the sidebar's Routines row is drawn only in the Advanced interface and not when every engine is a Claude/Codex
  // adapter; with the stand-in engine it is missing, so this screen is skipped (with a line saying so) until it is reachable
  await click(page.locator('[data-sidebar-nav="routines"]'));
  await wait(page, 900);
  if (webhooks) { await click(page.getByRole("button", { name: /Webhooks/ }).first()); await wait(page, 600); }
}

/** Every screen worth keeping an eye on: a name and how to reach it from the app's first screen.
 *  `narrow` also saves it in a phone-width window (a ".narrow" part before the skin in the file name);
 *  `advanced` turns on the Advanced interface mode for screens that only exist there. */
const SCREENS = [
  { name: "chat", go: async () => {}, narrow: true },
  { name: "panel-screen-off", go: (page) => openBotPanel(page, "off"), narrow: true },
  { name: "panel-screen-starting", go: (page) => openBotPanel(page, "preparing") },
  { name: "panel-screen-no-runtime", go: (page) => openBotPanel(page, "noRuntime") },
  { name: "panel-screen-unsupported", go: (page) => openBotPanel(page, "unsupported", "Screen") },
  { name: "panel-browser", go: (page) => openBotPanel(page, "off", "Browser") },
  { name: "panel-browser-computer-on", go: (page) => openBotPanel(page, "on", "Browser") },
  { name: "panel-files", go: (page) => openBotPanel(page, "off", "Files") },
  { name: "group-members", go: (page) => openGroupPanel(page, "Members") },
  { name: "group-screens", go: (page) => openGroupPanel(page, "Screens") },
  { name: "app-settings", go: (page) => openAppSettings(page) },
  settingsPage("general"),
  settingsPage("appearance"),
  settingsPage("ai"),
  settingsPage("computers"),
  settingsPage("account"),
  { name: "bot-details", go: openBotDetails, narrow: true },
  { name: "bot-details-library", go: async (page) => { await openBotDetails(page); await click(page.getByRole("tab", { name: /Library/ }).or(page.getByRole("button", { name: /^Library$/ })).first()); await wait(page, 400); } },
  { name: "bot-details-access", go: async (page) => { await openBotDetails(page); await click(page.getByRole("button", { name: /All settings|More profile options/ })); await wait(page, 500); await click(page.locator('[data-bot-settings-section="access"] > button').first()); await wait(page, 500); } },
  { name: "routines", advanced: true, go: (page) => openRoutines(page) },
  { name: "routines-webhooks", advanced: true, go: (page) => openRoutines(page, true) },
  { name: "mcp-servers", go: async (page) => { await click(page.getByRole("button", { name: "Apps", exact: true })); await wait(page, 700); await click(page.locator('[data-apps-filter="mcp"]')); await wait(page, 600); } },
  { name: "new-bot", seeded: true, blur: true, go: async (page) => { await click(page.getByRole("button", { name: "New or share" })); await click(page.getByRole("button", { name: /New Bot/ })); await wait(page, 700); } },
  { name: "new-group-or-dm", blur: true, go: async (page) => { await click(page.getByRole("button", { name: "New or share" })); await click(page.getByRole("button", { name: /New group or DM/ })); await wait(page, 600); } },
].filter((screen) => !only || only.includes(screen.name));
const VARIANTS = SCREENS.flatMap((screen) => [{ screen, narrow: false }, ...(screen.narrow ? [{ screen, narrow: true }] : [])]);

/** Times change on every run, and "Today" becomes "Yesterday" at midnight; one fixed wording keeps runs identical. */
const hold = (page) => page.evaluate(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    node.nodeValue = node.nodeValue.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)\b/gi, "9:41 AM").replace(/\bYesterday\b/g, "Today");
  }
});

mkdirSync(out, { recursive: true });
const ws = await startSharedWorkspace([], completionPatch(new Date("2026-01-01T00:00:00Z")), () => ({ COLONIE_STATIC_DIR: web }));
// a new workspace names its first bot at random; a fixed name keeps two runs identical
const first = (await (await fetch(`${ws.url}/api/bots`)).json()).bots[0];
const renamed = await fetch(`${ws.url}/api/bots/${first.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Scout" }) });
if (!renamed.ok) throw new Error(`could not name the bot: ${renamed.status} ${await renamed.text()}`);
const group = await fetch(`${ws.url}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "group", name: "Launch", bots: [first.id] }) });
if (!group.ok) throw new Error(`could not make the group: ${group.status} ${await group.text()}`);
const browser = await chromium.launch({ headless: true });
const written = {};
try {
  for (const skin of [undefined, "daylight"]) {
    for (const { screen, narrow } of VARIANTS) {
      const context = await browser.newContext({ viewport: narrow ? { width: 390, height: 844 } : { width: 1280, height: 800 }, reducedMotion: "reduce", deviceScaleFactor: 1 });
      // the server suggests a random name for a new bot; one fixed name keeps two runs identical
      if (screen.seeded) await context.route("**/api/bot-defaults", async (route) => { const reply = await route.fetch(); const body = await reply.json(); await route.fulfill({ response: reply, json: { ...body, suggestedName: "Pearl" } }); });
      if (screen.advanced) await context.addInitScript(() => { try { localStorage.setItem("colonie-advanced-mode", "1"); } catch {} });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(ws.url);
      await page.locator("main").first().waitFor({ timeout: 20_000 });
      if (skin) await page.evaluate((value) => { document.documentElement.dataset.skin = value; }, skin);
      await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; } span[aria-label*=\"nread\"] { opacity: 0 !important; }" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await wait(page, 1200);
      const file = `${screen.name}${narrow ? ".narrow" : ""}.${skin ? "light" : "dark"}.png`;
      try { await screen.go(page); } catch (error) {
        console.log(`  skipped ${file}: could not reach it (${String(error.message ?? error).split("\n")[0].slice(0, 140)})`);
        await context.close();
        continue;
      }
      // the focus ring of an auto-focused field sits a sliver differently from run to run, so a dialog is shown with nothing focused
      await page.evaluate(() => document.fonts.ready);
      await wait(page, 600);
      await hold(page);
      // the bot's face drifts a little all the time (it is alive), and its badge sits a fraction of a pixel differently
      // from one page load to the next, so both are covered with a flat patch. An unread dot appears or not
      // depending on timing, so it is hidden.
      // a dialog's backdrop or a focus ring can settle a few pixels late, so take the picture until two in a row match
      const shoot = async () => { if (screen.blur) { await page.evaluate(() => document.activeElement?.blur?.()); await wait(page, 150); } return page.screenshot({ animations: "disabled", caret: "hide", mask: [page.getByRole("img", { name: "Scout", exact: true }), page.getByRole("img", { name: "Launch", exact: true }), page.getByTitle("Chief of Staff").locator("xpath=..")], maskColor: "#6d5ae6" }); };
      let picture = await shoot();
      for (let tries = 0; tries < 6; tries += 1) { await wait(page, 250); const again = await shoot(); const same = again.equals(picture); picture = again; if (same) break; }
      writeFileSync(join(out, file), picture);
      written[file] = createHash("sha256").update(readFileSync(join(out, file))).digest("hex");
      if (errors.length) console.log(`  page error on ${file}: ${errors[0].slice(0, 160)}`);
      await context.close();
    }
  }
} finally { await browser.close(); await ws.stop(); }
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(written, null, 2)}\n`);
console.log(`Saved ${Object.keys(written).length} screens to ${relative(root, out)}`);

if (compare) await compareFolders(join(root, compare), out, { whole: !only });
