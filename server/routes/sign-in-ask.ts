// Settling a bot's sign-in card (shared/sign-in-request.ts): the person did
// the step in the bot's browser, or declined it. Only the card changes here;
// the person's own message, sent next, resumes the bot like any message.
// Also "Not now" on a bot's offer to set up its computer: the card says so
// and bots stop offering the free app.
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../persistence/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createSignInAskRoutes(deps: {
  store: () => Pick<Store, "messagesFor" | "patchMessage">;
  /** Whether this caller may act in the thread the card is in. */
  mayAct: (auth: RequestAuth, threadId: string) => boolean;
  /** Remember that the person does not want the computer's app offered. */
  declineComputerOffers: () => void;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const offer = path.match(/^\/api\/threads\/([\w-]+)\/computer-offer$/);
    if (offer) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      const threadId = offer[1]!;
      const body = (await readBody(req)) ?? {};
      if (typeof body.messageId !== "string") return json(res, 400, { error: "messageId is required" });
      if (!deps.mayAct(auth, threadId)) return json(res, 404, { error: "no such card" });
      const store = deps.store();
      const message = store.messagesFor(threadId).find((entry) => entry.id === body.messageId && entry.computerAsk);
      if (!message?.computerAsk) return json(res, 404, { error: "no such card" });
      if (!message.computerAsk.outcome) store.patchMessage(threadId, message.id, { computerAsk: { ...message.computerAsk, outcome: "later" } });
      deps.declineComputerOffers();
      return json(res, 200, { ok: true });
    }
    const m = path.match(/^\/api\/threads\/([\w-]+)\/sign-in$/);
    if (!m) return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const threadId = m[1]!;
    const body = (await readBody(req)) ?? {};
    const outcome = body.outcome === "done" || body.outcome === "cancelled" ? body.outcome : null;
    if (!outcome || typeof body.messageId !== "string") return json(res, 400, { error: "messageId and outcome (done or cancelled) are required" });
    if (!deps.mayAct(auth, threadId)) return json(res, 404, { error: "no such card" });
    const store = deps.store();
    const message = store.messagesFor(threadId).find((entry) => entry.id === body.messageId && entry.signInAsk);
    if (!message?.signInAsk) return json(res, 404, { error: "no such card" });
    if (message.signInAsk.outcome) return json(res, 409, { error: "this card is already settled", outcome: message.signInAsk.outcome });
    store.patchMessage(threadId, message.id, { signInAsk: { ...message.signInAsk, outcome } });
    return json(res, 200, { ok: true, outcome });
  };
}
