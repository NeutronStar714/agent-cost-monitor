// The figures every renderer shows, from priced units.
//
// This lived inside window/serve.mjs, which listens on import and so cannot be tested.
// It is the arithmetic behind the headline numbers, including three behaviours that were
// wrong in ways only real use revealed:
//
//   * the series ended at the last settled point rather than at the turn's current elapsed
//     time, so a long tool call left the chart's right edge minutes behind;
//   * a turn with no new usage for 30 seconds was called ended, so a slow command froze the
//     clock and zeroed β(t) in the middle of a turn that was still running;
//   * and the series was wall-clock absolute and spanned every turn, where the DSH panel's
//     is turn-relative and covers the current turn only. Two renderers of the same idea have
//     to agree about what the picture means, so this now matches the panel exactly: times are
//     measured from the turn's own start, and the axis stops when the turn does.

import { burnPerHour, usageCost } from "../lib/cost.js";

export const BURN_WINDOW_MS_DEFAULT = 15_000;
/** Nothing new for this long, with no tool call in flight, means the turn has ended. */
export const IDLE_IS_ENDED_MS = 30_000;
/** Cap on the plotted samples, the same cap the panel uses, so a fan-out cannot bloat it. */
export const SERIES_CAP = 240;

/**
 * @param {object[]} units priced units: {turn, time, model, usage}
 * @param {object} options
 * @param {number} options.now
 * @param {string} options.currency
 * @param {(model: string, o?: object) => object|undefined} options.lookup
 * @param {number} options.burnWindowMs
 * @param {boolean} [options.awaiting] the transcript ends with an unanswered tool call
 * @param {number} [options.turnStartMs] the turn's real start, when the host records one
 * @param {number} [options.durationMs] the host's own measurement of the turn
 * @param {boolean} [options.live] the host's own answer to "is this turn still running"
 */
