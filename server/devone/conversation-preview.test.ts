import { expect, it } from "vitest";
import { conversationPreview } from "./conversation-preview.ts";

it("previews recent text rather than tool/digest rows and bounds normalized display text", () => {
  expect(conversationPreview([{ kind: "text", text: "A completed\n reply" }, { kind: "digest", text: "tool receipt" }, { kind: "activity", text: "internal tool log" }])).toBe("A completed reply");
  expect(conversationPreview([{ kind: "text", text: "Old branch" }, { kind: "text", text: "" }, { kind: "text", text: "Newest message" }])).toBe("Newest message");
  expect(conversationPreview([{ kind: "text", text: "a".repeat(500) }])).toHaveLength(180);
  expect(conversationPreview([])).toBe("");
});
