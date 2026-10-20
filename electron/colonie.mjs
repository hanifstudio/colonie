import { app } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { colonieHome, colonieUserData, initializeColonieData } from "./colonie-config.mjs";
import { activeWorkspace } from "./local-workspaces.mjs";

// Only isolated deterministic checks enable this flag. Normal diagnostic
// exports keep the metadata-only crash records from diagnostics.mjs.
if (process.env.COLONIE_TEST_ACP_FIXTURE === "1") process.on("uncaughtExceptionMonitor", (error) => console.error(error.stack));

app.setName("Colonie");
// The app's own folder is settled before anything reads the workspace list,
// because the list lives in it.
app.setPath("userData", colonieUserData(app.getPath("appData")));
app.setAppLogsPath(join(app.getPath("userData"), "logs"));

// The data directory belongs to the workspace, not to the app. Resolving it
// here means everything downstream — the lease, the server child, the window —
// runs the workspace the person last chose, so a second workspace needs no
// second installation. An explicit COLONIE_DATA_DIR still wins and still means
// "the default workspace, here": that is the developer and rig escape.
//
// The resolved directory is deliberately not written back into the environment.
// A value written there is read as that same override, so every start would
// fall back to the first workspace and the list could never change anything.
const dataDir = activeWorkspace({ home: colonieHome(homedir()), userData: app.getPath("userData") }).dir;
initializeColonieData(dataDir);
if (app.isPackaged && process.env.COLONIE_TEST_ACP_FIXTURE !== "1") process.env.COLONIE_ACP_ENTRY = join(process.resourcesPath, "codex-acp", "dist", "index.js");
if (app.isPackaged && process.env.COLONIE_TEST_ACP_FIXTURE !== "1") process.env.COLONIE_CLAUDE_ACP_ENTRY = join(process.resourcesPath, "claude-acp", "index.js");
if (app.isPackaged) process.env.CLAUDE_CODE_EXECUTABLE = join(process.resourcesPath, "claude-acp", "claude-native");
await import("./main.mjs");