export function figuresFrom(units, { now, currency, lookup, burnWindowMs, awaiting = false, turnStartMs, durationMs, live: liveAsserted, approximate = false, note = "" }) {
  const window = Number.isFinite(burnWindowMs) && burnWindowMs > 0 ? burnWindowMs : BURN_WINDOW_MS_DEFAULT;
  const price = (u) => usageCost(u.usage, u.model, u.time, currency, lookup);

  const sorted = units.filter((u) => Number.isFinite(u.time)).sort((a, b) => a.time - b.time);
  let sessionCost = 0;
  let unpriced = 0;
  let lastTurn = 0;
  for (const u of sorted) {
    const priced = price(u);
    if (priced === undefined) unpriced += 1;
    else sessionCost += priced.cost;
    if (u.turn > lastTurn) lastTurn = u.turn;
  }

  // The current turn, which is what the chart draws.
  let turnCost = 0;
  let turnStart = null;
  let lastActivity = null;
  const turnUnits = sorted.filter((u) => u.turn === lastTurn);
  for (const u of turnUnits) {
    turnCost += price(u)?.cost ?? 0;
    if (turnStart === null || u.time < turnStart) turnStart = u.time;
    if (lastActivity === null || u.time > lastActivity) lastActivity = u.time;
  }

  // A tool call in flight is a running turn however long it takes: the transcript ends with
  // a `tool_use` whose result has not been written yet, so the absence of new usage is the
  // expected state, not evidence the turn is over. A host that records its own lifecycle
  // answers this outright, and its answer is used instead of this guess.
  const live = liveAsserted ?? (awaiting || (lastActivity !== null && now - lastActivity < IDLE_IS_ENDED_MS));

  // A host-supplied start is only believed if it is a plausible epoch time. `0` has to mean
  // "not recorded" rather than the epoch, because `0 ?? fallback` is `0` — believing it made
  // the elapsed time equal the whole Unix era (1.79 billion seconds). A duration is a span,
  // not an instant, so it gets its own guard.
  const epoch = (value) => (Number.isFinite(value) && value > 1e11 ? value : undefined);
  const start = epoch(turnStartMs) ?? turnStart;
  const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
  const elapsedMs = duration !== undefined
    ? duration
    : start === null
      ? 0
      : Math.max(0, (live ? now : (lastActivity ?? start)) - start);
  const origin = start ?? now;

  // A trailing window over the turn's own steps, sampled at each settled step and timed from
  // the turn's start — the panel's `series`, in the panel's units. An accumulator that never
  // removed aged-out calls would make the line climb forever, which is the opposite of a
  // burn rate.
  const costs = turnUnits.map((u) => price(u)?.cost ?? 0);
  const series = [];
  let windowCost = 0;
  let windowStart = 0;
  for (let i = 0; i < turnUnits.length; i += 1) {
    windowCost += costs[i];
    while (turnUnits[windowStart].time < turnUnits[i].time - window) windowCost -= costs[windowStart++];
    series.push({ atMs: turnUnits[i].time - origin, amountPerHour: burnPerHour(windowCost, window) });
  }

  const liveBurn = burnPerHour(
    sorted.filter((u) => now - u.time <= window).reduce((sum, u) => sum + (price(u)?.cost ?? 0), 0),
    window,
  );

  // The last turn that has actually finished — what a label saying "the last conversation" has
  // to mean, because `turnCost` above is the *current* turn and is still moving while the agent
  // works. A figure that is still growing, under a label that calls it final, is the one thing
  // this must not produce.
  //
  // The rule reads only what each host already reports, so there is no per-host branch: if the
  // current turn is over then it is itself the completed one, and if it is running then the
  // completed one is the turn before it. Before the first turn ends there is nothing to report
  // and `null` says so.
  const completedIndex = live
    ? sorted.filter((u) => u.turn < lastTurn).reduce((max, u) => Math.max(max, u.turn), Number.NEGATIVE_INFINITY)
    : sorted.length === 0
      ? Number.NEGATIVE_INFINITY
      : lastTurn;
  let completed = null;
  if (Number.isFinite(completedIndex)) {
    const own = sorted.filter((u) => u.turn === completedIndex);
    const tokens = { input: 0, cached: 0, output: 0 };
    let cost = 0;
    let firstAt = null;
    let lastAt = null;
    for (const u of own) {
      cost += price(u)?.cost ?? 0;
      if (firstAt === null || u.time < firstAt) firstAt = u.time;
      if (lastAt === null || u.time > lastAt) lastAt = u.time;
      tokens.input += Number(u.usage?.inputTokens) || 0;
      tokens.cached += (Number(u.usage?.cacheReadTokens) || 0) + (Number(u.usage?.cacheWriteTokens) || 0);
      tokens.output += Number(u.usage?.outputTokens) || 0;
    }
    const current = completedIndex === lastTurn;
    // Only the current turn can carry host bounds: an earlier turn's start is no longer in the
    // transcript, so its span is the distance between its own first and last billed call.
    const hostStart = current ? epoch(turnStartMs) : undefined;
    const hostDuration = current && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
    const startedAt = hostStart ?? firstAt ?? now;
    const endedAt = hostDuration === undefined ? (lastAt ?? startedAt) : startedAt + hostDuration;
    completed = {
      index: completedIndex,
      cost,
      tokens,
      models: [...new Set(own.map((u) => u.model).filter((m) => m !== ""))].slice(0, 4),
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      // Where the duration comes from: the host's own measurement, or the span between the first
      // and last billed call, which is shorter than the turn itself. A renderer that shows the
      // number without this cannot tell the two apart.
      basis: hostDuration === undefined ? "samples" : "host",
      current,
    };
  }

  return {
    turnCost,
    sessionCost,
    liveBurn,
    averageBurn: elapsedMs > 0 ? burnPerHour(turnCost, elapsedMs) : 0,
    elapsedMs,
    live,
    ended: !live,
    completed,
    turns: lastTurn,
    models: [...new Set(sorted.map((u) => u.model).filter((m) => m !== ""))].slice(0, 4),
    // Relative to the turn's start, and deliberately without a trailing point: the page adds
    // the sample at the current elapsed time, exactly as the panel's client does.
    series: series.slice(-SERIES_CAP),
    unpriced,
    approximate,
    note,
  };
}
