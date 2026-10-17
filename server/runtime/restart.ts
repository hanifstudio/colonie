// "Start me again": the one exit code a server uses to ask its launcher for
// a fresh start. Nothing asks for one since Copy this computer here went;
// ponytail: the contract stays because every launcher below still honours it
// and the desktop supervisor has its own rule. Delete it, the launchers that
// read it (cli.ts, server-launcher.ts, cloud-home-start.ts) and their tests
// together when a local-only app has no second server to be started for.
// Every launcher in this repo honours it through one restartPolicy:
//
//   - `colonie serve` (cli.ts serveUntilStopped), which systemd, launchd,
//     fleet and a terminal all run;
//   - the container image's launcher (server-launcher.ts);
//   - the COLONIE Cloud home's launcher (cloud-home-start.ts);
//   - the desktop app's supervisor, which starts its server again after any
//     exit (electron/server-supervisor.mjs).
//
// Anything else that runs `node dist-server/index.js` directly stays down;
// the committed restore installs at its next start.
export const RESTART_EXIT_CODE = 75;
/** Restarts in a row before a launcher gives up: a loop, not a restore. */
export const MAX_RESTARTS = 5;
/** A run that stayed up this long was not part of a loop. */
export const STABLE_RUN_MS = 60_000;

/** One launcher's restart rule, counting included: create it as the server
 * first starts, and ask `again` each time the server exits. It answers true
 * only when the server asked to start again (RESTART_EXIT_CODE), the launcher
 * is not stopping, and that has not happened MAX_RESTARTS times in a row (a
 * run that stayed up STABLE_RUN_MS starts the count again). True means the
 * launcher starts the server now: that run is timed from this answer. */
export function restartPolicy(now: () => number = Date.now) {
  let restarts = 0, startedAt = now();
  return {
    again(code: number | null, stopping = false): boolean {
      if (now() - startedAt >= STABLE_RUN_MS) restarts = 0;
      if (stopping || code !== RESTART_EXIT_CODE || restarts >= MAX_RESTARTS) return false;
      restarts++;
      startedAt = now();
      return true;
    },
  };
}
