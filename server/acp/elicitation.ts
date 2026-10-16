/**
 * ACP elicitations re-read as Colonie's own question cards.
 *
 * `AskUserQuestion` has no ACP-native shape. The claude adapter bridges it to a
 * form elicitation (`elicitation/create`, mode "form") — one property per
 * question, keyed `question_<n>`: a `oneOf` enum for a single-select, an array
 * with an `anyOf` item enum for a multi-select, and a `question_<n>_custom`
 * free-text field beside each one — and an MCP server that asks its client for
 * input arrives the same way. Both are the person's own question, so the ask is
 * re-read here into the questions and options the card renders, and their
 * answer is written back under the form's own keys so the adapter can fold it
 * into the tool or server call it came from.
 *
 * The payload is agent- and server-authored, so every field is validated
 * rather than cast, and the counts and lengths are capped exactly as the native
 * tool's parser caps them (`shared/ask-question.ts`).
 */
import { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import {
  MAX_OPTIONS, MAX_QUESTIONS,
  questionAnswersById,
  type AskQuestion, type AskQuestionOption,
} from "../../shared/ask-question.ts";

/** One option as the form offered it: the label a person sees, beside the
 * `const` the schema expects back. They are the same string for every adapter
 * today, but a form that titles an option differently from its value must
 * still answer with the value it offered. */
export interface ElicitationChoice {
  label: string;
  value: string;
  description?: string;
}

/** One form field, paired with the question the card renders for it. */
export interface ElicitationField {
  /** The property key the answer travels back under (`question_<n>`). */
  key: string;
  choices: ElicitationChoice[];
  multiSelect: boolean;
  question: AskQuestion;
}

export interface ElicitationAsk {
  questions: AskQuestion[];
  fields: ElicitationField[];
}

const FIELD_KEY = /^question_(\d+)$/;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit).trim() : undefined;
}

/** The enum entries of a property, whichever way the schema spelled them. */
function enumEntries(property: Record<string, unknown>): unknown[] | null {
  const items = isRecord(property.items) ? property.items : undefined;
  for (const source of [property.oneOf, property.enum, items?.anyOf, items?.enum]) {
    if (Array.isArray(source)) return source;
  }
  return null;
}

function choicesOf(property: Record<string, unknown>): ElicitationChoice[] {
  const choices: ElicitationChoice[] = [];
  const seen = new Set<string>();
  for (const raw of enumEntries(property) ?? []) {
    // A bare string is the obvious degradation and costs one line to accept.
    const constValue = typeof raw === "string" ? raw : isRecord(raw) ? text(raw.const, MAX_LABEL) : undefined;
    const title = isRecord(raw) ? text(raw.title, MAX_LABEL) : undefined;
    const value = constValue ?? title;
    const label = title ?? constValue;
    // Duplicate labels are the one thing a radio group cannot survive: the
    // answer text could no longer say which row was picked.
    if (!value || !label || seen.has(label)) continue;
    seen.add(label);
    const description = isRecord(raw) ? text(raw.description, MAX_DESCRIPTION) : undefined;
    choices.push({ label, value, ...(description ? { description } : {}) });
    if (choices.length === MAX_OPTIONS) break;
  }
  return choices;
}

/** The question's own options, in the shape the card renders. */
function optionsOf(choices: readonly ElicitationChoice[]): AskQuestionOption[] {
  return choices.map(({ label, description }) => description ? { label, description } : { label });
}

/**
 * The questions behind a form elicitation, or null when it is not a form ask
 * this app can present. Counts, labels and question text are capped, and a
 * property that yields no usable question is skipped rather than fatal.
 */
export function parseElicitationAsk(request: CreateElicitationRequest): ElicitationAsk | null {
  if (!CreateElicitationRequest.isForm(request)) return null;
  const message = text(request.message, 8_000);
  const schema = isRecord(request.requestedSchema) ? request.requestedSchema : undefined;
  const properties = schema && isRecord(schema.properties) ? schema.properties : undefined;
  if (!message || !properties) return null;
  // The card asks them in order; the schema's key order is not part of the
  // protocol, so the index in the key is what orders them.
  const keys = Object.keys(properties)
    .filter((key) => FIELD_KEY.test(key))
    .sort((left, right) => Number(FIELD_KEY.exec(left)![1]) - Number(FIELD_KEY.exec(right)![1]))
    .slice(0, MAX_QUESTIONS);
  const fields: ElicitationField[] = [];
  for (const key of keys) {
    const property = properties[key];
    if (!isRecord(property)) continue;
    const choices = choicesOf(property);
    // One question carries its text as the elicitation's own message; several
    // repeat each question in its field. A header is the field's title either
    // way (the adapter sets it from the model's short tab label).
    const header = text(property.title, MAX_LABEL);
    const question = keys.length === 1 ? message : text(property.description, 8_000) ?? header ?? message;
    if (!question) continue;
    fields.push({
      key,
      choices,
      multiSelect: property.type === "array",
      question: {
        question,
        ...(header ? { header } : {}),
        ...(property.type === "array" ? { multiSelect: true } : {}),
        options: optionsOf(choices),
      },
    });
  }
  return fields.length ? { fields, questions: fields.map((field) => field.question) } : null;
}

/**
 * The form content a person's answer becomes: one entry per question they
 * actually answered, keyed by the property the adapter wrote. The card sends
 * one answer for the whole card, so it is read back per question exactly as a
 * native ask's answer is (`questionAnswersById`) — the whole message answers a
 * single question, and a card with several arrives as Q:/A: blocks.
 *
 * A single-select carries one string; a multi-select carries the list. Values
 * prefer the option's own `const` over the label it displayed.
 */
export function elicitationAnswerContent(
  ask: ElicitationAsk,
  message: string,
): Record<string, string | string[]> | null {
  const answered = questionAnswersById(message, ask.fields.map((field) => ({ id: field.key, question: field.question })));
  const content: Record<string, string | string[]> = {};
  for (const field of ask.fields) {
    const answer = answered[field.key];
    if (!answer) continue;
    const picks = field.multiSelect
      ? answer.split(", ").map((part) => part.trim()).filter(Boolean)
      : [answer.trim()];
    if (!picks.length) continue;
    const values = picks.map((pick) => field.choices.find((choice) => choice.label === pick)?.value ?? pick);
    content[field.key] = field.multiSelect ? values : values[0]!;
  }
  return Object.keys(content).length ? content : null;
}
