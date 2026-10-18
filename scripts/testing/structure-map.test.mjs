import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareMap, evaluateMap, mappedFolders, mentionedFolders } from "../structure/map.mjs";

const ROOT = join(import.meta.dirname, "../..");

describe("the server map", () => {
  it("names every folder under server/ that holds source files", () => {
    const { missing } = evaluateMap(ROOT);
    expect(missing, `add a line for each of these to docs/structure/map.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("names no folder that is not on disk", () => {
    const { unknown } = evaluateMap(ROOT);
    expect(unknown, `remove or fix these names in docs/structure/map.md: ${unknown.join(", ")}`).toEqual([]);
  });

  it("looks at a tree large enough for the rule to mean something", () => {
    // A rule that covers three folders proves nothing. This fails if the walk breaks and
    // starts returning an empty or nearly empty list, which would make the check above pass
    // for the wrong reason.
    const folders = mappedFolders(ROOT);
    expect(folders.length).toBeGreaterThan(20);
    expect(folders).toContain("server/");
    expect(folders).toContain("server/harness/");
    expect(folders).toContain("server/colonie/memory/ledger/");
  });

  it("counts only paths under a known root", () => {
    expect(mentionedFolders("`server/x/` and `node_modules/foo/` and `plain/` and `docs/structure/`")).toEqual(["docs/structure/", "server/x/"]);
  });

  it("reports a folder the map forgot and a name the map invented", () => {
    expect(compareMap(["server/a/", "server/b/"], ["server/a/", "server/gone/"], ROOT)).toEqual({
      missing: ["server/b/"],
      unknown: ["server/gone/"],
    });
  });

  it("accepts a real folder named by the map, even when it holds no source files", () => {
    // docs/ is not a mapped folder; naming a real directory must never be reported as
    // invented, while naming one that is gone must be.
    expect(compareMap([], ["docs/structure/"], ROOT).unknown).toEqual([]);
    expect(compareMap([], ["docs/nonexistent/"], ROOT).unknown).toEqual(["docs/nonexistent/"]);
  });
});
