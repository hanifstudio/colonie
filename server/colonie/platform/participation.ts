// Conservative Group-only participation baseline for Cloud workspaces.
//
// This is the "simpler baseline" the workspace plan defers Jev against
// (docs/WORKSPACE-PLAN.md → P6 "considerate Group participation"). It answers
// one question: should at most one bot reply to an *unmentioned* human message
// in a Group? It stays silent unless the request is explicit and the choice is
// unambiguous, and it reports a reason instead of a confidence or probability —
// there is no model call here and no fabricated score.
//
// Bypass: a DM or a direct mention never passes through this filter. The caller
// dispatches straight to the mentioned bot(s); participation only ever decides
// unmentioned Group messages.
//
// The inputs are the Group's already-authorized context: the triggering
// message, the bots in this Group, the Group history the caller may read, and
// `now`. This module never widens that context, never reads a DM, and never
// touches the network, credentials, provider turns, or the Jev evaluation.
//
// Request detection is a keyword/question-mark heuristic and
// relevance is name/purpose token overlap, not a learned judgement. That is the
// deliberate P6 baseline ceiling. Upgrade path: swap the two private helpers
// for the evaluated Jev decision (or a labeled model) and keep this decision
// shape and reason vocabulary unchanged.

/** Only a Group is filtered. A DM bypasses participation entirely. */
export type ParticipationConversationKind = "group" | "dm";

/** A bot's own message is never a trigger: this is what stops bot loops. */
export type ParticipationSenderKind = "human" | "bot";

/** One message as the participation filter sees it. */
export interface ParticipationMessage {
  /** Stable message id, used only to skip the triggering message in history. */
  id: string;
  conversationKind: ParticipationConversationKind;
  senderKind: ParticipationSenderKind;
  senderName: string;
  body: string;
  /** ISO timestamp; used with `now` for the recent-contribution cooldown. */
  createdAt: string;
  /**
   * Bot ids the platform itself already resolved as direct mentions. The
   * platform owns mention parsing; participation never invents a mention.
   */
  mentions?: readonly string[];
}

/** A bot that is a participant of this Group. */
export interface GroupBot {
  id: string;
  name: string;
  /** Short description of what the bot is for, when the workspace has one. */
  purpose?: string;
}

export interface GroupParticipationInput {
  /** The new message that may or may not be answered. */
  message: ParticipationMessage;
  /** Bots that participate in this Group, and nothing outside it. */
  bots: readonly GroupBot[];
  /**
   * The Group's authorized history, oldest first. Already scoped by the
   * caller; participation does not read anything else.
   */
  history: readonly ParticipationMessage[];
  /** Epoch milliseconds, so the cooldown is deterministic in tests. */
  now: number;
  /** Overrides {@link DEFAULT_COOLDOWN_MS}. */
  cooldownMs?: number;
}

/**
 * The decision. `bypass` means "not a participation question, dispatch
 * directly"; `speak` names exactly one bot; `silent` means no bot should
 * answer. Every variant carries a `reason` and no probability.
 */
export type GroupParticipationDecision =
  | { action: "bypass"; reason: string; botIds: string[] }
  | { action: "speak"; reason: string; botId: string; matched?: string }
  | { action: "silent"; reason: string };

/**
 * How long after any bot message in the Group another proactive reply stays
 * silent. Conservative on purpose: the baseline treats every recent bot
 * message as a contribution, whether or not a person asked for it.
 */
export const DEFAULT_COOLDOWN_MS = 120_000;

const STOPWORDS = new Set([
  "the", "and", "you", "your", "for", "with", "this", "that", "can", "could",
  "would", "should", "please", "help", "about", "from", "have", "just",
  "tolong", "mohon", "bisa", "bisakah", "boleh", "yang", "untuk", "dengan",
  "dan", "atau", "ini", "itu", "saya", "kita", "kami", "apa", "saja", "ada",
  "tidak", "dari", "pada", "adalah", "akan", "sudah", "belum", "dong",
]);

// Whole-word phrases (lowercased, punctuation stripped before matching). Kept
// to explicit address/question markers so an ordinary statement stays silent.
const REQUEST_PHRASES = [
  "tolong", "mohon", "bisakah", "bisa", "boleh", "bantu", "bantulah",
  "jelaskan", "gimana", "bagaimana", "apakah", "apa itu", "kenapa", "mengapa",
  "kapan", "dimana", "di mana", "yang mana", "mana yang", "siapa", "coba",
  "can you", "could you", "would you", "will you", "please", "help me",
  "help us", "how do", "how can", "how does", "how to", "what is", "what are",
  "why is", "why are", "where is", "where are", "who is", "who can",
  "which one", "explain", "summarize", "walk me through", "show me",
  "tell me",
];

