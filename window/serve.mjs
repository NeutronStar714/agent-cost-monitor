// The window's daemon: one page, one JSON endpoint, no framework.
//
// Three sources, and the caller can say which it wants. A host is preferred with
// `?host=codex` (the launcher puts it in the URL), otherwise DSH is tried first
// because that route already carries everything, then Codex, then Claude Code.
//
// What it deliberately does NOT do any more: show a balance. The balance is
// DeepSeek's and only DSH can read it, so in a window that also serves Codex and
// Claude Code it was a figure about a different provider than the one being
// measured — and a number that silently never moves for two of the three hosts.
// Cost and burn rate are the whole job here.
//
// Every figure is display-only; the status line and the DSH panel compute their own.
// Three renderers over one engine is the design, so this file does not try to become
// a shared library.

import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPriceBook } from "../lib/pricing.js";
import { collectUnits } from "../claude/statusline.mjs";
import { parseRollout, readNewestRollout, readThreadTotals } from "../src/codex.mjs";
import { resolveConfig } from "../src/autostart.mjs";
import { figuresFrom } from "../src/figures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolveConfig(homedir());
const PORT = CONFIG.port;
const CURRENCY = CONFIG.currency;
const SYMBOL = CURRENCY === "USD" ? "$" : "\u00a5";
const BURN_WINDOW_MS = CONFIG.burnWindowMs;
const IDLE_IS_ENDED_MS = 30_000;
const CACHE = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");
const DSH_URL = process.env.ACM_DSH_URL ?? "http://127.0.0.1:19387/dsh-budget-watcher/balance";
const WARN = CONFIG.warnPerHour;

const LOG_DIR = join(homedir(), ".cache", "agent-cost-monitor");
const LOG_FILE = join(LOG_DIR, "window.log");

/** The transcript chosen last time, so a 1 Hz poll does not rescan every request. */
let claudePick = { path: "", at: 0 };

/**
 * When a window last asked for figures.
 *
 * This is how `acm launch --if-needed` knows one is already open, without spawning a
 * PowerShell probe on every prompt: the page polls this daemon once a second, so a recent
 * request *is* a live window. The launcher's own liveness probe uses /health instead, so
 * it never counts itself as a window.
 */
let lastWindowPollAt = 0;

/**
 * Every resolution, so "why is it showing that" is answerable after the fact.
 *
 * The same line is resolved once a second while nothing changes, and writing it every time made
 * the log useless for its actual purpose: `acm log --lines 20` returned twenty identical poll
 * lines and pushed the launcher's account of a failed launch off the screen. Runs are now
 * collapsed — the first occurrence is written, and when the value finally changes the number of
 * skipped repeats is recorded, so nothing is hidden and the timeline stays readable.
 */
let lastLogged = "";
let skipped = 0;

function log(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 256 * 1024) writeFileSync(LOG_FILE, "");
    if (message === lastLogged) {
      skipped += 1;
      return;
    }
    if (skipped > 0) {
      appendFileSync(LOG_FILE, `${new Date().toISOString()}  daemon  (the previous line repeated ${skipped} more times)\n`);
      skipped = 0;
    }
    lastLogged = message;
    appendFileSync(LOG_FILE, `${new Date().toISOString()}  daemon  ${message}\n`);
  } catch {
    /* a log that cannot be written is not a reason to fail a request */
  }
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

function loadPricing() {
  try {
    const cache = JSON.parse(readFileSync(join(CACHE, "claude-pricing.json"), "utf8"));
    return { usdToCny: cache.usdToCny ?? 0, models: cache.models ?? {} };
  } catch {
    return { usdToCny: 0, models: {} };
  }
}

/** One price lookup, shared by every source. */
function makeLookup() {
  const { usdToCny, models } = loadPricing();
  const book = createPriceBook({ enabled: false, bundled: models });
  return (model, options) => book.lookup(model, { ...options, usdToCny });
}

