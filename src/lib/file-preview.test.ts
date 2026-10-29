import { expect, test, vi } from "vitest";
import { decodePreviewText, filePreviewKind, previewFilename, readPreviewBytes } from "./file-preview";

test("recognizes encoded local filenames and leaves unsupported binaries save-only", () => {
  expect(filePreviewKind("file:///work/My%20Report.DOCX?download=1#page-2")).toBe("docx");
  expect(previewFilename("file:///work/report%23final%3F.docx")).toBe("report#final?.docx");
  expect(filePreviewKind("C:\\work\\report.PDF")).toBe("pdf");
  expect(filePreviewKind("/work/chart.svg")).toBe("image");
  expect(filePreviewKind("/work/README")).toBe("text");
  expect(filePreviewKind("/work/main.tsx")).toBe("text");
  for (const path of ["report.doc", "sheet.xlsx", "slides.pptx", "page.html", "app.exe", "file.zip"]) expect(filePreviewKind(path)).toBeNull();
});

test("decodes intact multilingual UTF-8 and refuses binary and broken text", () => {
  expect(decodePreviewText(new TextEncoder().encode("Laporan — 中文\nمرحبا"))).toBe("Laporan — 中文\nمرحبا");
  expect(() => decodePreviewText(new Uint8Array([65, 0, 66]))).toThrow("format");
  expect(() => decodePreviewText(new Uint8Array([0xff]))).toThrow("format");
});

test("caps actual streamed bytes even when Content-Length is missing or false", async () => {
  for (const headers of [new Headers(), new Headers({ "content-length": "1" })]) {
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.enqueue(new Uint8Array(3)); c.close(); } }), { headers });
    await expect(readPreviewBytes(response, new AbortController().signal, 5)).rejects.toThrow("size");
    expect(response.body?.locked).toBe(false);
  }
});

test("refuses declared oversize before reading a body", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": "6" } });
  await expect(readPreviewBytes(response, new AbortController().signal, 5)).rejects.toThrow("size");
  expect(cancel).toHaveBeenCalled();
});

test("closing a preview cancels a stalled read", async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const controller = new AbortController();
  const read = readPreviewBytes(response, controller.signal, 5);
  controller.abort();
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalled();
  expect(response.body?.locked).toBe(false);
});

test("reads at the limit and refuses a failed response", async () => {
  expect(await readPreviewBytes(new Response("hello"), new AbortController().signal, 5)).toEqual(new TextEncoder().encode("hello"));
  await expect(readPreviewBytes(new Response("denied", { status: 403 }), new AbortController().signal, 10)).rejects.toThrow("load");
});
