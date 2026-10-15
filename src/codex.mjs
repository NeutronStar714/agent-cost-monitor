// Codex spends, read from what Codex already writes.
//
// Two sources, because neither alone is sufficient:
//
//   * the rollout JSONL carries what pricing actually needs — `payload.usage` with
//     the cache buckets split out, and `turn_context.payload.model`, the model that
//     really ran rather than the one configured (they differ: a config saying
//     test-model while the sessions ran test-model is the reason this reads logs).
//   * `~/.codex/state_5.sqlite` carries a whole-thread total, `threads.tokens_used`,
//     which survives a rollout with no usage records at all. That happens when a
//     turn is refused — a subscription usage limit, for instance — and the total is
//     then the only evidence the thread ran.
//
// The rollout wins whenever it has usage. The total is a labelled approximation
// otherwise, and only the uncached price can be applied to it, which overstates
// rather than understates: the safe direction for a spend warning.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");

/** Every rollout file under a Codex home, newest first. */
export function listRollouts(home = codexHome()) {
  const root = join(home, "sessions");
  const found = [];
  (function walk(dir, depth = 0) {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          found.push({ path: full, mtimeMs: statSync(full).mtimeMs, size: statSync(full).size });
        } catch {
          /* vanished between listing and stat */
        }
      }
    }
  })(root);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Is this object a billed call's token report?
 *
 * Shape-tested rather than keyed on a parent type, because the parent differs by
 * Codex version: `payload.usage.input_tokens` was the 0.155 shape, and a newer
 * writer could place it elsewhere. Requiring both halves of the pair is what keeps
 * `usage_hint_hash` and friends from being mistaken for it.
 */
export function looksLikeUsage(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite(Number(value.input_tokens)) &&
    Number.isFinite(Number(value.output_tokens))
  );
}

/** Walk anything and collect every usage-shaped object, with its enclosing key. */
function collectUsage(node, path, found, depth = 0) {
  if (depth > 6 || node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (/usage|tokens/i.test(key) && looksLikeUsage(value)) found.push({ path: `${path}.${key}`, value });
    else if (typeof value === "object") collectUsage(value, `${path}.${key}`, found, depth + 1);
  }
}

/**
 * Codex reports `input_tokens` as the whole input, cache included — a 15.5M total
 * alongside 14.45M cached is only consistent that way. The engine's `inputTokens`
 * means the *uncached* remainder, so it is subtracted here rather than billed twice.
 */
