import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";
import { appPermissionAllowed, appPermissionHandlers, externalWebUrl, remoteClipboardWriteAllowed } from "./app-permissions.mjs";

const LOCAL_ORIGIN = "http://127.0.0.1:5199";
const LOCAL_PAGE = "http://127.0.0.1:5199/chat?botId=bot-1";

test("grants notifications, clipboard, and fullscreen to the local renderer page", () => {
  for (const permission of ["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]) {
    assert.equal(appPermissionAllowed(permission, LOCAL_PAGE, LOCAL_ORIGIN), true, permission);
  }
});

test("accepts a bare origin or a full URL on either side", () => {
  assert.equal(appPermissionAllowed("notifications", LOCAL_ORIGIN, LOCAL_ORIGIN), true);
  assert.equal(appPermissionAllowed("notifications", `${LOCAL_ORIGIN}/settings#voice`, `${LOCAL_ORIGIN}/`), true);
  assert.equal(appPermissionAllowed("fullscreen", "http://127.0.0.1:8799/chat", "http://127.0.0.1:8799"), true);
});

test("allows media for audio (microphone) and guarded display-capture, denies video (camera)", () => {
  // Audio only: allowed
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio"] }), true);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "audio" }), true);

  // Guarded display-capture path: Electron 43 routes getDisplayMedia through permission="media"
  // with an empty mediaTypes array before dispatching to setDisplayMediaRequestHandler
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: [] }), true);

  // Video / camera: strictly denied
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["video"] }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio", "video"] }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "video" }), false);

  // Unknown or omitted details: fail closed
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "unknown" }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, {}), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN), false);
});

