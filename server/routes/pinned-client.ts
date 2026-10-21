// A Colonie *client* session must name the thread it acts on, exactly like the
// app on the device does. Without a name, the request is ambiguous once a bot
// has more than one thread, so the client is asked to choose rather than
// guessing which thread the person meant.
//
// A Shared workspace is the exception: each person has their own conversation
// with a bot, so naming none means their own, not an ambiguous one.
import type { Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";

export type PinnedClientThread = (botId: string, threadId: unknown) => void;

export function pinnedClientThread({ auth, store, shared }: { auth: RequestAuth; store: Store; shared?: () => boolean }): PinnedClientThread {
  return (botId, threadId) => {
    if (shared?.()) return;
    if (threadId === undefined && auth.kind === "session" && store.tasks(botId).length > 1) {
      throw Object.assign(
        new Error("This bot has more than one thread. Update the Colonie app on this device, then choose a thread and try again."),
        { status: 409 },
      );
    }
  };
}
