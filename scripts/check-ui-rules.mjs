// Keeps the interface from drifting while it is tidied. Each rule counts a pattern in src/**/*.tsx
// (tests and src/components/ui/ excluded). The count may go down, never up: a new button, text size,
// corner or color written inline fails here, and the message says what to use instead.
//   node scripts/check-ui-rules.mjs            check (pnpm ui:check)
//   node scripts/check-ui-rules.mjs --update   write today's counts as the new limits, after cleaning some up
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const limitsFile = join(root, "scripts/ui-rules.json");

export const RULES = [
  { id: "inline-primary-button", pattern: /bg-accent px-/g, use: "<Button variant=\"primary\"> from src/components/ui/Button" },
  { id: "inline-tab-pills", pattern: /rounded-full bg-inset p-/g, use: "<TabPills> from src/components/ui/TabPills" },
  { id: "arbitrary-text-size", pattern: /text-\[\d+(?:\.\d+)?px\]/g, use: "one of the type sizes in docs/COLONIE-BLUEPRINT.md (Interface)" },
  { id: "arbitrary-corner", pattern: /rounded-\[[^\]]+\]/g, use: "rounded-md, rounded-lg, rounded-xl or rounded-full" },
  { id: "raw-hex-color", pattern: /#[0-9a-fA-F]{6}\b/g, use: "a color token from src/styles.css (bg-raised, text-ink, ...)" },
];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path.endsWith(join("src", "components", "ui")) ? [] : files(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

export function count() {
  const found = Object.fromEntries(RULES.map((rule) => [rule.id, 0]));
  const where = Object.fromEntries(RULES.map((rule) => [rule.id, new Map()]));
  for (const file of files(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const rule of RULES) {
      const hits = text.match(rule.pattern)?.length ?? 0;
      found[rule.id] += hits;
      if (hits) where[rule.id].set(relative(root, file), hits);
    }
  }
  return { found, where };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { found, where } = count();
  if (process.argv.includes("--update")) {
    writeFileSync(limitsFile, `${JSON.stringify(found, null, 2)}\n`);
    console.log("ui rules: limits updated", found);
    process.exit(0);
  }
  const limits = JSON.parse(readFileSync(limitsFile, "utf8"));
  let failed = false;
  for (const rule of RULES) {
    const limit = limits[rule.id] ?? 0;
    if (found[rule.id] > limit) {
      failed = true;
      const top = [...where[rule.id]].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([file, n]) => `${file} (${n})`).join(", ");
      console.error(`ui rules: ${rule.id} is ${found[rule.id]}, the limit is ${limit}. Use ${rule.use}. Most uses: ${top}`);
    } else if (found[rule.id] < limit) {
      console.log(`ui rules: ${rule.id} is down to ${found[rule.id]} (limit ${limit}); run node scripts/check-ui-rules.mjs --update to keep the gain`);
    }
  }
  if (failed) process.exit(1);
  console.log("ui rules: ok");
}
