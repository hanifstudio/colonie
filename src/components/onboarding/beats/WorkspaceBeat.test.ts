// The workspace step is the one place the first-run flow offers a choice, and
// the option that cannot work yet must never read as usable. A render check
// keeps both true without a browser; the flow itself has no other unit test.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceBeat } from "./WorkspaceBeat.tsx";

function render(): string {
  return renderToStaticMarkup(
    createElement(WorkspaceBeat, {
      onNext: () => {},
      onSkip: () => {},
      setMascot: () => {},
      bump: () => {},
    }),
  );
}

/** The cards are buttons; the last one is the step's Continue. */
function rows(html: string): string[] {
  return html.split("<button").slice(1);
}

describe("the workspace step", () => {
  it("offers Local as the chosen kind and Server as unavailable", () => {
    const [local, server, next] = rows(render());

    expect(local).toContain("Local");
    expect(local).toContain("On this computer. Free, and no account needed.");
    expect(local).toContain('aria-checked="true"');
    expect(local).not.toContain("disabled");

    expect(server).toContain("Server");
    expect(server).toContain("Coming later");
    expect(server).toContain('aria-checked="false"');
    expect(server).toContain("disabled");
    expect(server).toContain("cursor-not-allowed");

    expect(next).toContain("Continue");
  });

  it("says where the workspace lives before the engines are set up", () => {
    const html = render();
    expect(html).toContain("Your bots, conversations and connections live together in a workspace.");
    expect(html).toContain("Yours runs on this computer. Server workspaces are on the way.");
  });
});
