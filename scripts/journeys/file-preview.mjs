// Read generated files beside chat in the built app, using an isolated server
// and the deterministic ACP engine. pnpm build first. No real account or data.
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../../server/testing/colonie-env.ts";
import { startSharedWorkspace } from "../../server/testing/shared-workspace.ts";

const root = join(import.meta.dirname, "../..");
const require = createRequire(join(root, "package.json"));
const { chromium, _electron } = require("playwright");
// Strip the ambient integration key before the fixture helper spawns a server.
delete process.env.COMPOSIO_API_KEY;
const screenshots = process.env.COLONIE_PREVIEW_SCREENSHOTS ?? await mkdtemp(join(tmpdir(), "colonie-preview-"));
const ws = await startSharedWorkspace([], {
  onboarding: { completedAt: new Date().toISOString(), version: 1, reelSeen: true, hintsSeen: ["composer", "computer", "model", "bots"] },
}, () => ({ COLONIE_STATIC_DIR: join(root, "dist"), COLONIE_WORKSPACE_KIND: "local" }));
// Synthetic, token-free identity: this journey tests file viewing, not sign-in.
const accountFixture = JSON.stringify({ account: { email: "preview@example.test", name: "Preview tester", signedInAt: new Date().toISOString() } });
await writeFile(join(ws.dataDir, "colonie-account.json"), accountFixture);
let browser;
let desktop;
let desktopHome;
let page;
const errors = [];
const external = [];
const failedRequests = [];
const check = (condition, message) => { if (!condition) throw new Error(message); console.log(`  ok  ${message}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (path, init) => {
  const response = await fetch(`${ws.url}${path}`, init);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};

try {
  if (process.env.COLONIE_PREVIEW_ELECTRON) {
    desktopHome = await mkdtemp(join(tmpdir(), "colonie-preview-electron-"));
    await mkdir(join(desktopHome, "app"));
    await writeFile(join(desktopHome, "app", "colonie-account.json"), accountFixture);
    desktop = await _electron.launch({ executablePath: require("electron"), args: [join(root, "electron/colonie.mjs")], cwd: root,
      env: childEnv({ HOME: desktopHome, COLONIE_HOME: desktopHome, COLONIE_USER_DATA: join(desktopHome, "app"), COLONIE_DATA_DIR: join(desktopHome, "data"), COLONIE_PROFILE: "1", COLONIE_PORT: new URL(ws.url).port, ELECTRON_START_URL: ws.url }) });
    desktop.process().stderr?.on("data", (chunk) => console.log(`electron: ${chunk}`.trim()));
    await desktop.firstWindow();
    const windowDeadline = Date.now() + 20_000;
    while (Date.now() < windowDeadline) {
      page = desktop.windows().find((candidate) => !candidate.isClosed() && candidate.url().startsWith(ws.url));
      if (page) break;
      await sleep(100);
    }
    if (!page) throw new Error("The isolated Electron app did not open its main window");
    await page.setViewportSize({ width: 1440, height: 960 });
    await desktop.evaluate(({ app, session }, directory) => { app.setPath("downloads", directory); session.defaultSession.on("will-download", (_event, item) => item.setSavePath(`${directory}/${item.getFilename()}`)); }, desktopHome);
  } else {
    browser = await chromium.launch({ headless: !process.env.COLONIE_JOURNEY_HEADFUL, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  }
  page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") console.log("browser:", message.text()); });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => { if (!request.url().startsWith(ws.url) && /^https?:/.test(request.url()) && !request.url().includes("posthog")) external.push(request.url()); });
  page.on("response", (response) => { if (response.url().endsWith(".wasm") && !response.headers()["content-type"]?.startsWith("application/wasm")) failedRequests.push(`Wrong WASM type: ${response.url()}`); if (response.status() >= 400 && /\.(wasm|mjs|js|ttf|woff2?)(\?|$)/.test(response.url())) failedRequests.push(`${response.status()} ${response.url()}`); });
  const fixtures = [
    { name: "launch-report.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx() },
    { name: "launch-report.pdf", mime: "application/pdf", bytes: pdf() },
    { name: "launch-notes.md", mime: "text/markdown", bytes: Buffer.from("# Launch notes\n\nA preview beside the conversation.\n\n| Item | Status |\n| --- | --- |\n| Preview | Ready |\n\n<script>window.previewEscaped = true</script>") },
    { name: "launch-data.json", mime: "application/json", bytes: Buffer.from('{"project":"Colonie","status":"ready"}') },
    { name: "broken-report.pdf", mime: "application/pdf", bytes: Buffer.from("broken") },
    { name: "oversized-notes.txt", mime: "text/plain", bytes: Buffer.alloc(1_000_001, 65) },
    { name: "preview-image.png", mime: "image/png", image: true, bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6N1cAAAAASUVORK5CYII=", "base64") },
  ];
  for (const fixture of fixtures) {
    const saved = await json(fixture.image ? "/api/attachments" : `/api/files?name=${encodeURIComponent(fixture.name)}`, { method: "POST", headers: { "content-type": fixture.mime }, body: fixture.bytes });
    fixture.path = saved.path;
  }
  const bot = (await json("/api/bots")).bots[0];
  const text = "Review these launch files.\n\n" + fixtures.map((file) => `<attached-${file.image ? "image" : "file"} path="${file.path}" name="${file.name}" />`).join("\n\n");
  await json(`/api/bots/${bot.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, threadId: bot.threadId }) });
  const until = Date.now() + 20_000;
  while ((await json("/api/bots")).bots[0].busy && Date.now() < until) await sleep(100);
  await page.goto(ws.url);
  await page.locator("main textarea").waitFor();
  await page.locator("main .glass-scroller").evaluate((element) => { element.scrollTop = 0; });
  const more = page.getByRole("button", { name: /Show .* more/ }).first();
  if (await more.isVisible().catch(() => false)) await more.click();
  const open = async (name) => {
    const trigger = page.getByRole("button", { name: `Preview ${name}`, exact: true }).first();
    await trigger.click();
    const panel = page.getByRole("complementary", { name: `Preview ${name}`, exact: true });
    await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    return panel;
  };
  let panel = await open("launch-report.docx");
  await panel.locator('canvas').first().waitFor({ timeout: 60_000 });
  await panel.getByText("2 pages", { exact: true }).waitFor({ timeout: 60_000 });
  check(await panel.locator("canvas").count() >= 1, "Word pages render in the right panel");
  await page.screenshot({ path: join(screenshots, "docx-dark.png") });
  check((await panel.textContent()).includes("Launch report"), "Word has accessible document text");
  check(!(await panel.locator('[contenteditable="true"]').count()), "Word preview is read-only");
  const bounds = await panel.boundingBox();
  const chat = await page.locator("main").boundingBox();
  check(bounds.x + bounds.width === 1440 && chat.width >= 360, "preview docks at the right and leaves room for chat");
  await page.screenshot({ path: join(screenshots, "docx-dark.png") });
  const separator = panel.getByRole("separator");
  const before = await panel.boundingBox();
  await separator.focus(); await separator.press("ArrowLeft");
  check((await panel.boundingBox()).width > before.width, "preview width changes with the keyboard");
  if (desktop) {
    await panel.getByRole("button", { name: "Save a copy of launch-report.docx" }).click();
    const savedFile = join(desktopHome, "launch-report.docx");
    const downloadDeadline = Date.now() + 10_000;
    while (Date.now() < downloadDeadline) { try { await access(savedFile); break; } catch { await sleep(100); } }
    check((await readFile(savedFile)).equals(fixtures[0].bytes), "Save keeps the original Word filename and bytes in Electron");
  } else {
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Save a copy of launch-report.docx" }).click();
    check((await download).suggestedFilename() === "launch-report.docx", "Save keeps the original Word filename");
  }

  panel = await open("launch-report.pdf");
  await panel.getByText("2 pages", { exact: true }).waitFor();
  await panel.locator(".textLayer").first().getByText("Launch PDF").waitFor();
  const fittedWidth = (await panel.getByRole("group", { name: "Page 1", exact: true }).boundingBox()).width;
  await panel.getByRole("button", { name: "Zoom out", exact: true }).click();
  check((await panel.getByRole("group", { name: "Page 1", exact: true }).boundingBox()).width < fittedWidth, "Zoom out makes a fitted PDF smaller");
  await panel.getByRole("button", { name: "Fit to width" }).click();
  await panel.getByRole("button", { name: "Zoom in", exact: true }).click();
  check((await panel.getByRole("group", { name: "Page 1", exact: true }).boundingBox()).width > fittedWidth, "PDF renders selectable text and supports zoom");
  await page.screenshot({ path: join(screenshots, "pdf-dark.png") });
  await panel.getByRole("button", { name: "Fit to width" }).click();
  panel = await open("launch-notes.md");
  await panel.getByText("Launch notes", { exact: true }).waitFor();
  check(!await page.evaluate(() => window.previewEscaped), "Markdown does not run document scripts");
  await page.evaluate(() => { document.documentElement.dataset.skin = "atelier"; });
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  await page.screenshot({ path: join(screenshots, "markdown-light.png") });
  panel = await open("launch-data.json");
  await panel.getByText('"Colonie"', { exact: false }).waitFor();
  check((await panel.innerText()).includes("status"), "source files use the existing code renderer");
  panel = await open("broken-report.pdf");
  await panel.getByRole("alert").waitFor();
  check((await panel.innerText()).includes("could not be displayed"), "a corrupt document stays inside the preview error state");
  panel = await open("oversized-notes.txt");
  await panel.getByRole("alert").waitFor();
  check((await panel.innerText()).includes("too large"), "oversized text offers Save without parsing it");
  await panel.getByRole("button", { name: "Close preview" }).click();
  // Image thumbnails retain their existing exact-message authorization.
  await page.getByRole("button", { name: /Preview.*preview-image/ }).first().click();
  panel = page.getByRole("complementary", { name: /Preview.*preview-image/ });
  await panel.locator("img").waitFor();
  check(await panel.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0), "attached images open in the same panel");
  await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await page.setViewportSize({ width: 700, height: 820 });
  await page.waitForFunction(() => document.querySelector('aside[aria-label="Preview preview-image.png"]')?.getBoundingClientRect().width === 700);
  check((await panel.boundingBox()).width === 700, "on narrow windows the preview covers the chat instead of squeezing it");
  await page.screenshot({ path: join(screenshots, "image-narrow.png") });
  await page.keyboard.press("Escape");
  check(!await panel.count(), "Escape returns to the conversation");
  check(await page.locator("main textarea").isVisible(), "the chat composer stays available after closing preview");
  check(!failedRequests.length, `renderer assets load locally: ${failedRequests.join(", ")}`);
  check(!external.length, `preview sends no files to external services: ${external.join(", ")}`);
  check(!errors.length, `no uncaught browser errors: ${errors.join(", ")}`);
  console.log(`Screenshots: ${screenshots}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(screenshots, "failure.png") });
  console.error(`Screenshots: ${screenshots}`);
  console.error(`Browser errors: ${errors.join("\n")}\nAsset errors: ${failedRequests.join("\n")}`);
  throw error;
} finally {
  await desktop?.close();
  await browser?.close();
  await ws.stop();
  if (desktopHome) await rm(desktopHome, { recursive: true, force: true });
  if (!process.env.COLONIE_PREVIEW_SCREENSHOTS && process.env.COLONIE_PREVIEW_CLEAN_SCREENSHOTS) await rm(screenshots, { recursive: true, force: true });
}

// Tiny standards-based fixtures keep the journey independent of office apps.
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [path, text] of Object.entries(entries)) {
    const name = Buffer.from(path), bytes = Buffer.from(text), header = Buffer.alloc(30), index = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6);
    index.writeUInt32LE(crc32(bytes), 16); index.writeUInt32LE(bytes.length, 20); index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(index, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function docx() {
  return zip({
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="44"/></w:rPr><w:t>Launch report</w:t></w:r></w:p><w:p><w:r><w:t>Read your report without leaving the conversation.</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Feature</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>File preview</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Ready for review</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Next steps</w:t></w:r></w:p><w:p><w:r><w:t>Keep reading while the conversation stays beside you.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>',
  });
}
function pdf() {
  const content = 'BT /F1 24 Tf 72 720 Td (Launch PDF) Tj 0 -36 Td /F1 12 Tf (Read the document beside your conversation.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let source = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(source + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`);
}
