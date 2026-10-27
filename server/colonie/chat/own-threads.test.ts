import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { Store } from "../../persistence/store.ts";
import { createOwnThreads } from "./own-threads.ts";

test("a saved group-work pointer cannot become a personal chat, before or after reload", () => {
  const store = new Store(() => ({ instanceId: "codex-acp", model: "agent-default" }));
  const bot = store.createBot({ name: "Nimbus" });
  const person = "person";
  const personal = store.createTask(bot.id, "Private", false, undefined, undefined, undefined, undefined, [person])!;
  const work = store.createTask(bot.id, "Group", false, undefined, undefined, undefined, undefined, [person], { forConversation: "igrs" })!;
  work.updatedAt = Date.now() + 1000;
  const file = join(DATA_DIR, "test-person-threads.json");
  writeFileSync(file, JSON.stringify({ [`${person}:${bot.id}`]: work.threadId }));
  for (let reload = 0; reload < 2; reload++) {
    const own = createOwnThreads({ store: () => store, sharedWorkspace: () => true, file });
    expect(own.currentThread(person, bot)).toBe(personal.threadId);
    expect(own.choose(person, bot.id, work.threadId)).toBe(false);
    expect(own.openThread(person, bot)).toBe(personal.threadId);
  }
});

test("group work is marked before its first event and cannot become a Local DM", () => {
  const store = new Store(() => ({ instanceId: "codex-acp", model: "agent-default" }));
  const bot = store.createBot({ name: "Nimbus" });
  const personal = bot.threadId;
  let firstPurpose: string | undefined;
  const off = store.onChange((change) => {
    if (change.type === "bot" && change.botId === bot.id) firstPurpose ??= store.tasks(bot.id)[0]?.forConversation;
  });
  const work = store.createTask(bot.id, "Group", false, undefined, undefined, undefined, undefined, ["person"], { forConversation: "igrs" })!;
  off();
  expect(firstPurpose).toBe("igrs");
  store.switchTask(bot.id, work.threadId); // a pointer saved by an older build
  const own = createOwnThreads({ store: () => store, sharedWorkspace: () => false, file: join(DATA_DIR, "unused.json") });
  expect(own.currentThread(null, bot)).toBe(personal);
});
