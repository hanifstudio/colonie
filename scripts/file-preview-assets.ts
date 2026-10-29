import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Distribute the notices alongside the renderer and the bundled font files. */
export function filePreviewAssets(): Plugin {
  const modules = fileURLToPath(new URL("../node_modules/", import.meta.url));
  return {
    name: "file-preview-assets",
    generateBundle() {
      const files = ["@betteroffice/docx/LICENSE", "@betteroffice/docx-react/LICENSE", "@betteroffice/fonts/LICENSE", "pdfjs-dist/LICENSE"];
      const fontLicenses = join(modules, "@betteroffice/fonts/LICENSES");
      for (const name of readdirSync(fontLicenses).sort()) files.push(`@betteroffice/fonts/LICENSES/${name}`);
      const source = files.map((name) => `${name}\n\n${readFileSync(join(modules, name), "utf8")}`).join("\n\n----------------------------------------\n\n");
      this.emitFile({ type: "asset", fileName: "licenses/file-preview.txt", source });
    },
  };
}
