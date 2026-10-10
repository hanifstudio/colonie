// Ship the pinned maintained adapter and its compatible native Codex dependency.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const destination = resolve("dist-devone/codex-acp");
const adapterEntry = require.resolve("@agentclientprotocol/codex-acp");
const adapterRoot = dirname(dirname(adapterEntry));
const adapterRequire = createRequire(adapterEntry);
const codexEntry = adapterRequire.resolve("@openai/codex/bin/codex.js");
const codexRoot = dirname(dirname(codexEntry));
const codexRequire = createRequire(codexEntry);
const platformName = `@openai/codex-${process.platform}-${process.arch}`;
const nativeRoot = dirname(codexRequire.resolve(`${platformName}/package.json`));
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(adapterRoot, destination, { recursive: true, dereference: true });
const scoped = join(destination, "node_modules", "@openai");
mkdirSync(scoped, { recursive: true });
cpSync(codexRoot, join(scoped, "codex"), { recursive: true, dereference: true });
cpSync(nativeRoot, join(scoped, platformName.split("/")[1]), { recursive: true, dereference: true });
const manifest = {
  platform: process.platform, arch: process.arch,
  adapter: JSON.parse(readFileSync(join(adapterRoot, "package.json"), "utf8")).version,
  codex: JSON.parse(readFileSync(join(codexRoot, "package.json"), "utf8")).version,
};
writeFileSync(join(destination, "devone-runtime.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ destination, ...manifest }));

const claudeDestination = resolve("dist-devone/claude-acp");
mkdirSync(claudeDestination, { recursive: true });
const claudeEntry = require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
const claudeRequire = createRequire(claudeEntry);
const sdkEntry = claudeRequire.resolve("@anthropic-ai/claude-agent-sdk");
const sdkRequire = createRequire(sdkEntry);
const claudeNative = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
await build({ entryPoints: [claudeEntry], bundle: true, platform: "node", format: "esm", target: "node24",
  outfile: join(claudeDestination, "index.js"),
  banner: { js: "import {createRequire as __colonieRequire} from 'node:module'; const require=__colonieRequire(import.meta.url);" },
});
cpSync(claudeNative, join(claudeDestination, "claude-native"));
writeFileSync(join(claudeDestination, "package.json"), JSON.stringify({ type: "module" }));
const claudeRoot = dirname(dirname(claudeEntry));
cpSync(join(claudeRoot, "LICENSE"), join(claudeDestination, "LICENSE"));
cpSync(join(dirname(sdkEntry), "LICENSE.md"), join(claudeDestination, "Claude-Agent-SDK-LICENSE.md"));
const claudeManifest = { platform: process.platform, arch: process.arch, adapter: "0.88.0", sdk: "0.3.293" };
writeFileSync(join(claudeDestination, "colonie-runtime.json"), JSON.stringify(claudeManifest, null, 2));
console.log(JSON.stringify({ destination: claudeDestination, ...claudeManifest }));
