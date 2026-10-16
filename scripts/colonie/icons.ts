/** Generate reproducible static artwork from the same pinned Bloub engine. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve(".colonie-dev/generated-art");
mkdirSync(dir, { recursive: true });
const entry = join(dir, "icon-render.mjs");
await build({ stdin: { contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
import {BotEngine} from './third_party/bloub/src/bot/engine';
import {SHAPE_BY_ID} from './third_party/bloub/src/bot/skins';
import {EXPRESSION_BY_ID} from './third_party/bloub/src/bot/expressions';
import {BloubFrame} from './src/components/BloubAvatar';
const engine=new BotEngine(100,'idle',SHAPE_BY_ID.get('galet').radii,EXPRESSION_BY_ID.get('curieux'));
export const svg=renderToStaticMarkup(createElement(BloubFrame,{frame:engine.sample(1),size:1024,ink:'#6d4ae0',uid:'colonie-icon',label:'Colonie'}));`,
  resolveDir: resolve("."), loader: "tsx" }, outfile: entry, bundle: true, platform: "node", format: "esm", jsx: "automatic", external: ["react", "react-dom/server", "react/jsx-runtime"] });
const { svg } = await import(pathToFileURL(entry).href);
writeFileSync(resolve("public/colonie.svg"), svg);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".colonie-dev/browsers");
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`);
  const png = resolve("electron/resources/colonie-icon.png");
  await page.screenshot({ path: png, omitBackground: true });
  if (process.platform === "darwin") {
    const iconset = join(dir, "colonie.iconset"); mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
      execFileSync("sips", ["-z", String(size * scale), String(size * scale), png, "--out", join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)], { stdio: "ignore" });
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", resolve("build/colonie.icns")]);
  }
  console.log(JSON.stringify({ svg: "public/colonie.svg", icon: png, pngBytes: readFileSync(png).length }));
} finally { await browser.close(); }
