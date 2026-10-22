// The Shared workspace journey, as two people live it, in a real Chromium:
// the owner opens the owner invite and signs up at Colonie Cloud, lands in
// the workspace (never a blank page), writes to a bot, invites a second
// person who signs up too, makes a group with them and the bot, @mentions
// each, and the bot answers in the group. Everything runs on this machine: a
// local Colonie Cloud, a throwaway Shared workspace serving the built web
// app, and a stand-in engine. It exits non-zero at the first broken step.
//
// pnpm build first, then: node scripts/journeys/shared-workspace.mjs [web app folder]
// (default dist/). CHROME= points at a Chromium when Playwright's own is not
// installed (`pnpm exec playwright install chromium`).
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const web = process.argv[2] ?? join(root, "dist");
if (!existsSync(join(web, "index.html"))) throw new Error(`No built web app in ${web}: run pnpm build first.`);
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright");
const { startColonieCloud } = await import(join(root, "server/testing/colonie-cloud.ts"));
const { startSharedWorkspace } = await import(join(root, "server/testing/shared-workspace.ts"));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let step = "starting";
const check = (condition, what) => {
  if (!condition) throw new Error(`Journey failed at "${step}": ${what}`);
  console.log(`  ok  ${what}`);
};
const text = async (page) => (await page.innerText("body")).replace(/\s+/g, " ");
async function until(page, predicate, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) { console.log(`  ok  ${what}`); return true; } await wait(250); }
  check(false, `${what} (page: ${(await text(page)).slice(0, 200)})`);
}

const cloud = await startColonieCloud();
const ownerCode = randomBytes(24).toString("base64url");
const ws = await startSharedWorkspace([], {}, (url) => ({
  COLONIE_STATIC_DIR: web, COLONIE_WORKSPACE_KIND: "shared", COLONIE_PUBLIC_URL: url,
  COLONIE_CLOUD_ISSUER: cloud.url, COLONIE_WORKSPACE_NAME: "Launch Team", COLONIE_OWNER_INVITE_CODE: ownerCode,
}));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const errors = [];

async function join_(invite, person) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${person.name}: ${error}`));
  await page.goto(invite);
  check((await text(page)).includes("Open in the Colonie app"), `${person.name}'s invite page offers the app, this browser, or a download`);
  await page.click("text=Continue in this browser");
  await page.click("text=Create an account");
  await page.fill('input[name="name"]', person.name);
  await page.fill('input[name="email"]', person.email);
  await page.fill('input[name="password"]', "a strong password");
  await Promise.all([page.waitForLoadState("load"), page.click('button[type="submit"]')]);
  check((await page.title()).startsWith("Continue"), `${person.name} reaches the consent page after signing up`);
  await Promise.all([page.waitForLoadState("load"), page.click('button:has-text("Continue")')]);
  await until(page, async () => (await page.locator(`section[aria-label="Groups and people"]`).count()) > 0, `${person.name} lands in the workspace, not a blank page`);
  await settle(page);
  return page;
}

/** The first-run welcome (an admin's) or note (a member's) can arrive a
 * moment after the page: put it away so it covers nothing. */
async function settle(page) {
  for (let i = 0; i < 12; i++) {
    const skip = page.getByRole("button", { name: "Skip tour" });
    const gotIt = page.getByRole("button", { name: "Got it" });
    const next = page.locator('[role="dialog"] button:has-text("Continue")').first();
    if (await skip.isVisible().catch(() => false) && await skip.isEnabled().catch(() => false)) await skip.click();
    else if (await next.isVisible().catch(() => false)) await next.click();
    else if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
    await wait(250);
  }
}

