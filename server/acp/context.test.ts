// What a bot is told about Colonie on each turn: short background facts, no
// contradictions about what it can do, and its current profile.
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

import { composeContext, contextCandidate, pinContext, type ContextProfile } from "./context.ts";

const profile = (extra: Partial<ContextProfile> = {}): ContextProfile => ({ id: `bot-${randomUUID()}`, name: "Nova", title: "Researcher", description: "", soul: "Be brief.", ...extra });
const text = (prompt: Array<{ type: string; text?: string }>) => prompt.map((block) => block.text ?? "").join("\n\n");
const effective = { provider: "Codex", model: "m", mode: "default" };

test("a bot hears now, who is asking and where, once, as background before the message", () => {
  const bot = profile();
  const thread = randomUUID();
  const pin = pinContext(thread, contextCandidate(bot, "codex-acp", ""));
  const situation = "Now: Thursday, October 23, 2026 at 10:15 (Asia/Jakarta). You are talking with Hanif. This is the Shared workspace \"Etalas\" with 2 people: Hanif, Budi.";
  const { prompt, manifest } = composeContext(pin, "ingatkan aku besok jam 9", "codex-acp", "", { ...effective, situation });
  const all = text(prompt);
  expect(all.split(situation).length).toBe(2);
  expect(all.indexOf(situation)).toBeLessThan(all.indexOf("ingatkan aku besok jam 9"));
  expect(manifest.sections.find((section) => section.id === "app.situation")?.status).toBe("active");
  // the person's words reach the engine unchanged, as the last block
  expect(prompt.at(-1)).toEqual({ type: "text", text: "ingatkan aku besok jam 9" });
});

test("an ordinary bot is told it can schedule and save guides, not that automation is unavailable", () => {
  const bot = profile();
  const pin = pinContext(randomUUID(), contextCandidate(bot, "codex-acp", ""));
  const all = text(composeContext(pin, "hi", "codex-acp", "", effective).prompt);
  expect(all).toContain("schedule and change your own routines and save your own guides");
  expect(all).not.toContain("automation are not available");
  expect(all).toContain("call about_colonie rather than guessing");
});

test("the Chief is not told its role gives no delegation tools", () => {
  const bot = profile({ chiefOfStaff: true });
  const pin = pinContext(randomUUID(), contextCandidate(bot, "codex-acp", ""));
  const all = text(composeContext(pin, "hi", "codex-acp", "", { ...effective, chief: true }).prompt);
  expect(all).not.toContain("does not provide delegation tools");
  expect(all).toContain("Chief of Staff");
});

test("renaming a bot or changing its instructions reaches a conversation from its next message", () => {
  const bot = profile();
  const thread = randomUUID();
  pinContext(thread, contextCandidate(bot, "codex-acp", ""));
  const renamed = pinContext(thread, contextCandidate({ ...bot, name: "Mochi", soul: "Answer in Indonesian." }, "codex-acp", ""));
  const all = text(composeContext(renamed, "hi", "codex-acp", "", effective).prompt);
  expect(all).toContain("Name: Mochi");
  expect(all).toContain("Answer in Indonesian.");
  expect(all).not.toContain("Name: Nova");
});

test("a conversation from before context stays plain", () => {
  const bot = profile();
  const thread = randomUUID();
  const plain = pinContext(thread, contextCandidate(bot, "codex-acp", "", true));
  expect(pinContext(thread, contextCandidate({ ...bot, name: "Mochi" }, "codex-acp", "")).snapshot.hash).toBe(plain.snapshot.hash);
});
