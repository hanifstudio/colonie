// Isolated fixture stand-in for a Local workspace's server child
// (electron/colonie-workspaces.node-test.mjs). It answers the identity probe
// the way the real server answers /api/health, and it never touches a real data
// directory: the caller passes a tmpdir on an ephemeral loopback port.
//
// COLONIE_FIXTURE_MODE:
//   "serve"   (default) answer /api/health for this pid
//   "exit"    exit immediately, before listening
//   "foreign" answer with somebody else's pid
//   "hang"    listen but never answer
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.COLONIE_FIXTURE_MODE ?? "serve";
const port = Number(process.env.OMB_PORT);
const root = process.env.OMB_DATA_DIR;

if (mode === "exit") process.exit(3);

if (root) {
  writeFileSync(join(root, "fixture-started"), `${process.pid}\n`, { mode: 0o600 });
  // What the parent actually handed this child: the test's evidence, never a
  // real credential value.
  writeFileSync(join(root, "fixture-env"), `${JSON.stringify({
    dataDir: process.env.OMB_DATA_DIR,
    profile: process.env.COLONIE_PROFILE,
    desktopParent: process.env.OMB_DESKTOP_PARENT,
    hasXai: process.env.XAI_API_KEY ?? null,
    hasComposio: process.env.COMPOSIO_API_KEY ?? null,
  })}\n`, { mode: 0o600 });
}
process.on("SIGTERM", () => process.exit(0));
// Only a forked child has this channel; it records what the parent delivered.
process.on("message", (message) => {
  if (root) writeFileSync(join(root, "fixture-message"), `${JSON.stringify(message)}\n`, { mode: 0o600 });
});

const server = createServer((req, res) => {
  if (mode === "hang") return;
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      app: "openmausbot",
      pid: mode === "foreign" ? 1 : process.pid,
      static: true,
    }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fixture listening ${port}\n`);
});
