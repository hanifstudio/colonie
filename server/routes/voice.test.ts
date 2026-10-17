import { expect, test } from "vitest";
import { PASS, type RouteContext } from "./table.ts";
import { createVoiceRoutes } from "./voice.ts";

/** The smallest RouteContext that can answer: json records, readBody returns
 * the given body, and nothing else is touched by this module. */
function call(path: string, method: string, body: unknown = {}) {
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = { headersSent: false, writableEnded: false, writeHead: () => {}, end: () => {} };
  const ctx = {
    req: {},
    res,
    url: new URL(`http://127.0.0.1${path}`),
    path,
    method,
    auth: {},
    json: async (_res: unknown, status: number, payload: unknown) => {
      sent.push({ status, body: payload });
    },
    readBody: async () => body,
  } as unknown as RouteContext;
  return { ctx, sent };
}

test("declines paths and methods that are not its own", async () => {
  const routes = createVoiceRoutes({ cfg: {} as never });

  expect(await routes(call("/api/bots", "GET").ctx)).toBe(PASS);
  expect(await routes(call("/api/tts/speak", "GET").ctx)).toBe(PASS);
  expect(await routes(call("/api/tts/unknown", "POST").ctx)).toBe(PASS);
});

test("prepare answers 200 with utterances that keep the text intact", async () => {
  const routes = createVoiceRoutes({ cfg: {} as never });
  const { ctx, sent } = call("/api/tts/prepare", "POST", { text: "first one. second one?" });

  await routes(ctx);

  expect(sent[0]?.status).toBe(200);
  const { utterances } = (sent[0]?.body ?? { utterances: [] }) as { utterances: string[] };
  expect(Array.isArray(utterances)).toBe(true);
  expect(utterances.join(" ")).toBe("first one. second one?");
});