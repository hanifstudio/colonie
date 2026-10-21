// In a Shared workspace a person sees a conversation only when they take part
// in it, and that holds for admins too (owner decision, October 21). Bots stay
// visible by their audience; threads ask who the participants are.
import { expect, test } from "vitest";
import { VisibleSet, type VisibilityBot, type Viewer } from "./bot-visibility.ts";

const ADA = "p_ada000000000000000000";
const BOB = "p_bob000000000000000000";

const bots: VisibilityBot[] = [
  { id: "helper", threadId: "helper-main", tasks: [{ threadId: "t-ada" }, { threadId: "t-bob" }, { threadId: "t-nobody" }, { threadId: "t-both" }] },
  { id: "secret", threadId: "secret-main", visibility: "admins", tasks: [{ threadId: "t-secret-ada" }] },
];
const participants: Record<string, string[]> = {
  "t-ada": [ADA],
  "t-bob": [BOB],
  "t-both": [ADA, BOB],
  "t-secret-ada": [ADA],
};
const set = (viewer: Viewer) => new VisibleSet(bots, [], viewer, undefined, (threadId) => participants[threadId]);

const ada: Viewer = { kind: "person", key: ADA, admin: false, email: "ada@x.com" };
const adminBob: Viewer = { kind: "person", key: BOB, admin: true, email: "bob@x.com" };

test("a person sees only the threads they take part in", () => {
  const visible = set(ada);
  expect(visible.everything).toBe(false);
  expect(visible.thread("t-ada")).toBe(true);
  expect(visible.thread("t-both")).toBe(true);
  expect(visible.thread("t-bob")).toBe(false);
});

test("an admin sees every bot but still only their own threads", () => {
  const visible = set(adminBob);
  expect(visible.bot("helper")).toBe(true);
  expect(visible.bot("secret")).toBe(true);
  expect(visible.thread("t-bob")).toBe(true);
  expect(visible.thread("t-ada")).toBe(false);
  expect(visible.thread("t-secret-ada")).toBe(false);
});

test("a thread that names nobody, or a bot's shared main thread, is visible to nobody", () => {
  for (const viewer of [ada, adminBob]) {
    expect(set(viewer).thread("t-nobody")).toBe(false);
    expect(set(viewer).thread("helper-main")).toBe(false);
  }
});

test("taking part is not enough when the bot itself is hidden from the person", () => {
  expect(set(ada).bot("secret")).toBe(false);
  expect(set(ada).thread("t-secret-ada")).toBe(false);
});

test("a caller with no person, such as a local service, sees no thread at all", () => {
  const service = set({ kind: "person", key: "", admin: true });
  expect(service.bot("helper")).toBe(true);
  for (const threadId of Object.keys(participants)) expect(service.thread(threadId)).toBe(false);
});

test("an unknown thread is not visible", () => {
  expect(set(ada).thread("t-unknown")).toBe(false);
});

test("Local viewers are unchanged: the owner sees everything", () => {
  const owner = set({ kind: "all" });
  expect(owner.everything).toBe(true);
  expect(owner.thread("t-nobody")).toBe(true);
});
