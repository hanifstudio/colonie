import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("bot⇄bot exchange chips", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const pair = () => {
    const store = new Store(selection);
    const from = store.createBot({ name: "Forge", section: "Agents" });
    const target = store.createBot({ name: "Quarry", section: "Agents" });
    const bus: CommsBus = { store, broadcast: () => {} };
    return { store, from, target, bus };
  };

  it("records the exchange as a chip in both bots' threads without creating a channel", () => {
    const { store, from, target, bus } = pair();
    mirrorExchange(bus, from, target);

    expect(store.messagesFor(from.threadId).some((m) => m.tool?.name === "Messaged @Quarry" && !m.comm)).toBe(true);
    expect(store.messagesFor(target.threadId).some((m) => m.tool?.name === "Message from @Forge" && !m.comm)).toBe(true);
    expect(store.groups).toHaveLength(0);
    expect(existsSync(join(DATA_DIR, "groups.json"))).toBe(false);
  });

  it("puts the sender's chip in the thread the exchange came from", () => {
    const { store, from, target, bus } = pair();
    const task = store.createTask(from.id, "Side", false)!;
    mirrorExchange(bus, from, target, task.threadId);

    expect(store.messagesFor(task.threadId).some((m) => m.tool?.name === "Messaged @Quarry")).toBe(true);
    expect(store.messagesFor(from.threadId).some((m) => m.tool?.name === "Messaged @Quarry")).toBe(false);
  });
});
