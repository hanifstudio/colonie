// A person's secrets: encrypted at rest, theirs alone, given only to the bots
// they allow, in a private file for a request, and masked wherever they
// would be written down.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { redactSecretsInText } from "../../../shared/redact.ts";
import { createSecrets, envLine } from "./secrets.ts";

const VALUE = "abcd efgh ijkl mnop";

test("a secret is saved encrypted, listed without its value, and reaches only the bots allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "colonie-secrets-"));
  const secrets = createSecrets({ dir });
  const saved = secrets.put("ana", { name: "gmail_app_password", value: VALUE, description: "Gmail", botId: "b1" });
  expect(saved).toMatchObject({ name: "GMAIL_APP_PASSWORD", bots: ["b1"] });
  expect(JSON.stringify(saved)).not.toContain(VALUE);
  expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain(VALUE);
  expect(statSync(join(dir, "secrets.json")).mode & 0o777).toBe(0o600);

  expect(secrets.namesFor("ana", "b1")).toEqual(["GMAIL_APP_PASSWORD"]);
  expect(secrets.namesFor("ana", "b2")).toEqual([]);
  // another person's request never gets Ana's secret
  expect(secrets.namesFor("bob", "b1")).toEqual([]);
  expect(secrets.prepare("bob", "b1", "t1")).toBeNull();

  const prepared = secrets.prepare("ana", "b1", "t1")!;
  expect(prepared.names).toEqual(["GMAIL_APP_PASSWORD"]);
  expect(readFileSync(prepared.file, "utf8")).toBe(`${envLine("GMAIL_APP_PASSWORD", VALUE)}\n`);
  expect(statSync(prepared.file).mode & 0o777).toBe(0o600);
  expect(prepared.file.startsWith(join(dir, "runtime"))).toBe(true);

  // a restart reads it back with the same key
  expect(createSecrets({ dir }).prepare("ana", "b1", "t2")?.names).toEqual(["GMAIL_APP_PASSWORD"]);

  secrets.setBots("ana", "GMAIL_APP_PASSWORD", []);
  expect(secrets.prepare("ana", "b1", "t1")).toBeNull();
  expect(secrets.remove("ana", "GMAIL_APP_PASSWORD")).toBe(true);
  expect(secrets.list("ana")).toEqual([]);
});

test("a saved value is masked in anything written down, and names must be environment names", () => {
  const secrets = createSecrets({ dir: mkdtempSync(join(tmpdir(), "colonie-secrets-")) });
  secrets.put("ana", { name: "SERVICE_TOKEN", value: "plain-looking-value-123", bots: ["b1"] });
  expect(redactSecretsInText("the token is plain-looking-value-123, ok")).not.toContain("plain-looking-value-123");
  expect(() => secrets.put("ana", { name: "1BAD NAME", value: "x" })).toThrow(/capital letters/);
  expect(() => secrets.put("ana", { name: "EMPTY", value: "  " })).toThrow(/value/);
  // a value with quotes stays one shell word
  expect(envLine("A_B", "it's")).toBe("A_B='it'\\''s'");
});
