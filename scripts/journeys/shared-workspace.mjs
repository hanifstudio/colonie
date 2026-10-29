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
import { verifyChatComposer } from "./chat-composer.mjs";

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
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), headless: !process.env.COLONIE_JOURNEY_HEADFUL });
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
  await until(page, async () => (await page.locator("[data-sidebar-bot-row]").count()) > 0, `${person.name} lands in the workspace, not a blank page`);
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
  const personal = async (page) => page.evaluate(async () => {
    const bot = (await (await fetch("/api/bots")).json()).bots[0];
    return { threadId: bot.threadId, messages: bot.messages.map(({ id, text }) => ({ id, text })), busy: bot.busy };
  });
  await until(ana, async () => !(await personal(ana)).busy, "the personal bot reply finishes");
  const anaPersonal = await personal(ana);

  step = "a second person joins by invite";
  const invite = await ana.evaluate(async () => (await (await fetch("/api/invites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).url);
  check(typeof invite === "string" && invite.includes("/invite/"), "the owner makes an invite link");
  const bob = await join_(invite, { name: "Bob Hartono", email: "bob@x.com" });
  const bobPersonal = await personal(bob);

  step = "a group with a person and a bot";
  await settle(ana);
  await ana.click('button[aria-label="New or share"], button[aria-label="New"]');
  await ana.click('button:has-text("New group or DM")');
  await ana.fill('input[aria-label="Group name"]', "Launch");
  await ana.click('button[aria-pressed]:has-text("Bob")');
  await ana.locator('fieldset:has(legend:text("Bots")) button').first().click();
  await ana.click('button:has-text("Create group")');
  await until(bob, async () => (await text(bob)).includes("Launch"), "the group shows in Bob's sidebar without a reload");

  step = "typing and mentions in a group";
  await verifyChatComposer(ana, { name: "Bob Hartono", label: "group", check, until });

  step = "@mentions";
  await ana.click("main form textarea");
  await ana.keyboard.type("@Bo");
  await until(ana, async () => (await ana.locator('[role="listbox"][aria-label="Mention"] [role="option"]').count()) > 0, "typing @Bo suggests Bob");
  await ana.keyboard.press("Enter");
  await ana.keyboard.type("can you check the budget?");
  await ana.keyboard.press("Enter");
  await until(bob, async () => (await bob.locator('[aria-label="You were mentioned"]').count()) > 0, "Bob is marked as mentioned");
  // a bot is mentioned the same way: "@", its name from the menu
  const botName = await ana.evaluate(async () => (await (await fetch("/api/bots")).json()).bots[0].name);
  await ana.keyboard.type(`@${botName.slice(0, 2)}`);
  await until(ana, async () => (await ana.locator('[role="listbox"][aria-label="Mention"] [role="option"]', { hasText: botName }).count()) > 0, "typing @ suggests the bot too");
  await ana.locator('[role="listbox"][aria-label="Mention"] [role="option"]', { hasText: botName }).first().click();
  await ana.keyboard.type("please summarise");
  await ana.keyboard.press("Enter");
  await until(ana, async () => {
    const answered = await ana.locator('[data-testid="sender-line"]', { hasText: "Bot" }).count();
    return answered > 0 && !(await text(ana)).includes("is working on it");
  }, "the bot answers in the group, under its face and name", 40_000);

  step = "@here";
  const answersBefore = await ana.locator('[data-testid="sender-line"]', { hasText: "Bot" }).count();
  await ana.keyboard.type("@he");
  const here = ana.locator('[role="listbox"][aria-label="Mention"] [role="option"]', { hasText: "Everyone in this group" });
  await until(ana, async () => (await here.count()) > 0, "typing @he offers @here, for everyone in the group");
  await here.first().click();
  await ana.keyboard.type("standup in five");
  await ana.keyboard.press("Enter");
  await until(ana, async () => /Working · \d+s/.test(await text(ana)) || (await ana.locator('[data-testid="sender-line"]', { hasText: "Bot" }).count()) > answersBefore,
    "the bot's line says Working with a clock, not bare dots, while it answers");
  await until(ana, async () => (await text(ana)).includes("@here standup in five"), "the @here message is sent");
  check(!(await ana.getByRole("alert").count()), "sending @here shows no error");
  await until(ana, async () => (await ana.locator('[data-testid="sender-line"]', { hasText: "Bot" }).count()) > answersBefore && !(await text(ana)).includes("is working on it"),
    "the group's bot answers @here without being named", 40_000);

  step = "each bot's approval level in the group";
  await ana.click('button:has-text("Members")');
  const level = ana.locator(`select[aria-label="How ${botName} asks for permission"]`);
  await until(ana, async () => (await level.count()) > 0, "the group lists the bot with its approval level");
  check(await level.inputValue() === "auto", "a new bot starts on Ask when risky");
  await level.selectOption("ask");
  await until(ana, async () => (await ana.evaluate(async (name) => (await (await fetch("/api/bots")).json()).bots.find((bot) => bot.name === name).approvalMode, botName)) === "ask",
    "choosing Always ask in the group changes the bot");
  await level.selectOption("full");
  await ana.getByRole("button", { name: "Enable full access" }).click();
  await until(ana, async () => (await ana.evaluate(async (name) => (await (await fetch("/api/bots")).json()).bots.find((bot) => bot.name === name).approvalMode, botName)) === "full",
    "the admin turns on Full access from the group, after its warning");
  check(!(await ana.getByRole("alert").count()), "Full access shows no error");
  await level.selectOption("auto");
  await until(ana, async () => (await ana.evaluate(async (name) => (await (await fetch("/api/bots")).json()).bots.find((bot) => bot.name === name).approvalMode, botName)) === "auto",
    "and Ask when risky changes it back");
  await ana.click('button:has-text("Members")');

  step = "Bob reads the group";
  await bob.click('section[aria-label="Groups and people"] button:has-text("Launch")');
  await until(bob, async () => (await text(bob)).includes("can you check the budget?"), "Bob reads the conversation");
  await until(bob, async () => (await bob.locator('[data-testid="sender-line"]', { hasText: "Ana" }).count()) > 0, "Bob sees Ana's messages under her face and name");

  step = "group work stays out of personal chats";
  await bob.fill("main form textarea", `@${botName} Bob's separate group request`);
  await bob.keyboard.press("Enter");
  await until(bob, async () => {
    const body = await text(bob);
    return body.includes("Bob's separate group request") && !body.includes("is working on it") && (await personal(bob)).messages.length === bobPersonal.messages.length;
  }, "Bob's first bot request runs in the group", 40_000);
  for (const [page, before, name] of [[ana, anaPersonal, "Ana"], [bob, bobPersonal, "Bob"]]) {
    await page.reload();
    await settle(page);
    const after = await personal(page);
    check(after.threadId === before.threadId && JSON.stringify(after.messages) === JSON.stringify(before.messages), `${name}'s personal transcript is unchanged after live group work and reload`);
    await page.locator("[data-sidebar-bot-row]").first().click();
    check(!(await page.locator("main").innerText()).includes("Bob's separate group request"), `${name}'s bot DM contains no group request`);
  }

  step = "stopping one's own group work";
  await bob.click('section[aria-label="Groups and people"] button:has-text("Launch")');
  await bob.fill("main form textarea", `@${botName} permission please`);
  await bob.keyboard.press("Enter");
  await until(bob, async () => (await text(bob)).includes("is waiting for Bob"), "the bot asks Bob for approval inside the group", 40_000);
  await bob.getByRole("button", { name: "Stop my work", exact: true }).click();
  await until(bob, async () => (await text(bob)).includes("Stopped by the person who asked."), "Bob stops the waiting work in the group");
  await until(bob, async () => !(await bob.getByRole("button", { name: /^(Stop my work|Stopping…)$/ }).count()), "the cancelled work no longer appears active");
  check(!(await bob.getByRole("alert").count()), "stopping the work shows no request error");
  check(JSON.stringify((await personal(ana)).messages) === JSON.stringify(anaPersonal.messages), "stopping group work leaves Ana's personal transcript unchanged");
  if (process.env.COLONIE_JOURNEY_SCREENSHOT) await bob.screenshot({ path: process.env.COLONIE_JOURNEY_SCREENSHOT });

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
  step = "typing and mentions in a person's DM";
  await verifyChatComposer(ana, { name: "Bob Hartono", label: "person-dm", check, until });

  step = "typing and mentions in a bot's DM";
  const originalBotId = await ana.evaluate(async (name) => (await (await fetch("/api/bots")).json()).bots.find((bot) => bot.name === name).id, botName);
  const createdBot = await ana.evaluate(async () => {
    const response = await fetch("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Nara Research" }) });
    return response.status;
  });
  check(createdBot === 201, "a second fixture bot is available for mention suggestions");
  await ana.locator(`[data-sidebar-bot-row="${originalBotId}"]`).click();
  await until(ana, async () => {
    const editor = ana.locator('main [data-tour="composer"] textarea');
    return await editor.count() > 0 && (await editor.getAttribute("aria-label") ?? "").includes(botName);
  }, "the original bot's DM is open");
  await verifyChatComposer(ana, { name: "Nara Research", label: "bot-dm", check, until });
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
