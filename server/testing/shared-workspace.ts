// A throwaway Shared workspace with signed-in people, for privacy tests.
//
// Boots the real server (server/index.ts) in its own HOME, data folder and
// port, with the deterministic ACP agent as its engine. Each person gets an
// email session written into the workspace's session file before boot, and is
// listed in the sign-in config, which also makes the workspace Shared. Requests
// carry the person's bearer token, exactly as a signed-in client would.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allowedScopes, parseAllowList } from "../colonie/providers/account-signin.ts";
import { SessionRegistry } from "../sessions.ts";
import { childEnv } from "./colonie-env.ts";
import { removeTempDir, waitForExit } from "./cleanup.ts";
import { freePortBlock } from "./ports.ts";

export interface SharedPerson { email: string; admin?: boolean }

export interface LiveStream {
  /** Everything received so far. */
  text(): string;
  /** The cursor from the stream's hello frame. */
  cursor(): string | undefined;
  close(): void;
}

export interface SharedWorkspace {
  url: string;
  dataDir: string;
  /** A fetch as this person (by email). JSON bodies are encoded. */
  as(email: string, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  /** Open the live event stream as this person; `since` resumes from a cursor. */
  stream(email: string, since?: string): Promise<LiveStream>;
  /** The server log so far, for a failing assertion's message. */
  log(): string;
  stop(): Promise<void>;
}

const ROOT = join(import.meta.dirname, "..", "..");

export async function startSharedWorkspace(people: SharedPerson[], extraConfig: Record<string, unknown> = {}): Promise<SharedWorkspace> {
  const home = mkdtempSync(join(tmpdir(), "colonie-shared-home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "colonie-shared-data-"));
  const admins = people.filter((person) => person.admin).map((person) => person.email);
  const members = people.filter((person) => !person.admin).map((person) => person.email);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    signIn: { admins, members },
    instances: {
      "codex-acp": {
        driver: "codex-acp", displayName: "Codex · ACP",
        config: { cli: process.execPath, args: ["--experimental-strip-types", join(ROOT, "server", "acp", "testing", "fake-agent.ts")] },
        environment: { COLONIE_FAKE_STATE: join(dataDir, "fake-state.json") },
      },
    },
    defaultModelSelection: { instanceId: "codex-acp", model: "agent-default" },
    ...extraConfig,
  }));

  const membership = { admins: parseAllowList(admins.join(",")), members: parseAllowList(members.join(",")) };
  const registry = new SessionRegistry({ file: join(dataDir, "sessions.json"), emailScopesSnapshot: () => (email) => allowedScopes(email, membership) });
  const tokens = new Map<string, string>();
  for (const person of people) {
    const scopes = allowedScopes(person.email, membership);
    if (!scopes) throw new Error(`${person.email} is not on the sign-in list`);
    tokens.set(person.email, registry.issue({ label: person.email, email: person.email, scopes: [...scopes] }).token);
  }
  registry.close();

  const port = await freePortBlock([0, 1]);
  let output = "";
  const child: ChildProcess = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: childEnv({ HOME: home, COLONIE_PROFILE: "1", COLONIE_DATA_DIR: dataDir, COLONIE_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 10_000);
    }
    await removeTempDir(home);
    await removeTempDir(dataDir);
  };

  const until = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* starting */ }
    if (child.exitCode !== null || Date.now() > until) {
      await stop();
      throw new Error(`The Shared workspace server did not start:\n${output.slice(-3000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    url, dataDir, stop,
    log: () => output,
    async stream(email, since) {
      const token = tokens.get(email);
      if (!token) throw new Error(`no session for ${email}`);
      const abort = new AbortController();
      const response = await fetch(`${url}/api/events${since ? `?since=${encodeURIComponent(since)}` : ""}`, {
        headers: { authorization: `Bearer ${token}` }, signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(`stream refused: ${response.status}`);
      let received = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += decoder.decode(value, { stream: true });
          }
        } catch { /* closed */ }
      })();
      // the hello frame arrives at once; wait for it so callers can rely on it
      const until = Date.now() + 5_000;
      while (!received.includes('"hello"') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        text: () => received,
        cursor: () => /"cursor":"([^"]+)"/.exec(received)?.[1],
        close: () => abort.abort(),
      };
    },
    async as(email, path, init = {}) {
      const token = tokens.get(email);
      if (!token) throw new Error(`no session for ${email}`);
      const response = await fetch(`${url}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body };
    },
  };
}
