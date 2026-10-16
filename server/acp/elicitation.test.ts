// A form elicitation is the shape Claude's AskUserQuestion arrives in over ACP
// (bridged by the claude adapter) and the shape an MCP server asks its client
// for input in. What has to hold: the questions and options the person sees are
// the model's own, the answer goes back under the keys the form wrote, and an
// option whose value differs from its label answers with the value.
import { describe, expect, it } from "vitest";
import { elicitationAnswerContent, parseElicitationAsk } from "./elicitation.ts";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";

function form(requestedSchema: unknown, message = "Which color?"): CreateElicitationRequest {
  return { mode: "form", sessionId: "s-1", message, requestedSchema } as CreateElicitationRequest;
}

const COLORS = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      oneOf: [
        { const: "Blue", title: "Blue", description: "the sky" },
        { const: "Green", title: "Green" },
      ],
    },
    question_0_custom: { type: "string", title: "Other" },
  },
};

describe("parseElicitationAsk", () => {
  it("reads a single question's own message and its options", () => {
    const ask = parseElicitationAsk(form(COLORS));
    expect(ask?.questions).toHaveLength(1);
    expect(ask?.questions[0]).toMatchObject({
      question: "Which color?",
      options: [{ label: "Blue", description: "the sky" }, { label: "Green" }],
    });
    // the per-question "Other" companion is not a question of its own
    expect(ask?.fields.map((field) => field.key)).toEqual(["question_0"]);
  });

  it("reads several questions by their field order, each with its own text", () => {
    const ask = parseElicitationAsk(form({
      type: "object",
      properties: {
        question_1: { type: "string", title: "Model", description: "Which model?", oneOf: [{ const: "a", title: "A" }] },
        question_0: { type: "string", title: "Place", description: "Where?", oneOf: [{ const: "b", title: "B" }] },
      },
    }, "Please answer the following questions."));
    expect(ask?.questions.map((question) => question.question)).toEqual(["Where?", "Which model?"]);
    expect(ask?.questions.map((question) => question.header)).toEqual(["Place", "Model"]);
  });

  it("marks an array field as multi-select", () => {
    const ask = parseElicitationAsk(form({
      type: "object",
      properties: {
        question_0: { type: "array", items: { anyOf: [{ const: "Blue", title: "Blue" }, { const: "Green", title: "Green" }] } },
      },
    }));
    expect(ask?.questions[0]?.multiSelect).toBe(true);
    expect(ask?.questions[0]?.options.map((option) => option.label)).toEqual(["Blue", "Green"]);
  });

  it("accepts a plain enum of strings as the options", () => {
    const ask = parseElicitationAsk(form({ type: "object", properties: { question_0: { type: "string", enum: ["Blue", "Green"] } } }));
    expect(ask?.questions[0]?.options).toEqual([{ label: "Blue" }, { label: "Green" }]);
  });

  it("keeps a question with nothing to choose from — the card always offers free text", () => {
    const ask = parseElicitationAsk(form({ type: "object", properties: { question_0: { type: "string" } } }));
    expect(ask?.questions).toHaveLength(1);
    expect(ask?.questions[0]?.options).toEqual([]);
  });

  it("refuses anything that is not a form ask this app can present", () => {
    expect(parseElicitationAsk(form({ type: "object" }))).toBeNull();
    expect(parseElicitationAsk(form({ type: "object", properties: { answer: { type: "string" } } }))).toBeNull();
    expect(parseElicitationAsk({ mode: "url", sessionId: "s-1", message: "Sign in", url: "https://example.test", elicitationId: "e-1" } as CreateElicitationRequest)).toBeNull();
  });
});

describe("elicitationAnswerContent", () => {
  const ask = parseElicitationAsk(form(COLORS))!;

  it("answers a lone question with the flat answer the card sent", () => {
    expect(elicitationAnswerContent(ask, "Blue")).toEqual({ question_0: "Blue" });
  });

  it("reads the card's own Q:/A: block back to its question", () => {
    expect(elicitationAnswerContent(ask, "The user answered your questions.\n\nQ: Which color?\nA: Green")).toEqual({ question_0: "Green" });
  });

  it("answers with the option's value when the form titles it differently", () => {
    const titled = parseElicitationAsk(form({
      type: "object",
      properties: { question_0: { type: "string", oneOf: [{ const: "blue", title: "Blue" }] } },
    }))!;
    expect(elicitationAnswerContent(titled, "Blue")).toEqual({ question_0: "blue" });
  });

  it("answers a multi-select with the list of values", () => {
    const multi = parseElicitationAsk(form({
      type: "object",
      properties: { question_0: { type: "array", items: { anyOf: [{ const: "Blue", title: "Blue" }, { const: "Green", title: "Green" }] } } },
    }))!;
    expect(elicitationAnswerContent(multi, "Blue, Green")).toEqual({ question_0: ["Blue", "Green"] });
  });

  it("answers each of several questions, and nothing it was not told", () => {
    const many = parseElicitationAsk(form({
      type: "object",
      properties: {
        question_0: { type: "string", description: "Which color?", oneOf: [{ const: "Blue", title: "Blue" }] },
        question_1: { type: "string", description: "Which size?", oneOf: [{ const: "Small", title: "Small" }] },
      },
    }, "Please answer the following questions."))!;
    const content = elicitationAnswerContent(many, "The user answered your questions.\n\nQ: Which color?\nA: Blue\n\nQ: Which size?\nA: Small");
    expect(content).toEqual({ question_0: "Blue", question_1: "Small" });
  });

  it("keeps an answer the form never offered as the person's own words", () => {
    expect(elicitationAnswerContent(ask, "Chartreuse")).toEqual({ question_0: "Chartreuse" });
  });

  it("files nothing when the answer is empty", () => {
    expect(elicitationAnswerContent(ask, "   ")).toBeNull();
  });
});