test("refuses permissions to any other origin", () => {
  assert.equal(appPermissionAllowed("notifications", "https://other.example/chat", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("clipboard-read", "http://127.0.0.1:5200/", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("media", "https://127.0.0.1:5199/", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("fullscreen", "http://localhost:5199/", LOCAL_ORIGIN), false);
});

test("keeps every privileged capability off even for the local renderer page", () => {
  const privileged = [
    "geolocation", "camera", "usb", "hid", "serial", "midi", "midiSysex",
    "display-capture", "fileSystem", "openExternal", "idle-detection", "speaker-selection",
    "window-management", "storage-access", "top-level-storage-access", "pointerLock",
    "keyboardLock", "mediaKeySystem", "unknown",
  ];
  for (const permission of privileged) {
    assert.equal(appPermissionAllowed(permission, LOCAL_PAGE, LOCAL_ORIGIN), false, permission);
  }
  assert.equal(appPermissionAllowed(undefined, LOCAL_PAGE, LOCAL_ORIGIN), false);
});

test("rejects mixed, unknown, and conflicting media details", () => {
  for (const details of [
    { mediaTypes: ["audio", "unknown"] }, { mediaTypes: ["unknown"] },
    { mediaType: "audio", mediaTypes: ["video"] },
    { mediaType: "unknown", mediaTypes: [] }, { mediaTypes: "audio" }, null,
  ]) assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, details), false);
});

test("web links reject embedded credentials and non-web schemes", () => {
  assert.equal(externalWebUrl("https://example.com/help?q=hello#more"), "https://example.com/help?q=hello#more");
  assert.equal(externalWebUrl("http://127.0.0.1:8799"), "http://127.0.0.1:8799/");
  for (const url of ["https://user:pass@example.com", "http://user@example.com", "https://:pass@example.com"])
    assert.throws(() => externalWebUrl(url), /credentials/);
  for (const url of ["file:///tmp/test", "javascript:alert(1)", "data:text/html,test", "mailto:test@example.com"])
    assert.throws(() => externalWebUrl(url), /Only web/);
  for (const url of [null, 123, "not a url"])
    assert.throws(() => externalWebUrl(url), /web address/);
});

test("both external-link entry points use the policy and IPC retains the local-origin gate", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.handle\("desktop:open-external", localOnly\("desktop:open-external"/);
  assert.match(main, /shell\.openExternal\(externalWebUrl\(rawUrl\)\)/);
  assert.match(main, /shell\.openExternal\(externalWebUrl\(url\)\)/);
});

test("fails closed on unparsable or opaque origins", () => {
  assert.equal(appPermissionAllowed("notifications", "not a url", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", "", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", undefined, LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", null, LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", LOCAL_PAGE, "not a url"), false);
  assert.equal(appPermissionAllowed("notifications", LOCAL_PAGE, undefined), false);
  // Opaque origins all serialise as "null"; two of them must never match.
  assert.equal(appPermissionAllowed("notifications", "data:text/html,x", "about:blank"), false);
  assert.equal(appPermissionAllowed("notifications", "javascript:alert(1)", LOCAL_ORIGIN), false);
});

// ── The handlers this app installs, end to end ──
// This computer's own page gets its own rules; the active paired server, in
// this window's main frame, gets clipboard writes and nothing else. Both are
// re-evaluated per request, so a server switch withdraws it at once.
function appFixture() {
  const state = { main: { getURL: () => LOCAL_PAGE }, remote: null };
  const handlers = appPermissionHandlers({
    rendererOrigin: () => LOCAL_ORIGIN,
    mainContents: () => state.main,
    activeRemoteOrigin: () => state.remote,
  });
  const ask = (permission, details, contents = state.main) => {
    let granted;
    handlers.request(contents, permission, (value) => { granted = value; }, details);
    return granted;
  };
  const check = (permission, requestingOrigin, details, contents = state.main) => handlers.check(contents, permission, requestingOrigin, details);
  return { state, ask, check };
}

test("this computer's own page keeps its permissions through the same handlers", () => {
  const { state, ask, check } = appFixture();
  assert.equal(ask("media", { requestingUrl: LOCAL_PAGE, isMainFrame: true, mediaTypes: ["audio"] }), true);
  assert.equal(ask("media", { requestingUrl: LOCAL_PAGE, isMainFrame: true, mediaTypes: [] }), true, "guarded display capture");
  assert.equal(ask("media", { requestingUrl: LOCAL_PAGE, isMainFrame: true, mediaTypes: ["video"] }), false);
  assert.equal(ask("notifications", { requestingUrl: LOCAL_PAGE, isMainFrame: true }), true);
  // No requesting URL: the window's own address decides, as before.
  assert.equal(ask("notifications", {}), true);
  assert.equal(check("clipboard-read", "", { isMainFrame: true }), true);
  assert.equal(check("clipboard-read", "https://other.example", { isMainFrame: true }), false);
  assert.equal(state.remote, null, "this computer has no paired server to match");
});

test("the active paired server, in this window's main frame, may write the clipboard and nothing else", () => {
  const { state, ask } = appFixture();
  const remote = "https://my-vps.example.com";
  const contents = { getURL: () => `${remote}/chat`, mainFrame: { url: `${remote}/chat` } };
  // The paired server's page is the one the main window shows.
  state.main = contents;
  state.remote = remote;
  assert.equal(ask("clipboard-sanitized-write", { requestingUrl: `${remote}/chat`, isMainFrame: true }), true);
  assert.equal(ask("clipboard-read", { requestingUrl: `${remote}/chat`, isMainFrame: true }), false, "never reads it");
  assert.equal(ask("notifications", { requestingUrl: `${remote}/chat`, isMainFrame: true }), false);
  assert.equal(ask("media", { requestingUrl: `${remote}/chat`, isMainFrame: true, mediaTypes: ["audio"] }), false, "no microphone off this computer's page");
  assert.equal(ask("clipboard-sanitized-write", { requestingUrl: `${remote}/chat`, isMainFrame: false }), false, "a subframe");
  // Switching servers (or back to this computer) withdraws it at once.
  state.remote = null;
  assert.equal(ask("clipboard-sanitized-write", { requestingUrl: `${remote}/chat`, isMainFrame: true }), false);
  state.remote = remote;
  assert.equal(ask("clipboard-sanitized-write", { requestingUrl: `${remote}/chat`, isMainFrame: true }, { getURL: () => LOCAL_PAGE }), false, "another window");
});

test("the app installs these handlers, one module-level set and the local-origin gate", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(main, /setPermissionRequestHandler\(appPermissions\.request\)/);
  assert.match(main, /setPermissionCheckHandler\(appPermissions\.check\)/);
  // perm:status's pageMic asks these very handlers: one module-level set,
  // never a second const that would leave perm:status answering "refused".
  assert.match(main, /ipcMain\.handle\("perm:status", \(event\) => \(\{[\s\S]*?pageMic: appPermissions\?\.pageMicrophone\(event\) \?\? "refused",/);
  assert.match(main, /^let appPermissions = null;$/m);
  assert.match(main, /^  appPermissions = appPermissionHandlers\(\{$/m);
  assert.doesNotMatch(main, /(const|let|var) appPermissions = appPermissionHandlers/);
});

// ── What a page is told when its microphone is refused ──
// perm:status answers `pageMic` for the asking page, so a blocked Live call
// can say who blocked it: this app (then a web browser can make the call) or
// the computer (then its privacy settings can). The answer is the request
// handler's own, never a second copy of the rule.
const ipcFrom = (contents, frameUrl, { mainFrame = true } = {}) => {
  const frame = { url: frameUrl };
  if (mainFrame) contents.mainFrame = frame;
  else contents.mainFrame ??= { url: contents.getURL() };
  return { sender: contents, senderFrame: frame };
};
const pageMicFixture = () => {
  const state = { main: { getURL: () => LOCAL_PAGE } };
  const handlers = appPermissionHandlers({ rendererOrigin: () => LOCAL_ORIGIN, mainContents: () => state.main });
  return { state, handlers };
};

test("a page asking about its microphone hears whether this app lets it use it", () => {
  const { state, handlers } = pageMicFixture();
  assert.equal(handlers.pageMicrophone(ipcFrom(state.main, LOCAL_PAGE)), "allowed", "this computer's own page");
  const other = { getURL: () => "https://my-vps.example.com/chat" };
  assert.equal(handlers.pageMicrophone(ipcFrom(other, "https://my-vps.example.com/chat")), "refused", "another server");
});

test("a page that could not be granted the microphone is refused where it would ask", () => {
  const { state, handlers } = pageMicFixture();
  assert.equal(handlers.pageMicrophone({ sender: state.main, senderFrame: null }), "refused", "a frame that is gone");
  assert.equal(handlers.pageMicrophone({ sender: null, senderFrame: { url: `${LOCAL_ORIGIN}/` } }), "allowed", "a frame that is this computer's own");
  assert.equal(handlers.pageMicrophone(undefined), "refused", "no sender");
});

// The request may decide later (Electron's callback allows it), so the test
// waits for its answer rather than reading it as the call returns.
test("the page's answer is the request handler's answer for its microphone", async () => {
  const { state, handlers } = pageMicFixture();
  const other = { getURL: () => "https://my-vps.example.com/" };
  for (const contents of [state.main, other]) {
    for (const url of [LOCAL_PAGE, "https://my-vps.example.com/", "http://127.0.0.1:5200/"]) {
      for (const mainFrame of [true, false]) {
        const granted = await new Promise((resolve) => {
          handlers.request(contents, "media", resolve, { requestingUrl: url, isMainFrame: mainFrame, mediaTypes: ["audio"] });
        });
        const label = JSON.stringify({ page: contents.getURL(), url, mainFrame });
        assert.equal(await handlers.pageMicrophone(ipcFrom(contents, url, { mainFrame })), granted ? "allowed" : "refused", label);
      }
    }
  }
});

const REMOTE = "https://viernes.tail1.ts.net:9444";

test("a remote server may write clipboard text only as the active origin's main frame", () => {
  const write = "clipboard-sanitized-write";
  assert.equal(remoteClipboardWriteAllowed(write, `${REMOTE}/chat?x=1`, REMOTE, { isMainFrame: true }), true);
  assert.equal(remoteClipboardWriteAllowed(write, REMOTE, `${REMOTE}/`, { isMainFrame: true }), true);
  // Read and everything else stay denied for the same trusted origin.
  for (const permission of ["clipboard-read", "notifications", "fullscreen", "media", "geolocation", "camera", "openExternal", "unknown", undefined]) {
    assert.equal(remoteClipboardWriteAllowed(permission, REMOTE, REMOTE, { isMainFrame: true }), false, String(permission));
  }
  // Frame requirement: a child frame, or no frame information, never counts.
  for (const details of [{ isMainFrame: false }, {}, undefined, null, { isMainFrame: "true" }]) {
    assert.equal(remoteClipboardWriteAllowed(write, REMOTE, REMOTE, details), false);
  }
  // Exact origin only.
  for (const requesting of [
    "https://viernes.tail1.ts.net:9445/", "https://viernes.tail1.ts.net/", "http://viernes.tail1.ts.net:9444/",
    "https://other.tail1.ts.net:9444/", "https://viernes.tail1.ts.net.evil.test:9444/", "https://evil.test/#https://viernes.tail1.ts.net:9444",
    "about:blank", "data:text/html,x", "javascript:alert(1)", "not a url", "", null, undefined,
  ]) assert.equal(remoteClipboardWriteAllowed(write, requesting, REMOTE, { isMainFrame: true }), false, String(requesting));
  // No active remote server (Local, or a damaged value): nothing to match.
  for (const active of [undefined, null, "", "not a url", "about:blank", "data:text/html,x"]) {
    assert.equal(remoteClipboardWriteAllowed(write, REMOTE, active, { isMainFrame: true }), false, String(active));
    assert.equal(remoteClipboardWriteAllowed(write, "about:blank", active, { isMainFrame: true }), false);
  }
});

test("the base policy itself still grants a remote origin nothing", () => {
  for (const permission of ["clipboard-sanitized-write", "clipboard-read", "notifications", "fullscreen"]) {
    assert.equal(appPermissionAllowed(permission, REMOTE, LOCAL_ORIGIN, { isMainFrame: true }), false, permission);
  }
});