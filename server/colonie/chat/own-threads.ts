// Each person's own conversation with a bot, in a Shared workspace.
//
// A bot record has one current thread (`bot.threadId`), which the desktop app
// moves as its one person switches conversations. In a Shared workspace several
// people talk to the same bot, so that shared pointer belongs to nobody: each
// person keeps their own current conversation per bot here, in a server-private
// file (<data>/person-threads.json, 0600) that no client ever receives. A
// person's first message to a bot opens a conversation naming them. In a
// Local workspace nothing changes: the current thread is the bot's.
import { readFileSync } from "node:fs";

import { writeFileAtomic } from "../../persistence/atomic.ts";
import type { BotRecord, Store } from "../../persistence/store.ts";

export interface OwnThreadsDeps {
  store: () => Store;
  sharedWorkspace: () => boolean;
  file: string;
}

export function createOwnThreads({ store, sharedWorkspace, file }: OwnThreadsDeps) {
  const pointers = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [key, threadId] of Object.entries(raw)) if (typeof threadId === "string") pointers.set(key, threadId);
    }
  } catch {
    // absent or unreadable: everyone starts from their newest conversation
  }
  const keyOf = (person: string, botId: string) => `${person}:${botId}`;
  const save = () => writeFileAtomic(file, JSON.stringify(Object.fromEntries(pointers)), { mode: 0o600 });
  const takesPart = (botId: string, threadId: string, person: string) =>
    (store().taskByThread(botId, threadId)?.participants ?? []).includes(person);

  /** The person's current conversation with this bot, or null when they have
   * none yet. A pointer that no longer names one of their conversations falls
   * back to the newest conversation they take part in. */
  function current(person: string, bot: BotRecord): string | null {
    const pointed = pointers.get(keyOf(person, bot.id));
    if (pointed && takesPart(bot.id, pointed, person)) return pointed;
    const newest = store().tasks(bot.id)
      .filter((task) => !task.routineRunId && (task.participants ?? []).includes(person))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    return newest?.threadId ?? null;
  }

  return {
    shared: sharedWorkspace,

    /** The thread a request acts on when it names none: the bot's own in a
     * Local workspace, the person's own in a Shared one (null: none yet, or
     * a caller who is no person). */
    currentThread(person: string | null, bot: BotRecord): string | null {
      if (!sharedWorkspace()) return bot.threadId;
      return person ? current(person, bot) : null;
    },

    /** The person's conversation for a message that names none, opened now
     * when they have none. Only meaningful in a Shared workspace. */
    openThread(person: string, bot: BotRecord): string | null {
      const existing = current(person, bot);
      if (existing) return existing;
      const task = store().createTask(bot.id, undefined, false, undefined, undefined, undefined, undefined, [person]);
      if (!task) return null;
      pointers.set(keyOf(person, bot.id), task.threadId);
      save();
      return task.threadId;
    },

    /** Make one of the person's conversations their current one. False when
     * it is not theirs: the caller answers as for a thread that does not exist. */
    choose(person: string, botId: string, threadId: string): boolean {
      if (!takesPart(botId, threadId, person)) return false;
      pointers.set(keyOf(person, botId), threadId);
      save();
      return true;
    },
  };
}

export type OwnThreads = ReturnType<typeof createOwnThreads>;
