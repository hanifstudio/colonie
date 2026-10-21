// Bot memory learns from every person who uses the bot. A message signed by
// someone other than the owner (a person of a Shared workspace) teaches this
// bot only, naming who said it; it never reaches the owner's own profile,
// which every bot shares.
import { expect, test } from "vitest";

import type { MemorySnapshot } from "../../../../shared/colonie-memory.ts";
import { capturePrompt, parseCapture } from "./capture.ts";
import type { MemoryJob } from "./store.ts";

const job = (speaker?: string): MemoryJob => ({
  id: "j1", botId: "bot-1", threadId: "t1", messageId: "m1",
  text: "I prefer weekly summaries on Monday and our launch is in March.",
  at: "2026-10-21T08:00:00.000Z", state: "queued", attempts: 0, ownerGeneration: 0, revision: "1",
  ...(speaker ? { speaker } : {}),
});
const entry = (id: string, scope: "shared" | "bot") => ({
  id, scope, ...(scope === "bot" ? { botId: "bot-1" } : {}), key: `k.${id}`, text: `entry ${id}`, kind: "fact" as const,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", origin: "automatic" as const,
});
const snapshot: MemorySnapshot = {
  revision: "1",
  app: { enabled: true, automatic: true },
  bot: { enabled: true, automatic: true },
  entries: [entry("owner-profile", "shared"), entry("team-fact", "bot")],
} as MemorySnapshot;

const answer = JSON.stringify([
  { action: "upsert", scope: "shared", kind: "preference", key: "summary.day", text: "Prefers weekly summaries on Monday.", evidence: "I prefer weekly summaries on Monday", confidence: 0.9 },
  { action: "upsert", scope: "bot", kind: "preference", key: "budi.summary.day", text: "Budi prefers weekly summaries on Monday.", evidence: "I prefer weekly summaries on Monday", confidence: 0.9 },
  { action: "forget", replaces: "owner-profile", evidence: "our launch is in March", confidence: 0.9 },
]);

test("a signed message asks for facts about that person, in this bot's memory only", () => {
  const prompt = capturePrompt(job("Budi"), snapshot);
  expect(prompt).toContain("Budi");
  expect(prompt).toMatch(/several people/);
  expect(prompt).toMatch(/bot scope only/);
  // the owner's profile is not shown to a capture it may not change
  expect(prompt).not.toContain("owner-profile");
  expect(prompt).toContain("team-fact");
});

test("a signed message can neither write nor forget the owner's profile", () => {
  const changes = parseCapture(answer, job("Budi"), snapshot);
  expect(changes).toEqual([expect.objectContaining({ scope: "bot", key: "budi.summary.day" })]);
});

test("the owner's own message still keeps facts about them in their profile", () => {
  const changes = parseCapture(answer, job(), snapshot);
  expect(changes.map((change) => `${change.action}:${change.scope}`)).toEqual(["upsert:shared", "upsert:bot", "forget:shared"]);
  expect(capturePrompt(job(), snapshot)).toContain("owner-profile");
});
