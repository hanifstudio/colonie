// Running a thread-title one-shot: the cheap provider call behind a fresh
// thread's name and the "Regenerate title" action.
//
// The prompt itself lives in thread-title.ts; this is only the call and its
// bounds, plus the set that keeps Regenerate to one one-shot per thread.
import { titleFromLlm } from "../../persistence/store.ts";
import { threadTitlePrompt, type ThreadTitleSource } from "./thread-title.ts";

/** A short title for a fresh thread, from the provider's cheap one-shot
 * (generateText — Haiku on Claude, the chat completion endpoint's text
 * path on OpenAI-compatible engines). Null whenever that call cannot run,
 * runs long, or answers with something that is not a plain short title;
 * the caller keeps the snippet it already applied. "conversation" names an
 * existing thread from titleConversationExcerpt (Regenerate title). */
export async function generateThreadTitle(
  provider: { generateText?: (prompt: string, options?: { signal?: AbortSignal }) => Promise<string> },
  text: string,
  source: ThreadTitleSource = "first-message",
): Promise<string | null> {
  const prompt = threadTitlePrompt(text, source);
  const expiry = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // the race caps the wait; the signal aborts the provider call itself,
    // which every generateText driver that can honor it does
    const reply = await Promise.race([
      provider.generateText!(prompt, { signal: expiry.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expiry.abort();
          reject(new Error("thread title timed out"));
        }, 10_000);
      }),
    ]);
    return titleFromLlm(reply);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Threads whose Regenerate title one-shot is still running: one at a time. */
export const titleRegenerations = new Set<string>();
