// The HugeIcons wrapper keeps Lucide-like call-site semantics: a size, a
// 2-unit stroke default, and straight SVG passthrough.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";

describe("HIcon", () => {
  it("renders an svg with Lucide-like defaults and passthrough props", () => {
    const html = renderToStaticMarkup(
      createElement(HIcon, { icon: AttachmentIcon, size: 17, className: "shrink-0", "aria-hidden": true }),
    );
    expect(html).toMatch(/^<svg/);
    expect(html).toContain('width="17"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('class="shrink-0"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("M19.5 12.0001");
  });

  it("honours an explicit stroke width", () => {
    const html = renderToStaticMarkup(createElement(HIcon, { icon: AttachmentIcon, strokeWidth: 2.5 }));
    expect(html).toContain('stroke-width="2.5"');
  });
});
