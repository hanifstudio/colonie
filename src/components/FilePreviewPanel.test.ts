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
  expect(host.querySelector('[aria-label="Save a copy of Report.docx"]')).toBeTruthy();
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
