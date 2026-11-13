import { describe, expect, it } from "vitest";
import { collectMessageFiles, isImageFileAttachment, loadMessageImage, splitMessageAttachments } from "./AttachmentGallery";

const message = { threadId: "t1", messageId: "m1" };

describe("pictures a bot sends as files", () => {
  it("recognizes raster picture names, never svg or documents", () => {
    for (const name of ["kantor-01.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.bmp", "/x/My%20Pic.png"]) {
      expect(isImageFileAttachment(name), name).toBe(true);
    }
    for (const name of ["a.svg", "a.pdf", "png", "a.png.txt"]) expect(isImageFileAttachment(name), name).toBe(false);
  });

  it("keeps attach_file files and Markdown links in the file list, where the gallery turns pictures into thumbnails", () => {
    const attached = splitMessageAttachments([{ kind: "file", path: "/store/abc.avif", name: "kantor-01.avif" }]);
    expect(attached.files.map((file) => file.name)).toEqual(["kantor-01.avif"]);
    const linked = collectMessageFiles("Here: [kantor-01.png](/Users/me/work/kantor-01.png)");
    expect(linked.map((file) => file.name)).toEqual(["kantor-01.png"]);
    expect(isImageFileAttachment(linked[0]!.path)).toBe(true);
  });

  it("loads picture bytes through the message grant and refuses non-images", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })) as typeof fetch;
      const blob = await loadMessageImage({ path: "/a/kantor-01.png", name: "kantor-01.png", linked: true }, message, new AbortController().signal);
      expect(blob.type).toBe("image/png");
      expect(blob.size).toBe(3);
      globalThis.fetch = (async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })) as typeof fetch;
      await expect(loadMessageImage({ path: "/a/x.png", name: "x.png", linked: true }, message, new AbortController().signal)).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});
