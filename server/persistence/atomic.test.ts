import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { writeFileAtomic, writeFileAtomicIfChanged } from "./atomic.ts";

const dir = mkdtempSync(join(tmpdir(), "colonie-atomic-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("writeFileAtomic writes the bytes and leaves no temporary sibling behind", () => {
  const target = join(dir, "bots.json");

  writeFileAtomic(target, '{"a":1}');

  expect(readFileSync(target, "utf8")).toBe('{"a":1}');
  expect(readdirSync(dir)).toEqual(["bots.json"]);
});

test("writeFileAtomicIfChanged writes only when the content differs", () => {
  const target = join(dir, "once.json");

  expect(writeFileAtomicIfChanged(target, "x")).toBe(true);
  expect(writeFileAtomicIfChanged(target, "x")).toBe(false);
  expect(writeFileAtomicIfChanged(target, "y")).toBe(true);

  expect(readFileSync(target, "utf8")).toBe("y");
});