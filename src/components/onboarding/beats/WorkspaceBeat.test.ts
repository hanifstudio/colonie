// The workspace step is where the first run splits: use Colonie on this
// computer, set up a Shared workspace on a server, or join one with an invite
// link. Each choice is real; the person goes straight to the path they came
// for. A render check keeps that true without a browser.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceBeat, type WorkspaceChoice } from "./WorkspaceBeat.tsx";

function render(choice?: WorkspaceChoice, shared = true): string {
  return renderToStaticMarkup(
    createElement(WorkspaceBeat, {
      onNext: () => {},
      onSkip: () => {},
      setMascot: () => {},
      bump: () => {},
      initialChoice: choice,
      onShared: shared ? () => {} : undefined,
    }),
  );
}

/** The cards are buttons; the last one is the step's continue button. */
function rows(html: string): string[] {
  return html.split("<button").slice(1);
}

describe("the workspace step", () => {
  it("offers three real choices, Local chosen to begin with", () => {
    const [local, create, join, next] = rows(render());
    expect(local).toContain("Local");
    expect(local).toContain('aria-checked="true"');
    expect(create).toContain("Set up a Shared workspace");
    expect(create).toContain('aria-checked="false"');
    expect(join).toContain("Join with an invite link");
    for (const row of [local, create, join]) expect(row).not.toContain("disabled");
    expect(next).toContain("Continue");
  });

  it("the continue button says where each choice goes", () => {
    expect(rows(render("create")).at(-1)).toContain("Set up a server");
    expect(rows(render("join")).at(-1)).toContain("Paste the invite link");
  });

  it("where Shared workspaces cannot be opened (a browser), only Local is offered", () => {
    const html = render(undefined, false);
    expect(html).toContain("Local");
    expect(html).not.toContain("Set up a Shared workspace");
    expect(html).not.toContain("Join with an invite link");
  });
});
