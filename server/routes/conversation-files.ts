// A group's or DM's project folder, for its people: the list of files and
// one file to download. Only the conversation's own people get an answer
// (colonie/groups/group-conversations.ts decides); everyone else is told
// there is no such conversation.
import { createReadStream, statSync } from "node:fs";
import { basename, extname } from "node:path";

import type { Caller, GroupConversations } from "../colonie/groups/group-conversations.ts";
import { parseAudioRange } from "../colonie/chat/attachments.ts";
import { messageFileDisposition } from "../colonie/chat/message-file.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const VIDEO_TYPES: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mov": "video/quicktime" };

export function createConversationFilesRoutes(deps: {
  conversations: GroupConversations | undefined;
  caller: (auth: RequestAuth) => Caller | null;
}): RouteHandler {
  return async ({ req, res, url, path, method, auth, json }) => {
    const m = /^\/api\/conversations\/([\w-]+)\/files(\/content|\/where)?$/.exec(path);
    if (!m || method !== "GET" || !deps.conversations) return PASS;
    const caller = deps.caller(auth);
    if (!caller) return json(res, 403, { error: "sign in to talk with people and bots" });
    if (!m[2]) {
      const answer = deps.conversations.files(caller, m[1]!);
      return json(res, answer.status, answer.body);
    }
    if (m[2] === "/where") {
      const where = deps.conversations.where(caller, m[1]!, url.searchParams.get("path"));
      return json(res, where.status, where.body);
    }
    const answer = deps.conversations.file(caller, m[1]!, url.searchParams.get("path"));
    if (!("path" in answer)) return json(res, answer.status, answer.body);
    const bytes = statSync(answer.path).size;
    const video = VIDEO_TYPES[extname(answer.path).toLowerCase()];
    const headers = {
      "content-type": video ?? "application/octet-stream",
      "content-disposition": video ? "inline" : messageFileDisposition(basename(answer.path)),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...(video ? { "accept-ranges": "bytes" } : {}),
    };
    // A video is played in place, so it is served in byte windows (a player seeks), not as one
    // capped download; anything else keeps the plain full response.
    const range = video ? parseAudioRange(Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range, bytes) : { kind: "none" as const };
    if (range.kind === "unsatisfiable") {
      res.writeHead(416, { ...headers, "content-range": `bytes */${bytes}` });
      res.end();
      return;
    }
    const part = range.kind === "range" ? range : null;
    res.writeHead(part ? 206 : 200, {
      ...headers,
      "content-length": String(part ? part.end - part.start + 1 : bytes),
      ...(part ? { "content-range": `bytes ${part.start}-${part.end}/${bytes}` } : {}),
    });
    const stream = createReadStream(answer.path, part ? { start: part.start, end: part.end } : undefined);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  };
}
