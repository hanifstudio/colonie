import { expect, test } from "vitest";
import { mentionChoicesForQuery, mentionQueryAt, replaceMentionQuery } from "./mentions";

test("mention queries follow a collapsed caret, including multiword and long names", () => {
  const text = "Before @Hilmi Anugrah Bela Negara after";
  const caret = text.indexOf(" after");
  expect(mentionQueryAt(text, caret)).toEqual({ start: 7, end: caret, query: "Hilmi Anugrah Bela Negara" });
  expect(mentionQueryAt(text, caret, caret + 1)).toBeNull();
  expect(mentionQueryAt("(@Nimbus", 8)?.query).toBe("Nimbus");
  expect(mentionQueryAt("@" + "a".repeat(60), 61)?.query).toHaveLength(60);
  expect(mentionQueryAt("@小林 さく", 6)?.query).toBe("小林 さく");
});

test("emails, URL paths, and text across a newline do not open a mention picker", () => {
  for (const text of ["me@example.com", "https://x.test/@Nimbus", "@Nimbus\nother text", "@Nimbus\rother text"]) {
    expect(mentionQueryAt(text, text.length)).toBeNull();
  }
});

test("every matching person remains reachable; a completed name closes suggestions", () => {
  const choices = Array.from({ length: 20 }, (_, i) => ({ name: `Research Assistant ${i}` }));
  expect(mentionChoicesForQuery(choices, "assistant")).toHaveLength(20);
  expect(mentionChoicesForQuery(choices, "Research Assistant 1 ")).toEqual([]);
  expect(mentionChoicesForQuery([{ name: "Bob Hartono" }], "BOB HA")).toEqual([{ name: "Bob Hartono" }]);
});

test("completing a mention in the middle preserves later text and its spacing", () => {
  const text = "Before @Bob Ha after";
  const next = replaceMentionQuery(text, mentionQueryAt(text, 14)!, "Bob Hartono");
  expect(next.text).toBe("Before @Bob Hartono after");
  expect(next.caret).toBe("Before @Bob Hartono ".length);
  const newline = "@Bob\nnext line";
  expect(replaceMentionQuery(newline, mentionQueryAt(newline, 4)!, "Bob Hartono").text).toBe("@Bob Hartono\nnext line");
});

test("editing inside an existing mention replaces its whole name, keeping punctuation and Unicode", () => {
  const text = "Hi @Bob Hartono, thanks";
  expect(replaceMentionQuery(text, mentionQueryAt(text, 8)!, "Bob Hartono").text).toBe("Hi @Bob Hartono, thanks");
  const word = "@小林さくら next";
  expect(replaceMentionQuery(word, mentionQueryAt(word, 3)!, "小林さくら").text).toBe("@小林さくら next");
});
