![agent-cost-monitor](assets/header.svg)

Live cost and "burn rate" for AI coding agents, on the surface each one already gives you.

**English** · [简体中文](README.zh-CN.md)

- **Claude Code CLI** gets a status line — one row, redrawn in place.
- **Everything else** — Codex, DSH, or Claude Code when you want the picture rather than a
  number — gets a **Tauri window**: a small always-on-top widget with the same figures and a
  burn chart.
- **`acm tray`** puts a single figure in the Windows notification area: the current turn's cost
  drawn *into* the icon, with the last completed turn, the session total and both burn rates in
  its menu. It shows itself while an agent is running and takes itself away after five minutes of
  quiet. `acm autostart tray` adds it at login — off by default, because a notification icon that turns up
uninvited on a first install is a surprise rather than a feature.

That status line is the *only* place this project is a single row, and it is **Claude Code
CLI only**:

```
¥0.53 / ¥19.72 · β(t) ¥0.00/h · β ¥5.94/h · 5:21
```

## The figures, and what β means

**β is burn** — currency spent *per hour*. It is a rate, never a total: it answers "how fast is
this costing me right now", which is the question a running agent makes urgent.

In the status line, the window, or the tray's menu:

|||
|---|---|
| `¥0.53` | **this turn** — what the current turn has cost so far |
| `¥19.72` | **this session** — every turn in the conversation |
| `β(t)` | **live burn** — what the last `burnWindowMs` (15 s by default) cost, projected to an hour. Falls to zero when nothing is being spent; it is a trailing window, so it drops as calls age out |
| `β` | **average burn** — this turn's cost divided by this turn's own duration |
| `5:21` | **this turn's elapsed time** — it stops when the turn stops |

Precisely: every figure is computed from the token usage the host records — input, output, and the
cache-read/write split kept separate — priced per million tokens against a fetched rate card, with
DeepSeek's peak/off-peak periods applied and USD→CNY converted at the ECB daily rate. Nothing is
measured or estimated from wall-clock time; an unpriced model contributes nothing rather than a
guess.

**If a model you use is missing from that card — or your network cannot reach the list at all —
give it rates yourself** in `~/.agent-cost-monitor.pricing.json`, in USD per million tokens:

```json
{ "models": { "gpt-6-sol": { "input": 1.25, "cachedInput": 0.125, "output": 10 } } }
```

Those win over the fetched card for the names you list, are re-applied after every fetch (a good
fetch must not discard the only prices your machine can have), and are deliberately *not* kept in
the cache directory, because `acm uninstall` may clear that and a table you typed is not ours to
delete. A row with no `output` rate is skipped rather than half-applied: pricing output tokens at
zero would understate a turn while looking priced.

That rate card is also kept **offline**, in `~/.cache/spend-watch/`: a machine-readable record
(`pricing-rows.json`) and a readable document (`pricing.md`) listing every model's rates, when they
were fetched, and when they last *changed* — the document is only rewritten when the fetched list
actually differs, so a rate movement is visible instead of being absorbed silently. Inspect it with
`acm pricing`; fetch again with `acm pricing --refresh`.

## Install

```bash
npm install -g agent-cost-monitor     # puts `acm` on your PATH
acm install                           # Claude Code status line, /acm, config
acm autostart panel                   # start the window when a session starts (default: on)
acm autostart tray                    # the notification-area figure at login (default: off)
```

Requires Node 20+ (22.5+ for the Codex SQLite cross-check). The window and the tray are **Windows
only** for now; the status line, the daemon and the CLI are pure Node and run anywhere.

## Starting the window

```bash
acm launch                 # reuse the open window, or open one
acm launch --new           # a second window on purpose
acm launch --host codex    # read Codex, and say so on screen
```

