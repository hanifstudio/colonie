import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import environments from "./environments.cjs";
import localOriginModule from "./local-origin.cjs";

const LOCAL = "http://127.0.0.1:8799";
const OTHER = "https://bots.example.test";

const fixture = vi.hoisted(() => ({ autoUpdater: null, handlers: new Map() }));

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/unused-updater-test-log" },
  clipboard: { writeText: vi.fn() },
  ipcMain: { handle: (name, handler) => fixture.handlers.set(name, handler) },
}));
vi.mock("node:module", () => ({
  createRequire: () => () => ({ autoUpdater: fixture.autoUpdater }),
}));

/** A page in the main window: its contents, and an IPC event it sends. */
function page(origin) {
  const mainFrame = { url: `${origin}/` };
  const webContents = { mainFrame, send: vi.fn() };
  return { webContents, event: { sender: webContents, senderFrame: mainFrame } };
}

/** main.mjs's own rule for who may read and drive the updater, run against
 * fakes of the window and the saved servers it reads. */
function mainRule() {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("// ── this app's own page: the updater"), end = source.indexOf("// ── end this app's own page ──", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  // main registers the updater's channels with exactly this rule.
  expect(source.includes("registerUpdaterIpc({ pageAllowed: updaterPageAllowed });"), "main.mjs wires the updater to updaterPageAllowed").toBe(true);
  const window = { isDestroyed: () => false, webContents: null };
  const context = vm.createContext({
    senderIsLocal: localOriginModule.isLocalSender, workspaceSenderAllowed: environments.workspaceSenderAllowed,
    rendererOrigin: () => LOCAL, mainWindow: window,
    environmentsState: { environments: [], activeId: environments.LOCAL_ID },
  });
  vm.runInContext(source.slice(start, end), context);
  /** The main window shows `shown`'s page, and `activeId` is the saved server it is. */
  const show = (shown, activeId = environments.LOCAL_ID) => {
    window.webContents = shown.webContents;
    context.environmentsState = {
      environments: [{ id: "vps", name: "VPS", origin: OTHER }],
      activeId,
    };
  };
  return { context, window, show, pageAllowed: vm.runInContext("updaterPageAllowed", context) };
}

/** A fresh updater module with a fake electron-updater behind it. */
async function load(pageAllowed) {
  vi.resetModules();
  fixture.handlers.clear();
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = vi.fn(async () => {
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-available", { version: "2.0.0" });
    return { isUpdateAvailable: true };
  });
  autoUpdater.downloadUpdate = vi.fn(async () => {
    autoUpdater.emit("download-progress", { percent: 50 });
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    return ["/unused-staged-update.zip"];
  });
  autoUpdater.quitAndInstall = vi.fn();
  fixture.autoUpdater = autoUpdater;
  const updater = await import("./updater.mjs");
  updater.registerUpdaterIpc({ pageAllowed });
  return { updater, autoUpdater, handlers: fixture.handlers };
}

const settle = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

beforeEach(() => {
  localOriginModule.setLocalOrigin(LOCAL);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The bridge preload.cjs gives a page at `origin`. */
function bridgeFor(origin, { clicked = false } = {}) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`] },
    location: { origin }, navigator: { userActivation: { isActive: clicked } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: {
        on() {}, removeListener() {}, send() {},
        invoke: (...args) => { invoked.push(args); return Promise.resolve({ status: "idle" }); },
      },
    }),
  });
  return { bridge, invoked };
}

it("this computer's page gets the update bridge, and it restarts the app only on the person's click", async () => {
  const local = bridgeFor(LOCAL);
  expect(Object.keys(local.bridge.updater).sort()).toEqual(["check", "install", "onState"]);
  // install at once from a local page; a remote page's click is main's to check.
  await local.bridge.updater.install();
  expect(local.invoked).toEqual([["update:install"]]);
});

it("a paired server's page never gets the update bridge, this computer's always does", () => {
  const remote = bridgeFor(OTHER);
  expect("updater" in remote.bridge).toBe(false);
  // ...and it keeps the safe subset it does get.
  expect(Object.keys(remote.bridge)).toContain("workspaces");
  expect("updater" in bridgeFor(LOCAL).bridge).toBe(true);
});

it("main answers the updater for this computer's own page in the main window, and no other", () => {
  const rule = mainRule();
  const local = page(LOCAL);
  rule.show(local);
  expect(rule.pageAllowed(local.event)).toBe(true);
  // A paired server's page, even the active one.
  const other = page(OTHER);
  rule.show(other, "vps");
  expect(rule.pageAllowed(other.event)).toBe(false);
  // A frame inside this computer's page, or another window's page: nothing.
  rule.show(local);
  expect(rule.pageAllowed({ sender: local.webContents, senderFrame: { url: `${LOCAL}/frame` } })).toBe(false);
  const stranger = page(LOCAL);
  expect(rule.pageAllowed(stranger.event)).toBe(false);
});

it("a downloaded update installs when the app quits, except a system package, which is the person's to install", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const resourcesPath = process.resourcesPath;
  const appImage = process.env.APPIMAGE;
  const resources = mkdtempSync(join(tmpdir(), "omb-updater-package-"));
  try {
    for (const [os, marker, image, installsOnQuit] of [
      ["darwin", null, null, true],
      ["win32", null, null, true],
      ["linux", null, "/home/a/OpenMausBot.AppImage", true],
      ["linux", "deb", null, false],
      ["linux", "rpm", null, false],
    ]) {
      Object.defineProperty(process, "platform", { ...platform, value: os });
      process.resourcesPath = resources;
      rmSync(join(resources, "package-type"), { force: true });
      if (marker) writeFileSync(join(resources, "package-type"), marker);
      if (image) process.env.APPIMAGE = image;
      else delete process.env.APPIMAGE;
      const { updater, autoUpdater } = await load(() => false);
      updater.startUpdater();
      expect(autoUpdater.autoInstallOnAppQuit, `${os} ${marker ?? image ?? ""}`).toBe(installsOnQuit);
      // Nothing is installed by itself before then: the coordinator owns the download.
      expect(autoUpdater.autoDownload).toBe(false);
    }
  } finally {
    Object.defineProperty(process, "platform", platform);
    process.resourcesPath = resourcesPath;
    if (appImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = appImage;
    rmSync(resources, { recursive: true, force: true });
  }
});

it("downloads an update by itself: the first check after launch starts it, and nothing restarts", async () => {
  const rule = mainRule();
  const local = page(LOCAL);
  rule.show(local);
  const { updater, autoUpdater } = await load(rule.pageAllowed);
  updater.attachUpdaterWindow(rule.window);
  updater.startUpdater();

  await vi.advanceTimersByTimeAsync(15_000);
  await settle();

  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  const statuses = local.webContents.send.mock.calls.map(([, state]) => state.status);
  expect(statuses).not.toContain("available");
  expect(statuses.at(-1)).toBe("downloaded");
});

it("sends update news only to the page main answers, never a paired server's", async () => {
  const rule = mainRule();
  const { updater, autoUpdater, handlers } = await load(rule.pageAllowed);
  updater.attachUpdaterWindow(rule.window);
  updater.startUpdater();

  let finish;
  autoUpdater.downloadUpdate = vi.fn(() => new Promise((resolve) => { finish = resolve; }).then(() => {
    autoUpdater.emit("update-downloaded", { version: "2.0.0" });
    return ["/unused-staged-update.zip"];
  }));

  const other = page(OTHER);
  rule.show(other, "vps");
  await vi.advanceTimersByTimeAsync(15_000);
  await settle();
  expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(other.webContents.send).not.toHaveBeenCalled();
  expect(() => handlers.get("update:get-state")(other.event)).toThrow(/only available/);

  // The person goes back to this computer while it downloads: that page reads it, then hears it is ready.
  const local = page(LOCAL);
  rule.show(local);
  expect(handlers.get("update:get-state")(local.event)).toMatchObject({ status: "downloading", version: "2.0.0" });
  finish();
  await settle();
  expect(local.webContents.send).toHaveBeenLastCalledWith("update:state", expect.objectContaining({ status: "downloaded", version: "2.0.0" }));
  expect(other.webContents.send).not.toHaveBeenCalled();
});

it("this computer's page reads and drives the update channels, and a paired server's page is refused", async () => {
  const rule = mainRule();
  const { handlers } = await load(rule.pageAllowed);
  // There is no Download step left to ask for.
  expect([...handlers.keys()].sort()).toEqual(["update:check", "update:get-state", "update:install"]);

  const other = page(OTHER);
  rule.show(other, "vps");
  for (const channel of handlers.keys()) expect(() => handlers.get(channel)(other.event), channel).toThrow(/only available/);

  const local = page(LOCAL);
  rule.show(local);
  for (const channel of handlers.keys()) expect(() => handlers.get(channel)(local.event), channel).not.toThrow();
  // A frame inside this computer's page, or a page no window shows, is refused too.
  expect(() => handlers.get("update:get-state")({ sender: local.webContents, senderFrame: { url: `${LOCAL}/frame` } })).toThrow(/only available/);
  expect(() => handlers.get("update:get-state")({ sender: page(LOCAL).webContents, senderFrame: { url: `${LOCAL}/` } })).toThrow(/only available/);
});

it("sends updater progress to a reopened window without restarting the updater", async () => {
  const rule = mainRule();
  const first = page(LOCAL);
  rule.show(first);
  const { updater, autoUpdater, handlers } = await load(rule.pageAllowed);
  updater.attachUpdaterWindow({ webContents: first.webContents });
  updater.startUpdater();
  const listenerCount = autoUpdater.eventNames().reduce((count, name) => count + autoUpdater.listenerCount(name), 0);
  const timerCount = vi.getTimerCount();

  first.webContents.send.mockImplementation(() => { throw new Error("window destroyed"); });
  first.webContents.send.mockClear();
  const reopened = page(LOCAL);
  rule.show(reopened);
  updater.attachUpdaterWindow(rule.window);

  await handlers.get("update:check")(reopened.event);
  await settle();

  expect(first.webContents.send).not.toHaveBeenCalled();
  expect(reopened.webContents.send.mock.calls.map(([, state]) => state.status))
    .toEqual(["checking", "downloading", "downloading", ...(process.platform === "darwin" ? ["preparing"] : []), "downloaded"]);
  expect(autoUpdater.eventNames().reduce((count, name) => count + autoUpdater.listenerCount(name), 0)).toBe(listenerCount);
  expect(vi.getTimerCount()).toBe(timerCount);
});