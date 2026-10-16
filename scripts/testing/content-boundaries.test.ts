import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function valueImports(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement) => {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) return [];
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((binding) => binding.isTypeOnly)) return [];
    } else {
      if (statement.isTypeOnly) return [];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.length > 0
        && statement.exportClause.elements.every((binding) => binding.isTypeOnly)) return [];
    }
    return [statement.moduleSpecifier.text];
  });
}

describe("shared content boundaries", () => {
  it.each(["server/index.ts", "server/workspace-backup.ts"])(
    "%s has no static renderer value imports",
    (consumer) => {
      const path = resolve(ROOT, consumer);
      const rendererRoot = resolve(ROOT, "src") + sep;
      const forbidden = valueImports(path).filter((specifier) =>
        specifier.startsWith("@/")
        || (specifier.startsWith(".") && resolve(dirname(path), specifier).startsWith(rendererRoot)));
      expect(forbidden).toEqual([]);
    },
  );

  // Modules whose storage location is chosen by their caller (E02). Add a module
  // here when it stops reading `DATA_DIR`; type-only imports of config are fine.
  it.each([
    "server/colonie/connections/policy.ts",
    "server/colonie/connections/manager.ts",
    "server/colonie/connections/routes.ts",
    "server/profile-learned.ts",
  ])(
    "%s gets its storage from its caller, not global config",
    (module) => {
      const path = resolve(ROOT, module);
      const config = resolve(ROOT, "server/config.ts");
      const forbidden = valueImports(path).filter((specifier) =>
        specifier.startsWith(".") && resolve(dirname(path), specifier) === config);
      expect(forbidden).toEqual([]);
    },
  );

  it.each(["shared/transcript-attachments.ts", "shared/thread-address.ts"])(
    "%s has no static application-layer imports",
    (module) => {
      const path = resolve(ROOT, module);
      const sharedRoot = resolve(ROOT, "shared") + sep;
      const forbidden = valueImports(path).filter((specifier) =>
        specifier.startsWith("@/")
        || (specifier.startsWith(".") && !resolve(dirname(path), specifier).startsWith(sharedRoot)));
      expect(forbidden).toEqual([]);
    },
  );
});