**Claude Code gets the status line, never a window.** Its CLI and its desktop app share a single
settings file, so a window hook cannot be limited to the desktop — and a window showing the same
figures as a line that is already there is noise. `acm autostart panel` therefore *removes* any Claude Code
window hook an earlier version installed; the only way to get one is to ask for the desktop case
explicitly with `acm autostart panel on --host claude --window`.

`acm autostart panel` installs a `SessionStart` **and** `UserPromptSubmit` hook for **Codex**, so its
window comes up when you start working rather than when you remember. Codex may ask you to trust
the hook once — it keeps a per-hook trust hash and nothing can forge it.

**The turn clock starts at the turn and stops at the turn.** Where a harness reports its own
duration — Codex reports `duration_ms` when a task completes — that number is used *exactly*, so a
task that took 1 min 52 s freezes at `1:52` even though the line is drawn a moment later. Where the
harness reports nothing (Claude Code), the clock settles on the turn's last recorded step once the
turn has clearly gone quiet: brief latency, then the correct frozen value. It never keeps climbing
after the work stopped.

## The notification-area figure

`acm tray` keeps one number where you already look — beside the clock — rather than in a window you
have to find.

- **The icon is the figure**: this turn's cost, at most three glyphs (`.53`, `1.2`, `12`), drawn
  from text geometry and scaled to fill the box the shell actually gives it — 32 physical pixels at
  200% scaling. White on a dark taskbar, dark on a light one, and **amber** once the live burn rate
  passes `warnPerHour`.
- **The menu** carries what will not fit: the last turn that *finished*, the session total, both
  burn rates, the host and model, the rate-card status, and shortcuts to open the window or quit.
- **Hovering** gives one line — `acm · [host] · [this turn] · [avg. burn] · [session]` — with the
  session at two decimals, because a running total is the figure people compare. It uses 48
  characters of the shell's 63, and when it does not fit, fields are dropped from the least
  important end rather than the line being cut: a truncated figure reads as a smaller figure.
- **It shows itself when there is something to say** — while a turn is running, or while a window
  is open — and hides after five minutes of quiet. The icon is not permanent furniture.
- **`acm autostart tray`** writes a login entry, and is off by default; **`acm tray --status`** says whether one is
  running; **`acm tray --stop`** ends it. `acm tray` on its own starts it now.

It is started through the **Task Scheduler**, not as a child of the command that asked for it: a
process spawned that way is killed when the command exits, which showed up as an icon that flashed
and vanished. In the taskbar's own settings the icon is listed as **Windows PowerShell**, because it
belongs to the process that owns it, not to this project.

## Setting the warning limit

One number is shared by every surface — the window's dashed line and its dot, and the tray's
figure:

```bash
acm warn          # show it
acm warn 8        # set it, in the currency the figures use, per hour
```

It is stored as `warnPerHour` in the config file, with a timestamped backup of the previous file,
and the daemon notices the change and applies it on the next poll — nothing needs restarting. A
DSH session also has the dsh-budget-watcher plugin's own threshold for the plugin's own panel; the
figures *ACM* draws follow ACM's number wherever they come from, so setting it here always changes
what you see here.

## Using DSH desktop? Read this instead

