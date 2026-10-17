import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createVoiceRoutes } from "./voice.ts";
import { callRoute } from "../testing/route-context.ts";

test("declines paths and methods that are not its own", async () => {
  const routes = createVoiceRoutes({ cfg: {} as never });

  expect(await routes(callRoute("/api/bots", "GET").ctx)).toBe(PASS);
  expect(await routes(callRoute("/api/tts/speak", "GET").ctx)).toBe(PASS);
  expect(await routes(callRoute("/api/tts/unknown", "POST").ctx)).toBe(PASS);
});

test("prepare answers 200 with utterances that keep the text intact", async () => {
  const routes = createVoiceRoutes({ cfg: {} as never });
  const { ctx, sent } = callRoute("/api/tts/prepare", "POST", { text: "first one. second one?" });

  await routes(ctx);

  expect(sent[0]?.status).toBe(200);
  const { utterances } = (sent[0]?.body ?? { utterances: [] }) as { utterances: string[] };
  expect(Array.isArray(utterances)).toBe(true);
  expect(utterances.join(" ")).toBe("first one. second one?");
});