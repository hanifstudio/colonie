import { expect, test } from "vitest";
import {
  forgetKey,
  keyRejected,
  KEY_REJECTED_REASON,
  noteKeyAccepted,
  noteKeyRejected,
  onKeyRejectionChange,
  rejectsKey,
} from "./key-rejections.ts";

const URL = "https://api.example.com/v1";

test("a rejection is the key's fault, and only then", () => {
  expect(rejectsKey(401, "")).toBe(true);
  expect(rejectsKey(400, '{"error":{"message":"Invalid API key"}}')).toBe(true);
  expect(rejectsKey(403, "API key is invalid")).toBe(true);
  expect(rejectsKey(400, '{"error":"invalid_api_key"}')).toBe(true);
  expect(rejectsKey(403, "Your API key was revoked")).toBe(true);
  expect(rejectsKey(400, "api key is expired")).toBe(true);
  // Noted, not changed: recognition needs the phrase "api key" (or an adjective
  // directly before "key"). "has expired" and a bare "key was revoked" are not
  // recognised today.
  expect(rejectsKey(400, "this api key has expired")).toBe(false);
  expect(rejectsKey(403, "Your key was revoked")).toBe(false);
});

test("quota, billing and rate limits are never the key's fault", () => {
  expect(rejectsKey(403, "Your quota has been exceeded")).toBe(false);
  expect(rejectsKey(400, "insufficient balance")).toBe(false);
  expect(rejectsKey(429, "rate limit reached")).toBe(false);
  // the quota rule is read before the status, even on a 401
  expect(rejectsKey(401, "rate limit reached")).toBe(false);
  expect(rejectsKey(403, "this model is not included in your plan")).toBe(false);
  expect(rejectsKey(500, "invalid api key")).toBe(false);
  expect(rejectsKey(403, "forbidden")).toBe(false);
});

test("a saved key counts as working until a real use says otherwise", () => {
  expect(keyRejected(URL, "sk-one")).toBe(false);

  noteKeyRejected(URL, "sk-one");

  expect(keyRejected(URL, "sk-one")).toBe(true);
  expect(keyRejected(URL, "sk-two")).toBe(false);
  expect(KEY_REJECTED_REASON).toContain("Settings");
});

test("a mark belongs to the key and the endpoint, and a trailing slash is the same endpoint", () => {
  noteKeyRejected(`${URL}`, "sk-three");

  expect(keyRejected(`${URL}/`, "sk-three")).toBe(true);
  expect(keyRejected("https://api.other.com/v1", "sk-three")).toBe(false);
  // and the key is compared after trimming
  expect(keyRejected(URL, "  sk-three  ")).toBe(true);
});

test("a later accepted use clears the mark, and saving or clearing drops every mark", () => {
  noteKeyRejected(URL, "sk-four");
  noteKeyRejected("https://api.other.com/v1", "sk-four");

  noteKeyAccepted(URL, "sk-four");
  expect(keyRejected(URL, "sk-four")).toBe(false);
  expect(keyRejected("https://api.other.com/v1", "sk-four")).toBe(true);

  forgetKey("sk-four");
  expect(keyRejected("https://api.other.com/v1", "sk-four")).toBe(false);
});

test("listeners hear a change once, and stop when they unsubscribe", () => {
  const heard: number[] = [];
  const stop = onKeyRejectionChange(() => heard.push(heard.length + 1));

  noteKeyRejected(URL, "sk-five");
  noteKeyRejected(URL, "sk-five");
  noteKeyAccepted(URL, "sk-five");
  expect(heard).toHaveLength(2);

  stop();
  noteKeyRejected(URL, "sk-six");
  expect(heard).toHaveLength(2);
});