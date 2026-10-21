// Colonie Cloud's web surface: plain pages for signing up, signing in and out,
// and the signed-in home. A fetch handler, so the same code runs in a
// Cloudflare Worker and in a test.
import {
  closeSession, createAccount, finishPasswordReset, LOCK_MINUTES, openSession, passwordProblem,
  resetAccount, sessionAccount, SESSION_DAYS, signIn, signUpProblem, startPasswordReset, type Account,
} from "./accounts.ts";
import type { Db } from "./db.ts";
import { findClient, issueCode, redeemCode, redirectProblem, registerClient, type Client, type Signer } from "./oauth.ts";

export const SESSION_COOKIE = "__Host-colonie_session";

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export interface AppOptions {
  db: Db;
  /** This service's public address, the `iss` of every ID token. */
  issuer: string;
  /** Signs ID tokens for Sign in with Colonie. */
  signer: Signer;
  /** Sends the password-reset link. Without one, the page still answers the
   * same, but no email leaves this service. */
  mailer?: Mailer;
  now?: () => Date;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...SECURITY_HEADERS } });

/** The parameters of a sign-in request from a workspace, read from a query
 * string or a form. */
function authorizeParams(source: URLSearchParams) {
  return {
    response_type: source.get("response_type") ?? "",
    client_id: source.get("client_id") ?? "",
    redirect_uri: source.get("redirect_uri") ?? "",
    state: source.get("state") ?? "",
    code_challenge: source.get("code_challenge") ?? "",
    code_challenge_method: source.get("code_challenge_method") ?? "",
    nonce: source.get("nonce") ?? "",
  };
}
type AuthorizeParams = ReturnType<typeof authorizeParams>;

/** Back to the workspace with a result. Only ever to its registered address. */
function backTo(client: Client, values: Record<string, string>): Response {
  const url = new URL(client.redirect_uri);
  for (const [key, value] of Object.entries(values)) if (value) url.searchParams.set(key, value);
  return redirect(url.toString());
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  // Not "no-referrer": with it a browser sends its own forms with Origin
  // "null", which the form check below refuses. "same-origin" still keeps
  // every address off other sites.
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

/** The look of the Colonie app (its default "midnight" skin and brand
 * colour), so signing in feels like part of the app. Inline only: the pages
 * load nothing from anywhere (see the content security policy). */
const STYLE = `
:root{color-scheme:dark;--canvas:#080808;--panel:#111111;--inset:#191919;--hairline:#333333;--ink:#fcfcfc;--ink-2:#fcfcfc99;--accent:#7b61ff;--accent-ink:#ffffff;--danger:#ff5667}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--canvas);color:var(--ink);
font:15px/1.5 Inter,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:420px;background:var(--panel);border:1px solid #33333380;border-radius:20px;padding:28px;box-shadow:0 24px 60px -20px #000000cc}
.brand{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--ink-2);margin-bottom:14px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
h1{font-size:20px;line-height:1.3;font-weight:600;margin:0 0 6px}
p{color:var(--ink-2);font-size:13.5px;margin:10px 0}
label{display:block;margin:14px 0 6px;font-size:12.5px;font-weight:500;color:var(--ink-2)}
input{width:100%;padding:10px 12px;font:inherit;font-size:14px;color:var(--ink);background:var(--inset);border:1px solid #33333399;border-radius:10px;outline:none}
input:focus{border-color:var(--accent)}
button{width:100%;margin-top:20px;padding:11px 16px;font:inherit;font-size:14px;font-weight:600;color:var(--accent-ink);background:var(--accent);border:0;border-radius:12px;cursor:pointer}
button:hover{filter:brightness(1.1)}
button.quiet{background:transparent;color:var(--ink-2);margin-top:8px;font-weight:500}
a{color:var(--ink);text-underline-offset:3px}
.error{color:var(--danger);font-size:13px}
.row{display:flex;justify-content:space-between;gap:12px;margin-top:16px;font-size:13px;color:var(--ink-2)}
.row p{margin:0}`;

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Colonie</title><style>${STYLE}</style></head>
<body><main><div class="brand"><span class="dot"></span>Colonie</div><h1>${escape(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...headers } });
}

