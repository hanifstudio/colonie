// @vitest-environment happy-dom
// Saving a file with progress and a way to stop: the body is read in pieces and counted.
import { expect, test, vi } from "vitest";

import { readDownload, saveBlob } from "./file-download";

function stream(chunks: number[], headers: Record<string, string> = {}, gate?: Promise<void>) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= chunks.length) return controller.close();
      if (gate && sent === 1) await gate;
      controller.enqueue(new Uint8Array(chunks[sent]!).fill(sent + 1));
      sent += 1;
    },
  });
  return new Response(body, { headers });
}

test("a download reports how much arrived as it arrives, against the length the server gave", async () => {
  const seen: Array<[number, number]> = [];
  const blob = await readDownload(stream([100, 200, 300], { "content-length": "600", "content-type": "video/mp4" }), new AbortController().signal, (p) => seen.push([p.received, p.total]));
  expect(blob.size).toBe(600);
  expect(blob.type).toBe("video/mp4");
  expect(seen).toEqual([[0, 600], [100, 600], [300, 600], [600, 600]]);
});

test("with no length from the server the total stays unknown, so no false percent is shown", async () => {
  const seen: number[] = [];
  await readDownload(stream([10, 10]), new AbortController().signal, (p) => seen.push(p.total));
  expect(new Set(seen)).toEqual(new Set([0]));
});

test("stopping cancels the read and the save never completes", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const progress: number[] = [];
  const read = readDownload(stream([100, 100, 100], { "content-length": "300" }, gate), controller.signal, (p) => progress.push(p.received));
  await vi.waitFor(() => expect(progress).toContain(100));
  controller.abort();
  release();
  await expect(read).rejects.toThrow();
  // nothing past the stop was counted
  expect(Math.max(...progress)).toBeLessThanOrEqual(200);
});

test("a response with no stream to count is taken whole and reported done", async () => {
  const seen: Array<[number, number]> = [];
  const response = { headers: new Headers({ "content-type": "text/plain" }), body: null, blob: async () => new Blob(["hello"]) } as unknown as Response;
  const blob = await readDownload(response, new AbortController().signal, (p) => seen.push([p.received, p.total]));
  expect(blob.size).toBe(5);
  expect(seen).toEqual([[5, 5]]);
});

test("a finished download is handed to the browser's save under its name", () => {
  const click = vi.fn();
  const create = vi.spyOn(document, "createElement");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
  create.mockImplementation(((tag: string) => tag === "a" ? Object.assign(document.createDocumentFragment().ownerDocument!.createElementNS("http://www.w3.org/1999/xhtml", "a"), { click }) : document.createElementNS("http://www.w3.org/1999/xhtml", tag)) as typeof document.createElement);
  saveBlob(new Blob(["x"]), "clip.mp4");
  expect(click).toHaveBeenCalledTimes(1);
  create.mockRestore();
  vi.unstubAllGlobals();
});