If your agent is **DSH**, start with
[dsh-budget-watcher](https://github.com/NeutronStar714/dsh-budget-watcher): a DSH host plugin
with a floating panel, a settings form and cost accounting built for DSH's own session model.

**This project is that one step further — cross-platform.** The pricing engine here was
extracted from that plugin, and it now reads whatever each host writes on disk, so the same
figures follow you to Claude Code and Codex. If you run both, use both: they are configured
alike (`burnWindowMs` means the same thing in each) and neither interferes with the other.

## How it works

| Source | What it reads |
|---|---|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` transcripts |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` for per-call usage, `state_5.sqlite` for a thread total when a rollout has none |
| **DSH** | the dsh-budget-watcher plugin's HTTP route — the only source that also knows your balance, which this project ignores |

Every figure is display-only; each renderer prices from the same engine. A turn's boundaries
come from the host where the host records them — Codex's `task_started`/`task_complete`, the
prompt entry for Claude Code — and only fall back to usage samples when it records none.

## Commands

| | |
|---|---|
| `acm install [--host claude\|dsh\|all]` | Configure a host (default: Claude Code) |
| `acm autostart [panel\|tray] [on\|off]` | Start the window or the tray automatically — panel on, tray off |
| `acm launch [--host h] [--new] [--quiet]` | Start the window |
| `acm tray [--status\|--stop]` | The notification-area figure, and whether it is running |
| `acm warn [rate]` | Show or set the burn rate the figures turn amber at |
| `acm pricing [--refresh]` | The offline rate card: what it holds, when it changed |
| `acm status` / `acm doctor` / `acm log [--lines N]` | What is detected, what is broken, what happened |
| `acm uninstall [--self] [--keep-cache]` | Remove everything acm added |
| `acm clean-profiles` | Remove an old shell-shim block, if a previous version left one |

`--dry-run` prints the plan and changes nothing.

## Configuration

`~/.agent-cost-monitor.json`, every key overridable by environment variable:

| Key | Default | Meaning | Env |
|---|---|---|---|
| `backend` | `browser` | `browser` app window, or `tauri` for the widget | `ACM_WINDOW_BACKEND` |
| `windowWidth` / `windowHeight` | `225` / `300` | Window size in pixels | `ACM_WINDOW_WIDTH/_HEIGHT` |
| `windowX` / `windowY` | `40` / `80` | Where it opens | `ACM_WINDOW_X/_Y` |
| `alwaysOnTop` | `true` | Keep it above other windows | `ACM_ALWAYS_ON_TOP=0` |
| `warnPerHour` | `15` | Where the chart's dashed warn line sits, the burn rate the dot turns amber at, and the rate the tray's figure turns amber at | `ACM_WARN_PER_HOUR` |
| `burnWindowMs` | `15000` | The window `β(t)` is measured over | `ACM_BURN_WINDOW_MS` |
| `pollMs` | `1000` | How often the window asks for figures | `ACM_POLL_MS` |

`SPEND_WATCH_CURRENCY=USD` prices in dollars. The window puts itself back on top and repairs a
window that was hidden or minimised — but never moves one you have positioned yourself, whichever
flags the launch was given. Reuse is the default: an existing window is left exactly where it is,
and only `acm launch --new` opens a second one.

## Limitations

1. **Everything is priced as one pot.** Subagent spend is included and flagged, but the line has
   no per-agent split.
2. **Claude Code turn boundaries are derived** from the prompt entry; a compacted or continued
   session can misattribute its earliest turns.
3. **Average burn is the turn's**, paired with the turn's own clock — not a session average.
4. **A repeated API response is billed once**, by `message.id`; a proxy that logs one line per
   content block without ids would be counted per line.
5. **The first run prices DeepSeek only**, until the first rate-card fetch lands. An unpriced
   model reads as zero rather than as its real cost.
6. **`lib/` is copied from dsh-budget-watcher 0.7.2, not shared.** The two drift on purpose; a
   fix in one should be checked against the other.
7. **The window is Windows only.** Placement is Win32 calls. The status line, the daemon, the
   CLI and the Codex adapter are pure Node and portable; the window would need `/Applications`
   browser paths, a platform branch for placement, and `.app`/`.dmg` bundle targets.
8. **The window's page is one HTML file with inline JavaScript.** Tests execute that script
   against a stub DOM, so logic and scope errors are caught; layout, CSS and rendering are not —
   those still need eyes.
9. **The hook is verified on Codex, not on Claude Code desktop**, because no Claude Code desktop
   app exists on the machine this was built on. The file editing is tested; the firing is not.
10. **A reused window keeps the host it was created with.** Close it to get one bound to a
    different host. Making reuse host-aware is not worth the complexity yet.
11. **A browser window cannot appear at the right size instantly**, and at high display scaling
    (200% here) its taskbar icon is upscaled by Windows and looks soft — Edge renders its *own*
    default globe the same soft way, which is the quickest proof that the artwork is not at fault.
    `backend: "tauri"` avoids both: the widget declares its own size and carries a real window
    icon, built at **128 px** so that the 64 px taskbar slot of a 200% display is an exact 2:1
    reduction. The window icon is compiled in, so changing it means rebuilding the widget, and the
    shell's icon cache can go on drawing an older bitmap for the same exe path — restart Explorer
    to clear it. If the widget fails to appear, its own explanation is written to the window log
    (`acm log`) rather than discarded; the browser fallback then runs, and that fallback is the one
    case where a soft taskbar icon is unavoidable.
12. **The balance is deliberately not shown.** It is DeepSeek's, and only DSH can read it, so in
    a window that also serves Codex and Claude Code it would describe a different provider.
13. **Tiered pricing is not applied.** 80 of the 459 entries in the fetched list publish a second
    rate above a token threshold (`overrides[]`, e.g. a doubled rate past 272k prompt tokens).
    Those tiers are ignored, so a very long-context call is understated; the first-tier rate is
    used for the whole call.
14. **Some entries are genuinely priced at zero by the source** — 19 of 459, nearly all `:free`
    variants — so a zero is not always a missing price. Where a model you use reads zero and your
    provider charges for it, give it rates yourself (above); where it reads zero and is free, leave
    it. What must never happen is a zero standing in for "unknown", which is why an unpriced model
    says `(no rate card)` rather than `¥0.00`.
15. **The rate card comes from `openrouter.ai`, and without it nothing but DeepSeek can be
    priced.** Where that host is unreachable — it times out from some networks — the bundled
    DeepSeek table still prices DeepSeek, every other model reads as unpriced, and the line says
    so (`(no rate card)`) rather than showing a bare `¥0.00`. A failed fetch is retried after ten
    minutes and never overwrites a working card. If you need a model the fetch cannot reach, the
    cache is a plain JSON file at `~/.cache/spend-watch/claude-pricing.json` and can be seeded by
    hand.
16. **The tray is Windows-only.** The notification-area icon is a Windows shell object, so
    `acm tray` cannot exist elsewhere; it needs PowerShell 7 or Windows PowerShell, and it asks the
    daemon for every figure rather than reading anything itself — starting one when nothing answers.
    It is started through the **Task Scheduler**, because a process spawned directly by `acm` is
    killed the moment that command exits (a job object with kill-on-close covers the tree), which is
    what made the icon flash and vanish. In the taskbar's own settings it is listed as **Windows
    PowerShell**, because the icon belongs to the process that owns it, not to this project.
17. **The tray shows the last turn that *finished*,** never the one still running, and marks a
    figure as the shorter call-span estimate when the host does not record its own turn bounds. A
    total that is still climbing, under a label that calls it final, is the one thing it must not
    show.
18. **A notification-area icon is 16 logical pixels, and no more.** At 200% scaling the shell
    draws that slot as 32 physical pixels — which the tray uses — but it is the only text slot
    Windows offers a third-party app. Text in the taskbar's own row, beside the clock and the
    battery percentage, is shell-owned: the Deskband API that once allowed it was removed in
    Windows 11. The alternatives are injecting into `explorer.exe` or floating a window over the
    taskbar, and neither is worth the fragility.
19. **Changing the tray's script needs the tray restarted** — it is a running PowerShell process,
    so `acm tray --stop` then `acm tray` — and a tray that is already running holds a session mutex
    that makes every later start leave quietly. If a start seems to do nothing, check
    `acm tray --status` first. The tray's own log,
    `~/.cache/agent-cost-monitor/tray.log`, records where it got to, including which DPI-awareness
    call succeeded and how large a slot it was given.

## Licence

MIT
