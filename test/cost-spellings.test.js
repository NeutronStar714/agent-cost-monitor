// One model, several spellings.
//
// The case this exists for is concrete: a session reaches a model through a middle layer, and the
// middle layer rewrites the id on the way past. A Claude Code session behind a router records
// `DeepSeek/deepseek-v4-flash`; one that picked the model from the router's own list records
// `anthropic/claude-ccr-h<hex>`; the same model also appears plain. All three name one model at one
// price, and before this every spelling past the first was silently unpriced — which reads on the
// panel as a cheap session rather than a missing rate.
//
// Every case here is synthetic. The rule under test is a spelling rule, so it needs no session, no
// cache and no network.
import assert from "node:assert/strict";
import test from "node:test";

import { PRICING, normalizeModelId, pricingFor, usageCost } from "../lib/cost.js";
import { createPriceBook, parseOpenRouterModels } from "../lib/pricing.js";

/** The shape a router uses when it passes an id through under an opaque name: `-h` + hex of the id. */
const cloak = (id) => `anthropic/claude-ccr-h${Buffer.from(id, "utf8").toString("hex")}`;

/** A fixed usage report, so every spelling is priced over identical numbers. */
const usage = { inputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 0, outputTokens: 50_000 };

/** Sunday noon UTC — off-peak, so the DeepSeek comparison is not a peak/off-peak coin toss. */
const offPeak = Date.parse("2026-10-11T12:00:00Z");

/** What the bundled table says this usage costs, derived rather than hard-coded: the rates may move. */
function bundledCost(model, rates = PRICING["deepseek-flash"].USD.offPeak) {
  return (usage.cacheReadTokens * rates.cacheHit + usage.inputTokens * rates.cacheMiss + usage.outputTokens * rates.output) / 1_000_000;
}

// --------------------------------------------------------------- normalizeModelId ----

