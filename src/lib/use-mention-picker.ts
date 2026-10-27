import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject, type TextareaHTMLAttributes } from "react";
import { mentionChoicesForQuery, mentionQueryAt, replaceMentionQuery } from "./mentions";

/** A single interaction model for bot DMs, human DMs, and groups. The native
 * textarea keeps selection, composition, and editing focus throughout. */
export function useMentionPicker<T extends { name: string }>({ text, choices, inputRef, onChange }: {
  text: string; choices: readonly T[]; inputRef: RefObject<HTMLTextAreaElement | null>; onChange: (text: string) => void;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const composition = useRef(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const query = focused && !composing ? mentionQueryAt(text, caret, selectionEnd) : null;
  const candidates = query && query.start !== dismissed ? mentionChoicesForQuery(choices, query.query) : [];
  const open = candidates.length > 0;
  const index = Math.min(highlight, Math.max(0, candidates.length - 1));
  useEffect(() => setHighlight(0), [query?.start, query?.query]);
  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, open, query?.start, query?.query]);
  const selected = (input: HTMLTextAreaElement) => { setCaret(input.selectionStart); setSelectionEnd(input.selectionEnd); };
  const changed = (input: HTMLTextAreaElement) => { selected(input); setDismissed(null); };
  const isComposing = (event: KeyboardEvent<HTMLTextAreaElement>) => composition.current || event.nativeEvent.isComposing || event.keyCode === 229;
  const pick = (choice: T) => {
    const input = inputRef.current;
    if (!query || !input || composition.current) return;
    const next = replaceMentionQuery(text, query, choice.name);
    input.focus();
    input.setSelectionRange(next.start, next.end);
    // Native insertion retains the browser's undo buffer. setRangeText is
    // the fallback for engines without insertText support. Undo is the reason
    // to retain this narrow, tested use of the deprecated editing API:
    // https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, next.inserted); } catch { /* use native range replacement below */ }
    if (!inserted) input.setRangeText(next.inserted, next.start, next.end, "end");
    onChange(input.value);
    input.setSelectionRange(next.caret, next.caret);
    selected(input); setDismissed(query.start);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event) || !open || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(candidates[index]!); return true; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(query!.start); return true; }
    return false;
  };
  // Keep the textarea's multiline textbox semantics. HTML does not permit
  // replacing a textarea's native role with combobox:
  // https://www.w3.org/TR/html-aria/#el-textarea
  const inputProps: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    "aria-autocomplete": "list", "aria-haspopup": "listbox",
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant": open ? `${listId}-${index}` : undefined,
    onSelect: (event) => selected(event.currentTarget),
    onKeyUp: (event) => selected(event.currentTarget),
    onClick: (event) => selected(event.currentTarget),
    onFocus: (event) => { selected(event.currentTarget); setFocused(true); },
    onBlur: () => setFocused(false),
    onCompositionStart: () => { composition.current = true; setComposing(true); },
    onCompositionEnd: (event) => { composition.current = false; setComposing(false); changed(event.currentTarget); },
  };
  return { caret, setCaret, changed, candidates, open, highlight: index, setHighlight, pick, keyDown, isComposing, listId, listRef, inputProps,
    optionId: (at: number) => `${listId}-${at}` };
}
