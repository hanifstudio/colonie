// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.colonie), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

// Main can finish loading the document before React subscribes: the one
// action it sends is "open Settings", with nothing the renderer could name.
let pendingSettingsAction = false;
const appSettingsListeners = new Set();
ipcRenderer.on("app:open-settings", () => {
  if (!appSettingsListeners.size) { pendingSettingsAction = true; return; }
  pendingSettingsAction = false;
  for (const listener of appSettingsListeners) listener();
});

// The bridge is built once, then exposed in full only to the local server's
// UI. A remote server's page (Server menu) gets the safe subset: nothing that
// captures this screen, touches this computer's files or logins, or runs
// helpers here. Main enforces the same rule on the sensitive channels.
const localOrigin = process.argv.find((arg) => arg.startsWith("--colonie-local-origin="))?.slice("--colonie-local-origin=".length) ?? null;
const isLocalPage = !localOrigin || location.origin === localOrigin;
const REMOTE_SAFE = new Set(["platform", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus", "workspaces"]);
// A paired server's page gets the safe subset only, and never this app's
// updater (which changes this computer's app, and only its own page may drive).


const bridge = {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  // Safe on any page: the user chooses in a native menu owned by Electron.
  // No direct switching, saved-list reads, host files or secrets.
  workspaces: {
    state: () => ipcRenderer.invoke("workspaces:state"),
    menu: () => ipcRenderer.invoke("workspaces:menu"),
    thisComputer: () => ipcRenderer.invoke("workspaces:this-computer"),
  },
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** Keep this computer awake for scheduled routines. The hold itself lives
   * in the main process; the page reads its state and flips the toggle. */
  routines: {
    wakeState: () => ipcRenderer.invoke("routines:wake-state"),
    keepAwake: (enabled) => ipcRenderer.invoke("routines:keep-awake", enabled),
  },
  /** Full/Custom and transitions out of Custom are deliberately unavailable
   * through the loopback API. The local renderer applies those changes over
   * the embedded server's private utilityProcess port. */
  approvals: {
    setMode: (botId, mode, options) => ipcRenderer.invoke("approvals:set-trusted-mode", botId, mode, options),
  },
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  /** One frame of this computer's screen as a data: URL when supported. */
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  /** Physical USB Android devices. Network ADB is deliberately excluded. */
  androidDevice: {
    status: () => ipcRenderer.invoke("android-device:status"),
    frame: (serial) => ipcRenderer.invoke("android-device:frame", serial),
    input: (serial, payload) =>
      ipcRenderer.invoke("android-device:input", serial, payload).then(() => undefined),
  },
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  /** The app menu's Preferences… item; local shell only (the remote-safe
   * subset never sees it). */
  onOpenAppSettings: (cb) => {
    appSettingsListeners.add(cb);
    queueMicrotask(() => {
      if (!pendingSettingsAction || !appSettingsListeners.size) return;
      pendingSettingsAction = false;
      for (const listener of appSettingsListeners) listener();
    });
    return () => appSettingsListeners.delete(cb);
  },
  /** Absolute path of a dropped File — Electron 32 removed File.path, and
   * only the preload can ask. "" when the drag carried no file on disk. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** {mic} TCC status strings: granted|denied|not-determined|unknown.
   * No screen field — macOS 15+ caches that status per-process, so any
   * value here would lie for the whole session after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  /** Triggers the macOS microphone prompt; resolves true when granted. */
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  /** Relaunch the local desktop app through its normal shutdown cleanup. */
  relaunch: () => ipcRenderer.invoke("desktop:relaunch"),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  signInTerminal: (engineId) => ipcRenderer.invoke("engine:sign-in-terminal", engineId),
  /** Writes plain text to the system clipboard; the copy button's fallback
   * when the web Clipboard API is rejected. Resolves false on failure. */
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  /** Open a web link in the default browser. Unlike renderer window.open,
   * this remains reliable after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  /** Tell the window which skin the page wears, so the native chrome the
   * renderer cannot paint (the Windows caption-button overlay) matches. */
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
  /** The renderer-drawn Windows caption buttons: minimize / restore /
   * maximize / close, plus live maximize state so the glyph can flip. */
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    state: () => ipcRenderer.invoke("window:state"),
    onMaximizedChanged: (cb) => {
      const handler = (_event, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", handler);
      return () => ipcRenderer.removeListener("window:maximized-changed", handler);
    },
  },
  /** A reviewed BotMRR package opened through colonie://install. */
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  /** Mirrors durable unread state into the native Dock/taskbar badge. */
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  /** Live VNC/noVNC in a sandboxed window owned by the app window. */
  desktopViewer: {
    open: (url, title, contextId) => ipcRenderer.invoke("desktop-viewer:open", url, title, contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-viewer:close", contextId),
    currentState: () => ipcRenderer.invoke("desktop-viewer:state-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  /** Two sandboxed Local VM viewers embedded in the owning app window. */
  desktopWorkspace: {
    open: (input) => ipcRenderer.invoke("desktop-workspace:open", input),
    layout: (items) => ipcRenderer.invoke("desktop-workspace:layout", items),
    setInteractive: (contextId) => ipcRenderer.invoke("desktop-workspace:set-interactive", contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-workspace:close", contextId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-workspace:state", handler);
      return () => ipcRenderer.removeListener("desktop-workspace:state", handler);
    },
  },
  /** Native folder picker for a bot's working folder; null when cancelled. */
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  /** Writes the redacted diagnostics report to a user-chosen file; resolves
   * the path, or null when the save dialog was cancelled. */
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  /** Ask where to save a bot-created file (inside ~/.colonie), copy it
   * there and reveal it. Returns the chosen path, or null if the user
   * cancelled the dialog. The chat bubble shows the
   * rejection text verbatim, so strip the "Error invoking remote method"
   * wrapper ipcRenderer adds around a main-process throw. */
  saveFile: (filePath) =>
    ipcRenderer.invoke("desktop:save-file", filePath).catch((error) => {
      const message = String(error?.message ?? error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    }),
  /** Point the file manager at a file a bot linked outside its workspace,
   * without opening it. Resolves "shown", "missing" or "invalid". */
  revealInFolder: (filePath) => ipcRenderer.invoke("desktop:reveal-file", filePath),
  /** Store a provider credential with OS-backed encryption. */
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),

  /** In-app auto-update. Updates download by themselves; install is the
   *  person's "Restart to update". State object:
   *  { status: "idle"|"checking"|"downloading"|"preparing"|"downloaded"|"installing"|"handed-off"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    install: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("update:install") : Promise.reject(new Error("Choose Restart to update.")),
    onState: (cb) => {
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => cb(s))
        .catch(() => {});
      const handler = (_event, s) => cb(s);
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },

  /** Saved servers and the active one (Server menu). Switching, adding and
   * forgetting are local-only: a remote page may read the list but not change
   * where this window goes. */
  environments: {
    state: () => ipcRenderer.invoke("environments:state"),
    switch: (id) => ipcRenderer.invoke("environments:switch", id),
    addFromLink: (link, name) => ipcRenderer.invoke("environments:add-from-link", link, name),
    forget: (id) => ipcRenderer.invoke("environments:forget", id),
    /** Settings → Servers, on a saved server's Computer access panel, or
     * ("copy") its Copy this computer here panel. */
    /** The workspace menu's New workspace / Shared workspace servers, on this computer's page. */
    onAction: (cb) => {
      const handler = (_event, action) => cb(action === "shared-servers" ? "shared-servers" : "new-workspace");
      ipcRenderer.on("workspaces:action", handler);
      return () => ipcRenderer.removeListener("workspaces:action", handler);
    },
    onOpenSettings: (cb) => {
      const handler = (_event, computerId, panel) => cb(computerId, panel === "copy" ? "copy" : undefined);
      ipcRenderer.on("workspaces:open-settings", handler);
      return () => ipcRenderer.removeListener("workspaces:open-settings", handler);
    },
  },
  confirm: message => ipcRenderer.invoke("dialog:confirm", message),

  /** Sign up or in to Colonie (on first opening the app) in a small window
   * of this app. Local-shell only; it opens Colonie Cloud's pages and
   * nothing else (electron/environments.cjs). */
  account: {
    openWindow: (url) => ipcRenderer.invoke("account:open-window", url),
  },

  /** The Local workspaces on this computer — a name and a data folder each —
   * and which one this app runs. Not the Server menu's saved servers, which is
   * `environments` above. Local-shell only: where this app's data lives is not
   * a remote page's to change. `switch` resolves
   * `{ ok: true, mode: "already-open" | "restart-app" | "reopen-colonie" }` or
   * `{ ok: false, code: "not-named" | "not-listed" | "in-use" }`. */
  localWorkspaces: {
    list: () => ipcRenderer.invoke("local-workspaces:list"),
    create: (name) => ipcRenderer.invoke("local-workspaces:create", name),
    switch: (id) => ipcRenderer.invoke("local-workspaces:switch", id),
  },
};

contextBridge.exposeInMainWorld(
  "colonie",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => REMOTE_SAFE.has(key))),
);
