import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { mountPreview } from "../testing/preview-fixture.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".colonie-dev/browsers");
const { chromium } = await import("playwright");
const preview = await mountPreview({ info: { url: "http://127.0.0.1:1" } }, { entry: "/scripts/colonie/art-preview.tsx", route: "/__colonie-art.html", title: "Colonie artwork", logLevel: "warn" });
const browser = await chromium.launch({ headless: true });
const evidence = resolve(".colonie-dev/evidence"); mkdirSync(evidence, { recursive: true });
const errors: string[] = [];
const result: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1150 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(preview.previewUrl);
  await page.locator('svg[data-mascot="bloub"]').first().waitFor();
  await page.waitForTimeout(700);
  const maskIds = await page.locator("mask").evaluateAll((masks) => masks.map((mask) => mask.id));
  if (maskIds.length !== 30 || new Set(maskIds).size !== maskIds.length) throw new Error("Artwork masks are missing or collide");
  for (const skin of ["midnight", "daylight"]) {
    await page.evaluate((skin) => document.documentElement.setAttribute("data-skin", skin), skin);
    await page.screenshot({ path: join(evidence, `bloub-${skin}.png`), fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(100);
  const before = await page.locator('svg[aria-label="working animated"]').innerHTML();
  await page.waitForTimeout(500);
  const after = await page.locator('svg[aria-label="working animated"]').innerHTML();
  if (before !== after) throw new Error("Reduced-motion avatar kept animating");
  if (errors.length) throw new Error(errors.join("\n"));
  result.ok = true; result.avatarCount = maskIds.length; result.reducedMotion = "static";
} catch (error) { result.ok = false; result.error = (error as Error).message; process.exitCode = 1; }
finally { await browser.close(); await preview.close(); }
writeFileSync(join(evidence, "bloub-art-check.json"), JSON.stringify({ ...result, errors }, null, 2));
console.log(JSON.stringify(result));
