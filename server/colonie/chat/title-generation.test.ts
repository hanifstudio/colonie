// The title one-shot must stay bounded: a slow or misbehaving provider can
// neither hang the caller nor name a thread with something that is not a
// plain short title.
import { expect, test, vi } from "vitest";
import { generateThreadTitle, titleRegenerations } from "./title-generation.ts";

function provider(impl?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>) {
  return { generateText: impl } as never;
}

test("a plain short answer names the thread", async () => {
  const title = await generateThreadTitle(provider(async () => '"Deploy the release"'), "ship it");
  expect(title).toBe("Deploy the release");
});

test("the prompt asks the conversation form when regenerating", async () => {
  let seen = "";
  await generateThreadTitle(provider(async (prompt) => { seen = prompt; return "Anything"; }), "User: hi\nBot: hello", "conversation");
  expect(seen).toContain("Name the conversation below");
});

test("an answer that is not a plain short title is refused", async () => {
  const long = "x".repeat(60);
  expect(await generateThreadTitle(provider(async () => long), "hi")).toBeNull();
  expect(await generateThreadTitle(provider(async () => "   "), "hi")).toBeNull();
});

test("a provider with no one-shot text path yields no title", async () => {
  expect(await generateThreadTitle(provider(undefined), "hi")).toBeNull();
});

test("a slow one-shot is abandoned instead of hanging the caller", async () => {
  vi.useFakeTimers();
  try {
    const pending = generateThreadTitle(
      provider((_prompt, options) => new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
      "hi",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("Regenerate's one-at-a-time set starts empty and is shared", () => {
  expect(titleRegenerations.size).toBe(0);
  titleRegenerations.add("t1");
  expect(titleRegenerations.has("t1")).toBe(true);
  titleRegenerations.clear();
});
