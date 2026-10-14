import { build } from "esbuild";
await build({ entryPoints: ["scripts/colonie/start-platform.ts"], bundle: true,
  packages: "external", platform: "node", format: "esm", target: "node24",
  outfile: "dist-platform/host.mjs", sourcemap: true,
});
await build({ entryPoints: ["scripts/colonie/verify-platform-neon.ts"], bundle: true,
  packages: "external", platform: "node", format: "esm", target: "node24",
  outfile: "dist-platform/verify-neon.mjs", sourcemap: true,
});