/** When a host's own file was last written, or undefined when it cannot be read. */
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The figures, from priced units — now in src/figures.mjs, where it can be tested.
 *
 * It used to live here, and this file listens on import, so the arithmetic behind every
 * headline number had no test at all.
 */

// --------------------------------------------------------------- sources -----

/**
 * The DSH panel's own answer to "which turn finished last".
 *
 * The other two hosts keep their whole history on disk, so `figuresFrom` can find the turn
 * before the running one. The panel reports only the turn it is showing, so its answer is
 * either the turn that has just ended or nothing at all — and saying nothing while one is
 * running is the honest half of that, because the alternative is presenting a live total as a
 * finished one. The shape matches the engine's field for field so a renderer reads one field
 * whichever host it happens to be looking at.
 */
function dshCompleted({ cost, ended, durationMs, models }) {
  if (ended !== true) return null;
  return {
    index: null,
    cost,
    tokens: null,
    models: models ?? [],
    startedAt: null,
    endedAt: null,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    basis: "host",
    current: true,
  };
}

/** The DSH plugin already answers all of this; pass it through in one shape. */
async function fromDsh(now) {
  const response = await fetch(DSH_URL, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status} from ${DSH_URL}` };
  const body = await response.json();
  if (body?.ok !== true) return { ok: false, reason: `${DSH_URL} did not return ok` };
  const cost = body.cost ?? {};
  const turn = cost.thisTurn ?? {};
  const session = cost.session ?? {};
  const currency = cost.currency ?? CURRENCY;
  return {
    ok: true,
    payload: {
      state: "ok",
      source: "dsh",
      // The panel answering is itself the activity: it runs inside an agent host, so while it is
      // there, something is there. See the note on `activityAt` in fromCodex.
      activityAt: now,
      sourceDetail: `dsh-budget-watcher ${body.pluginVersion ?? "?"}`,
      currency,
      symbol: currency === "USD" ? "$" : "\u00a5",
      turnCost: turn.amount ?? turn.cost ?? 0,
      sessionCost: session.amount ?? session.cost ?? 0,
      liveBurn: cost.liveBurnPerHour ?? cost.liveAmountPerHour ?? 0,
      averageBurn: cost.averageBurnPerHour ?? cost.averageAmountPerHour ?? 0,
      elapsedMs: turn.durationMs ?? 0,
      // The panel's own flag for "this turn is still running", which the page uses to decide
      // whether the axis is frozen. Its series is already turn-relative, like ours.
      ended: turn.ended === true,
      live: turn.ended !== true,
      completed: dshCompleted({
        cost: turn.amount ?? turn.cost ?? 0,
        ended: turn.ended === true,
        durationMs: Number(turn.durationMs),
        models: turn.models,
      }),
      turns: session.turns ?? 0,
      models: turn.models ?? [],
      series: turn.series ?? [],
      pollMs: CONFIG.pollMs,
      warnPerHour: cost.warnPerHour ?? WARN,
      unpriced: session.unpricedTurns ?? 0,
      approximate: false,
      note: "live from the DSH host plugin",
    },
  };
}

async function fromCodex(now, lookup) {
  const rollout = readNewestRollout();
  if (rollout === undefined) return { ok: false, reason: "no rollout under ~/.codex/sessions" };
  const parsed = parseRollout(rollout.lines);
  const where = rollout.path.split(/[\\/]/).slice(-1)[0];
  // When the host last wrote anything at all — as opposed to what it last spent, which is what
  // every other figure here is about. A renderer that wants to know whether an agent is running
  // right now (the tray shows and hides itself on that) has no other way to ask: `turnCost` is
  // zero between turns, and a finished session looks exactly like a silent one.
  const activityAt = mtimeOf(rollout.path) ?? now;

  if (parsed.sawUsage) {
    return {
      ok: true,
      payload: {
        state: "ok",
        source: "codex",
        activityAt,
        sourceDetail: `${where} \u00b7 cli ${parsed.cliVersion || "?"} \u00b7 ${parsed.provider || "?"}`,
        currency: CURRENCY,
        symbol: SYMBOL,
        ...figuresFrom(parsed.units, {
          now,
          currency: CURRENCY,
          lookup,
          burnWindowMs: BURN_WINDOW_MS,
          // Codex records its own turn boundaries and even its own duration, so nothing has
          // to be inferred from the usage samples: a turn it called 51 seconds is 51 seconds,
          // not the span between the first and last billed call.
          turnStartMs: parsed.turnStartedAt ?? undefined,
          durationMs: parsed.turnDurationMs ?? undefined,
          live: parsed.sawLifecycle ? parsed.turnEndedAt === null : undefined,
        }),
        pollMs: CONFIG.pollMs,
        warnPerHour: WARN,
      },
    };
  }

  // No per-call usage in the rollout. That is what a refused turn looks like — a
  // subscription limit leaves nothing to record — and Codex keeps a whole-thread
  // total anyway, so report that, labelled, rather than reporting zero spend.
  const totals = await readThreadTotals();
  const match = totals.find((t) => t.rolloutPath.endsWith(where)) ?? totals.find((t) => t.tokensUsed > 0);
  if (match === undefined || match.tokensUsed === 0) {
    return { ok: false, reason: `no usage in ${where}, and no thread total to fall back on` };
  }
  return {
    ok: true,
    payload: {
      state: "ok",
      source: "codex",
      activityAt,
      sourceDetail: `${where} \u00b7 totals from state_5.sqlite`,
      currency: CURRENCY,
      symbol: SYMBOL,
      ...figuresFrom(
        [{ turn: 1, time: now, model: match.model, usage: { inputTokens: match.tokensUsed, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }],
        {
          now,
          currency: CURRENCY,
          lookup,
          burnWindowMs: BURN_WINDOW_MS,
          approximate: true,
          note: `${match.tokensUsed.toLocaleString()} tokens priced as uncached input \u2014 the cache split was not recorded`,
        },
      ),
      pollMs: CONFIG.pollMs,
      warnPerHour: WARN,
    },
  };
}

function fromClaudeCode(now, lookup) {
  const root = join(homedir(), ".claude", "projects");
  // Which transcript to read is the expensive part — the scan reads candidate files
  // until one has usage. At one request a second that is worth remembering briefly; the
  // figures themselves are recomputed every time, so nothing shown is stale.
  if (claudePick.path !== "" && now - claudePick.at < 2000 && existsSync(claudePick.path)) {
    const picked = readClaudeTranscript(claudePick.path, now, lookup);
    if (picked !== undefined) return picked;
  }

  const found = [];
  (function walk(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) found.push({ full, mtimeMs: statSync(full).mtimeMs });
    }
  })(root);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { full } of found.slice(0, 12)) {
    const picked = readClaudeTranscript(full, now, lookup);
    if (picked !== undefined) {
      claudePick = { path: full, at: now };
      return picked;
    }
  }
  return { ok: false, reason: "no Claude Code transcript with usage found" };
}

function readClaudeTranscript(full, now, lookup) {
  try {
    const text = readFileSync(full, "utf8");
    if (!text.includes('"input_tokens"')) return undefined;
    const { units, awaitingToolResult, turnStartedAt } = collectUnits(text.split("\n").filter(Boolean));
    if (units.length === 0) return undefined;
    return {
      ok: true,
      payload: {
        state: "ok",
        source: "claude-code",
        // The transcript's own mtime, not the last billed call's: a session that is open and idle
        // still has an agent behind it, and the tray's question is "is anyone there", not "did
        // anything get spent just now".
        activityAt: mtimeOf(full) ?? now,
        sourceDetail: full.split(/[\\/]/).slice(-1)[0],
        currency: CURRENCY,
        symbol: SYMBOL,
        // The prompt that opened the turn is its real start; the first billed call is not.
        ...figuresFrom(units, {
          now,
          currency: CURRENCY,
          lookup,
          burnWindowMs: BURN_WINDOW_MS,
          awaiting: awaitingToolResult,
          turnStartMs: turnStartedAt ?? undefined,
        }),
        pollMs: CONFIG.pollMs,
        warnPerHour: WARN,
      },
    };
  } catch {
    return undefined;
  }
}

const SOURCES = { dsh: fromDsh, codex: fromCodex, claude: fromClaudeCode, "claude-code": fromClaudeCode };

/** Try the requested host first, then the rest, and say why each one failed. */
async function resolveData(prefer, now, lookup) {
  const order = ["dsh", "codex", "claude"];
  const wanted = prefer === "dsh-tui" ? "dsh" : prefer;
  const keys = SOURCES[wanted] !== undefined ? [wanted, ...order.filter((k) => k !== wanted)] : order;

  const attempts = [];
  for (const key of keys) {
    // `await` rather than `.catch()` on the call: one source is synchronous (it only
    // reads files) and chaining a promise method onto its result threw, which took
    // every other source down with it and reported "no data" for a host that was
    // sitting right there.
    let result;
    try {
      result = await SOURCES[key](now, lookup);
    } catch (error) {
      result = { ok: false, reason: String(error?.message ?? error) };
    }
    attempts.push({ source: key === "claude" ? "claude-code" : key, ok: result.ok, reason: result.ok ? "" : result.reason });
    if (result.ok) return { ...result.payload, requested: wanted || "auto", attempts };
  }
  return {
    state: "nodata",
    requested: wanted || "auto",
    currency: CURRENCY,
    symbol: SYMBOL,
    pollMs: CONFIG.pollMs,
    attempts,
    hint: "nothing to read yet \u2014 run Codex, start dsh-tui, or use Claude Code",
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    return json(res, { ok: true, port: PORT, windowPolledAt: lastWindowPollAt });
  }
  if (url.pathname === "/data") {
    const now = Date.now();
    // A window polling is not the only reader any more: the tray reads this endpoint too, and
    // counting it would make `windowPolledAt` say a window is open whenever a tray is running —
    // which is the opposite of what that field is for. So the tray identifies itself.
    if (url.searchParams.get("client") !== "tray") lastWindowPollAt = now;
    const lookup = makeLookup();
    const prefer = (url.searchParams.get("host") ?? process.env.ACM_PREFER_HOST ?? "").trim().toLowerCase();
    try {
      const data = await resolveData(prefer, now, lookup);
      log(
        data.state === "ok"
          ? `host=${prefer || "auto"} -> ${data.source} (${data.models.join(",") || "no model"})`
          : `host=${prefer || "auto"} -> ${data.state}: ` + (data.attempts ?? []).map((a) => `${a.source}=${a.ok ? "ok" : a.reason}`).join("; "),
      );
      return json(res, data);
    } catch (error) {
      log(`host=${prefer || "auto"} -> error: ${String(error?.message ?? error)}`);
      return json(res, { state: "error", hint: String(error?.message ?? error) });
    }
  }
  if (/^\/icon(-\d+)?\.(png|ico)$/.test(url.pathname)) {
    // The page's icon set, which is what a browser app window wears. Served from the same
    // directory as the page so a browser window and the Tauri widget can share one image
    // rather than carrying the browser's default globe. The pattern is a whitelist — only
    // icon, icon-<digits> and those two extensions — so no path can escape this directory.
    const icon = join(HERE, url.pathname.slice(1));
    if (!existsSync(icon)) return json(res, { error: "no icon" }, 404);
    const type = url.pathname.endsWith(".ico") ? "image/x-icon" : "image/png";
    res.writeHead(200, { "content-type": type, "cache-control": "max-age=3600" });
    return res.end(readFileSync(icon));
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(join(HERE, "index.html")));
  }
  json(res, { error: "not found" }, 404);
}).listen(PORT, "127.0.0.1", () => {
  log(`listening on ${PORT}, currency ${CURRENCY}, warn ${WARN}/h`);
  process.stdout.write(`agent-cost-monitor window on http://127.0.0.1:${PORT}\n`);
});
