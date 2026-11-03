// A group's project file served to its people: a video in byte windows so it plays and seeks
// with no size cap, everything else as the plain full download it always was.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";

import { createConversationFilesRoutes } from "./conversation-files.ts";
import { PASS, type RouteContext } from "./table.ts";

const dir = mkdtempSync(join(tmpdir(), "colonie-files-"));
const video = Buffer.alloc(1000, 7);
writeFileSync(join(dir, "clip.mp4"), video);
writeFileSync(join(dir, "notes.md"), "hello");

function ask(path: string, file: string, range?: string) {
  const handler = createConversationFilesRoutes({
    conversations: { file: (_caller: unknown, _id: string, requested: string) => ({ status: 200, path: join(dir, requested) }) } as never,
    caller: () => ({ key: "ana", name: "Ana", seesBot: () => true }) as never,
  });
  const url = new URL(`http://127.0.0.1${path}?path=${file}`);
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk) => chunks.push(chunk));
  let head: { status: number; headers: Record<string, string> } = { status: 0, headers: {} };
  const res = Object.assign(out, {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) { head = { status, headers }; return this; },
  });
  const ctx = { req: { headers: range ? { range } : {} }, res, url, path: url.pathname, method: "GET", auth: { scopes: [] }, json: async () => {} } as unknown as RouteContext;
  return handler(ctx).then(async (outcome) => {
    // a route that declined wrote nothing, so there is no stream to wait for
    if (outcome === PASS) return { outcome, ...head, body: Buffer.alloc(0) };
    await new Promise((resolve) => out.on("end", resolve).on("close", resolve));
    return { outcome, ...head, body: Buffer.concat(chunks) };
  });
}

test("a video is played in place and served in byte windows, with no size cap", async () => {
  const whole = await ask("/api/conversations/c1/files/content", "clip.mp4");
  expect(whole.status).toBe(200);
  expect(whole.headers["content-type"]).toBe("video/mp4");
  expect(whole.headers["accept-ranges"]).toBe("bytes");
  expect(whole.body.length).toBe(1000);

  const part = await ask("/api/conversations/c1/files/content", "clip.mp4", "bytes=100-299");
  expect(part.status).toBe(206);
  expect(part.headers["content-range"]).toBe("bytes 100-299/1000");
  expect(part.headers["content-length"]).toBe("200");
  expect(part.body.length).toBe(200);

  const beyond = await ask("/api/conversations/c1/files/content", "clip.mp4", "bytes=5000-");
  expect(beyond.status).toBe(416);
  expect(beyond.headers["content-range"]).toBe("bytes */1000");
});

test("a file that is not a video keeps the plain full download", async () => {
  const note = await ask("/api/conversations/c1/files/content", "notes.md", "bytes=0-1");
  expect(note.status).toBe(200);
  expect(note.headers["content-type"]).toBe("application/octet-stream");
  expect(note.body.toString()).toBe("hello");
});

test("a path that is not a files route is left to the next handler", async () => {
  const other = await ask("/api/health", "x");
  expect(other.outcome).toBe(PASS);
});
