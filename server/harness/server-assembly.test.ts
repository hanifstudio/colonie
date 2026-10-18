// Static serving is public, so the path a request turns into a file on disk is
// the boundary: a request must never climb out of the built UI's root.
import { expect, test } from "vitest";
import { staticRelativePath } from "./server-assembly.ts";

test("the root serves the SPA entry", () => {
  expect(staticRelativePath("/")).toBe("/index.html");
});

test("traversal segments are stripped before the path is joined", () => {
  expect(staticRelativePath("/../../etc/passwd")).toBe("///etc/passwd");
  expect(staticRelativePath("/a/../b")).toBe("/a//b");
  expect(staticRelativePath("/assets/app.js")).toBe("/assets/app.js");
});