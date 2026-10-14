import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startPlatformHost, type PlatformHostConfig } from "../../server/colonie/platform/host.ts";

const file = process.env.COLONIE_PLATFORM_CONFIG;
if (!file) throw new Error("Set COLONIE_PLATFORM_CONFIG to the private platform configuration file.");
const config = JSON.parse(await readFile(file, "utf8")) as PlatformHostConfig;
config.runtimeRoot = resolve(dirname(file), config.runtimeRoot);
const host = await startPlatformHost(config);
console.log(`Colonie platform listening on ${host.origin}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void host.close().finally(() => process.exit(0));
});
