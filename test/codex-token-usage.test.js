// One call, three token reports — and only one of them is a bill.
//
// Codex writes the same usage at three levels under the same field names: `usage` for the
// call, `turn_token_usage` for the turn so far, `thread_token_usage` for the whole thread.
// The cumulative two are running totals. Dropping only the turn total was not enough: the
// thread total was still kept, so every call was billed twice, the second time carrying the
// entire session's tokens. Measured on real rollouts, that inflated input tokens by 2x on a
// one-call thread and 216x on a long one.
//
// Synthetic throughout — a rollout is append-ordered text, so a fixture is the whole input.
import assert from "node:assert/strict";
import test from "node:test";

import { parseRollout, toEngineUsage } from "../src/codex.mjs";

const tokens = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: Math.floor(output / 2),
  total_tokens: input + output,
});

const line = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });

const turnContext = (model) =>
  line("2026-10-14T10:00:00.000Z", "turn_context", { turn_id: "t1", model });

// ------------------------------------------------------------------ the new writer ----

test("only the per-call report is billed, not the turn or the thread running total", () => {
  const lines = [
    turnContext("deepseek-flash"),
    // One call: 1000 in / 500 out, of which 400 read from cache.
    line("2026-10-14T10:00:01.000Z", "token_usage_record", {
      usage: tokens(1000, 400, 500),
      turn_token_usage: tokens(1000, 400, 500),
      thread_token_usage: tokens(900_000_000, 800_000_000, 1_500_000),
    }),
    // Second call in the same turn. Both cumulative levels have grown well past the call.
    line("2026-10-14T10:00:02.000Z", "token_usage_record", {
      usage: tokens(1100, 400, 300),
      turn_token_usage: tokens(2100, 800, 800),
      thread_token_usage: tokens(900_001_100, 800_000_400, 1_500_300),
    }),
  ];

  const { units, sawUsage } = parseRollout(lines);

  assert.equal(sawUsage, true);
  assert.equal(units.length, 2, "two calls, two units — the running totals are not calls");
  assert.deepEqual(units.map((u) => u.usage.inputTokens), [600, 700]);
  assert.deepEqual(units.map((u) => u.usage.cacheReadTokens), [400, 400]);
  assert.deepEqual(units.map((u) => u.usage.outputTokens), [500, 300]);
});

test("a thread total left in the bill would be visible as a preposterous number", () => {
  // The assertion above is the contract; this one states the failure it prevents, so a
  // regression reads as the bug it is rather than as an off-by-one in a count.
  const [unit] = parseRollout([
    turnContext("deepseek-flash"),
    line("2026-10-14T10:00:01.000Z", "token_usage_record", {
      usage: tokens(1000, 0, 500),
      thread_token_usage: tokens(900_000_000, 0, 1_500_000),
    }),
  ]).units;

  assert.equal(unit.usage.inputTokens, 1000);
  assert.ok(unit.usage.inputTokens < 1_000_000, "a single call cannot carry the thread's tokens");
});

// ------------------------------------------------------------------ the older writer ----

test("the older token_count shape drops its thread total the same way", () => {
  // `payload.info.total_token_usage` is the thread total under its older name, sitting
  // beside the per-call `last_token_usage`. Both shapes have to be handled, because a
  // rollout written by one Codex version is still read by the next.
  const lines = [
    turnContext("deepseek-flash"),
    line("2026-10-14T10:00:01.000Z", "event_msg", {
      type: "token_count",
      info: { last_token_usage: tokens(1000, 400, 500), total_token_usage: tokens(900_000_000, 800_000_000, 1_500_000) },
    }),
  ];

  const { units } = parseRollout(lines);
  assert.equal(units.length, 1);
  assert.equal(units[0].usage.inputTokens, 600);
  assert.equal(units[0].usage.outputTokens, 500);
});

// -------------------------------------------------------------------- effort ----

test("reasoning tokens break the output down, they do not add to it", () => {
  // Codex reports `reasoning_output_tokens` beside `output_tokens`, and its own
  // `total_tokens` satisfies input + output. Adding reasoning again would bill the thinking
  // twice. This is also why a low-to-high effort change prices correctly at any model: effort
  // moves the output count, and the rate per token never depends on it.
  const engine = toEngineUsage(tokens(1000, 400, 500));
  assert.equal(engine.inputTokens, 600, "input minus the cached part");
  assert.equal(engine.cacheReadTokens, 400);
  assert.equal(engine.outputTokens, 500, "reasoning is already inside this");
});

// --------------------------------------------------------------- the same call twice ----

const usageRecord = (timestamp, value) => line(timestamp, "token_usage_record", { usage: value });
const countEcho = (timestamp, value) =>
  line(timestamp, "event_msg", { type: "token_count", info: { last_token_usage: value, total_token_usage: tokens(900_000_000, 800_000_000, 1_500_000) } });

test("one call written in both record shapes is billed once", () => {
  // Codex emits `token_usage_record` and, a line or two later, the older `token_count`
  // carrying the same numbers as `last_token_usage`. They describe one call, so counting
  // both doubles the session.
  const one = tokens(1000, 400, 500);
  const lines = [
    turnContext("deepseek-flash"),
    usageRecord("2026-10-14T10:00:01.000Z", one),
    countEcho("2026-10-14T10:00:02.000Z", one),
    // A second call, also written twice.
    usageRecord("2026-10-14T10:00:03.000Z", tokens(1100, 400, 300)),
    countEcho("2026-10-14T10:00:04.000Z", tokens(1100, 400, 300)),
  ];

  const { units } = parseRollout(lines);
  assert.equal(units.length, 2, "two calls, however many shapes each was written in");
  assert.deepEqual(units.map((u) => u.usage.outputTokens), [500, 300]);
});

test("the echo is dropped whichever of the pair was written first", () => {
  // The check is symmetric in the two record kinds, so it does not depend on which writer
  // ran first — an ordering the format does not promise.
  const one = tokens(1000, 400, 500);
  const { units } = parseRollout([
    turnContext("deepseek-flash"),
    countEcho("2026-10-14T10:00:01.000Z", one),
    usageRecord("2026-10-14T10:00:02.000Z", one),
  ]);
  assert.equal(units.length, 1);
  assert.equal(units[0].usage.inputTokens, 600);
});

test("two calls of the same kind are never mistaken for an echo, even with identical numbers", () => {
  // The guard against over-deduplicating. Two identical reports of the *same* shape are two
  // calls — a model asked the same thing twice can report the same counts — so the echo test
  // requires the record kind to differ as well.
  const one = tokens(1000, 400, 500);
  const { units } = parseRollout([
    turnContext("deepseek-flash"),
    usageRecord("2026-10-14T10:00:01.000Z", one),
    usageRecord("2026-10-14T10:00:02.000Z", one),
  ]);
  assert.equal(units.length, 2);
});

test("an older rollout written only as token_count is still billed in full", () => {
  // Before the token_usage_record writer existed, last_token_usage was the only per-call
  // report there was. Nothing precedes it, so nothing may be dropped.
  const lines = [
    turnContext("deepseek-flash"),
    countEcho("2026-10-14T10:00:01.000Z", tokens(1000, 400, 500)),
    countEcho("2026-10-14T10:00:02.000Z", tokens(1100, 400, 300)),
  ];
  const { units } = parseRollout(lines);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((u) => u.usage.outputTokens), [500, 300]);
});