export function toEngineUsage(usage) {
  const input = Number(usage.input_tokens) || 0;
  const cached = Number(usage.cached_input_tokens) || 0;
  return {
    inputTokens: Math.max(0, input - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: Number(usage.cache_write_input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
  };
}

/**
 * Fold rollout lines into the engine's units.
 *
 * Rollouts are append-ordered, so a usage record belongs to the most recent
 * `turn_context` above it; that is what supplies its model and its turn number.
 * Pure, so the mapping is testable without a Codex install.
 *
 * @returns {{units: object[], provider: string, cliVersion: string, sawUsage: boolean, usagePath: string}}
 */
export function parseRollout(lines) {
  const units = [];
  let provider = "";
  let cliVersion = "";
  let model = "";
  let turn = 0;
  let sawUsage = false;
  let usagePath = "";
  // The record kind and the numbers of the call billed last, for the echo check below.
  let lastBilledKind = "";
  let lastBilledFingerprint = "";
  let turnFromTask = 0;
  let turnFromContext = 0;
  let sawTaskStarted = false;
  let turnStartedAt = null;
  let turnEndedAt = null;
  let turnDurationMs = null;

  const when = (value) => (Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

  for (const line of lines) {
    if (typeof line !== "string" || line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload ?? {};
    const kind = `${entry.type}${typeof payload.type === "string" ? "/" + payload.type : ""}`;
    const time = when(entry.timestamp);
    /**
     * Codex writes `started_at`/`completed_at` in epoch **seconds** while `duration_ms` is in
     * milliseconds. Treating seconds as milliseconds puts the start in 1970: the window then
     * reported an elapsed time of 1.79 billion seconds and a chart with no visible duration.
     * Anything below 1e11 cannot be an epoch in milliseconds — the threshold is 1973 — so it is
     * read as seconds.
     */
    const at = (value, fallback) => {
      const parsed = typeof value === "number" ? value : when(value);
      if (!Number.isFinite(parsed)) return fallback;
      return parsed < 1e11 ? parsed * 1000 : parsed;
    };

    if (kind === "session_meta") {
      provider = typeof payload.model_provider === "string" ? payload.model_provider : provider;
      cliVersion = typeof payload.cli_version === "string" ? payload.cli_version : cliVersion;
    }
    if (kind === "turn_context") {
      turnFromContext += 1;
      if (typeof payload.model === "string" && payload.model !== "") model = payload.model;
    }
    if (kind === "event_msg/task_started") {
      // A new turn, by the host's own reckoning.
      turnFromTask += 1;
      sawTaskStarted = true;
      turnStartedAt = at(payload.started_at, time);
      turnEndedAt = null;
      turnDurationMs = null;
    }
    if (kind === "event_msg/task_complete") {
      turnEndedAt = at(payload.completed_at, time);
      // Codex already measured the turn; there is no reason to re-derive it.
      turnDurationMs = Number.isFinite(Number(payload.duration_ms)) ? Number(payload.duration_ms) : null;
    }

    const found = [];
    collectUsage(payload, "payload", found);
    for (const { path, value } of found) {
      // Codex reports the same tokens at three levels under the same field names: the
      // call, the turn and the whole thread. The two cumulative ones are running totals,
      // so summing either multiplies the bill — and the thread total is the dangerous
      // one, because for a long session it runs to hundreds of millions of tokens and
      // would be added to every single call. Only per-call reports become units.
      // (`total_token_usage` is the older writer's name for the thread total.)
      if (/(?:turn|thread|total)_token_usage/i.test(path)) continue;

      // And Codex writes one call twice: as `token_usage_record` and, a line or two on, as
      // the older `token_count` echo carrying the same numbers under `last_token_usage`.
      // Both are the same call, so billing both doubles the session. The echo is recognised
      // by three things together — a different record kind from the call billed last, and
      // input, cached and output counts that repeat it exactly. Two distinct calls of one
      // rollout do not land on a different record kind with identical numbers, so nothing
      // real is dropped; and because the test is symmetric in the two kinds, it does not
      // matter which of the pair was written first.
      const engineUsage = toEngineUsage(value);
      const fingerprint = `${engineUsage.inputTokens}/${engineUsage.cacheReadTokens}/${engineUsage.outputTokens}`;
      if (kind !== lastBilledKind && fingerprint === lastBilledFingerprint) continue;

      sawUsage = true;
      usagePath = path;
      lastBilledKind = kind;
      lastBilledFingerprint = fingerprint;
      units.push({
        turnTask: Math.max(1, turnFromTask),
        turnContext: Math.max(1, turnFromContext),
        time,
        model,
        usage: engineUsage,
      });
    }
  }

  // Prefer the host's own boundaries; fall back only when it recorded none.
  const turnOf = sawTaskStarted ? (u) => u.turnTask : (u) => u.turnContext;
  for (const unit of units) {
    unit.turn = turnOf(unit);
    delete unit.turnTask;
    delete unit.turnContext;
  }
  if (!sawTaskStarted) {
    turnStartedAt = null;
    turnEndedAt = null;
    turnDurationMs = null;
  }
  return {
    units,
    provider,
    cliVersion,
    sawUsage,
    usagePath,
    turnStartedAt,
    turnEndedAt,
    turnDurationMs,
    sawLifecycle: sawTaskStarted,
  };
}

/** Read the newest rollout, or undefined when Codex has never run here. */
export function readNewestRollout(home = codexHome()) {
  const [newest] = listRollouts(home);
  if (newest === undefined) return undefined;
  try {
    return { ...newest, lines: readFileSync(newest.path, "utf8").split("\n").filter(Boolean) };
  } catch {
    return undefined;
  }
}

/**
 * Whole-thread totals from Codex's own database.
 *
 * Read-only and optional: `node:sqlite` arrived in Node 22.5, so a newer Node gets
 * the cross-check and an older one simply has no fallback. Nothing here writes.
 */
export async function readThreadTotals(home = codexHome()) {
  const file = join(home, "state_5.sqlite");
  if (!existsSync(file)) return [];
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return [];
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db
      .prepare("SELECT id, model, model_provider, tokens_used, updated_at, rollout_path FROM threads ORDER BY updated_at DESC LIMIT 30")
      .all()
      .map((row) => ({
        id: String(row.id ?? ""),
        model: String(row.model ?? ""),
        provider: String(row.model_provider ?? ""),
        tokensUsed: Number(row.tokens_used) || 0,
        updatedAt: Number(row.updated_at) || 0,
        rolloutPath: String(row.rollout_path ?? ""),
      }));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