const redirect = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, ...SECURITY_HEADERS, ...headers } });

/** Only a path on this site: never another origin (`//evil.example`), so a
 * sign-in link cannot be used to send someone elsewhere. */
export function safeNext(raw: string | null | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/";
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=") || null;
  }
  return null;
}

const sessionCookie = (token: string) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
const clearedCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const hidden = (next: string) => (next === "/" ? "" : `<input type="hidden" name="next" value="${escape(next)}">`);
const problem = (text: string | null) => (text ? `<p class="error" role="alert">${escape(text)}</p>` : "");

function signUpPage(next: string, error: string | null = null, values: { email?: string; name?: string } = {}, status = 200) {
  return page("Create your Colonie account", `${problem(error)}
<form method="post" action="/signup">${hidden(next)}
<label for="name">Name</label><input id="name" name="name" autocomplete="name" required value="${escape(values.name ?? "")}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${escape(values.email ?? "")}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
<button type="submit">Create account</button></form>
<p>Already have an account? <a href="/signin${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}">Sign in</a></p>`, status);
}

function signInPage(next: string, error: string | null = null, email = "", status = 200) {
  return page("Sign in to Colonie", `${problem(error)}
<form method="post" action="/signin">${hidden(next)}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${escape(email)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form>
<div class="row"><p>New to Colonie? <a href="/signup${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}">Create an account</a></p><p><a href="/forgot">Forgot password?</a></p></div>`, status);
}

function forgotPage(error: string | null = null, status = 200) {
  return page("Reset your password", `${problem(error)}
<p>Enter the email you signed up with. If it has a Colonie account, we will send a link to choose a new password.</p>
<form method="post" action="/forgot">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
<button type="submit">Send reset link</button></form>
<p><a href="/signin">Back to sign in</a></p>`, status);
}

/** The answer to every reset request, whether or not the address has an
 * account and whether or not a mail left the service. */
function resetSentPage() {
  return page("Check your email", `<p>If that address has a Colonie account, a reset link is on its way. It works once, within thirty minutes.</p>
<p><a href="/signin">Back to sign in</a></p>`);
}

function resetPage(token: string, error: string | null = null, status = 200) {
  return page("Choose a new password", `${problem(error)}
<form method="post" action="/reset">
<input type="hidden" name="token" value="${escape(token)}">
<label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="10">
<button type="submit">Set new password</button></form>`, status);
}

const invalidResetPage = () =>
  page("Reset link not valid", `<p>This reset link has expired or was already used. Ask for a new one.</p>
<p><a href="/forgot">Ask for a new link</a></p>`, 400);

