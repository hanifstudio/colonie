/**
 * A bot asking the person to do a step only a person can do in its browser:
 * sign in, pass a CAPTCHA, enter a code it cannot read. Colonie never
 * receives the password; the person types it into the page and the bot uses
 * the session the page keeps. Adapted from OpenMausBot's sign-in request
 * (Apache-2.0), the project Colonie began from.
 */

export type SignInAsk = {
  site: string;
  url: string;
  reason?: string;
  botId: string;
  /** How it ended; absent while the card waits. */
  outcome?: "done" | "cancelled";
};

/** The site as a page address and the host shown on the card. A bare
 * domain means its https home page. Anything that is not a plain http(s)
 * address (a script URL, a file, an address carrying a username or
 * password) is refused, so the card can never open more than a page. */
export function normalizeSignInSite(raw: unknown): { url: string; site: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters and spaces before URL parsing normalizes them.
  if (!text || text.length > 2048 || /[\u0000- \u007f\\]/u.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
  // A bare word is no site ("example" would parse as a host); localhost and
  // addresses are the exceptions a developer's own app needs.
  if (!url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.startsWith("[")) return null;
  return { url: url.href, site: url.hostname.replace(/^www\./, "") };
}

/** The person's own words that resume the bot, sent like any message. */
export function signInResumeText(site: string, outcome: "done" | "cancelled"): string {
  return outcome === "done"
    ? `I finished on ${site}. Please check and continue.`
    : `I won't do the step on ${site}. Continue without it if you can.`;
}
