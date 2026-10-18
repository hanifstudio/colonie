// The request handler is the one place every HTTP request goes through, so the
// cheap thing worth guarding is that the module still loads and still hands back
// a callable handler: a missing export or a broken top-level statement would
// otherwise only show up when the server boots. Route behaviour itself is
// covered by the route tests, which drive this same module through the table.
import { expect, test } from "vitest";
import { createRequestHandler } from "./request-handler.ts";

test("the front door hands back a callable async handler", () => {
  expect(createRequestHandler({} as never)).toBeInstanceOf(Function);
});

test("building the handler does not read any of the wiring", () => {
  // In index.ts the server object and several counters are declared below the
  // wiring point, so the handler must only touch them once a request arrives.
  const touched: string[] = [];
  createRequestHandler({
    server: () => touched.push("server"),
    setCustomDomainRevision: () => touched.push("revision"),
  } as never);
  expect(touched).toEqual([]);
});