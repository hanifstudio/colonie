// Every conversation can name who takes part in it (step two of privacy by
// person). The list is server-private: no client ever sees a person key, and it
// survives a restart. The visibility check reads it from the store.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { workspaceScope } from "../runtime/scope.ts";
import type { ModelSelection } from "../contracts.ts";
import { createVisibility } from "../harness/visibility.ts";
import { Store, toWireTask } from "./store.ts";

const ADA = "p_ada000000000000000000";
const BOB = "p_bob000000000000000000";
const selection = (): ModelSelection => ({ instanceId: "claude-acp", model: "default" });

function storeWithBot() {
  const scope = workspaceScope(mkdtempSync(join(tmpdir(), "colonie-participants-")));
  writeFileSync(scope.botsFile, JSON.stringify([{
    id: "helper", name: "Helper", threadId: "helper-thread", createdAt: 1_700_000_000_000, modelSelection: selection(),
  }]));
  return { scope, store: new Store(selection, undefined, undefined, scope) };
}

test("a conversation created for a person names that person, and only the server knows", () => {
  const { store } = storeWithBot();
  const task = store.createTask("helper", "Ada's question", false, undefined, undefined, undefined, undefined, [ADA])!;
  expect(task.participants).toEqual([ADA]);
  expect(store.threadParticipants(task.threadId)).toEqual([ADA]);
  // never on the wire
  expect(JSON.stringify(toWireTask(task, selection()))).not.toContain(ADA);
  expect(JSON.stringify(store.bot("helper"))).toContain(ADA);
});

test("the list is a copy: changing what was passed in changes nothing stored", () => {
  const { store } = storeWithBot();
  const people = [ADA];
  const task = store.createTask("helper", undefined, false, undefined, undefined, undefined, undefined, people)!;
  people.push(BOB);
  expect(store.threadParticipants(task.threadId)).toEqual([ADA]);
});

test("participants survive a restart", () => {
  const { scope, store } = storeWithBot();
  const task = store.createTask("helper", undefined, false, undefined, undefined, undefined, undefined, [ADA, BOB])!;
  expect(readFileSync(scope.botsFile, "utf8")).toContain(BOB);
  const reopened = new Store(selection, undefined, undefined, scope);
  expect(reopened.threadParticipants(task.threadId)).toEqual([ADA, BOB]);
});

test("a conversation created without people names nobody, and an unknown thread has no list", () => {
  const { store } = storeWithBot();
  const task = store.createTask("helper", undefined, false)!;
  expect(store.threadParticipants(task.threadId) ?? []).toEqual([]);
  expect(store.threadParticipants("no-such-thread")).toBeUndefined();
});

test("in a Shared workspace the visibility check reads participants from the store", () => {
  const { store } = storeWithBot();
  const adas = store.createTask("helper", undefined, false, undefined, undefined, undefined, undefined, [ADA])!;
  const bobs = store.createTask("helper", undefined, false, undefined, undefined, undefined, undefined, [BOB])!;
  const { visibleTo } = createVisibility({ store: () => store, routines: () => null, sharedWorkspace: () => true } as never);
  const ada = visibleTo({ kind: "person", key: ADA, admin: false });
  expect(ada.thread(adas.threadId)).toBe(true);
  expect(ada.thread(bobs.threadId)).toBe(false);
});
