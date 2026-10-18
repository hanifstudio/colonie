// Finding a CLI binary and asking whether a path actually runs — the two
// questions the Engines picker asks before a save happens.
//
// `GET /api/cli-candidates` lists every `claude` (or `codex`, …) the app's
// augmented PATH reaches, in PATH order, so a just-installed CLI shows up
// without a restart. `POST /api/cli-test` spawns `<cli> --version` with the
// same environment a real turn gets: a miss here (typo, missing exec bit, a
// binary the GUI app cannot see) means every turn would fail, so the UI asks
// before registering a dead engine.
//
// The probe executes a local binary, so it is gated the same way the local-VM
// lifecycle routes are: a hostile page must not be able to submit it as a
// plain text/plain cross-origin request. Its environment carries PATH and
// nothing else — a wrapper chosen in Settings must never inherit the
// credentials this process holds.
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { augmentedPath, findCliCandidates, resetPathCache } from "../runtime/env-path.ts";
import { describeSpawnFailure, execCli } from "../runtime/procs.ts";
import { PROVIDER_CREDENTIAL_ENV, stripWorkspaceCredentialEnv } from "../config.ts";
import { PASS, type RouteHandler } from "./table.ts";

type Driver = (typeof BUILT_IN_DRIVERS)[number];

/** Pre-save probe for a CLI path override: run `<cli> --version` with the
 * same environment a real turn gets (augmented PATH). Returns ok + the
 * version line, or a fail the UI can act on — ENOENT on a GUI-launched app
 * usually means "not on the app's PATH", the exact mistake this catches
 * before the override is saved. */
async function testCliBinary(
  cli: string,
  driver: Driver | undefined,
): Promise<{ ok: boolean; version?: string; message?: string; install?: Driver["install"] }> {
  return new Promise((resolve) => {
    execCli(
      cli,
      ["--version"],
      {
        timeout: 10_000,
        // SIGKILL, not SIGTERM: a child that traps TERM (sh -c "trap '' TERM;
        // sleep 99999") would otherwise never fire the callback and pin the
        // HTTP socket forever. maxBuffer bounds a chatty --version too.
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 64,
        env: cliProbeEnvironment(),
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          // err.code is an errno CONSTANT ("ENOENT", "EACCES") only for spawn
          // failures; for a non-zero exit it's the exit STATUS (a number) and
          // for a timeout it's null + killed:true — describeSpawnFailure words
          // only the first kind
          const exceededBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const isSpawnError = typeof e.code === "string" && !exceededBuffer;
          const message = exceededBuffer
            ? "CLI test produced more than 64 KiB of output"
            : isSpawnError
              ? describeSpawnFailure(e, cli).message
              : e.killed
              ? "CLI test timed out after 10s"
                : `CLI exited with error ${String(e.code)}: ${(stderrOf(err) || "").slice(0, 200) || err.message.split("\n")[0]}`;
          resolve({ ok: false, message, ...(driver?.install && isSpawnError ? { install: driver.install } : {}) });
          return;
        }
        resolve({ ok: true, version: stdout.trim().split("\n")[0] });
      },
    );
  });
}

/** A pre-save probe only needs PATH. Never hand credentials inherited by the
 * desktop/server process to an arbitrary wrapper selected through Settings.
 * The shared lists (config.ts) cover every workspace, control-plane and
 * provider credential, including ones added later; the probe and `claude
 * update` keep everything else (HOME, proxy settings, CA bundles). */
function cliProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  return env;
}

/** execFile's error carries the child's stderr in .stderr. */
function stderrOf(err: unknown): string {
  const s = (err as { stderr?: unknown }).stderr;
  return typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : "";
}

export const cliProbeRoutes: RouteHandler = async ({ req, res, url, path, method, json, readBody }) => {
  if (method === "GET" && path === "/api/cli-candidates") {
    const name = url.searchParams.get("name") ?? "";
    resetPathCache();
    return json(res, 200, { candidates: findCliCandidates(name) });
  }

  if (method === "POST" && path === "/api/cli-test") {
    // same gate as the local-VM lifecycle routes: this executes a local
    // binary, so a hostile page must not be able to submit it as a simple
    // text/plain cross-origin request
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const body = await readBody(req);
    const cli = typeof body?.cli === "string" ? body.cli.trim() : "";
    if (!cli || /[\n\r]/.test(cli)) return json(res, 400, { error: "cli must be a non-empty path" });
    const driver = typeof body?.driver === "string" ? BUILT_IN_DRIVERS.find((d) => d.driverKind === body.driver) : undefined;
    // Probe the exact configured wrapper plus --version. testCliBinary uses
    // a credential-redacted environment, so fixed wrapper arguments cannot
    // turn this endpoint into an inherited-secret reader.
    const probe = await testCliBinary(cli, driver);
    return json(res, 200, probe);
  }

  return PASS;
};