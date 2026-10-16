// ── canonical thread links ─────────────────────────────────────────────
// colonie://thread/<id>?bot=<owner> is the one spelling a copied
// reference has, in the clipboard and inside sent messages. The bot id is
// optional when parsing — a bare link or a raw UUID resolves by preference
// — but copy always emits it, so a paste round-trips to the exact thread.

/** Where a canonical link points. `botId` is the owner the link was copied
 * from, when it carries one. */
export interface ThreadRefAddress {
  threadId: string;
  botId?: string;
}

const THREAD_URL_PREFIX = "colonie://thread/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_LIMIT = 256;

const plainId = (value: string): string | null => {
  // oxlint-disable-next-line no-control-regex -- a thread id never carries control characters
  if (!value || value.length > ID_LIMIT || /[\u0000-\u001f]/.test(value)) return null;
  return value;
};

/** The canonical link for a thread a person can copy. */
export function threadRefUrl(ref: { botId: string; threadId: string }): string {
  return THREAD_URL_PREFIX + encodeURIComponent(ref.threadId) + "?bot=" + encodeURIComponent(ref.botId);
}

/** Parse a canonical thread link; null for anything else, including
 * near-misses with extra path, extra query or a foreign scheme. */
export function parseThreadRefUrl(value: string): ThreadRefAddress | null {
  const raw = value.trim();
  if (!raw.toLowerCase().startsWith(THREAD_URL_PREFIX)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.hash) return null;
  if (url.hostname.toLowerCase() !== "thread") return null;
  let threadId: string;
  try {
    threadId = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  if (!threadId || threadId.includes("/") || url.pathname.slice(1) !== encodeURIComponent(threadId)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "bot")) return null;
  const bot = url.searchParams.get("bot");
  if (keys.length > 1 || (bot !== null && !bot)) return null;
  const thread = plainId(threadId);
  const owner = bot === null ? undefined : plainId(bot);
  if (!thread || owner === null) return null;
  return owner ? { threadId: thread, botId: owner } : { threadId: thread };
}

/** Whether a value is shaped like a thread link at all — even one that
 * fails strict parsing. Markdown must never hand such a URL to the shell
 * as an external link, live or dead. */
export function looksLikeThreadRefUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith(THREAD_URL_PREFIX);
}

/** A raw thread id on its own: the UUID form the server mints. */
export function isThreadUuid(value: string): boolean {
  return UUID.test(value.trim());
}
