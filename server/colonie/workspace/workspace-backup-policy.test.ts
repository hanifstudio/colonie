import { expect, test } from "vitest";
import {
  ephemeralWorkspaceTokenPath,
  excludedWorkspaceAuthPath,
  portableWorkspaceConfig,
  restoredWorkspaceConfig,
} from "./workspace-backup-policy.ts";

test("a backup carries the portable sections and never the machine's own", () => {
  const portable = portableWorkspaceConfig({
    profile: { name: "Riaen" },
    budgets: { monthlyUsd: 20 },
    language: "id",
    signIn: { admins: ["riaen"] },
    customDomain: "colonie.example",
    cliStartup: { access: "local" },
    mistral: { key: "sk-live-abc" },
  });

  expect(Object.keys(portable).sort()).toEqual(["budgets", "language", "profile"]);
  // a restored workspace must never redirect an API key kept on this device
  expect(portable).not.toHaveProperty("mistral");
  expect(portable).not.toHaveProperty("signIn");
  expect(portable).not.toHaveProperty("customDomain");
  expect(portable).not.toHaveProperty("cliStartup");
});

test("a configuration that is not an object is refused by name", () => {
  expect(() => portableWorkspaceConfig(["profile"])).toThrow(/Invalid workspace configuration/);
  expect(() => restoredWorkspaceConfig({ profile: {} }, "not-an-object")).toThrow(/Invalid destination/);
});

test("restoring replaces portable sections and keeps everything else on the machine", () => {
  const restored = restoredWorkspaceConfig(
    { profile: { name: "From the backup" }, budgets: { monthlyUsd: 5 } },
    { profile: { name: "This machine" }, signIn: { admins: ["riaen"] }, customDomain: "here.example" },
  );

  expect(restored.profile).toEqual({ name: "From the backup" });
  expect(restored.signIn).toEqual({ admins: ["riaen"] });
  expect(restored.customDomain).toBe("here.example");
});

test("lending this computer stays a decision of the machine, both ways", () => {
  const mine = restoredWorkspaceConfig({ features: { sharedComputers: true } }, { features: {} });
  expect(mine.features).toBeUndefined();

  const theirs = restoredWorkspaceConfig({ features: { sharedComputers: false } }, { features: { sharedComputers: true } });
  expect(theirs.features).toEqual({ sharedComputers: true });
});

test("the paths that must never travel are named exactly, not scanned for", () => {
  for (const path of [
    "command-allowlist.json",
    "command-allowlist.json.1792292875767.9f3a6c2e-1b4d-4c1a-8f2e-5b7c9d0e1f23.tmp",
    "mcp-oauth.json",
    "providers/openai.json",
    "caddy/data.pem",
    "chrome-profile/Default/Cookies",
    ".agent-browser/session",
    "workspace-credentials.json",
    "external-runtimes.json",
    "browser-engine-key",
    "webhooks.json.1792292875767.tmp",
    "vm-home/.browser-profiles/x",
    "vm-homes/abc/.browser-profiles",
  ]) {
    expect(excludedWorkspaceAuthPath(path), path).toBe(true);
  }
});

test("ordinary workspace files are not mistaken for authentication", () => {
  for (const path of ["bots.json", "threads/abc.json", "notes.md", "hook-tokens", "vm-home/notes.txt", "sessions.json"]) {
    expect(excludedWorkspaceAuthPath(path), path).toBe(false);
  }
  // The configuration file is not refused wholesale either: the restore
  // rewrites it from the portable allowlist instead (workspace-backup.ts), and
  // a backup whose config.json holds anything else is rejected.
  expect(excludedWorkspaceAuthPath("config.json")).toBe(false);
  expect(excludedWorkspaceAuthPath("config.json.1792292875767.9f3a6c2e-1b4d-4c1a-8f2e-5b7c9d0e1f23.tmp")).toBe(true);
});

test("per-turn engine hooks are never exported, but an old backup still restores", () => {
  expect(ephemeralWorkspaceTokenPath("hook-tokens/abc.token")).toBe(true);
  expect(ephemeralWorkspaceTokenPath("sessions.json.open")).toBe(true);
  expect(ephemeralWorkspaceTokenPath("sessions.json")).toBe(false);
  // unlike the refused paths above, this one is not on the import side
  expect(excludedWorkspaceAuthPath("hook-tokens/abc.token")).toBe(false);
});