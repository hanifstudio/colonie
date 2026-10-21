// A Colonie Cloud for tests: the real app on an in-process Postgres (PGlite).
import { PGlite } from "@electric-sql/pglite";

import { createApp } from "../src/app.ts";
import { migrate, type Db } from "../src/db.ts";
import { createSigner, generateSigningJwk } from "../src/oauth.ts";

export const ORIGIN = "https://cloud.test";

export async function testDb(): Promise<Db & { close(): Promise<void> }> {
  const pg = new PGlite();
  const db = {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

export async function testCloud(options: { now?: () => Date } = {}) {
  const db = await testDb();
  const signer = await createSigner(await generateSigningJwk("test-key"), ORIGIN);
  const app = createApp({ db, issuer: ORIGIN, signer, ...options });
  /** A browser-ish request: form posts carry this site's Origin, and the
   * session cookie is sent when given. */
  async function request(path: string, init: { method?: string; form?: Record<string, string>; json?: unknown; cookie?: string; origin?: string } = {}) {
    const headers: Record<string, string> = {};
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      // a browser form carries its page's origin; a server-to-server call none
      if (init.origin !== "") headers.origin = init.origin ?? ORIGIN;
    }
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (init.cookie) headers.cookie = init.cookie;
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.form || init.json !== undefined ? "POST" : "GET"),
      headers,
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    }));
    return { response, text: await response.text() };
  }
  /** The `name=value` pair of the session cookie a response sets, if any. */
  const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0];
  return { db, app, signer, request, cookieFrom };
}
