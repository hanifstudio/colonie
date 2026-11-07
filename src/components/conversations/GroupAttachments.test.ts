// @vitest-environment happy-dom
// A person can attach a file next to their message in a group, as in a bot chat: the message that
// is posted carries the words and one tag per attachment, which is what the bots read.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Conversation } from "@/lib/conversations";
import { citationAttachment, citationDraftId, createCitationTextSelector } from "@/lib/citations";
import { appendDraftAttachments } from "@/lib/drafts";

const { post, upload } = vi.hoisted(() => ({ post: vi.fn(), upload: vi.fn() }));
// the file upload is one POST of the bytes to /api/files; answer it as the server does
const serverUpload = (name: string) => upload.mockImplementation(async () => new Response(JSON.stringify({ path: `/data/attachments/${name}`, name, bytes: 10 }), { status: 201, headers: { "content-type": "application/json" } }));
vi.mock("@/lib/conversations", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/conversations")>()), postToConversation: post }));
vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), useStore: () => ({ state: { bots: [], instances: [] }, dispatch: vi.fn() }), api: vi.fn() }));

import { ConversationComposer } from "./ConversationView";

let root: Root;
let host: HTMLDivElement;
const group = { id: "g1", threadId: "t1", kind: "group", title: "Studio", name: "Studio", people: [{ key: "ana", name: "Ana", you: true }], bots: [], lastMessageAt: 0, unread: false, responder: { kind: "lead" }, leadBotId: null } as unknown as Conversation;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  post.mockReset(); upload.mockReset(); vi.stubGlobal("fetch", upload);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); localStorage.clear(); });

const render = () => act(() => root.render(createElement(ConversationComposer, { conversation: group, bots: [], messages: [], viewerKey: "ana", onSent: vi.fn() })));
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

test("the group composer has an attach button and a file input", async () => {
  await render();
  expect(host.querySelector('button[aria-label="Attach a file"]')).toBeTruthy();
  expect(host.querySelector('input[type="file"]')).toBeTruthy();
});

test("a file attached in a group is posted as a tag beside the words, and the draft is cleared", async () => {
  serverUpload("report.pdf");
  post.mockResolvedValue({ message: { id: "m1", role: "user", kind: "text", text: "" } });
  await render();
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  expect(host.textContent).toContain("report.pdf");

  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "summarise this");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await flush();

  expect(post).toHaveBeenCalledTimes(1);
  const [id, text] = post.mock.calls[0]!;
  expect(id).toBe("g1");
  expect(text).toContain("summarise this");
  expect(text).toContain('<attached-file path="/data/attachments/report.pdf" name="report.pdf" />');
  expect(host.textContent).not.toContain("report.pdf");
});

test("a file alone, with no words, can be sent", async () => {
  serverUpload("notes.pdf");
  post.mockResolvedValue({ message: { id: "m2", role: "user", kind: "text", text: "" } });
  await render();
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [new File(["x"], "notes.pdf", { type: "application/pdf" })], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  const send = host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  expect(send.disabled).toBe(false);
});

test("an image pasted into the group box is uploaded and sent as an image tag", async () => {
  upload.mockImplementation(async () => new Response(JSON.stringify({ path: "/data/attachments/0a1b2c3d-0000-4000-8000-000000000009.png", mime: "image/png", bytes: 8 }), { status: 201, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview", revokeObjectURL: () => {} }));
  post.mockResolvedValue({ message: { id: "m3", role: "user", kind: "text", text: "" } });
  await render();
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const image = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [image], items: [{ kind: "file", type: "image/png", getAsFile: () => image }], getData: () => "" } });
  await act(async () => { textarea.dispatchEvent(paste); });
  await flush();
  expect(paste.defaultPrevented).toBe(true);
  await act(async () => { host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await flush();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]![1]).toContain('<attached-image path="/data/attachments/0a1b2c3d-0000-4000-8000-000000000009.png"');
});

const bobLine = { id: "m-bob", role: "user", kind: "text", text: "Cut the intro by half?", sender: { id: "bob", name: "Bob" } } as unknown as import("@/state/store").Message;
const renderReply = (extra: { onClearReply?: () => void; onConsumeReply?: () => void } = {}) =>
  act(() => root.render(createElement(ConversationComposer, { conversation: group, bots: [], messages: [], viewerKey: "ana", onSent: vi.fn(), replyTo: bobLine, ...extra })));
const type = async (value: string) => act(async () => {
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
});
const submit = async () => { await act(async () => { host.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush(); };

test("replying to a message shows who it is from above the box, and sending carries it", async () => {
  post.mockResolvedValue({ message: { id: "m9", role: "user", kind: "text", text: "" } });
  const onConsumeReply = vi.fn();
  await renderReply({ onConsumeReply });
  // the quote names Bob and shows what he wrote
  expect(host.textContent).toContain("Replying to Bob");
  expect(host.textContent).toContain("Cut the intro by half?");
  await type("yes, do it");
  await submit();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]![1]).toBe("yes, do it");
  expect(post.mock.calls[0]![3]).toBe("m-bob");
  expect(onConsumeReply).toHaveBeenCalledTimes(1);
});

test("a reply is kept when the send fails, and removed only by the person", async () => {
  post.mockRejectedValue(new Error("the message being replied to is not in this conversation"));
  const onConsumeReply = vi.fn();
  const onClearReply = vi.fn();
  await renderReply({ onConsumeReply, onClearReply });
  await type("hello");
  await submit();
  // nothing was consumed: the reply stays so the person can try again
  expect(onConsumeReply).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("not in this conversation");
  expect(host.textContent).toContain("Replying to Bob");
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Cancel reply"]')!.click(); });
  expect(onClearReply).toHaveBeenCalledTimes(1);
});

test("with no reply chosen, the message is sent without one", async () => {
  post.mockResolvedValue({ message: { id: "m10", role: "user", kind: "text", text: "" } });
  await act(() => root.render(createElement(ConversationComposer, { conversation: group, bots: [], messages: [], viewerKey: "ana", onSent: vi.fn() })));
  expect(host.textContent).not.toContain("Replying to");
  await type("plain");
  await submit();
  expect(post.mock.calls[0]![3]).toBeUndefined();
});

test("a passage quoted from the transcript lands in the group's own draft and is sent as a quote", async () => {
  post.mockResolvedValue({ message: { id: "m11", role: "user", kind: "text", text: "" } });
  // what the selection toolbar builds for a line of this group: the owner id of the lines is the composer's draft id
  const source = { ownerType: "bot" as const, ownerId: `conversation:${group.id}`, threadId: group.threadId, messageId: "m-bob" };
  const selector = createCitationTextSelector("Cut the intro by half?", 0, 7)!;
  const citation = citationAttachment(source, selector);
  expect(citationDraftId(source, true)).toBe(`conversation:${group.id}`);
  expect(citationDraftId(source, false)).toBe(`bot:conversation:${group.id}:${group.threadId}`);
  appendDraftAttachments(citationDraftId(source, true), [citation]);
  await render();
  expect(host.textContent).toContain("Cut the");
  await type("shorter, yes");
  await submit();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]![1]).toContain("shorter, yes");
  // the bots read the plain form: "> Quoted message:" then the passage
  expect(post.mock.calls[0]![1]).toContain("> Quoted message:\n> Cut the");
});
