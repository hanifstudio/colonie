import { expect, test } from "vitest";
import { linkNamedFiles } from "./name-files.ts";

const files = ["budget.md", "reports/q3.pdf", "notes/budget.md", "shot.png"];

test("a plain or backticked mention of a listed file becomes a link, once", () => {
  expect(linkNamedFiles("I saved it in shot.png and again shot.png.", files)).toBe("I saved it in [shot.png](shot.png) and again shot.png.");
  expect(linkNamedFiles("See `shot.png` now", files)).toBe("See [shot.png](shot.png) now");
});

test("a folder path is linked by its full path; a bare name two files share is left alone", () => {
  expect(linkNamedFiles("The numbers are in reports/q3.pdf.", files)).toBe("The numbers are in [reports/q3.pdf](reports/q3.pdf).");
  expect(linkNamedFiles("Edit budget.md please", files)).toBe("Edit budget.md please");
  expect(linkNamedFiles("Edit notes/budget.md please", files)).toBe("Edit [notes/budget.md](notes/budget.md) please");
  expect(linkNamedFiles("the q3.pdf one", files)).toBe("the [q3.pdf](reports/q3.pdf) one");
});

test("a name that is not a listed file, or part of a longer name, is never touched", () => {
  expect(linkNamedFiles("Open other.md and old-shot.png and shot.png.bak", files)).toBe("Open other.md and old-shot.png and shot.png.bak");
});

test("existing links, urls, and code fences are left as they are", () => {
  expect(linkNamedFiles("[shot.png](shot.png) is ready", files)).toBe("[shot.png](shot.png) is ready");
  expect(linkNamedFiles("Look at [the picture](shot.png)", files)).toBe("Look at [the picture](shot.png)");
  expect(linkNamedFiles("https://x.com/shot.png", files)).toBe("https://x.com/shot.png");
  expect(linkNamedFiles("```\ncat shot.png\n```\nDone with shot.png", files)).toBe("```\ncat shot.png\n```\nDone with [shot.png](shot.png)");
});

test("no files, no text: nothing changes", () => {
  expect(linkNamedFiles("shot.png", [])).toBe("shot.png");
  expect(linkNamedFiles("", files)).toBe("");
});
