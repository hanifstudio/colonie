// The Colonie account of the person using this computer. Everyone signs up
// (or in) once on first opening the app, Local included (owner decision,
// October 22). The app registers itself with Colonie Cloud for this computer's
// own way back (127.0.0.1), the person signs in in their browser (code plus
// PKCE), and the verified account is kept app-wide, in the app's own folder
// (COLONIE_USER_DATA, else the workspace's), so every Local workspace on this
// computer shares it. After that nothing checks the account again: a Local
// workspace works offline.
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../persistence/atomic.ts";
import { verifiedColonieAccount, type ColonieAccount } from "./colonie-oauth.ts";

export const DESKTOP_CALLBACK = "/auth/colonie/desktop-callback";
const PENDING_MS = 15 * 60_000;

interface Stored { issuer?: string; clientId?: string; redirectUri?: string; account?: ColonieAccount & { signedInAt: string } }

export function createDesktopAccount(deps: {
  dir: string;
  issuer: string;
  /** The account's name and email become the app's profile. */
  onSignedIn: (account: ColonieAccount) => void;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const file = join(deps.dir, "colonie-account.json");
  const http = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const issuer = deps.issuer.replace(/\/+$/, "");
  const pending = new Map<string, { verifier: string; nonce: string; clientId: string; redirectUri: string; expires: number }>();
  const read = (): Stored => { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Stored : {}; } catch { return {}; } };
  const save = (value: Stored) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

  return {
    account(): { email: string; name: string } | null {
      const { account } = read();
      return account ? { email: account.email, name: account.name } : null;
    },

    /** Where to send the person's browser to sign up or in. */
    async start(redirectUri: string): Promise<{ authorizationUrl: string }> {
      let stored = read();
      // A client is registered for one way back; a new port registers again.
      if (stored.issuer !== issuer || !stored.clientId || stored.redirectUri !== redirectUri) {
        const answer = await http(`${issuer}/clients`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Colonie on this computer", redirect_uri: redirectUri }),
        });
        if (!answer.ok) throw Object.assign(new Error("Colonie accounts cannot be reached right now. Check the internet connection and try again."), { status: 502 });
        const { client_id: clientId } = await answer.json() as { client_id: string };
        stored = { ...stored, issuer, clientId, redirectUri };
        save(stored);
      }
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      for (const [key, value] of pending) if (value.expires < now()) pending.delete(key);
      pending.set(state, { verifier, nonce, clientId: stored.clientId!, redirectUri, expires: now() + PENDING_MS });
      const url = new URL(`${issuer}/authorize`);
      url.search = new URLSearchParams({
        response_type: "code", client_id: stored.clientId!, redirect_uri: redirectUri, state, nonce,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl: url.href };
    },

    /** The browser's way back. The state is the credential, used once. */
    async callback(search: string): Promise<{ status: number; text: string }> {
      const query = new URLSearchParams(search);
      const state = query.get("state") ?? "";
      const flow = pending.get(state);
      pending.delete(state);
      const code = query.get("code");
      if (!flow || flow.expires < now() || !code) return { status: 400, text: "This sign-in is no longer valid. Return to Colonie and try again." };
      try {
        const account = await verifiedColonieAccount({ http, issuer, clientId: flow.clientId, redirectUri: flow.redirectUri, code, verifier: flow.verifier, nonce: flow.nonce });
        if (!account) return { status: 400, text: "Colonie could not confirm who you are. Return to Colonie and try again." };
        save({ ...read(), account: { ...account, signedInAt: new Date(now()).toISOString() } });
        deps.onSignedIn(account);
        return { status: 200, text: `You are signed in as ${account.email}. You can close this tab and return to Colonie.` };
      } catch {
        return { status: 400, text: "Colonie could not confirm who you are. Return to Colonie and try again." };
      }
    },

    signOut() {
      const { account: _account, ...rest } = read();
      if (Object.keys(rest).length) save(rest); else rmSync(file, { force: true });
    },
  };
}

export type DesktopAccount = ReturnType<typeof createDesktopAccount>;
