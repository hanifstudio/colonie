import { app } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { colonieDataDir, colonieUserData, initializeColonieData } from "./colonie-config.mjs";

// Only isolated deterministic checks enable this flag. Normal diagnostic
// exports keep the metadata-only crash records from diagnostics.mjs.
if (process.env.COLONIE_TEST_ACP_FIXTURE === "1") process.on("uncaughtExceptionMonitor", (error) => console.error(error.stack));

process.env.COLONIE_DATA_DIR = colonieDataDir(homedir());
initializeColonieData(process.env.COLONIE_DATA_DIR);
if (app.isPackaged && process.env.COLONIE_TEST_ACP_FIXTURE !== "1") process.env.COLONIE_ACP_ENTRY = join(process.resourcesPath, "codex-acp", "dist", "index.js");
if (app.isPackaged && process.env.COLONIE_TEST_ACP_FIXTURE !== "1") process.env.COLONIE_CLAUDE_ACP_ENTRY = join(process.resourcesPath, "claude-acp", "index.js");
if (app.isPackaged) process.env.CLAUDE_CODE_EXECUTABLE = join(process.resourcesPath, "claude-acp", "claude-native");
app.setName("Colonie");
app.setPath("userData", colonieUserData(app.getPath("appData")));
app.setAppLogsPath(join(app.getPath("userData"), "logs"));
await import("./main.mjs");