function flatWords(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a message asks the Group for something. A question mark or an
 * explicit request marker counts; an ordinary statement does not, and a
 * statement is therefore left silent. Exported so the caller and its tests can
 * reason about the same predicate.
 */
export function isRequestMessage(body: string): boolean {
  if (typeof body !== "string" || !body.trim()) return false;
  if (body.includes("?")) return true;
  const flat = flatWords(body);
  return REQUEST_PHRASES.some((phrase) => flat.includes(` ${phrase} `));
}

/** Bot ids directly addressed, from platform-resolved mentions and `@name`. */
function mentionedBotIds(message: ParticipationMessage, bots: readonly GroupBot[]): string[] {
  const found = new Set<string>();
  for (const id of message.mentions ?? []) {
    if (bots.some((bot) => bot.id === id)) found.add(id);
  }
  const lower = message.body.toLowerCase();
  for (const bot of bots) {
    for (const handle of [bot.name, bot.id]) {
      if (!handle) continue;
      const pattern = new RegExp(`@${escapeRegExp(handle.toLowerCase())}(?![\\p{L}\\p{N}])`, "u");
      if (pattern.test(lower)) found.add(bot.id);
    }
  }
  return [...found];
}

/**
 * The clearest relevant bot, or null when no single bot is clearly relevant.
 * A name match weighs double a purpose match, and a tie for the top score
 * means the Group stays silent rather than guessing.
 */
function clearestBot(
  message: ParticipationMessage,
  bots: readonly GroupBot[],
): { bot: GroupBot; matched: string } | null {
  const messageTokens = new Set(tokens(message.body));
  if (!messageTokens.size) return null;
  const scored = bots.map((bot) => {
    const nameTokens = new Set(tokens(bot.name));
    const purposeTokens = new Set(tokens(bot.purpose ?? ""));
    let score = 0;
    let matched: string | undefined;
    for (const token of messageTokens) {
      if (nameTokens.has(token)) {
        score += 2;
        matched ??= token;
      } else if (purposeTokens.has(token)) {
        score += 1;
        matched ??= token;
      }
    }
    return { bot, score, matched };
  });
  scored.sort((a, b) => b.score - a.score);
  const [top, next] = scored;
  if (!top || top.score < 1 || !top.matched) return null;
  if (next && next.score === top.score) return null;
  return { bot: top.bot, matched: top.matched };
}

/**
 * Decide whether one bot should answer an unmentioned Group message.
 *
 * Order matters: a bot message is silent before anything else (no loops), a DM
 * or a direct mention bypasses (the caller dispatches it), then duplicates,
 * then the recent-contribution cooldown, then the request test, then the choice
 * of bot.
 */
export function chooseGroupBot(input: GroupParticipationInput): GroupParticipationDecision {
  const { message, bots, history, now } = input;

  if (message.senderKind === "bot") {
    return { action: "silent", reason: "bot message" };
  }

  if (message.conversationKind === "dm") {
    return { action: "bypass", reason: "direct message", botIds: bots.map((bot) => bot.id) };
  }

  const mentioned = mentionedBotIds(message, bots);
  if (mentioned.length) {
    return { action: "bypass", reason: "direct mention", botIds: mentioned };
  }

  const normalized = message.body.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized && history.some((entry) =>
    entry.id !== message.id && entry.senderKind === "human" &&
    entry.body.toLowerCase().replace(/\s+/g, " ").trim() === normalized)) {
    return { action: "silent", reason: "duplicate request" };
  }

  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastBotMessage = [...history].reverse().find((entry) => entry.senderKind === "bot");
  if (lastBotMessage) {
    const at = Date.parse(lastBotMessage.createdAt);
    if (Number.isFinite(at) && Math.abs(now - at) < cooldownMs) {
      return { action: "silent", reason: "recent bot contribution" };
    }
  }

  if (!isRequestMessage(message.body)) {
    return { action: "silent", reason: "not a request" };
  }

  if (!bots.length) {
    return { action: "silent", reason: "no bot in this group" };
  }

  if (bots.length === 1) {
    return { action: "speak", reason: "the only bot in this group", botId: bots[0].id };
  }

  const choice = clearestBot(message, bots);
  if (!choice) {
    return { action: "silent", reason: "no clearly relevant bot" };
  }
  return { action: "speak", reason: "clearly relevant bot", botId: choice.bot.id, matched: choice.matched };
}
