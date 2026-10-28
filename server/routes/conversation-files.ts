// A group's or DM's project folder, for its people: the list of files and
// one file to download. Only the conversation's own people get an answer
// (colonie/groups/group-conversations.ts decides); everyone else is told
// there is no such conversation.
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

import type { Caller, GroupConversations } from "../colonie/groups/group-conversations.ts";
import { messageFileDisposition } from "../colonie/chat/message-file.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createConversationFilesRoutes(deps: {
  conversations: GroupConversations | undefined;
  caller: (auth: RequestAuth) => Caller | null;
}): RouteHandler {
  return async ({ res, url, path, method, auth, json }) => {
    const m = /^\/api\/conversations\/([\w-]+)\/files(\/content)?$/.exec(path);
    if (!m || method !== "GET" || !deps.conversations) return PASS;
    const caller = deps.caller(auth);
    if (!caller) return json(res, 403, { error: "sign in to talk with people and bots" });
    if (!m[2]) {
      const answer = deps.conversations.files(caller, m[1]!);
      return json(res, answer.status, answer.body);
    }
    const answer = deps.conversations.file(caller, m[1]!, url.searchParams.get("path"));
    if (!("path" in answer)) return json(res, answer.status, answer.body);
    const bytes = statSync(answer.path).size;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes),
      "content-disposition": messageFileDisposition(basename(answer.path)),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    const stream = createReadStream(answer.path);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  };
}
