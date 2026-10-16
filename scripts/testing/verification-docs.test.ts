// Documentation checks read repository files only: no application imports,
// servers, providers, browsers, or historical feature-count requirements.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCS = join(ROOT, "docs");
const VERIFICATION = join(DOCS, "verification");

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".md") ? [path] : [];
  }).sort();
}

const documents = [
  join(ROOT, "AGENTS.md"),
  join(ROOT, "README.md"),
  ...["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", ".github/pull_request_template.md"]
    .map((path) => join(ROOT, path)).filter(existsSync),
  ...markdownFiles(DOCS),
];
const recipes = markdownFiles(VERIFICATION);
const text = (path: string) => readFileSync(path, "utf8");
const withoutFences = (markdown: string) => markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
const external = (link: string) => /^[a-z][\w+.-]*:/i.test(link);
const links = (markdown: string) => [...withoutFences(markdown).matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)]
  .map((match) => match[1]!.trim().replace(/^<|>$/g, "")).filter((link) => !external(link));

function headings(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const [, heading] of withoutFences(markdown).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = heading!.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/\s+/g, "-");
    const count = counts.get(base) ?? 0;
    anchors.add(count ? `${base}-${count}` : base);
    counts.set(base, count + 1);
  }
  return anchors;
}

function destination(document: string, link: string) {
  const [path, anchor] = decodeURIComponent(link).split("#", 2);
  return { path: path ? resolve(document, "..", path) : document, anchor };
}

describe("current documentation references", () => {
  it("links to existing local files and directories", () => {
    const broken = documents.flatMap((document) => links(text(document)).flatMap((link) => {
      const target = destination(document, link);
      return existsSync(target.path) ? [] : [`${relative(ROOT, document)}: ${link}`];
    }));
    expect(broken).toEqual([]);
  });

  it("links to existing Markdown headings, including same-page anchors", () => {
    const broken = documents.flatMap((document) => links(text(document)).flatMap((link) => {
      const target = destination(document, link);
      if (!target.anchor || !target.path.endsWith(".md") || !existsSync(target.path)) return [];
      return headings(text(target.path)).has(target.anchor) ? [] : [`${relative(ROOT, document)}: ${link}`];
    }));
    expect(broken).toEqual([]);
  });

  it("cites source and test files that exist in verification methods", () => {
    const source = /(?<![\w/.-])((?:scripts|server|src|shared|electron)\/[\w./-]+\.(?:ts|tsx|mjs|cjs|py))(?![\w/])/g;
    const broken = recipes.flatMap((recipe) => {
      const markdown = text(recipe).replace(/https?:\/\/\S+/g, " ");
      return [...markdown.matchAll(source)].flatMap((match) => existsSync(join(ROOT, match[1]!))
        ? [] : [`${relative(ROOT, recipe)}: ${match[1]}`]);
    });
    expect(broken).toEqual([]);
  });

  it("uses package commands defined in the current package manifest", () => {
    const { scripts } = JSON.parse(text(join(ROOT, "package.json"))) as { scripts: Record<string, string> };
    const builtin = new Set(["install", "exec"]);
    const unknown = documents.flatMap((document) => [...text(document).matchAll(/\bpnpm\s+([a-z][\w:-]*)/g)]
      .flatMap((match) => builtin.has(match[1]!) || Object.hasOwn(scripts, match[1]!)
        ? [] : [`${relative(ROOT, document)}: pnpm ${match[1]}`]));
    expect(unknown).toEqual([]);
  });

  it("lists every current verification method in its index", () => {
    const index = join(VERIFICATION, "README.md");
    const linked = new Set(links(text(index)).map((link) => destination(index, link).path));
    expect(recipes.filter((recipe) => recipe !== index && !linked.has(recipe)).map((recipe) => relative(ROOT, recipe))).toEqual([]);
  });
});
