// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AttachedFileChip, FilePreviewScope } from "./AttachmentPreview";
import { FilePreviewPanel } from "./FilePreviewPanel";
import { PreviewToolbar } from "./file-preview/PreviewToolbar";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch }) }));
let root: Root;
let host: HTMLDivElement;
const target = { threadId: "thread-fixture", messageId: "message-fixture", path: "/workspace/plan.md", name: "plan.md" };

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

test("clicking a shared DOCX opens its exact message grant without downloading", async () => {
  const onPreview = vi.fn();
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await act(() => root.render(createElement(FilePreviewScope, { onPreview, children: createElement(AttachedFileChip, {
    file: { path: "/workspace/report.docx", name: "Report.docx", private: true }, message: target,
  }) })));
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Preview Report.docx"]')!.click());
  expect(onPreview).toHaveBeenCalledWith({ threadId: target.threadId, messageId: target.messageId, path: "/workspace/report.docx", name: "Report.docx" });
  expect(fetcher).not.toHaveBeenCalled();
  // Saving is offered in the preview panel only (owner, November 3), not on the chat row.
  expect(host.querySelector('[aria-label="Save a copy of Report.docx"]')).toBeNull();
});

test("legacy attachments do not gain a preview capability", async () => {
  const onPreview = vi.fn();
  await act(() => root.render(createElement(FilePreviewScope, { onPreview, children: createElement(AttachedFileChip, { file: { path: "/workspace/report.docx", name: "Report.docx" }, message: target }) })));
  expect(host.querySelector("button")).toBeNull();
  expect(onPreview).not.toHaveBeenCalled();
});

test("Zoom out starts from the fitted page scale rather than enlarging the page", async () => {
  const onZoom = vi.fn();
  await act(() => root.render(createElement(PreviewToolbar, { zoom: null, fitZoom: 0.5, onZoom })));
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
  expect(onZoom).toHaveBeenCalledWith(0.25);
});

test("loads Markdown through the message route, keeps embedded file links inert, and closes with Escape", async () => {
  const fetcher = vi.fn(async () => new Response("# Preview fixture\n\n[Private](file:///outside/private.txt)")); vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(FilePreviewPanel, { preview: target })));
  expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining(`/threads/${target.threadId}/messages/${target.messageId}/file`), expect.objectContaining({ method: "POST", body: JSON.stringify({ path: target.path }) })]));
  expect(host.textContent).toContain("Preview fixture");
  expect(host.querySelector('[aria-label="Preview private.txt"]')).toBeNull();
  expect(host.querySelector('a[href^="file:"]')).toBeNull();
  await act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(dispatch).toHaveBeenCalledWith({ type: "closeFilePreview" });
});

test("a failed read can be retried from the panel", async () => {
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ++attempts === 1 ? new Response("no", { status: 404 }) : new Response("# Recovered")));
  await act(async () => root.render(createElement(FilePreviewPanel, { preview: target })));
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh preview"]')!.click());
  expect(host.textContent).toContain("Recovered");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("switching files cancels the previous read and closing returns keyboard focus", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
    signals.push(options.signal as AbortSignal);
    return new Promise<Response>(() => {});
  }));
  const opener = document.createElement("button"); document.body.prepend(opener); opener.focus();
  await act(() => root.render(createElement(FilePreviewPanel, { preview: target })));
  expect(document.activeElement).toBe(host.querySelector("h2"));
  await act(() => root.render(createElement(FilePreviewPanel, { preview: { ...target, path: "/other.md", name: "other.md" } })));
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  await act(() => root.render(null));
  expect(signals[1]?.aborted).toBe(true);
  expect(document.activeElement).toBe(opener);
});

test("a group's video plays straight from the group's folder, with no size limit and nothing read into memory", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const group = { threadId: "thread-fixture", messageId: "", path: "Final/2026-11-03_palessi_v02.mp4", name: "palessi.mp4", conversationId: "conv-1" };
  await act(async () => root.render(createElement(FilePreviewPanel, { preview: group })));
  const video = host.querySelector<HTMLVideoElement>("video");
  expect(video?.getAttribute("src")).toBe("/api/conversations/conv-1/files/content?path=Final%2F2026-11-03_palessi_v02.mp4");
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("too large");
});

test("a video that is not in a group's folder is not offered as a preview", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(FilePreviewPanel, { preview: { ...target, path: "/workspace/clip.mp4", name: "clip.mp4" } })));
  expect(host.querySelector("video")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

test("a path inside a group's project folder names the group and the file inside it", async () => {
  const { groupFileRef } = await import("@/lib/file-preview");
  expect(groupFileRef("/data/conversation-files/d1b57a7f-3da4/Final/palessi_v02.mp4"))
    .toEqual({ conversationId: "d1b57a7f-3da4", path: "Final/palessi_v02.mp4" });
  expect(groupFileRef("/data/Movies/clip.mp4")).toBeNull();
  expect(groupFileRef("/data/conversation-files/c1/../secret.mp4")).toBeNull();
});

const slowSave = (chunks: number[], total: number, gate: Promise<void>) => {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= chunks.length) return controller.close();
      if (sent === 1) await gate;
      controller.enqueue(new Uint8Array(chunks[sent]!)); sent += 1;
    },
  });
  return new Response(body, { headers: { "content-length": String(total), "content-type": "application/octet-stream" } });
};

test("saving a group file shows a progress ring with the percent, and pressing it stops the save", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = vi.fn(async () => slowSave([250, 750], 1000, gate)); vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
  const group = { threadId: "t", messageId: "", path: "notes.zip", name: "notes.zip", conversationId: "c1" };
  await act(async () => root.render(createElement(FilePreviewPanel, { preview: group })));
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Save a copy of notes.zip"]')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25"));
  const stop = host.querySelector<HTMLButtonElement>('button[aria-label^="Downloading"]')!;
  expect(stop.getAttribute("aria-label")).toContain("25%");
  await act(async () => { stop.click(); });
  release();
  // stopped: the ring is gone and the plain save button is back, with no error
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Save a copy of notes.zip"]')).toBeTruthy());
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent ?? "").not.toContain("download");
});

test("a failed save offers a retry on the same button", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no such file" }), { status: 404 })));
  const group = { threadId: "t", messageId: "", path: "gone.zip", name: "gone.zip", conversationId: "c1" };
  await act(async () => root.render(createElement(FilePreviewPanel, { preview: group })));
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Save a copy of gone.zip"]')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Retry saving gone.zip"]')).toBeTruthy());
  expect(host.textContent).toContain("no such file");
});

test("a file row in a message has no save button of its own: it opens the preview, which saves", async () => {
  const onPreview = vi.fn();
  await act(() => root.render(createElement(FilePreviewScope, { onPreview, children: createElement(AttachedFileChip, {
    file: { path: "/workspace/clip.zip", name: "clip.zip", private: true }, message: target,
  }) })));
  expect(host.querySelector('[aria-label="Save a copy of clip.zip"]')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Preview clip.zip"]')!.click());
  expect(onPreview).toHaveBeenCalledWith({ threadId: target.threadId, messageId: target.messageId, path: "/workspace/clip.zip", name: "clip.zip" });
});

test("saving a file from a message shows the same progress ring, and stopping it leaves no error", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = vi.fn(async () => slowSave([300, 700], 1000, gate)); vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
  await act(async () => root.render(createElement(FilePreviewPanel, { preview: { ...target, path: "/workspace/archive.zip", name: "archive.zip" } })));
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Save a copy of archive.zip"]')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("30"));
  await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label^="Downloading"]')!.click(); });
  release();
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Save a copy of archive.zip"]')).toBeTruthy());
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
});
