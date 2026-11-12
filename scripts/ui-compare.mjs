// Compares two folders of screenshots made by scripts/ui-shots.mjs and says which screens really changed.
//   node scripts/ui-compare.mjs .ui-shots/before .ui-shots/after
// A picture can differ by a sliver of anti-aliasing from one run to the next (a drifting face, a focus
// ring), so pixels that differ by more than a few shades are counted: a handful is noise, a real change is many.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = join(import.meta.dirname, "..");
const NOISE_PIXELS = 40;
const SHADES = 24;

export async function compareFolders(before, after, { whole = true } = {}) {
  const require = createRequire(join(root, "package.json"));
  const { chromium } = require("playwright");
  const base = JSON.parse(readFileSync(join(before, "manifest.json"), "utf8"));
  const written = JSON.parse(readFileSync(join(after, "manifest.json"), "utf8"));
  const differing = Object.keys(written).filter((file) => base[file] && base[file] !== written[file]);
  const browser = await chromium.launch({ headless: true });
  const changed = [];
  const noise = [];
  try {
    const page = await browser.newPage();
    for (const file of differing) {
      const pair = [join(before, file), join(after, file)].map((path) => `data:image/png;base64,${readFileSync(path).toString("base64")}`);
      const pixels = await page.evaluate(async ([first, second, limit]) => {
        const load = (src) => new Promise((done, fail) => { const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = src; });
        const [a, b] = await Promise.all([load(first), load(second)]);
        if (a.width !== b.width || a.height !== b.height) return -1;
        const read = (image) => { const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data; };
        const left = read(a);
        const right = read(b);
        let count = 0;
        for (let at = 0; at < left.length; at += 4) if (Math.max(Math.abs(left[at] - right[at]), Math.abs(left[at + 1] - right[at + 1]), Math.abs(left[at + 2] - right[at + 2])) > limit) count++;
        return count;
      }, [...pair, SHADES]);
      (pixels < 0 || pixels > NOISE_PIXELS ? changed : noise).push(`${file}${pixels < 0 ? " (size changed)" : ` (${pixels} pixels)`}`);
    }
  } finally { await browser.close(); }
  const added = Object.keys(written).filter((file) => !base[file]);
  const gone = whole ? Object.keys(base).filter((file) => !written[file]) : [];
  const name = relative(process.cwd(), before) || before;
  console.log(changed.length || added.length || gone.length
    ? `Compared with ${name}:\n${[...changed.map((file) => `  changed  ${file}`), ...added.map((file) => `  new      ${file}`), ...gone.map((file) => `  missing  ${file}`)].join("\n")}`
    : `Compared with ${name}: every screen is the same${noise.length ? ` (${noise.length} differ only by anti-aliasing noise)` : ""}.`);
  return { changed, added, gone, noise };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [before, after] = process.argv.slice(2);
  if (!before || !after) { console.error("usage: node scripts/ui-compare.mjs <before folder> <after folder>"); process.exit(2); }
  await compareFolders(resolve(before), resolve(after));
}
