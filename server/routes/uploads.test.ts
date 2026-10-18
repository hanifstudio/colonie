// Uploads write bytes to disk, so this guards the front door: which requests
// are this route's, that a picture must actually be an image and of a declared
// size, and that a document without a name is refused before any byte is read.
// Actually saving is proven live on a throwaway HOME instead.
import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createUploadRoutes } from "./uploads.ts";

const IMAGE = "/api/attachments";
const FILE = "/api/files";

const handler = () => createUploadRoutes();

const call = async (
  route = IMAGE,
  method = "POST",
  headers: Record<string, string> = {},
) => {
  const { ctx, sent } = callRoute(route, method, {}, headers);
  // The fixture's request is a header bag; the real one can be drained.
  (ctx as { req: unknown }).req = { headers, resume: () => {}, on: () => {} };
  return { out: await handler()(ctx), sent };
};

test("another route, or another verb, is left to the next handler", async () => {
  const elsewhere = await call("/api/health", "POST");
  const wrongVerb = await call(IMAGE, "GET");

  expect(elsewhere.out).toBe(PASS);
  expect(wrongVerb.out).toBe(PASS);
  expect(elsewhere.sent).toEqual([]);
});

test("a picture must say it is an image", async () => {
  const noType = await call(IMAGE, "POST", {});
  const notAnImage = await call(IMAGE, "POST", { "content-type": "text/plain" });

  expect(noType.sent).toEqual([{ status: 400, body: { error: "content-type must be an image type" } }]);
  expect(notAnImage.sent).toEqual([{ status: 400, body: { error: "content-type must be an image type" } }]);
});

test("a declared size that is not a size is refused", async () => {
  const { sent } = await call(IMAGE, "POST", { "content-type": "image/png", "content-length": "not-a-number" });

  expect(sent).toEqual([{ status: 400, body: { error: "content-length must be a non-negative integer" } }]);
});

test("a picture bigger than the limit is refused before it is read", async () => {
  const { sent } = await call(IMAGE, "POST", { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) });

  expect(sent[0]?.status).toBe(413);
  expect(String((sent[0]?.body as { error?: string } | undefined)?.error)).toMatch(/image exceeds/);
});

test("a document without a name is refused before it is read", async () => {
  const { sent } = await call(FILE, "POST", { "content-type": "application/octet-stream" });

  expect(sent).toEqual([{ status: 400, body: { error: "name is required" } }]);
});