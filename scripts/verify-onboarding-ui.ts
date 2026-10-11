// Assert the first-run welcome flow against a handle from `control-omb ui
// launch`. The handle gate refuses live-app URLs and stopped fixtures. All
// profile, bot and onboarding writes below stay inside that launch's
// disposable home.
//
// The guided tour and the first-conversation spotlights are disabled in
// Colonie for now, so this recipe stops at the welcome flow: it proves the
// flow completes, persists, stays dismissed after reload, hands straight to
// the chat with no tour, and still replays from Settings.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runControlOmb } from "./control-omb.ts";

const handle = process.argv[2];
if (!handle) throw new Error("Usage: node --experimental-strip-types scripts/verify-onboarding-ui.ts /path/to/fixture/ui.json");
const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;
const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
const click = async (name: string) => {
  // Let the 320ms view transition land before sending a real pointer click;
  // the browser CLI does not wait for moving controls to stabilize.
  await delay(400);
  return ui("click", "--name", name);
};
const type = (name: string, text: string) => ui("type", "--name", name, "--text", text);
const snapshot = async () => (await ui("snapshot")).snapshot as string;
const config = () => evaluate("fetch('/api/config').then(r => r.json())");
const poll = async (read: () => Promise<unknown>, expected: unknown, label: string) => {
  const end = Date.now() + 15_000;
  let result;
  do {
    result = await read();
    if (JSON.stringify(result) === JSON.stringify(expected)) return;
    await delay(100);
  } while (Date.now() < end);
  assert.deepEqual(result, expected, label);
};
const textVisible = (text: string) => poll(async () => (await snapshot()).includes(text), true, text);
const evidence = resolve(".omb-scratch/verify-evidence/onboarding");
mkdirSync(evidence, { recursive: true });
const screenshot = (name: string) => ui("screenshot", "--out", resolve(evidence, `${name}.png`));
const openSettings = async () => {
  await click("Onboarding fixture");
  await click("Settings");
  await textVisible("Replay welcome tour");
};
const holdConfigWrite = () => evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.heldWrites = 0;
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.heldWrites++;
      window.fetch = original;
      return new Promise(resolve => { window.releaseWrite = () => resolve(original(input, init)); });
    }
    return original(input, init);
  };
  return true;
})()`);

// The standard fixture suppresses onboarding. This opt-in entry skips that
// suppression; only this fixture browser's localStorage is cleared. The
// onboarding record is reset first so the recipe can rerun on one fixture.
await evaluate("fetch('/api/config', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({onboarding:{completedAt:'', version:0, reelSeen:false, hintsSeen:[]}})}).then(r=>r.ok)");
await evaluate("localStorage.clear(); setTimeout(() => { location.search = '?onboarding=1'; }, 0); true");
await textVisible("Your name");
await evaluate("document.documentElement.dataset.reducedMotion = 'true'; true");
await screenshot("welcome");
await type("Your name", "Onboarding fixture");
await type("Email", "onboarding@example.test");
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/config' && init?.method === 'PUT') {
      window.fetch = original;
      return Promise.resolve(new Response(JSON.stringify({error:'Fixture profile rejected'}), {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Continue");
await textVisible("Couldn't save your details");
assert.equal(await evaluate("document.querySelector('input[type=email]').value"), "onboarding@example.test");
await click("Continue");
await textVisible("What your bots can do");
assert.equal((await config()).profile.email, "onboarding@example.test");
console.log("PASS profile failure preserves input; retry persists before advancing");

// Reduced motion must hold every scene, particularly the timed /setup
// scene. Scene navigation is driven by the real Next button.
await click("Next");
await click("Next");
await textVisible("Start a message with /setup and describe the job");
await screenshot("reel");
await delay(5500);
await textVisible("Start a message with /setup and describe the job");
await click("Next");
await click("Next");
await click("Next");
await click("Continue");

// The engines beat frames the two ACP providers and keeps working when the
// inventory request fails.
await textVisible("Codex or Claude Code");
await textVisible("Never installed either");
await textVisible("Check again");
await screenshot("engines");
const inventoryBefore = await evaluate("[...document.querySelectorAll('.welcome-card [aria-expanded]')].map(e => e.textContent)");
await evaluate(`(() => {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (String(input) === '/api/instances') {
      window.fetch = original;
      return Promise.resolve(new Response(JSON.stringify({error:'Fixture inventory unavailable'}), {status:503}));
    }
    return original(input, init);
  };
  return true;
})()`);
await click("Check again");
await textVisible("Couldn't check your AI connections");
assert.deepEqual(await evaluate("[...document.querySelectorAll('.welcome-card [aria-expanded]')].map(e => e.textContent)"), inventoryBefore);
await click("Check again");
await poll(async () => (await snapshot()).includes("Couldn't check your AI connections"), false, "inventory retry");
await click("Continue");

// No phone beat in Colonie: the engines beat hands straight to the bot beat.
await textVisible("Start chatting");
await screenshot("meet-bot");
await click("Start chatting");

// The guided tour is off: finishing lands directly in the chat with no card.
await poll(async () => (await snapshot()).includes("Start chatting"), false, "welcome closed");
assert.equal(await evaluate("document.querySelectorAll('.welcome-card, [data-tour-card]').length"), 0);
await textVisible("Message Pepper");
await poll(async () => Boolean((await config()).onboarding.completedAt), true, "welcome save completed");
assert.equal((await config()).onboarding.hintsSeen.filter((id: string) => id.startsWith("tour.")).length, 0);
console.log("PASS reel, engine failure/retry, no phone beat, welcome completion with no guided tour");

await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible("Message Pepper");
assert.equal(await evaluate("document.querySelectorAll('.welcome-card, [data-tour-card]').length"), 0);
console.log("PASS reload stays dismissed with no tour");

// Settings keeps the welcome replay and no longer offers an app tour.
await openSettings();
assert.equal(await evaluate("document.body.innerHTML.includes('Replay app tour')"), false, "no app-tour replay button");
await click("Replay welcome tour");
await textVisible("Your name");
// The greeting cannot be skipped: name and email are mandatory.
assert.equal(
  await evaluate("[...document.querySelectorAll('.welcome-card button')].find((b) => b.textContent.includes('Skip tour')).disabled"),
  true,
  "greeting Skip tour is disabled",
);
await type("Your name", "Onboarding fixture");
await type("Email", "onboarding@example.test");
await click("Continue");
await textVisible("What your bots can do");
await holdConfigWrite();
await click("Skip tour");
await poll(() => evaluate("document.querySelectorAll('.welcome-card').length"), 0, "slow completion cannot trap welcome");
await evaluate("window.releaseWrite(); true");
console.log("PASS greeting cannot be skipped; welcome replay can close while persistence is pending");
await poll(async () => Boolean((await config()).onboarding.completedAt), true, "welcome save completed");

// An upgraded install can have only the legacy browser gate; replay still
// works there without a new welcome completion.
await evaluate("fetch('/api/config', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({onboarding:{completedAt:'', version:0}})}).then(r=>r.ok)");
await evaluate("setTimeout(() => location.reload(), 0); true");
await textVisible("Message Pepper");
await openSettings();
await click("Replay welcome tour");
await textVisible("Your name");
console.log("PASS legacy-install replay opens without a new welcome completion");
await screenshot("complete");
console.log(JSON.stringify({ ok: true, evidence, config: (await config()).onboarding }));