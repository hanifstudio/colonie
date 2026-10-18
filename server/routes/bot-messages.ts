// Sending a message to a bot: the normal route, and the `guarded` variant an
// external interface must opt into so that an older server answers 404 rather
// than silently ignoring safety preconditions. A guarded send is checked
// against the approval mode, the branch and a free thread slot *synchronously*
// before it starts, because nothing may be steered under stale permissions.
import { admit } from "../admission.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { parseSendId } from "../send-idempotency.ts";
import type { UsageTrigger } from "../colonie/providers/usage-ledger.ts";
import type { BotRecord, Store } from "../persistence/store.ts";
import type { DirectSendReceipt } from "../colonie/chat/direct-send.ts";
import type { RequestAuth } from "../request-auth.ts";
import { pinnedClientThread } from "./pinned-client.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Helpers whose own signatures are wide; the module only forwards to them. */
type Helper = (...args: any[]) => any;

export interface BotMessagesRouteDeps {
  store: Store;
  desktopManaged: boolean;
  /** A zod schema whose safeParse outcome the block reads directly. */
  guardedSendSchema: { safeParse: (body: unknown) => any };
  directSendRefusal: (botId: string, threadId: string) => { status: number; body: unknown } | null;
  resolveReplyTarget: Helper;
  messageSender: (auth: RequestAuth) => unknown;
  usageTriggerFor: (auth: RequestAuth) => UsageTrigger;
  acceptDirectSend: Helper;
  startTurn: Helper;
  botAtThreadCapacity: (botId: string) => boolean;
  threadBusy: (botId: string, threadId: string) => boolean;
  /** The same class object index.ts uses, so `instanceof` still holds. */
  DirectSendRefused: new (...args: any[]) => { status: number; body: unknown };
}

export function createBotMessagesRoutes(deps: BotMessagesRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const {
      store, guardedSendSchema, directSendRefusal, resolveReplyTarget, messageSender,
      usageTriggerFor, acceptDirectSend, startTurn, botAtThreadCapacity, threadBusy,
      DirectSendRefused,
    } = deps;
    const DESKTOP_MANAGED = deps.desktopManaged;
    const requirePinnedClientThread = pinnedClientThread({ auth, store });
    let m: RegExpMatchArray | null = null;
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages(?:\/(guarded))?$/);
    if (m && method === "POST") {
      const guarded = m[2] === "guarded";
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      // External interfaces must opt into a distinct route: an older server
      // returns 404 rather than silently ignoring safety preconditions.
      const guardedBody = guarded ? guardedSendSchema.safeParse(body) : null;
      if (guardedBody && !guardedBody.success) {
        const onBehalfOfInvalid = guardedBody.error.issues.some((issue: { path: Array<string | number> }) => issue.path[0] === "onBehalfOf");
        return json(res, 400, { error: onBehalfOfInvalid
          ? "onBehalfOf must name the person with an email address, a name, or both"
          : "guarded sends require threadId, sendId, text and expectedActiveLeafId" });
      }
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      requirePinnedClientThread(bot.id, body.threadId);
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      // A retry carries its original task. That lets us return the canonical
      // receipt after a task switch, while a genuinely new send still has to
      // target the task that is active now.
      const threadId = body.threadId ?? bot.threadId;
      // Who this message is from, for the ledger. It is captured here and
      // travels with the message: into the turn it starts, or into the queue
      // until it drains. A message steered into someone else's running turn
      // books nothing — that turn stays with whoever started it. A guarded
      // relay (the Slack worker, which already holds admin scope to reach
      // this route) names the person it acts for.
      const onBehalfOf = guardedBody?.data?.onBehalfOf;
      const trigger: UsageTrigger = onBehalfOf
        ? { kind: "user", ...(onBehalfOf.email ? { email: onBehalfOf.email } : {}), ...(onBehalfOf.name ? { label: onBehalfOf.name } : {}) }
        : usageTriggerFor(auth);
      // The spend cap and a task that is gone answer before a malformed
      // sendId or reply target does. acceptDirectSend checks both again for
      // callers that do not come through this route; nothing awaits between.
      const refused = directSendRefusal(bot.id, threadId);
      if (refused) return json(res, refused.status, refused.body);
      const sendId = parseSendId(body.sendId);
      const replyTo = resolveReplyTarget(threadId, body.replyToId);
      const sender = messageSender(auth);
      const guardedStart = guarded
        ? async (currentAtStart: BotRecord): Promise<DirectSendReceipt> => {
            // There is no await between these checks and startTurn's
            // synchronous transcript append / runtime reservation. In
            // particular, never steer or enqueue under stale permissions.
            const expectedMode = body.expectedApprovalMode ?? "ask";
            if (approvalModeFor(currentAtStart) !== expectedMode ||
                (expectedMode === "ask" && (currentAtStart.autoApprove === true || currentAtStart.alwaysAllow?.length))) {
              throw Object.assign(new Error("guarded sends require the exact expected approval mode; Ask cannot have remembered permissions"), { status: 409, code: "guarded_permissions" });
            }
            if (store.activeLeaf(threadId) !== body.expectedActiveLeafId) {
              throw Object.assign(new Error("the conversation changed before this message could start"), { status: 409, code: "guarded_branch" });
            }
            const guardedAdmission = admit("guarded", {}, {
              botBusy: currentAtStart.busy,
              threadBusy: threadBusy(bot.id, threadId),
              atCapacity: botAtThreadCapacity(bot.id),
            });
            if (guardedAdmission.action === "refuse") {
              throw Object.assign(new Error("wait for a free thread slot before retrying this message"), { status: 409, code: "guarded_busy" });
            }
            // Stored as relayed: a worker's line for someone else, which a
            // Live call on this thread must not read back as typed there.
            const message = await startTurn(bot.id, text, { threadId, replyTo, sendId, sender, trigger, relayed: true });
            return { ok: true as const, threadId, message };
          }
        : undefined;
      try {
        const receipt = await acceptDirectSend({
          botId: bot.id, threadId, text, sendId, replyTo, sender, trigger,
          // A person steering a webhook turn is present, and auto mode may
          // follow them again. But this route is also reachable from the
          // bot's own shell on a headless server (loopback is the owner
          // there), and "continue" typed by the turn itself must not be the
          // thing that lifts the block written against it — so only a
          // request that proves a person (a paired session, or the desktop's
          // owner capability, which every mutation there has already shown)
          // clears the mark.
          personPresent: auth.kind === "session" || DESKTOP_MANAGED,
        }, guardedStart);
        return json(res, 202, receipt);
      } catch (error) {
        if (error instanceof DirectSendRefused) return json(res, error.status, error.body);
        throw error;
      }
    }
    return PASS;
  };
}
