// The platform application factory. The host mounts this in front of (or
// beside) the legacy server: `handle` answers auth and platform requests and
// returns false for anything else so the host can fall through.
//
// Production wires a PostgreSQL repository (auth migrations run separately with
// the same pool) and the Better Auth adapter; tests wire the in-memory fixture
// and a fake runtime. Both share the same service, so authorization is never
// bypassed by a test-only path.
import type { IncomingMessage, ServerResponse } from "node:http";
import { PLATFORM_AUTH_BASE } from "../../../shared/colonie-platform.ts";
import { json } from "../../harness/http.ts";
import type { PlatformAuth, PlatformRepository } from "./contracts.ts";
import { createPlatformRoutes } from "./routes.ts";
import type { PlatformServiceConfig } from "./service.ts";
import { PlatformService } from "./service.ts";

export interface PlatformApp {
  /** True when this request was handled; false means "not mine, fall through". */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  service: PlatformService;
  auth: PlatformAuth;
  repository: PlatformRepository;
  /** Close the repository (and its pool, in production). */
  close(): Promise<void>;
}

export function createPlatformApp(config: PlatformServiceConfig): PlatformApp {
  const service = new PlatformService(config);
  const routes = createPlatformRoutes(service, config.auth);
  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith(PLATFORM_AUTH_BASE)) {
        const handled = await config.auth.handle(req, res);
        if (!handled && !res.headersSent && !res.writableEnded) {
          json(res, 404, { error: "No such endpoint.", code: "not_found" });
        }
        return true;
      }
      return routes(req, res);
    },
    service,
    auth: config.auth,
    repository: config.repository,
    async close() {
      // End live streams first: a subscriber that reacts to close must not
      // query a repository whose pool is already shut.
      service.hub.closeAll();
      await config.repository.close();
    },
  };
}
