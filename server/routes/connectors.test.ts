import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createConnectorRoutes } from "./connectors.ts";
import { callRoute } from "../testing/route-context.ts";

const unconfigured = { connectorAvailability: () => "not_configured" } as never;

test("declines paths and methods that are not its own", async () => {
  const routes = createConnectorRoutes({ cfg: {} as never, composio: unconfigured });

  expect(await routes(callRoute("/api/bots").ctx)).toBe(PASS);
  expect(await routes(callRoute("/api/connectors/connected", "PUT").ctx)).toBe(PASS);
});

test("an unconfigured server says so instead of reporting an outage", async () => {
  const routes = createConnectorRoutes({ cfg: {} as never, composio: unconfigured });

  const { ctx, sent } = callRoute("/api/connectors/connected");
  await routes(ctx);

  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toMatchObject({ configured: false, credentialStore: "ok", services: {} });
});

test("an unreadable credential store is not the same as an empty one", async () => {
  const routes = createConnectorRoutes({
    cfg: {} as never,
    composio: { connectorAvailability: () => "unreadable" } as never,
  });

  const { ctx, sent } = callRoute("/api/connectors/connected");
  await routes(ctx);

  expect(sent[0]?.body).toMatchObject({ configured: false, credentialStore: "unavailable" });
});