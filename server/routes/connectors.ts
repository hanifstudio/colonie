// Connectors (Composio): the catalog, which services are connected, the
// grantable tool inventory, per-service status, and authorize/remove actions.
//
// Every answer carries `credentialStore` when it can: an unreadable store
// means we do not KNOW what is connected, which is not the same as knowing
// nothing is. A read-only failure here (the tools inventory) degrades the
// grant editor, never a save — the exact-name grant model does not depend on
// the listing being reachable.
import type { loadConfig } from "../config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ConnectorRouteDeps {
  cfg: ReturnType<typeof loadConfig>;
  composio: typeof import("../composio.ts");
}

export function createConnectorRoutes(deps: ConnectorRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source, pagination } = await deps.composio.listToolkits(deps.cfg);
      return json(res, 200, {
        configured: deps.composio.configured(deps.cfg),
        mode: deps.composio.connectionMode(deps.cfg),
        // lets the panel say "add a key" on a fresh server instead of
        // reporting an outage that never happened
        setup: deps.composio.connectorSetup(deps.cfg),
        source,
        cards,
        ...(pagination ? { pagination } : {}),
      });
    }
    if (method === "GET" && path === "/api/connectors/connected") {
      const availability = deps.composio.connectorAvailability(deps.cfg);
      if (availability !== "configured") {
        return json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
      }
      return json(res, 200, {
        configured: true,
        credentialStore: "ok",
        services: await deps.composio.connectedServices(deps.cfg),
      });
    }
    if (method === "GET" && path === "/api/connectors/tools") {
      // The grant editor's inventory: every grantable tool name grouped by
      // service, read from the same MCP endpoint a mounted bot relays through.
      const availability = deps.composio.connectorAvailability(deps.cfg);
      if (availability !== "configured") {
        return json(res, 200, { configured: false, services: {} });
      }
      try {
        return json(res, 200, { configured: true, services: await deps.composio.listConnectorTools(deps.cfg) });
      } catch (e) {
        return json(res, 502, { configured: true, services: {}, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      const availability = deps.composio.connectorAvailability(deps.cfg);
      if (availability !== "configured") {
        return json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
      }
      const status = await deps.composio.connectionStatus(deps.cfg, services.length ? services : deps.composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    const authorize = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (authorize && method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await deps.composio.authorizeService(deps.cfg, authorize[1], body.alias));
    }
    const account = path.match(/^\/api\/connectors\/([\w-]+)\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
    if (account && method === "DELETE") {
      return json(res, 200, await deps.composio.removeAccount(deps.cfg, account[1], account[2]));
    }
    const service = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (service && method === "DELETE") return json(res, 200, await deps.composio.removeService(deps.cfg, service[1]));
    return PASS;
  };
}