test("a router's provider prefix is removed, leaving the id the provider bills", () => {
  assert.equal(normalizeModelId("DeepSeek/deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(normalizeModelId("MiMo/mimo-v2.6-pro"), "mimo-v2.6-pro");
});

test("a context-variant tag is removed; a routing suffix is not", () => {
  // `[1m]` is a host's annotation for a long-context beta. `:batch` is not an annotation — the
  // fetched book keys it as its own row, and folding it onto the interactive row would misprice it.
  assert.equal(normalizeModelId("deepseek-v4-flash[1m]"), "deepseek-v4-flash");
  assert.equal(normalizeModelId("deepseek-v4-flash[1m][2m]"), "deepseek-v4-flash");
  assert.equal(normalizeModelId("vendor/model-a:batch"), "model-a:batch");
});

test("an opaque alias is decoded when its hex names a model, and left alone when it does not", () => {
  assert.equal(normalizeModelId(cloak("MiMo/mimo-v2.6-pro")), "mimo-v2.6-pro");
  // The `-h…` tail has to look like a decodable model id before it is trusted. These are written
  // without a namespace on purpose, so each assertion is about the decode and nothing else.
  assert.equal(normalizeModelId("thing-hzzzz"), "thing-hzzzz", "not hex at all");
  assert.equal(normalizeModelId("thing-habc"), "thing-habc", "odd-length hex cannot decode");
  assert.equal(normalizeModelId("thing-h00ff00"), "thing-h00ff00", "valid hex, but not model-shaped text");
});

test("an id with nothing to undo comes back unchanged", () => {
  for (const id of ["deepseek-v4-flash", "mimo-v2.6-pro", "claude-sonnet-4-5"]) {
    assert.equal(normalizeModelId(id), id);
  }
});

// ------------------------------------------------------------- the bundled table ----

test("every spelling of a DeepSeek model resolves to the same card", () => {
  const spellings = [
    "deepseek-flash",
    "deepseek-v4-flash",
    "deepseek-v4-flash[1m]",
    "DeepSeek/deepseek-v4-flash",
    "DeepSeek/deepseek-v4-flash[1m]",
    cloak("DeepSeek/deepseek-v4-flash"),
  ];
  for (const spelling of spellings) {
    assert.notEqual(pricingFor(spelling, "USD"), undefined, `${spelling} should be priced`);
  }
});

test("a decorated DeepSeek id costs what the plain one costs", () => {
  const expected = bundledCost("deepseek-flash");
  for (const spelling of ["deepseek-v4-flash", "DeepSeek/deepseek-v4-flash", cloak("DeepSeek/deepseek-v4-flash")]) {
    const priced = usageCost(usage, spelling, offPeak, "USD");
    assert.notEqual(priced, undefined, `${spelling} should be priced`);
    assert.equal(priced.cost, expected, `${spelling} should cost the same as the plain id`);
    assert.equal(priced.source, "bundled");
  }
});

test("a decorated DeepSeek id is priced in CNY too, off the provider's own CNY table", () => {
  const expected = bundledCost("deepseek-flash", PRICING["deepseek-flash"].CNY.offPeak);
  const priced = usageCost(usage, cloak("DeepSeek/deepseek-v4-flash"), offPeak, "CNY");
  assert.notEqual(priced, undefined);
  assert.equal(priced.cost, expected);
});

// ------------------------------------------------------------------- the fetched book ----

/** A book shaped the way the status line builds one: a flat map, no network. */
const cachedBook = createPriceBook({
  enabled: false,
  bundled: {
    "xiaomi/mimo-v2.6-pro": { currency: "USD", cacheHit: 0.0036, cacheMiss: 0.435, output: 0.87, label: "MiMo V2.6 Pro" },
    "mimo-v2.6-pro": { currency: "USD", cacheHit: 0.0036, cacheMiss: 0.435, output: 0.87, label: "MiMo V2.6 Pro" },
  },
});
const cachedLookup = (model, options) => cachedBook.lookup(model, { ...options, usdToCny: 7 });

test("a decorated third-party id reaches the book, through its bare name", () => {
  const expected = usageCost(usage, "mimo-v2.6-pro", offPeak, "USD", cachedLookup);
  assert.notEqual(expected, undefined, "the plain spelling should price");
  for (const spelling of ["MiMo/mimo-v2.6-pro", cloak("MiMo/mimo-v2.6-pro")]) {
    const priced = usageCost(usage, spelling, offPeak, "USD", cachedLookup);
    assert.notEqual(priced, undefined, `${spelling} should price`);
    assert.equal(priced.cost, expected.cost, `${spelling} should cost the same`);
    assert.equal(priced.source, "bundled");
  }
});

test("the fetched book, parsed from a list, answers a decorated id the same way", () => {
  const index = parseOpenRouterModels({
    data: [{ id: "xiaomi/mimo-v2.6-pro", name: "MiMo V2.6 Pro", pricing: { prompt: "0.000000435", completion: "0.00000087", input_cache_read: "0.0000000036" } }],
  });
  const book = createPriceBook({ enabled: false, bundled: {} });
  const lookup = (model) => index.byId.get(String(model).toLowerCase()) ?? index.byBareName.get(String(model).toLowerCase());
  const flat = usageCost(usage, "mimo-v2.6-pro", offPeak, "USD", lookup);
  const decorated = usageCost(usage, "MiMo/mimo-v2.6-pro", offPeak, "USD", lookup);
  assert.notEqual(flat, undefined);
  assert.notEqual(decorated, undefined);
  assert.equal(decorated.cost, flat.cost);
  assert.equal(book.snapshot().fetched, 0, "the book is not consulted here; the lookup is");
});

// ------------------------------------------------------------------------ no guessing ----

test("an unresolvable DeepSeek id stays unpriced rather than reaching for the book", () => {
  // The book carries DeepSeek at roughly a third of DeepSeek's own published rate, so falling back
  // to it would understate the spend while looking entirely plausible. A decorated id must not
  // become an escape hatch around that guard.
  const lookup = () => ({ cacheHit: 0.001, cacheMiss: 0.091, output: 0.182, source: "fetched" });
  for (const id of ["deepseek-v9-ultra", cloak("DeepSeek/deepseek-v9-ultra")]) {
    assert.equal(usageCost(usage, id, offPeak, "USD", lookup), undefined, `${id} must stay unpriced`);
  }
});

test("a model nothing recognises stays unpriced", () => {
  for (const id of ["not-a-model", "vendor/mystery-model", cloak("Vendor/mystery-model")]) {
    assert.equal(usageCost(usage, id, offPeak, "USD", cachedLookup), undefined, `${id} must stay unpriced`);
  }
});
