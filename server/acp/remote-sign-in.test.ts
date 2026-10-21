// Signing an engine in from a browser on another computer: the flow around
// the engine's own CLI, driven against small stand-in CLIs that print what the
// real ones print and behave the same way on stdin and exit.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { claudeSignInUrl, createRemoteSignIn } from "./remote-sign-in.ts";

const dir = mkdtempSync(join(tmpdir(), "colonie-remote-sign-in-"));
function script(name: string, body: string) {
  const file = join(dir, name);
  writeFileSync(file, body);
  return () => spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] });
}

// Codex: page and code, then success once approved (here, after a moment).
const codexApproves = script("codex.mjs", `
process.stderr.write("Follow these steps to sign in with ChatGPT using device code authorization:\\n");
process.stderr.write("1. Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n");
process.stderr.write("2. Enter this one-time code (expires in 15 minutes)\\n   ABCD-12345\\n");
setTimeout(() => { process.stderr.write("Successfully logged in\\n"); process.exit(0); }, 300);
`);
// Claude: a page, then a pasted code on stdin; only "good#state" works.
const claudePaste = script("claude.mjs", `
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\\n");
process.stdout.write("Paste code here if prompted > ");
process.stdin.once("data", (data) => {
  if (String(data).trim() === "good#state") { process.stdout.write("Login successful.\\n"); process.exit(0); }
  process.stdout.write("OAuth error\\n"); process.exit(1);
});
`);
const silent = script("silent.mjs", `setTimeout(() => process.exit(3), 100);`);
const waitFor = async (check: () => Promise<boolean>) => {
  const until = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("Codex: the person sees OpenAI's page and the code, and the flow finishes when they approve", async () => {
  const signIn = createRemoteSignIn({ kind: "device-code", spawn: codexApproves });
  const started = await signIn.start();
  expect(started).toMatchObject({ phase: "waiting", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" });
  await waitFor(async () => (await signIn.status(started.flowId!)).phase === "succeeded");
});

test("Claude: the person opens Anthropic's page and pastes the code back", async () => {
  const signIn = createRemoteSignIn({ kind: "paste-code", spawn: claudePaste });
  const started = await signIn.start();
  expect(started.authorizationUrl).toBe("https://claude.com/cai/oauth/authorize?code=true&state=abc");
  expect(started.userCode).toBeUndefined();
  await signIn.complete(started.flowId!, "  good#state  ");
  expect((await signIn.status(started.flowId!)).phase).toBe("succeeded");
});

test("Claude: a wrong code is refused and the flow has to start again", async () => {
  const signIn = createRemoteSignIn({ kind: "paste-code", spawn: claudePaste });
  const started = await signIn.start();
  await expect(signIn.complete(started.flowId!, "wrong#code")).rejects.toMatchObject({ status: 400 });
  expect((await signIn.status(started.flowId!)).phase).toBe("failed");
  await expect(signIn.complete(started.flowId!, "good#state")).rejects.toMatchObject({ status: 404 });
});

test("a code with spaces in it, or an old flow id, is refused without touching the CLI", async () => {
  const signIn = createRemoteSignIn({ kind: "paste-code", spawn: claudePaste });
  const started = await signIn.start();
  await expect(signIn.complete(started.flowId!, "two words")).rejects.toMatchObject({ status: 400 });
  await expect(signIn.complete("old-flow", "good#state")).rejects.toMatchObject({ status: 404 });
  await signIn.cancel();
});

test("an engine that offers no page is reported, not left waiting", async () => {
  const signIn = createRemoteSignIn({ kind: "device-code", spawn: silent });
  await expect(signIn.start()).rejects.toMatchObject({ status: 409 });
});

test("a flow expires after fifteen minutes", async () => {
  let clock = 1_000_000;
  const signIn = createRemoteSignIn({ kind: "paste-code", spawn: claudePaste, now: () => clock });
  const started = await signIn.start();
  clock += 15 * 60_000;
  expect((await signIn.status(started.flowId!)).phase).toBe("expired");
});

test("only Anthropic's own pages become links", () => {
  expect(claudeSignInUrl("visit: https://claude.ai/oauth/authorize?x=1 now")).toBe("https://claude.ai/oauth/authorize?x=1");
  expect(claudeSignInUrl("visit: https://evil.example/claude.ai")).toBeNull();
  expect(claudeSignInUrl("visit: https://user:pw@claude.ai/x")).toBeNull();
  expect(claudeSignInUrl("visit: http://claude.ai/x")).toBeNull();
});