let failed = false;
try {
  step = "the owner joins";
  const ana = await join_(`${ws.url}/invite/${ownerCode}`, { name: "Ana", email: "ana@x.com" });
  check((await text(ana)).includes("ana@x.com"), "the sidebar shows the owner's own account");

  step = "the owner's first message to a bot";
  await ana.fill("textarea", "hello bot");
  await ana.keyboard.press("Enter");
  await until(ana, async () => (await text(ana)).includes("hello bot"), "the first message is sent (no thread error)");
  check(!/threadId must be|no such task/.test(await text(ana)), "no error is shown");

  step = "a second person joins by invite";
  const invite = await ana.evaluate(async () => (await (await fetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).url);
  check(typeof invite === "string" && invite.includes("/invite/"), "the owner makes an invite link");
  const bob = await join_(invite, { name: "Bob", email: "bob@x.com" });

  step = "a group with a person and a bot";
  await settle(ana);
  await ana.click('button[aria-label="New group or DM"]');
  await ana.fill('input[aria-label="Group name"]', "Launch");
  await ana.click('button[aria-pressed]:has-text("Bob")');
  await ana.locator('fieldset:has(legend:text("Bots")) button').first().click();
  await ana.click('button:has-text("Create group")');
  await until(bob, async () => (await text(bob)).includes("Launch"), "the group shows in Bob's sidebar without a reload");

  step = "@mentions";
  await ana.click("main form textarea");
  await ana.keyboard.type("@Bo");
  await until(ana, async () => (await ana.locator('ul[aria-label="Mention"] button').count()) > 0, "typing @Bo suggests Bob");
  await ana.keyboard.press("Enter");
  await ana.keyboard.type("can you check the budget?");
  await ana.keyboard.press("Enter");
  await until(bob, async () => (await bob.locator('[aria-label="You were mentioned"]').count()) > 0, "Bob is marked as mentioned");
  const botChip = ana.locator("main form button", { hasText: /^@/ }).first();
  await botChip.click();
  await ana.keyboard.type("please summarise");
  await ana.keyboard.press("Enter");
  await until(ana, async () => {
    const answered = await ana.locator('[data-testid="sender-line"]', { hasText: "Bot" }).count();
    return answered > 0 && !(await text(ana)).includes("is working on it");
  }, "the bot answers in the group, under its face and name", 40_000);

  step = "Bob reads the group";
  await bob.click('section[aria-label="Groups and people"] button:has-text("Launch")');
  await until(bob, async () => (await text(bob)).includes("can you check the budget?"), "Bob reads the conversation");
  check(await bob.locator('[data-testid="sender-line"]', { hasText: "Ana" }).count() > 0, "Bob sees Ana's messages under her face and name");

  step = "a photo on the account";
  const photoPage = await ana.context().newPage();
  await photoPage.goto(`${cloud.url}/photo`);
  // a 4×4 PNG; the page shrinks it to a square JPEG in the browser
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4EWADRwzEcQAxkhVB/dKiCQAAAABJRU5ErkJggg==", "base64");
  await photoPage.setInputFiles("#file", { name: "me.png", mimeType: "image/png", buffer: png });
  await until(photoPage, async () => await photoPage.locator("#save").isEnabled(), "Ana chooses a picture at Colonie Cloud");
  await Promise.all([photoPage.waitForLoadState("load"), photoPage.click("#save")]);
  await until(photoPage, async () => (await text(photoPage)).includes("Saved."), "the photo is saved on her account");
  await photoPage.close();
  await bob.reload();
  await settle(bob);
  await until(bob, async () => bob.evaluate(() => [...document.querySelectorAll('section[aria-label="Groups and people"] img')]
    .some((img) => img.src.includes("/photos/") && img.complete && img.naturalWidth > 0)), "Bob sees Ana's photo in his sidebar");

  step = "a DM from the sidebar";
  await bob.reload();
  await settle(bob);
  await bob.click('section[aria-label="Groups and people"] button[title="ana@x.com"]');
  await bob.fill("main form textarea", "just between us");
  await bob.keyboard.press("Enter");
  await until(ana, async () => (await ana.locator('section[aria-label="Groups and people"] button:has-text("Bob") [aria-label="Unread"]').count()) > 0, "Ana sees Bob's DM as unread in her sidebar");
  await ana.click('section[aria-label="Groups and people"] button:has-text("Bob")');
  await until(ana, async () => (await text(ana)).includes("just between us"), "Ana reads the DM");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
  console.log("Shared workspace journey: passed");
} catch (error) {
  failed = true;
  console.error(String(error));
  console.error(ws.log().slice(-2000));
} finally {
  await browser.close();
  await ws.stop();
  await cloud.stop();
}
process.exit(failed ? 1 : 0);