export function createApp({ db, issuer, signer, mailer, now = () => new Date() }: AppOptions) {
  /** The workspace asking, checked before anything is sent back to it: an
   * unknown client or an address that is not exactly its own gets an error
   * page here, never a redirect. Then the request itself: a problem with it
   * goes back to the (now trusted) address as an OAuth error. */
  async function checkAuthorize(params: AuthorizeParams): Promise<{ client: Client } | { page: Response } | { back: Response }> {
    const client = params.client_id ? await findClient(db, params.client_id) : null;
    if (!client || client.redirect_uri !== params.redirect_uri) {
      return { page: page("Cannot continue", "<p>This sign-in link does not come from a workspace Colonie knows. Ask for a new invite link.</p>", 400) };
    }
    if (params.response_type !== "code" || params.code_challenge_method !== "S256" || !/^[\w-]{43}$/.test(params.code_challenge)) {
      return { back: backTo(client, { error: "invalid_request", state: params.state }) };
    }
    return { client };
  }

  function consentPage(client: Client, account: Account, params: AuthorizeParams): Response {
    const fields = Object.entries(params).map(([key, value]) => `<input type="hidden" name="${key}" value="${escape(value)}">`).join("");
    const redirect = new URL(client.redirect_uri);
    // Continue answers with a redirect to the client's way back, and browsers
    // hold a form's redirects to form-action too: allow that one origin, on
    // this page only, or Continue does nothing.
    const csp = { "content-security-policy": SECURITY_HEADERS["content-security-policy"].replace("form-action 'self'", `form-action 'self' ${redirect.origin}`) };
    const signOut = `<form method="post" action="/signout"><button type="submit" class="quiet">Not you? Sign out</button></form>`;
    // The Colonie app on the person's own computer: it registers under this
    // name and comes back to 127.0.0.1 (server/colonie/accounts/desktop-account.ts).
    if (client.name === "Colonie on this computer" && ["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname)) {
      return page("Continue to Colonie", `<p>Sign in to the Colonie app on this computer as
<strong>${escape(account.name)}</strong> (${escape(account.email)})?</p>
<form method="post" action="/authorize">${fields}<button type="submit">Continue</button></form>${signOut}`, 200, csp);
    }
    return page("Continue to the workspace", `<p>Join <strong>${escape(client.name)}</strong> at <strong>${escape(redirect.host)}</strong> as
<strong>${escape(account.name)}</strong> (${escape(account.email)})?</p>
<form method="post" action="/authorize">${fields}<button type="submit">Continue</button></form>${signOut}`, 200, csp);
  }

  async function currentAccount(request: Request): Promise<Account | null> {
    const token = cookieToken(request);
    return token ? sessionAccount(db, token, now()) : null;
  }

  async function signedIn(account: Account, next: string): Promise<Response> {
    const token = await openSession(db, account.id, now());
    return redirect(next, { "set-cookie": sessionCookie(token) });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method;
      // A form post must come from this site: SameSite=Lax already keeps the
      // session cookie off cross-site posts; this refuses them outright.
      if (method === "POST") {
        const origin = request.headers.get("origin");
        if (origin && origin !== url.origin) return page("Not allowed", "<p>This form must be sent from Colonie.</p>", 403);
      }
      const raw = method === "POST" ? await request.text() : "";
      const form = method === "POST" ? new URLSearchParams(raw) : null;
      const next = safeNext(form?.get("next") ?? url.searchParams.get("next"));

      if (url.pathname === "/signup" && method === "GET") return signUpPage(next);
      if (url.pathname === "/signup" && method === "POST") {
        const input = { email: form!.get("email") ?? "", name: form!.get("name") ?? "", password: form!.get("password") ?? "" };
        const invalid = signUpProblem(input);
        if (invalid) return signUpPage(next, invalid, input, 400);
        const account = await createAccount(db, input);
        // The same answer whether or not the address was taken would hide who
        // has an account, but a person signing up needs to know to sign in
        // instead; email is not secret here (it is not verified).
        if (account === "exists") return signUpPage(next, "An account with this email already exists. Sign in instead.", input, 409);
        return signedIn(account, next);
      }

      if (url.pathname === "/signin" && method === "GET") return signInPage(next);
      if (url.pathname === "/signin" && method === "POST") {
        const email = form!.get("email") ?? "";
        const account = await signIn(db, email, form!.get("password") ?? "", now());
        if (account === "locked") return signInPage(next, `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes.`, email, 429);
        if (!account) return signInPage(next, "That email and password do not match an account.", email, 401);
        return signedIn(account, next);
      }

      if (url.pathname === "/forgot" && method === "GET") return forgotPage();
      if (url.pathname === "/forgot" && method === "POST") {
        const started = await startPasswordReset(db, form!.get("email") ?? "", now());
        if (started && mailer) {
          const link = `${issuer}/reset?token=${started.token}`;
          try {
            await mailer.send({
              to: started.account.email,
              subject: "Reset your Colonie password",
              text: `Someone asked to reset the password for your Colonie account.\n\nIf it was you, choose a new one here within thirty minutes:\n\n${link}\n\nIf it was not you, ignore this message. Your password has not changed.\n`,
            });
          } catch (error) {
            // Say nothing different to the person asking; the mail is the only
            // place the link exists, so an operator must see the failure.
            console.error("reset email failed", error);
          }
        }
        return resetSentPage();
      }

      if (url.pathname === "/reset" && method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        if (!token || !(await resetAccount(db, token, now()))) return invalidResetPage();
        return resetPage(token);
      }
      if (url.pathname === "/reset" && method === "POST") {
        const token = form!.get("token") ?? "";
        const password = form!.get("password") ?? "";
        const invalid = passwordProblem(password);
        // Check the link before naming the password problem, so a spent link
        // does not look like a usable one.
        if (!token || !(await resetAccount(db, token, now()))) return invalidResetPage();
        if (invalid) return resetPage(token, invalid, 400);
        if (!(await finishPasswordReset(db, { token, password, now: now() }))) return invalidResetPage();
        return redirect("/signin");
      }

      if (url.pathname === "/signout" && method === "POST") {
        const token = cookieToken(request);
        if (token) await closeSession(db, token);
        return redirect("/signin", { "set-cookie": clearedCookie });
      }

      // ── Sign in with Colonie (for Shared workspaces) ──
      if (url.pathname === "/.well-known/jwks.json" && method === "GET") return json(await signer.publicJwks());
      if (url.pathname === "/.well-known/openid-configuration" && method === "GET") {
        return json({
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`, registration_endpoint: `${issuer}/clients`,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["ES256"],
          subject_types_supported: ["public"], token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/clients" && method === "POST") {
        // A workspace registers itself: its name, and the one address it may
        // be sent back to. No secret: it proves each sign-in with PKCE.
        let body: { name?: unknown; redirect_uri?: unknown } = {};
        try { body = JSON.parse(raw); } catch { /* answered as missing fields below */ }
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
        const invalid = !name ? "name required" : redirectProblem(redirectUri);
        if (invalid) return json({ error: "invalid_client_metadata", error_description: invalid }, 400);
        const client = await registerClient(db, { name, redirect_uri: redirectUri });
        return json({ client_id: client.id, client_name: client.name, redirect_uris: [client.redirect_uri], token_endpoint_auth_method: "none" }, 201);
      }
      if (url.pathname === "/authorize" && (method === "GET" || method === "POST")) {
        const params = authorizeParams(method === "GET" ? url.searchParams : form!);
        const checked = await checkAuthorize(params);
        if ("page" in checked) return checked.page;
        if ("back" in checked) return checked.back;
        const account = await currentAccount(request);
        if (!account) {
          const query = new URLSearchParams(params).toString();
          return redirect(`/signin?next=${encodeURIComponent(`/authorize?${query}`)}`);
        }
        if (method === "GET") return consentPage(checked.client, account, params);
        const code = await issueCode(db, { client: checked.client, account, challenge: params.code_challenge, nonce: params.nonce || null, now: now() });
        return backTo(checked.client, { code, state: params.state });
      }
      if (url.pathname === "/token" && method === "POST") {
        if (form!.get("grant_type") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
        const redeemed = await redeemCode(db, {
          code: form!.get("code") ?? "", clientId: form!.get("client_id") ?? "",
          redirectUri: form!.get("redirect_uri") ?? "", verifier: form!.get("code_verifier") ?? "", now: now(),
        });
        if ("error" in redeemed) return json({ error: redeemed.error }, 400);
        const { account, nonce } = redeemed;
        const idToken = await signer.sign(
          { sub: account.id, email: account.email, email_verified: false, name: account.name, ...(nonce ? { nonce } : {}) },
          form!.get("client_id")!, now());
        return json({ id_token: idToken, token_type: "Bearer", expires_in: 300 });
      }

      if (url.pathname === "/" && method === "GET") {
        const account = await currentAccount(request);
        if (!account) return redirect("/signin");
        return page("Your Colonie account", `<p>Signed in as <strong>${escape(account.name)}</strong> (${escape(account.email)}).</p>
<form method="post" action="/signout"><button type="submit" class="quiet">Sign out</button></form>`);
      }

      return page("Not found", "<p>There is nothing here.</p>", 404);
    },
  };
}
