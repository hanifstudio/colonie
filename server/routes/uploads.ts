// Raw uploads over the authenticated connection: a picture pasted into the
// composer, and a document a companion app or the desktop sends as bytes. The
// saving itself lives in colonie/chat/attachments.ts; this is the front door
// that reads the request, and the reason a partial upload is removed on error.
import { extensionForMime, FILE_MAX_BYTES, IMAGE_MAX_BYTES, saveFile, saveImageUpload, validateAttachmentUploadId, type SavedAttachment } from "../colonie/chat/attachments.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createUploadRoutes(): RouteHandler {
  return async ({ req, res, path, method, url, json }) => {
    if (method === "POST" && path === "/api/attachments") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const rawType = Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"];
      const mime = rawType?.split(";")[0]?.trim().toLowerCase();
      if (!mime || !extensionForMime(mime)) {
        return json(res, 400, { error: "content-type must be an image type" });
      }
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > IMAGE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `image exceeds ${IMAGE_MAX_BYTES} bytes` });
      }
      const saved = await new Promise<SavedAttachment>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        const fail = (status: number, msg: string) => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error(msg), { status }));
        };
        req.on("data", (chunk: Buffer) => {
          if (settled) return;
          received += chunk.byteLength;
          if (received > IMAGE_MAX_BYTES) return fail(413, `image exceeds ${IMAGE_MAX_BYTES} bytes`);
          chunks.push(chunk);
        });
        req.on("end", async () => {
          if (settled) return;
          settled = true;
          try {
            resolve(await saveImageUpload(Buffer.concat(chunks), mime, uploadId));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
        req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
      });
      return json(res, 201, saved);
    }

    // ── shared files ────────────────────────────────────────────────────
    // Companion apps and the desktop composer send documents as raw bytes
    // over the same authenticated connection as messages. saveFile writes each
    // incoming chunk directly to disk, atomically commits it, and removes
    // partial uploads on error. Its optional UUID uploadId is stable across
    // route retries, while the aggregate store quota rejects rather than
    // silently deleting files that old prompts may still reference.
    if (method === "POST" && path === "/api/files") {
      let uploadId: string | undefined;
      try {
        uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
      } catch (error) {
        req.resume();
        throw error;
      }
      const name = url.searchParams.get("name");
      if (!name) {
        req.resume();
        return json(res, 400, { error: "name is required" });
      }
      const rawType = Array.isArray(req.headers["content-type"])
        ? req.headers["content-type"][0]
        : req.headers["content-type"];
      const rawLength = Array.isArray(req.headers["content-length"])
        ? req.headers["content-length"][0]
        : req.headers["content-length"];
      const declaredLength = rawLength === undefined ? undefined : Number(rawLength);
      if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) {
        req.resume();
        return json(res, 400, { error: "content-length must be a non-negative integer" });
      }
      if (declaredLength !== undefined && declaredLength > FILE_MAX_BYTES) {
        req.resume();
        return json(res, 413, { error: `file exceeds ${FILE_MAX_BYTES} bytes` });
      }
      try {
        // Returning from this iterator must not destroy the request socket:
        // the caller still needs to receive the useful 4xx response when the
        // streamed byte count crosses the limit.
        const chunks = req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
        const saved = await saveFile(chunks, name, rawType ?? "", { uploadId, expectedBytes: declaredLength });
        return json(res, 201, saved);
      } catch (error) {
        req.resume();
        throw error;
      }
    }
    return PASS;
  };
}
