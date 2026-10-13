// @vitest-environment happy-dom
// The file preview panel reads a Markdown file through the same
// message-scoped grant as the chat's save button, then renders it with
// the chat's Markdown — without a message scope, so links inside stay inert.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
}));

const { FilePreviewPanel } = await import("./FilePreviewPanel");
const { BotEditorStore, initialState } = await import("@/state/store");
import type { FilePreviewTarget } from "./AttachmentPreview";

const preview: FilePreviewTarget = { threadId: "thread-1", messageId: "message-1", path: "/workspace/notes.md", name: "notes.md" };

let root: Root;
const fetched: string[] = [];
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function mount() {
  const dispatch = vi.fn();
  const value = {
    state: initialState, dispatch,
    flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(FilePreviewPanel, { preview }) })));
  await settle();
  return dispatch;
}

beforeEach(() => {
  fetched.length = 0;
  vi.stubGlobal("fetch", (path: string, init?: { body?: string }) => {
    fetched.push(`${path} ${(init?.body as string) ?? ""}`);
    return Promise.resolve(new Response("# Hello", { headers: { "content-type": "text/markdown; charset=utf-8" } }));
  });
});
afterEach(() => {
  root.unmount();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("FilePreviewPanel", () => {
  it("fetches through the message grant and renders the Markdown", async () => {
    await mount();
    expect(fetched).toEqual([`/api/threads/thread-1/messages/message-1/file {"path":"/workspace/notes.md"}`]);
    expect(document.body.textContent).toContain("notes.md");
    expect(document.body.textContent).toContain("Hello");
    expect(document.body.innerHTML).not.toContain("/workspace/notes.md");
  });

  it("closes through the store and offers a retry", async () => {
    const dispatch = await mount();
    (document.querySelector('[aria-label="Close preview"]') as HTMLButtonElement).click();
    expect(dispatch).toHaveBeenCalledWith({ type: "closeFilePreview" });
  });

  it("reports a failed load without leaking the path into a link", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ error: "gone" }), { status: 404 })));
    await mount();
    await settle();
    expect(document.body.textContent).toContain("Could not open this preview");
  });
});
