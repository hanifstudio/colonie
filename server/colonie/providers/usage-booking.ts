// Booking a settled turn into the usage ledger: who a request is for (usageTriggerFor), the operator's own price list when the billing entitlement reads it (operatorPrices), one write of tokens and estimated cost that also lets the spend cap and its admin notification see the row at once (bookTurnUsage), and the trigger a line queued by an older build gets (queuedTurnTrigger).
import { type ResolvedSender } from "../../../shared/wire.ts";
import { ledgerCost } from "../../colonie/providers/model-prices.ts";
import { appendUsage, type UsageRow, type UsageTrigger} from "../../colonie/providers/usage-ledger.ts";
import { DATA_DIR } from "../../config.ts";
import { entitled } from "../../enterprise.ts";
import { buildSpendNotification } from "../../notify.ts";
import { type PriceList } from "../../prices.ts";
import { type RequestAuth } from "../../request-auth.ts";
import { noteSpend, spendAlertText, spendState, takeSpendAlert } from "../../spend.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface UsageBookingDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createUsageBooking(deps: UsageBookingDeps) {
  const {
    broadcast, cfg
  } = deps;
/** Who a request is, for the usage ledger: a paired or signed-in person, or
 * this machine. Captured when the message is accepted and carried with it. */
function usageTriggerFor(auth: RequestAuth): UsageTrigger {
  return auth.kind === "session"
    ? { kind: "user", ...(auth.session.email ? { email: auth.session.email } : {}), label: auth.session.label }
    : { kind: "owner" };
}

/** The operator's price list, when the server may read it (`billing`). */
function operatorPrices(): PriceList | null {
  return entitled("billing") && cfg.billing?.prices && Object.keys(cfg.billing.prices).length ? cfg.billing.prices : null;
}

/** Write one settled turn to the ledger, estimating its cost when the
 * engine reported tokens but no price, and let the spend cap see it at once.
 * The first booking that takes the month past the warning threshold, or to
 * the cap, notifies admins (once per month each; server/spend.ts). */
function bookTurnUsage(row: Omit<UsageRow, "at" | "costSource">, tokensReported = true, notificationThreadId = row.threadId): void {
  // Missing helper usage is unpriced, not an estimated zero-dollar call.
  const cost = tokensReported || row.costUsd !== null ? ledgerCost(row, operatorPrices()) : { costUsd: null };
  const booked = { ...row, ...cost, at: new Date().toISOString() };
  // The append lands asynchronously; the cap counts the row from memory
  // until it does, so the check below (and the next turn start) sees it.
  noteSpend(DATA_DIR, booked, appendUsage(DATA_DIR, booked));
  const state = spendState(cfg, DATA_DIR);
  const alert = takeSpendAlert(DATA_DIR, state);
  if (alert && state) {
    broadcast()({ kind: "notify", notification: buildSpendNotification({ id: row.botId, name: row.botName }, notificationThreadId, spendAlertText(alert, state)) }, { adminOnly: true });
  }
}

/** A queued line from before triggers were stored with it: its sender, else
 * the owner; a bot's own queued words set nothing. */
function queuedTurnTrigger(item: { trigger?: UsageTrigger; sender?: ResolvedSender; peerAsk?: unknown }): UsageTrigger | undefined {
  if (item.trigger) return item.trigger;
  if (item.peerAsk) return undefined;
  return item.sender ? { kind: "user", label: item.sender.name } : { kind: "owner" };
}

  return {
    usageTriggerFor,
    operatorPrices,
    bookTurnUsage,
    queuedTurnTrigger,
  };
}
