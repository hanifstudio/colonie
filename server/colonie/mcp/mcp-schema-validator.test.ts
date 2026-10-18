import { expect, test } from "vitest";
import {
  compileToolSchema,
  LENIENT_SCHEMA_CHARS,
  lenientSchema,
  lenientToolValidator,
  schemaProblems,
} from "./mcp-schema-validator.ts";

const objectSchema = {
  type: "object",
  properties: { n: { type: "integer" }, name: { type: "string" } },
  required: ["n"],
  additionalProperties: false,
} as const;

test("both supported dialects compile, and an unsupported one is refused by name", () => {
  const modern = compileToolSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { x: { type: "number" } } });
  expect(modern({ x: 1 })).toBe(true);

  expect(() => compileToolSchema({ $schema: "https://json-schema.org/draft-04/schema#", type: "string" }))
    .toThrow(/unsupported dialect/);
  expect(() => compileToolSchema({ type: "string", minLength: "two" })).toThrow(/could not be validated/);
});

test("a schema is a contract: nothing is coerced, defaulted or dropped", () => {
  const validate = compileToolSchema(objectSchema);

  expect(validate({ n: 1 })).toBe(true);
  expect(validate({ n: "5" })).toBe(false);
  expect(validate({})).toBe(false);
  // an undeclared field is not quietly removed
  expect(validate({ n: 1, extra: true })).toBe(false);

  const defaults = compileToolSchema({ type: "object", properties: { mode: { type: "string", default: "fast" } } });
  expect(defaults({})).toBe(true);
});

test("a keyword Ajv does not know is refused strictly and ignored leniently", () => {
  const odd = { type: "string", "x-company-field": true };

  expect(() => compileToolSchema(odd)).toThrow(/could not be validated/);
  expect(compileToolSchema(odd, { strict: false })("ok")).toBe(true);
});

test("the uint bounds are the point of the custom formats", () => {
  const validate = compileToolSchema({
    type: "object",
    properties: { a: { type: "integer", format: "uint32" }, b: { type: "integer", format: "uint64" } },
  });

  expect(validate({ a: 0, b: 0 })).toBe(true);
  expect(validate({ a: 4294967295, b: Number.MAX_SAFE_INTEGER })).toBe(true);
  expect(validate({ a: 4294967296 })).toBe(false);
  expect(validate({ a: -1 })).toBe(false);
  expect(validate({ b: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  expect(validate({ b: 1.5 })).toBe(false);
});

test("a complaint reads as a line a model can act on", () => {
  const validate = compileToolSchema({ ...objectSchema, properties: { company_id: { type: "string" } }, required: ["company_id"] }, { allErrors: true });
  validate({ company_id: 7, extra: 1 });

  const lines = schemaProblems(validate.errors);

  expect(lines).toContain("company_id: must be string");
  expect(lines).toContain("must NOT have additional properties (extra)");

  // the one error by default is the first one Ajv reports
  validate({});
  expect(schemaProblems(validate.errors)).toEqual(["must have required property 'company_id'"]);
  const missing = compileToolSchema({ ...objectSchema, properties: {}, required: ["company_id"] });
  missing({});
  expect(schemaProblems(missing.errors)).toEqual(["must have required property 'company_id'"]);

  const allowed = compileToolSchema({ type: "string", enum: ["a", "b"] });
  allowed("c");
  expect(schemaProblems(allowed.errors)[0]).toContain("[\"a\",\"b\"]");

  expect(schemaProblems(null)).toEqual([]);
  // the cap and the de-duplication are on the caller's list, so produce two real ones
  const twoMissing = compileToolSchema({ type: "object", required: ["a", "b"] }, { allErrors: true });
  twoMissing({});
  expect(schemaProblems(twoMissing.errors)).toHaveLength(2);
  expect(schemaProblems(twoMissing.errors, 1)).toHaveLength(1);
  const doubled = compileToolSchema({ type: "string", enum: ["a"] }, { allErrors: true });
  doubled("z");
  expect(schemaProblems([...(doubled.errors ?? []), ...(doubled.errors ?? [])])).toHaveLength(1);
});

test("the forgiving copy drops what must not refuse a call, and only that", () => {
  const lenient = lenientSchema({
    type: "object",
    properties: { when: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", format: "date" } },
    patternProperties: { "^x-": { type: "string" } },
    additionalProperties: false,
    required: ["when"],
  }) as Record<string, unknown>;

  expect(JSON.stringify(lenient)).not.toContain("pattern");
  expect(lenient).not.toHaveProperty("patternProperties");
  // opened by patternProperties, so a strict reading must not refuse unknown fields
  expect(lenient).not.toHaveProperty("additionalProperties");
  // and the real constraints stay
  expect(lenient).toHaveProperty("required");
  expect((lenient.properties as Record<string, unknown>).when).toEqual({ type: "string" });
});

test("a closed object stays closed when nothing opened it", () => {
  const lenient = lenientSchema(objectSchema) as Record<string, unknown>;

  expect(lenient.additionalProperties).toBe(false);
});

test("the forgiving check is forgiving where the server is not", () => {
  const schema = { type: "object", properties: { when: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, required: ["when"] };

  expect(compileToolSchema(schema)({ when: "yesterday" })).toBe(false);
  const lean = lenientToolValidator(schema);
  expect(lean).not.toBeNull();
  expect(lean!({ when: "yesterday" })).toBe(true);
  expect(lean!({})).toBe(false);
});

test("a schema not worth checking is left to the server", () => {
  expect(lenientToolValidator("not a schema")).toBeNull();
  expect(lenientToolValidator({ type: "object", properties: { big: { type: "string", description: "x".repeat(LENIENT_SCHEMA_CHARS) } } })).toBeNull();
  expect(lenientToolValidator({ type: "object", properties: { x: { type: "nope" } } })).toBeNull();
});