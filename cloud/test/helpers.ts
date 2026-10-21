// A Colonie Cloud for tests: the real app on an in-process Postgres (PGlite).
import { PGlite } from "@electric-sql/pglite";

import { createApp } from "../src/app.ts";
import { migrate, type Db } from "../src/db.ts";

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

export async function testCloud() {
  const db = await testDb();
  const app = createApp({ db });
  /** A browser-ish request: form posts carry this site's Origin, and the
   * session cookie is sent when given. */
  async function request(path: string, init: { method?: string; form?: Record<string, string>; cookie?: string; origin?: string } = {}) {
    const headers: Record<string, string> = {};
    if (init.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers.origin = init.origin ?? ORIGIN;
    }
    if (init.cookie) headers.cookie = init.cookie;
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.form ? "POST" : "GET"),
      headers,
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    }));
    return { response, text: await response.text() };
  }
  /** The `name=value` pair of the session cookie a response sets, if any. */
  const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0];
  return { db, app, request, cookieFrom };
}
