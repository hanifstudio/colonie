// Signing an engine in on a server, from a browser on another computer.
//
// The engines' usual sign-in sends the browser back to localhost, which on a
// server is the wrong machine. Both have a way that needs no such return:
// Codex prints a page and a one-time code (`login --device-auth`), and Claude
// prints a page and then waits for the code that page shows to be pasted back
// (`auth login`, which reads it from stdin). This runs that command in the
// engine's own environment (its own CODEX_HOME / CLAUDE_CONFIG_DIR), shows the
// person the page (and code), and for Claude feeds the pasted code in. Only
// the provider's own pages ever become links; nothing else of the output is
// passed on.
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { deviceSignInPrompt } from "../../shared/device-sign-in.ts";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";

export type RemoteSignInKind = "device-code" | "paste-code";

const FLOW_MS = 15 * 60_000;
const PROMPT_WAIT_MS = 30_000;
const CODE_WAIT_MS = 60_000;
const CLAUDE_HOSTS = ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"];

/** Anthropic's sign-in page in the CLI's output, over https on its own hosts. */
export function claudeSignInUrl(text: string): string | null {
  for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(match[0]);
      const host = url.hostname.toLowerCase();
      if (!url.username && !url.password && CLAUDE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return url.href;
    } catch { /* not a URL */ }
  }
  return null;
}

const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

interface Flow {
  id: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  authorizationUrl: string;
  userCode?: string;
  expiresAt: number;
  exit: Promise<number | null>;
  exitCode: number | null | undefined;
  submitted: boolean;
}

export function createRemoteSignIn(input: { kind: RemoteSignInKind; spawn: () => ChildProcessWithoutNullStreams; now?: () => number }) {
  const now = input.now ?? Date.now;
  let flow: Flow | null = null;

  const stop = (current: Flow) => { if (current.exitCode === undefined) current.child.kill("SIGTERM"); };
  const prompt = (text: string) => {
    if (input.kind === "device-code") return deviceSignInPrompt("codex", text);
    const url = claudeSignInUrl(text);
    return url ? { authorizationUrl: url } : null;
  };

  function phaseOf(current: Flow): ProviderAuthenticationStatus["phase"] {
    if (current.exitCode === 0) return "succeeded";
    if (current.exitCode !== undefined) return "failed";
    if (now() >= current.expiresAt) { stop(current); return "expired"; }
    return "waiting";
  }

  return {
    async start(): Promise<ProviderAuthenticationStart> {
      if (flow) stop(flow);
      const child = input.spawn();
      let output = "";
      let resolveExit!: (code: number | null) => void;
      const exit = new Promise<number | null>((resolve) => { resolveExit = resolve; });
      const current: Partial<Flow> & { exitCode: number | null | undefined } = { exitCode: undefined };
      child.on("exit", (code) => { current.exitCode = code; resolveExit(code); });
      child.on("error", () => { current.exitCode = -1; resolveExit(-1); });
      const found = await new Promise<{ authorizationUrl: string; userCode?: string } | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), PROMPT_WAIT_MS);
        const read = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-16_000);
          const seen = prompt(output);
          if (seen) { clearTimeout(timer); resolve(seen); }
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        void exit.then(() => { clearTimeout(timer); resolve(prompt(output)); });
      });
      if (!found || current.exitCode !== undefined && current.exitCode !== 0) {
        child.kill("SIGTERM");
        throw failure("The engine did not offer a sign-in page. Try again in a moment.", 409);
      }
      flow = Object.assign(current, {
        id: randomUUID(), child, output, ...found, expiresAt: now() + FLOW_MS, exit, submitted: false,
      }) as Flow;
      return {
        phase: "waiting", flowId: flow.id, authorizationUrl: flow.authorizationUrl,
        expiresAt: new Date(flow.expiresAt).toISOString(), ...(flow.userCode ? { userCode: flow.userCode } : {}),
      };
    },

    async status(flowId: string): Promise<ProviderAuthenticationStatus> {
      if (!flow || flow.id !== flowId) throw failure("This sign-in is no longer active. Start again.", 404);
      const phase = phaseOf(flow);
      return {
        phase, flowId: flow.id, authorizationUrl: flow.authorizationUrl, expiresAt: new Date(flow.expiresAt).toISOString(),
        ...(flow.userCode ? { userCode: flow.userCode } : {}),
        ...(phase === "failed" ? { message: "The sign-in did not finish. Start again." } : {}),
      };
    },

    /** Claude only: hand the CLI the code the sign-in page showed. */
    async complete(flowId: string, code: string): Promise<void> {
      if (!flow || flow.id !== flowId || phaseOf(flow) !== "waiting") throw failure("This sign-in is no longer active. Start again.", 404);
      const value = code.trim();
      if (!value || value.length > 2_000 || /\s/.test(value)) throw failure("Paste the code exactly as the sign-in page shows it.", 400);
      if (flow.submitted) throw failure("A code was already sent for this sign-in. Start again.", 409);
      flow.submitted = true;
      flow.child.stdin.write(`${value}\n`);
      const code_ = await Promise.race([flow.exit, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), CODE_WAIT_MS))]);
      if (code_ === "timeout") { stop(flow); throw failure("The engine did not confirm the code in time. Start again.", 409); }
      if (code_ !== 0) throw failure("That code was not accepted. Start again and paste the newest code.", 400);
    },

    async cancel(): Promise<void> {
      if (flow) stop(flow);
      flow = null;
    },
  };
}
