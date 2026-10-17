import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { SERVER_ROOT, SPAWNED_PROXIES } from "./proxy-paths.ts";

// proxy-paths.ts must stay at the server root, and these two facts are why.
// esbuild inlines modules into an entry bundle (scripts/bundle-server.mjs), so a
// copy living in a nested folder resolves SERVER_ROOT one level too high: every
// spawned proxy then points outside Resources/server, and permission prompting,
// computer use and dweb die on the first turn that needs them while /api/health
// stays perfectly green. That shipped in the 0.1.24 release candidate.
test("SERVER_ROOT is the server directory that holds the entry point", () => {
  expect(basename(SERVER_ROOT)).toBe("server");
  expect(existsSync(join(SERVER_ROOT, "index.ts"))).toBe(true);
});

test("every spawned proxy resolves to a file inside SERVER_ROOT", () => {
  for (const [name, path] of Object.entries(SPAWNED_PROXIES)) {
    expect(path.startsWith(SERVER_ROOT), `${name}: ${path}`).toBe(true);
    expect(existsSync(path), `${name}: ${path}`).toBe(true);
  }
});