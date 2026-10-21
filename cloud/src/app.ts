// Colonie Cloud's web surface: plain pages for signing up, signing in and out,
// and the signed-in home. A fetch handler, so the same code runs in a
// Cloudflare Worker and in a test.
import { closeSession, createAccount, openSession, sessionAccount, SESSION_DAYS, signIn, signUpProblem, type Account } from "./accounts.ts";
import type { Db } from "./db.ts";

export const SESSION_COOKIE = "__Host-colonie_session";

export interface AppOptions {
  db: Db;
  now?: () => Date;
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Colonie</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f}
label{display:block;margin:.75rem 0 .25rem}input{width:100%;box-sizing:border-box;padding:.5rem;font:inherit}
button{margin-top:1rem;padding:.5rem 1rem;font:inherit}.error{color:#b00020}a{color:inherit}</style></head>
<body><h1>${escape(title)}</h1>${body}</body></html>`;
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
<p>New to Colonie? <a href="/signup${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}">Create an account</a></p>`, status);
}

export function createApp({ db, now = () => new Date() }: AppOptions) {
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
      const form = method === "POST" ? new URLSearchParams(await request.text()) : null;
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
        const account = await signIn(db, email, form!.get("password") ?? "");
        if (!account) return signInPage(next, "That email and password do not match an account.", email, 401);
        return signedIn(account, next);
      }

      if (url.pathname === "/signout" && method === "POST") {
        const token = cookieToken(request);
        if (token) await closeSession(db, token);
        return redirect("/signin", { "set-cookie": clearedCookie });
      }

      if (url.pathname === "/" && method === "GET") {
        const account = await currentAccount(request);
        if (!account) return redirect("/signin");
        return page("Your Colonie account", `<p>Signed in as <strong>${escape(account.name)}</strong> (${escape(account.email)}).</p>
<form method="post" action="/signout"><button type="submit">Sign out</button></form>`);
      }

      return page("Not found", "<p>There is nothing here.</p>", 404);
    },
  };
}
