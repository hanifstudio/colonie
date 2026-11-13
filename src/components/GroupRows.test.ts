// @vitest-environment happy-dom
// One line of a group's transcript, drawn the way the chat draws it: Reply is offered, a quote names its real
// writer, and a bot's waiting line offers Cancel or Stop to the person who asked for it, and to nobody else.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Message } from "@/state/store";
import { Bubble, ChatRowsContext, type ChatRows } from "./ChatView";

vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), useStore: () => ({ state: { bots: [], instances: [] }, dispatch: vi.fn() }) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const rows = (extra: Partial<ChatRows> = {}): ChatRows => ({
  botId: "conversation:g1", threadId: "t1", botName: "Studio", tts: undefined as never, localVoice: false, busy: false,
  accountWorkspace: true, bots: [], mentionPeers: [], focus: null as never, showToolCalls: false, locale: "en",
  dispatch: vi.fn(), onBranch: () => true, ...extra,
});
const botLine = { id: "b1", at: 1, role: "bot", kind: "text", text: "The plan has three steps.", from: { botId: "x", name: "Reka", color: "" } } as unknown as Message;
const draw = (message: Message, context: ChatRows, props: { replyTarget?: Message; onReply?: (message: Message) => void } = {}) =>
  act(() => root.render(createElement(ChatRowsContext.Provider, { value: context, children: createElement(Bubble, {
    message, editing: false, pinned: false, onStartEdit: vi.fn(), onCancelEdit: vi.fn(), onSubmitEdit: vi.fn(), onReply: props.onReply ?? vi.fn(), replyTarget: props.replyTarget,
  }) })));
const replyButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]');

test("a line in a group offers Reply when the group can take a reply, and pressing it chooses that line", async () => {
  const onReply = vi.fn();
  await draw(botLine, rows({ conversation: { viewerKey: "ana", onSecretSaved: vi.fn(), continueBot: vi.fn(), onReply } }), { onReply });
  expect(replyButton()).toBeTruthy();
  await act(async () => { replyButton()!.click(); });
  expect(onReply).toHaveBeenCalledWith(botLine);
});

test("a group that cannot take a reply shows no Reply button, as before", async () => {
  await draw(botLine, rows({ conversation: { viewerKey: "ana", onSecretSaved: vi.fn(), continueBot: vi.fn() } }));
  expect(replyButton()).toBeNull();
});

test("a 1:1 chat keeps its Reply button", async () => {
  await draw(botLine, rows({ accountWorkspace: false }));
  expect(replyButton()).toBeTruthy();
});

test("a line that replies shows who the quoted message is from, even Bob's second line of a run", async () => {
  const quoted = { id: "q1", at: 1, role: "bot", kind: "text", text: "Cut the intro by half?", authorName: "Bob" } as unknown as Message;
  const replying = { id: "r1", at: 2, role: "user", kind: "text", text: "yes, do it", replyToId: "q1" } as unknown as Message;
  await draw(replying, rows({ conversation: { viewerKey: "ana", onSecretSaved: vi.fn(), continueBot: vi.fn(), onReply: vi.fn() } }), { replyTarget: quoted });
  expect(host.textContent).toContain("Replying to Bob");
  expect(host.textContent).toContain("Cut the intro by half?");
});

const waiting = (extra: Partial<Message> = {}) => ({ id: "w1", at: 1, role: "bot", kind: "text", text: "Reka is finishing something else; this is next.", working: true, askedBy: "ana", from: { botId: "x", name: "Reka", color: "" }, ...extra }) as unknown as Message;

test("the person who asked sees Cancel on a waiting line, and pressing it cancels that line", async () => {
  const cancelWork = vi.fn(async () => {});
  await draw(waiting(), rows({ conversation: { viewerKey: "ana", onSecretSaved: vi.fn(), continueBot: vi.fn(), cancelWork } }));
  const cancel = host.querySelector<HTMLButtonElement>('[aria-label="Cancel Reka\'s queued request"]');
  expect(cancel).toBeTruthy();
  await act(async () => { cancel!.click(); });
  expect(cancelWork).toHaveBeenCalledWith("w1");
});

test("a waiting line shows no Cancel to anyone but the person who asked", async () => {
  const cancelWork = vi.fn(async () => {});
  await draw(waiting(), rows({ conversation: { viewerKey: "bob", onSecretSaved: vi.fn(), continueBot: vi.fn(), cancelWork } }));
  expect(host.querySelector('[aria-label^="Cancel"]')).toBeNull();
  expect(host.querySelector('[aria-label^="Stop"]')).toBeNull();
});

test("a bot's pictures and files sit below its reply as small tiles, not above it", async () => {
  const reply = { id: "g1", at: 1, role: "bot", kind: "text", text: "Here is the floor plan.", attachments: [{ kind: "image", path: "/store/plan.png" }, { kind: "file", path: "/store/notes.pdf", name: "notes.pdf" }] } as unknown as Message;
  await draw(reply, rows({ accountWorkspace: false }));
  const text = host.querySelector("[data-citation-source]")!;
  const gallery = host.querySelector("section[aria-label]")!;
  expect(gallery).toBeTruthy();
  expect(text.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const tile = gallery.querySelector("img")?.parentElement?.parentElement;
  expect(tile?.className).toContain("size-28");
});
