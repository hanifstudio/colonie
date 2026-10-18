// Staged skill writes must be dropped when the transcript holding their card
// goes away, and the listing must never leak the staged instructions.
import { expect, test } from "vitest";
import { createStagedSkillCleanup } from "./staged-cleanup.ts";

type Message = {
  from?: { botId?: string };
  card?: { skillRequest?: { stagedId: string } };
};

function build(thread: { directOwner?: string; messages: Message[] }) {
  return createStagedSkillCleanup({
    store: {
      botByThread: () => (thread.directOwner ? { id: thread.directOwner } : undefined),
      messagesFor: () => thread.messages,
    },
  } as never);
}

test("a staged listing carries lifecycle metadata but no instructions", () => {
  const { stagedSkillListing } = build({ messages: [] });
  expect(stagedSkillListing({
    id: "s1", botId: "b1", status: "pending", files: [{ path: "SKILL.md" }],
    baseSha256: "abc", baseAppliedStageId: "prev",
  } as never)).toEqual({ id: "s1", botId: "b1", status: "pending" });
});

test("the cleanup collects one pair per card, deduplicated", () => {
  const { stagedSkillCleanupsForThread } = build({
    messages: [
      { from: { botId: "b1" }, card: { skillRequest: { stagedId: "s1" } } },
      { from: { botId: "b1" }, card: { skillRequest: { stagedId: "s1" } } },
      { from: { botId: "b2" }, card: { skillRequest: { stagedId: "s1" } } },
    ],
  });
  expect(stagedSkillCleanupsForThread("t1")).toEqual([
    { botId: "b1", stagedId: "s1" },
    { botId: "b2", stagedId: "s1" },
  ]);
});

test("a card with no sender belongs to the thread's own bot", () => {
  const { stagedSkillCleanupsForThread } = build({
    directOwner: "b1",
    messages: [{ card: { skillRequest: { stagedId: "s9" } } }],
  });
  expect(stagedSkillCleanupsForThread("t1")).toEqual([{ botId: "b1", stagedId: "s9" }]);
});

test("messages with no skill card, and cards with no owner, are ignored", () => {
  const { stagedSkillCleanupsForThread } = build({
    messages: [
      { from: { botId: "b1" } },
      { card: { skillRequest: { stagedId: "s1" } } }, // no sender and no direct owner
    ],
  });
  expect(stagedSkillCleanupsForThread("t1")).toEqual([]);
});
