# Changelog

All notable changes to this project are documented in this file, together with the
[README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.1] — 2026-10-15

### Fixed

- **The tray was killed the instant `acm` exited, which is why it only ever flashed.** Measured
  with a throwaway probe rather than guessed: spawn PowerShell with exactly the options the tray was
  spawned with — hidden, `unref`, not detached — from a node parent that then exits, and the child
  is gone within seconds; the same probe from inside a PowerShell job is gone too. A **job object
  with kill-on-close** covers the tree, the same restriction that refuses the widget a window. So
  the tray built its notification icon, wrote its pid file, and was killed during its first refresh:
  the icon appeared for about a hundred milliseconds, the log never reached the line that records
  the decision, and the pid file was left behind pointing at a process that no longer existed —
  which is why `acm tray --status` could report a tray that was already dead.

  `acm tray` now hands the tray to the **Task Scheduler** (`/it`, so it runs in the interactive
  session a notification icon requires), outside the caller's job.

- **The hand-off was itself broken in its first version.** The arguments were joined into a string
  and each one re-quoted, which double-quoted the task's own action: schtasks stored a mangled
  command line, PowerShell never started, and the tray died before writing a single log line —
  exactly the "nothing comes up and nothing says why" symptom the change was meant to remove.
  Arguments now go to `schtasks` as an array, with no shell and no re-quoting.

- **The tray log destroyed every non-ASCII character.** `Add-Content` used the console's default
  encoding, so the currency symbol and any non-ASCII model name became `?` on the way in. It is
  written as UTF-8 now.

### Changed

- **The tray's interface is English**, like the rest of the project: its menu items, tooltips, host
  lines, and its no-data and error messages. One deliberate exception — verbatim quotes of what
  Windows itself said, such as the SmartScreen refusal and the File Explorer window title found in a
  window search, keep their original text and now carry an English gloss, because translating
  evidence would falsify it.

## [0.16.0] — 2026-10-13

Merged from a fork (PR #1, CaiJw147): the tray, and two pricing corrections. The entries below are
written from that work's commits and its tests — the code is theirs, the documentation is mine.
It arrived with no changelog entry and no version bump, which is why this one exists.

### Added

- **`acm tray` — the figures in the notification area, between the panel and the status line.** A
  third renderer over the same engine: it prices nothing and reads no transcript of its own, it
  draws what the daemon already computes.

  **The icon is the figure.** The current turn's cost, as at most three glyphs, taken as geometry
  and scaled into the 16px box the shell actually asks for rather than a larger bitmap for the shell
  to resample — and grown taller than it is wide, because a condensed figure reads better than a
  small one. White on a dark taskbar and dark on a light one (the theme is re-read on every redraw),
  turning amber once the burn rate passes `warnPerHour`, which is what the window's dot does.

  - It **shows itself only while an agent is behind it** — a transcript or rollout written recently,
    or an open window polling the daemon — and takes itself away after five minutes of quiet. A turn
    in flight always counts as presence, so a ten-minute build cannot make the figure vanish
    mid-work.
  - Its menu reports the **last completed turn**, the session total and both burn rates, and says
    whether a window is open. Where a host records its own turn bounds the menu says so; where it
    does not, the figure is marked as the shorter call-span estimate rather than passed off as the
    turn.
  - **One instance, enforced by a named mutex** rather than a lock file, so a crashed tray cannot
    lock out the next one. `acm tray --install` writes a Startup entry as a `.vbs`, so no console
    flashes at login; `acm uninstall` removes it and stops the tray.
  - Tray reads identify themselves (`client=tray`) so they are not counted as a window by
    `windowPolledAt`, which is the field that says whether a window is open.

### Fixed

- **Each Codex call is billed once.** A rollout can carry the same usage more than once; the engine
  now counts it a single time (`test/codex-token-usage.test.js`).
- **Decorated model ids are priced.** A name carrying a suffix or a vendor prefix resolves to its
  base price instead of reading as unpriced (`test/cost-spellings.test.js`).
- **`window/tray.ps1` asked for `icon.ico`**, a file this project had already renamed to `mark.ico`
  when a browser-cached favicon was showing stale artwork. The tray's own fallback kept it working,
  which is exactly what hid the mistake: it had been displaying a generic Windows icon instead of
  the mark.

### Notes

- The tray is Windows-only by nature — the icon is a Windows shell object — and needs PowerShell 7
  or Windows PowerShell. It starts the daemon itself when nothing answers, so a tray on its own
  still has figures to show.
- Its menu labels are in Chinese, as the contribution arrived. Worth a decision rather than a
  silence: the rest of the interface is English.

## [0.15.18] — 2026-10-13

### Changed

- **The supplied artwork is gone from the repository entirely; the mark is the only source now.**
  Deleted: the whole `iconset/` export (every .ico and .png in it, plus the snippet that referenced
  them) and everything derived from it — the `npx tauri icon` leftovers (`Square*Logo.png`,
  `StoreLogo.png`, `icon.icns`: about 380 KB of unused tiles for a Windows-only build).
  `build-icon.py` no longer defaults to that export; it reads `build/acm-iconset/`, which only
  `build-mark.py` produces from `assets/acm-icon.svg`. Even the intermediate renders were renamed
  `mark-*`, because a file called `favicon-128.png` in this repository is a claim about whose
  artwork it is.

- **The page asks for `mark-*` paths, and that is the bug fix rather than tidying.** A browser
  caches a favicon **by URL**, so replacing the bytes at an existing path leaves the old picture on
  screen indefinitely. That is exactly what was happening: every shipped icon already measured as
  the mark — 18.5 to 22.2 percent of the canvas opaque, against 92.7 percent for the supplied tile —
  while the taskbar went on drawing the tile from cache, because the page still asked for
  `/icon-32.png`. Measured, not assumed: opaque coverage distinguishes the two designs
  unambiguously, and it said the files had been right for several versions. New paths are the only
  cache-bust a favicon respects. The server accepts both names so an already-open window can still
  be closed cleanly, and the old-named files were deleted rather than left to be served.

## [0.15.17] — 2026-10-13

### Fixed

- **A launch could hang forever after giving up on the widget.** `unref()` had to go, because it
  suppressed the exit event the launcher was waiting for — and with it gone, a widget that cannot
  create a window and never exits kept Node's event loop alive through its piped stderr. A real
  launch sat for five minutes. A given-up attempt now kills the child outright, which is the honest
  end of a process that has already been written off.

- **Two of my own diagnostics were blind.** `EnumWindows` enumerates only the calling process's
  desktop, so a window probe running inside a host hook cannot see a window the Task Scheduler
  created in the interactive session — every "no window appeared" concluded from a hook context was
  therefore unproven. The daemon answers without that limitation: `/health` reports
  `windowPolledAt`, and a window polls once a second. Asked that way, nothing was polling and no
  widget process existed, which settled that the scheduler launch fails here too. And because a
  scheduler-started process has no stderr to capture, the widget now writes its own failure into
  the window log itself (`note_in_log`, stamped in epoch milliseconds since there is no date crate).

### Added

- **A failed widget launch is remembered for ten minutes.** Hook-driven launches were paying seconds
  per prompt for an attempt already known to fail; they now go straight to the browser. The state
  lives in a marker file whose SIZE carries it — empty is healthy, a non-empty timestamp is a
  failure — which needed no new import, since `statSync` already answers both questions.

## [0.15.16] — 2026-10-13

### Fixed

- **`acm update` reported the wrong directory's version.** Run from a checkout, as it normally is, it read the version beside itself — the SOURCE — and printed it as "installed", so "already current (0.15.15)" was a claim about the repository while the question was whether the global copy had been refreshed. It now asks npm for its global prefix, reads the version there, prints the source separately, and after installing compares the two: if the global copy still disagrees with the source it says so and names the cure instead of reporting success. Verified on this machine: every file in the global copy is hash-identical to the repository, which is what settled that the install was never the problem.

- **The Task Scheduler probe is capped at 8s instead of 15s.** A scheduler launch starts the widget immediately, so a working one appears within a second or two and the probe returns as soon as it does; the cap only bounds the failing case, which is the one the user pays for.

## [0.15.15] — 2026-10-13

### Fixed

- **The Explorer hand-off was the wrong door, and it produced a SmartScreen prompt.** Reported with
  a screenshot of Microsoft Defender SmartScreen blocking `agent-cost-monitor-window.exe` as an
  unrecognised app: launching an unsigned executable **through the shell** is exactly what
  SmartScreen exists to interrupt. So the escape from the restricted context became a security
  dialog sitting on screen with no widget behind it, while the launcher waited out its own timeout
  — two symptoms, one cause, and the cause was the line added an hour earlier. The hand-off is now
  to the **Task Scheduler** (`schtasks /create` with `/it`, then `/run`), which starts the process in
  the interactive session and never touches the shell. It also needs nothing passed in, because the
  widget reads its own port and geometry from the config file.

- **A doomed launch no longer costs the full wait.** Three attempts, each defeated by an assumption:
  `unref()` suppressed the very exit event it was waiting on; the exit event does not arrive at all
  when the widget cannot create a window in a restricted session and simply sits there; and a
  truncated pipeline had earlier made it look as though the process exited promptly. The reliable
  signal is the widget's **own sentence** — it declares that it could not create the window within a
  few hundred milliseconds — so a 100 ms watcher triggers on that, with the exit and close events
  kept as second triggers, and the post-failure re-probe dropped from 2 s to 400 ms because a dead
  process cannot have produced a window.

### Notes

- The daemon's repeated resolution line is collapsed in the log (as a count of the repeats), which is
  what had made `acm log --lines 20` return nothing but polls and hide the launcher's own account of
  a failed start.

## [0.15.14] — 2026-10-13

### Changed

- **The mark is new, and drawn for the two things that ruin an icon: a 16px slot and a blur.**
  After the evidence said the supplied artwork was never the problem and the taskbar was still soft,
  the useful move was to stop fighting the rendering path and design something that survives it.

  `assets/acm-icon.svg` is one continuous shape — a stepped line climbing to the right, which is
  what a burn rate does — stroked wide with round joins, in the light yellow the window already
  uses, on **transparency** rather than a tile. Every alternative failed one of the tests: a glyph
  goes mushy at 16px, a tile disappears against a dark taskbar, several bars merge into one blob
  under a blur, and thin lines vanish outright. A single thick ribbon survives all of them, and a
  deliberately blurred render confirms it degrades into a soft rising streak rather than mush —
  which is the property that was asked for.

- **`build-mark.py` renders it, reading the geometry out of the SVG** rather than repeating the
  coordinates in a second place. Edge can rasterise SVG and does render the README banner, but its
  headless screenshot ignored `--window-size` here and returned the desktop work area: a 16px
  favicon came back as **746x483**. That was caught only because `build-icon.py` refuses a bitmap
  claiming a size it does not have — which is precisely why that check exists. Pillow draws the
  polyline at 4x and reduces once, so the pixel sizes are exact and the edges are supersampled.

### Notes

- The `.ico` carries 16 through 256, and the window icon remains the 128 — an exact 2:1 of the 64px
  slot a 200%-scaled taskbar asks for. The widget is rebuilt with it, since the icon is compiled in.
- The previous artwork is untouched in `iconset/`, so `python build-icon.py iconset` still rebuilds
  from it; the mark in `assets/acm-icon.svg` is now what the shipped sets come from.

## [0.15.13] — 2026-10-13

### Fixed

- **The widget could not start at all from a host hook, and the icon was never the problem.**
  The log finally said it, once the launcher stopped discarding stderr:

  ```
  tauri widget said: agent-cost-monitor: could not create the window: 拒绝访问。 (access denied; os error 5)
  ```

  A process started by a hook inherits that process's restrictions, and Windows refuses a WebView2
  window inside them. **A browser escapes this by handing off to its own already-running process**
  — which is why Edge created a window in the very same launch while our exe was refused, and why
  the taskbar kept showing Edge's soft, favicon-derived icon.

  The launcher now **retries the widget through Explorer** when the failure is "access denied"
  (or when the widget said nothing at all). Explorer runs in the interactive session, so the window
  it starts is a real one. Explorer cannot carry the launcher's environment, so the widget now
  **reads its own port and geometry from `~/.agent-cost-monitor.json`** — with the environment still
  winning, because a direct launch is the more specific instruction.

- **WebView2 gets an explicit, writable data folder**: `%LOCALAPPDATA%\agent-cost-monitor\webview2`.
  Left to the default it lands beside the executable — for a development build, inside
  `target/release`, a directory a rebuild replaces — and a data folder left behind by an instance
  running with different rights is a documented cause of "access denied" at startup.

### Notes

- The failure sentence the widget prints now names the cause rather than the symptom: it says that a
  hook, service or background job cannot create the window, that a browser only escapes by handing
  off to its own process, and that starting it from your own session works.
- The icon work from 0.15.11–0.15.12 remains correct and unindicted: the window icon is the 128px
  bitmap, an exact 2:1 of the 64px slot a 200%-scaled taskbar asks for. It simply never had a
  window to be drawn on.

## [0.15.12] — 2026-10-13

### Fixed

- **The launcher threw away the widget's own explanation, and called a slow start a failure.**
  Chasing a taskbar icon that stayed blurred found this instead, and it was the cause:

  ```
  15:57:52  the tauri widget showed no window within 4s; falling back to the browser
  ```

  Every launch was falling back to an **Edge** window — the one backend whose taskbar icon cannot
  be crisp, because a Chromium app window takes it from the page favicon through Chromium's own
  path. So the widget was never on screen to be judged, and its failure was invisible: spawned with
  `stdio: "ignore"`, its stderr — one sentence naming the reason — went nowhere. Two changes:

  - the widget's stderr is captured into the window log, so "failed" and "slow" stop being the same
    event from the outside. Demonstrated on the failure path this shell can reproduce:

    ```
    tauri widget said: agent-cost-monitor: could not create the window: 拒绝访问。 (access denied; os error 5)
    tauri widget said: This needs an interactive desktop session with the WebView2 runtime.
    ```

  - the probe waits **15 s, not 4**. A cold WebView2 start on a loaded machine can exceed four
    seconds, and the widget does arrive — declaring failure then opens a second, inferior window on
    top of the good one.

### Notes

- **The icon work was not the problem, and the artwork is measurably innocent.** Gradient energy in
  the supplied bitmaps — a blurred bitmap has weak, wide gradients — measures 25.1 at 16 px and
  16.8 at 32 px, i.e. genuinely sharp edges, and the window icon (128 px) is an exact 2:1 of the
  64 px slot a 200%-scaled taskbar asks for.
- **What the taskbar actually draws:** for a running window it uses the **window's** own large icon,
  never the exe's resource and never a favicon. Windows *downscaling* is fine; **upscaling** is what
  blurs, which is why a 16 px resource in a 32 px slot looks soft and a 128 px icon in a 64 px slot
  does not.
- **The shell's icon cache can keep an old bitmap** for an exe path after the icon changes — the
  caches here were last written before the rebuild. Restarting Explorer, or deleting
  `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` and restarting it, is the cure.
- **Tauri sets only the window's large icon; `ICON_SMALL` is never set.** The small-icon slot
  therefore falls back to whatever Windows derives. Setting both, from the exact 32 and 128
  bitmaps, is the next lever if the taskbar still looks soft on the widget path.

## [0.15.11] — 2026-10-13

### Changed

- **The icon sets are assembled from `iconset/` instead of resampled from one big source.** The
  set supplies exact 16, 24, 32, 128, 144 and 512 bitmaps, so `build-icon.py` now takes those
  bitmaps **as given** — including the 24, read out of the set's own `.ico` — and derives only the
  sizes the set does not carry (48, 64, 256), from the 512 master by halving so every step is an
  exact 2:1. It also refuses to run if a file claims a size it does not have, and reads every
  written file back afterwards, because a ladder that silently produces a 1x1 or an `.ico` that
  lost an entry surfaces much later as "the icon looks wrong".

- **The window's own large icon is now the 128.** This is the bitmap that decides whether a taskbar
  looks blurred: a running window's taskbar button is drawn from the **window's** icon at the
  taskbar's pixel size, which on a 200%-scaled display is 64 — so 128 is an exact 2:1 of it, where
  the previous 256 was 4:1 and the available 512 would have been 8:1. The `.ico` still carries 256
  for Explorer, the jumplist and any surface that asks for it.

### Notes

- **The browser backend cannot be made crisp, and this is now the stated reason to prefer the
  widget.** A Chromium app window takes its taskbar icon from the page favicon through its own
  rendering path at its own chosen size; Edge renders its *own* default globe the same soft way at
  200% scaling, which is the quickest proof that the artwork is not at fault. `backend: "tauri"`
  gives a real window icon that Windows scales **down**.
- The window icon is compiled in with `include_bytes!`, so rebuilding the widget is part of
  changing it — the sets on disk alone do not alter a running build.

## [0.15.10] — 2026-10-13

### Fixed

- **A window you had positioned could be snapped back to the corner by a launch that was never
  asked to move anything.** Reported as "the widget location resets every turn, again". Two things
  had to be true together, and on the reporting machine they were:

  1. the Claude Code window hooks were installed by an earlier version and had never been removed
     — 0.15.7 stopped *installing* them, but only a later `acm hook on` can remove an existing one
     — so every prompt in the desktop app ran `acm launch --if-needed --host claude`;
  2. the launcher reused an existing window **only when `--if-needed` was present**. A hook without
     it, or any hand-typed `acm launch`, fell through to the browser path, whose `place` script
     finds the first window with our title and re-applies the configured geometry.

  Reuse is now the default for every caller and only `--new` opens a second window, so a window's
  position cannot depend on which flags the caller happened to pass. Verified by moving the window
  by hand to `1200,300`, running `acm launch` with no flags, and re-reading its rectangle:
  `1200,300`, with the window count unchanged.

- **The obsolete Claude Code hooks were removed from the reporting machine** — the status line and
  a4phone's own hooks are untouched. 0.15.7 could only remove what it found when `acm hook on` next
  ran; that had not happened, which is why the per-prompt window launches were still firing.

### Notes

- Residual, stated plainly: `--new` still lets the `place` script act on the first matching window,
  so deliberately asking for a second window can nudge an existing one. A fresh window takes its
  geometry from the browser arguments either way.

## [0.15.9] — 2026-10-13

### Fixed

- **A rate you delete now actually disappears.** Reported as "how could `gpt-6-sol` be 0-0-0",
  which turned out to be my own doing rather than the provider's. The fetched list carries
  `openai/gpt-6-sol` at **$2 in / $10 out per million** (cached $0.20) — the card was right. The
  zero came from a *placeholder override with zero rates* that I had written into the user's rates
  file: the merge had already copied that row into the cache, and emptying the file afterwards
  could not remove it, because a row cannot delete itself.

  The merge now records which keys the local table introduced (`localKeys`) and **removes them
  before applying the next merge**, so an emptied file leaves the fetched table exactly as fetched.
  This is the general form of the bug: a corrected or deleted local rate would otherwise have gone
  on pricing a model at its old value indefinitely, and it would have looked authoritative.

### Notes

- Two facts about the source list, found while auditing it, are now written down as limitations:
  **80 of 459 entries publish tiered rates** (`overrides[]`, a second rate above a token threshold,
  e.g. doubled past 272k prompt tokens) and those tiers are ignored, so a very long-context call is
  understated; and **19 of 459 are genuinely priced at zero** by the source, nearly all `:free`
  variants — so a zero is not always a missing price, which is why the local rates table exists for
  the case where your provider charges and the listing says nothing.

## [0.15.8] — 2026-10-13

### Added

- **Your own rates, for models the fetched card does not cover.** Reported as "it still estimates
  0.00/0.00 for `gpt-6-sol`": that model is not in the public list **and** this machine cannot
  reach the list anyway, so there was no price source at all — and an unpriced model reads as a
  free one, which is the worst way to be wrong. Rates can now be supplied by hand in
  `~/.agent-cost-monitor.pricing.json` (USD per million tokens, `input` / `cachedInput` / `output`):

  ```json
  { "models": { "gpt-6-sol": { "input": 1.25, "cachedInput": 0.125, "output": 10 } } }
  ```

  They win over the fetched card for the names they list, are **re-applied after every fetch** so a
  successful fetch cannot discard the only prices a blocked network can have, and live outside the
  cache directory because `acm uninstall` may clear that and a table typed by hand is not ours to
  delete. A row without an `output` rate is skipped rather than half-applied — pricing output at
  zero would understate a turn while looking priced — and a missing `cachedInput` falls back to the
  plain input rate rather than to zero, which is the conservative direction.

### Added

- **`acm update`** installs the published version (`npm install -g agent-cost-monitor@latest`) and
  prints the version before and after, so "updated" that moved nothing is visible as such.
  `acm update --local` reinstalls from a checkout instead, which is how a fix reaches a machine
  before it is published.

## [0.15.7] — 2026-10-13

### Fixed

- **A fresh install showed no status line at all — and took eleven seconds to say nothing.**
  Reported from a second machine: the pop-up appeared, the line did not. Measured here:

  ```
  cold (no rate card):  10,798 ms
  warm:                     71 ms
  ```

  The first-run path fetched the rate card inline under a 2.5 s cap, and the cap was a lie: the
  fetch kept Node's event loop alive until the socket gave up, so the script ran for ten seconds.
  A status line is allowed a moment, not ten seconds, so Claude Code rendered nothing — while the
  session hooks fired and opened the window exactly as configured. The inline fetch is gone: the
  line renders from whatever is cached (on a cold cache it says `(no rate card)` — honest, and
  instant) and the refresh always happens in a detached child.

- **Claude Code no longer gets a window.** The rule is line-only for its CLI, and since the CLI and
  the desktop app share one settings file, a hook cannot be limited to the desktop. `acm hook on`
  now removes any Claude Code window hook instead of installing one, and says so; the desktop case
  is opt-in with `acm hook on --host claude --window`. Codex and DSH keep their hooks — neither has
  a status row.

### Changed

- **The status line's clock settles sooner** (8 s of quiet instead of 30 s). The window can afford
  30 s because a host there often reports its own lifecycle; a line has no such signal, and a clock
  that is still climbing after the work stopped is the thing people notice. The frozen value is
  unchanged — the turn's last recorded step — and a harness that reports its duration (Codex's
  `duration_ms`) is still used exactly: a 1 min 52 s task freezes at `1:52`.

## [0.15.6] — 2026-10-13

### Added

- **An offline copy of the rate card, kept up to date on its own.** Every successful fetch now
  writes two files into `~/.cache/spend-watch/`:

  - `pricing-rows.json` — the machine-readable record: one row per model, plus when it was
    fetched, when it last changed, when it was last checked, the FX rate and the source;
  - `pricing.md` — the document a person reads: the same metadata as a header and a table of
    rates in USD per million tokens.

  **The document is rewritten only when the list has actually changed** — that is its whole
  purpose, and rewriting it on every fetch would destroy it. Changes are diffed per model
  (added / removed / repriced) against the previous record, source ordering is normalised first so
  a reshuffle is not 1,300 "repriced" models, and a failed or partial fetch writes **neither**
  file, so a network problem cannot erase a good record. The record itself is written on every
  successful fetch, because "when was this last checked" is worth knowing on its own.
- **`acm pricing`** reads that record — models, when fetched, when changed, when checked, the FX
  rate and the last change — and prints where both files are. `acm pricing --refresh` fetches
  first. Neither needs the module's own state: it is all on disk, which is why it works on a
  machine whose network cannot reach the rate-card host.

### Notes

- The diff and the document are pure functions in `src/pricing-doc.mjs` with eight tests of their
  own, including that a reordered source is not a change, that an empty fetch produces no rows
  rather than free models, and that a missing cache-write price drops the column instead of
  printing dashes. A document that can say "0 models" while looking like a price list is worse
  than no document, so the empty case is stated in words.

## [0.15.5] — 2026-10-13

### Fixed

- **A failed rate-card fetch was cached as a success for 24 hours.** Reported as "the estimate is
  not working" after a fresh install: the line read `¥0.00 / ¥0.00 · β(t) ¥0.00/h · β ¥0.00/h`
  with `54 unpriced`. The cause was not leftover state — it was this machine's network:

  ```
  fetch https://openrouter.ai/api/v1/models  →  UND_ERR_CONNECT_TIMEOUT
  ```

  The FX endpoint answered, the model endpoint did not, and the refresh wrote
  `{ models: {}, fetchedAt: <now> }` anyway. So for the next 24 hours every render saw a *fresh*
  cache, priced nothing, and had nothing to explain why. Four rules now:

  - `fetchedAt` moves **only** when a model list actually arrived, so a failure leaves the cache
    stale and the next run retries;
  - `models` is only ever replaced by a **non-empty** table, so a working rate card survives a
    transient failure instead of being wiped by it;
  - a cache with **zero models never counts as fresh**, however recently it was written — the rule
    that would have prevented this on its own;
  - a failed attempt buys a **10-minute cooldown**, so "stale" does not mean one fetch per render,
    each waiting out its own timeout.

- **The line now says why it is zero.** A missing rate card appends `(no rate card)` (or the fetch
  error) rather than presenting `¥0.00` as though the session had been cheap. The line previously
  could not distinguish "cost nothing" from "cannot price anything".

### Changed

- **Environment-specific model names are gone from the repository.** A scan of all tracked files
  for personal paths, email addresses, API keys, session ids and the model names this machine
  happens to run found them in four test files and two comments; they are now `test-model`. The
  alias table in `lib/cost.js` keeps real product names, because recognising them *is* its
  function. Also re-confirmed: no personal paths, no email addresses, no keys, no transcript or
  session ids anywhere in the tree.

### Notes

- **The rate card needs `openrouter.ai`.** Where that host is unreachable, DeepSeek models still
  price from the bundled table and every other model reads as unpriced — now visibly, on the line
  and in `acm doctor`, rather than as a silent zero. The cache is a plain JSON file
  (`~/.cache/spend-watch/claude-pricing.json`) and can be seeded by hand.

## [0.15.4] — 2026-10-12

### Fixed

- **`acm status` told Codex users their host was unsupported.** The line read "not supported
  yet (no status-line hook; hooks/notify only)" — true when it was written, and wrong since 0.9,
  when the Codex adapter (rollouts and SQLite) and the `SessionStart`/`UserPromptSubmit` hooks
  landed. It now reports whether the hooks are installed and points at `acm hook on` when they
  are not. Found by running the published 0.15.3 from the registry and reading its own output,
  which is exactly the kind of stale text a release smoke test exists to catch.

## [0.15.3] — 2026-10-12

### Changed

- **The text block is vertically centred on the widget panel**, the way the panel is centred in
  the canvas — so the three share one axis instead of two competing ones. The block sat 26 px
  low, which is the kind of misalignment that reads as sloppy without being nameable.
- **A second peak, at the 3:2 division of the axis (60%), rises just above the warning line.**
  It is not decoration: it is the moment the dot would turn amber, so the chart now shows the
  threshold being crossed and re-crossed rather than describing it. Apex sits 12 px above the
  line — above, but plainly not a different order of magnitude.

### Notes

- Verified by rasterising with headless Edge and looking at the result. An attempt to measure the
  centring from pixels was abandoned rather than trusted: the colour masks matched the background
  gradient and the amber label instead of the panel plate and the dashed line, and a measurement
  that answers a different question is worse than no measurement.

## [0.15.2] — 2026-10-12

### Changed

- **The banner was redesigned, and the icon replica removed.** A hand-drawn SVG copy of a bitmap
  icon reads as subtly wrong at banner size — the right answer is not to draw it better but not
  to draw it. The **widget's chart now takes that space on the left**, which is better on its own
  terms: it is what the project actually looks like, and it shows the figures doing something
  rather than describing them.
- **The flashing red dot moved beside the heading**, where it reads as a status badge next to the
  name instead of as a detail of a picture.
- Canvas is now 1200×340 with the bottom margin raised to match the top, so the block sits
  evenly rather than hanging toward the bottom edge.

### Verified

- Rasterised with headless Edge and then **measured the render** rather than eyeballing it: the
  heading's last ink ends at x=812 and the dot spans 836–859, a 24 px gap with no collision. On
  the first attempt the dot sat at 900, which the render showed as floating rather than adjacent.

## [0.15.1] — 2026-10-12

### Changed

- **The README was rewritten to say only what a reader needs**, with a designed banner
  (`assets/header.svg`) at the top instead of prose. Removed outright: the whole icon section,
  the screenshot, and the long annotated walk-throughs.
- **The status-line format is now scoped explicitly.** `¥0.53 / ¥19.72 · β(t) ¥0.00/h · β
  ¥5.94/h · 5:21` is the **Claude Code CLI** row and nothing else — every other host, and Claude
  Code when you want the picture, is the Tauri window. The old README let the row read as the
  project's general output.
- **β is defined before it is used.** A section states plainly that **β is burn**, defines it as
  currency per hour and never a total, and gives every figure in the row its own meaning, then
  states exactly what the numbers are computed from.
- **A DSH-desktop section** now sits above *How it works*: users on DSH are pointed at
  [dsh-budget-watcher](https://github.com/NeutronStar714/dsh-budget-watcher) first, and this
  project is described as that one step further — cross-platform, sharing the same engine and
  the same `burnWindowMs` meaning.

### Notes

- The banner is a self-contained SVG: no external fonts or images, and the burn line is
  deliberately **not** animated, because a dash-offset draw animation left only a fragment of the
  line wherever CSS animations do not run. Verified by rasterising it with headless Edge and
  looking at the result, not by assuming it renders.
- All limitations are retained, compressed to one line each.

## [0.15.0] — 2026-10-12

### Fixed

- **A launch could be silently blocked by a completely unrelated window.** Found live on this
  machine:

  ```
  vis=True  1132x713  pid=12940 (explorer)  title='agent-cost-monitor - 文件资源管理器'  (File Explorer)
  ```

  A **File Explorer window on the project folder** contains the project name in its title. The
  window search matched as a *substring*, so it found Explorer's window, concluded a window was
  already open, and did nothing — every launch in that state was a no-op. That is what "I tried
  launching again and it failed" actually was, and it also meant the Tauri widget (with its
  fixed icon) never got a chance to run. The search now requires an **exact** trimmed,
  case-insensitive title match, which is what our app window and the widget both carry.
- **A widget that cannot start left no window and no explanation.** If it exits without creating
  one — no interactive desktop, a missing WebView2, a restricted session — the launcher used to
  report success. It now waits up to four seconds for the window and **falls back to a browser
  window**, verified live in an environment where the widget genuinely cannot start.
- **`acm launch` no longer stacks a second window.** It reuses an open window; `--new` asks for
  another deliberately. The log showed a manual launch finding an existing window and then
  adding a second one at the corner, which is easy to read as a failure.

### Notes

- **The blurred taskbar icon is a display-scaling problem, and our artwork was never at fault.**
  `AppliedDPI = 192` — this display is at **200%**, so a 32 px taskbar slot wants **64 px** of
  artwork. An Edge/Chromium app window supplies roughly 32 px and Windows **upscales** it, which
  is why Edge's *own* default globe was blurred in exactly the same way. The browser path cannot
  be crisp at this scaling; with `backend: "tauri"` the widget carries a 256 px window icon that
  Windows **downscales**. Measured along the way: the original 512 artwork was 3.7% mid-tone
  pixels and the Illustrator redraw 1.7% — both crisp, so the artwork was exonerated by
  measurement rather than by opinion.
- **Why earlier diagnosis kept landing on the wrong icon:** my DPI reading of "96" came from a
  process that was not DPI-aware, which always reports 96. Asking the registry for `AppliedDPI`
  is what gave the real number, and it also explains why every screenshot I took was offset.

## [0.14.2] — 2026-10-12

### Fixed

- **The blur persisted because I had been fixing the wrong window's icon.** The backend in use
  is `browser`, so the taskbar button belongs to **Edge** — and an Edge/Chromium app window
  takes its taskbar icon from the **page's favicon**, rendered through Chromium's own path. No
  `.ico` and no Tauri window icon can affect it. The 0.14.1 change improved the Tauri widget's
  window icon, which was not the icon being looked at; that is worth stating plainly rather
  than burying.
- **The page now offers its icon at declared sizes.** `<link rel="icon">` entries for 16, 32,
  48 and 256 px, plus a multi-size `.ico`, served from `window/`. A Chromium app window picks a
  favicon bitmap at the resolution it wants; giving it one image and letting it scale is how a
  taskbar icon ends up soft. The route is a whitelist (`/icon`, `/icon-<digits>`, `.png`/`.ico`)
  so no path can escape the directory — `/../package.json` answers 404.
- **Everything is regenerated from the new Illustrator source**, which measures about twice as
  crisp as the old one — **1.7% mid-tone pixels** at full size against 3.7%, and **6.5% against
  8.6%** at 32 px. The Tauri widget was rebuilt from it too.

### Notes

- **The reliable way to a crisp taskbar icon is `"backend": "tauri"`.** The widget sets a real
  256 px window icon, whereas the browser path hands the job to Chromium. Documented in the
  README rather than switched silently, because it changes the window's whole nature.

## [0.14.1] — 2026-10-12

### Fixed

- **The blurred taskbar icon, and the answer to "should I convert my icon to .ico?" — no.**
  The `.ico` was never the problem: it already carried 16/24/32/48/64/256, the display is at
  100% scaling so the taskbar wanted exactly 32 px, and that size was present. Three things
  were actually wrong, in order of how much they mattered:

  1. **The window's icon was 32 px.** For a *running* app the taskbar draws the window's own
     icon, not the executable's resource, and Tauri takes the default from the first entry in
     `bundle.icon` — which was `32x32.png`. A 32 px image rendered into a ~48 px slot is
     **upscaled**, which is where the blur came from. The widget now sets its window icon from
     `icons/icon.png` — 256 px, generated from your 512 source (`image-png` feature added) —
     because Windows scales down well and up badly. The Explorer *file* icon, which does use
     the multi-size `.ico`, looked correct all along — a useful clue that was easy to miss.
  2. **Every `.ico` entry was stored as PNG.** Windows has supported PNG-in-ICO since Vista,
     but the convention is DIB below 256 and PNG only at 256, and the shell paths that draw a
     taskbar button are the least forgiving. Regenerated with DIB entries for 16–128.
  3. **The small sizes came from one 512→32 reduction.** Now an explicit halving ladder
     (512→256→128→64→32→16) with LANCZOS, resampling only by factors of two.

  Measured first, and it **exonerated the source artwork**: 3.7% mid-tone pixels at 512 and
  8.6% at 32 px, where a genuinely soft icon would be far higher. An earlier claim in this
  session that the 512×512 PNG was itself blurry was wrong, and the measurement is why that is
  known rather than argued.

### Verified

- The regenerated `.ico` parses as 7 entries, DIB for 16–128 and PNG at 256.
- A 4× side-by-side of the 32 px entry before and after, and the median-tone measurement above.
- What I could **not** verify here: the Tauri window's icon in a real taskbar, because a
  process launched from this shell cannot create a window on the desktop (`os error 5`). The
  change is reasoned from how the shell selects an icon, not observed.

## [0.14.0] — 2026-10-12

### Added

- **The window wears the project's own icon instead of the browser's globe.** Two paths,
  because the two backends take their icon from different places:
  - **Browser window** — a browser app window takes its icon from the *page*, so `index.html`
    now declares `<link rel="icon" href="/icon.png">` and the daemon serves it from
    `window/icon.png`. That is what replaces the globe.
  - **Tauri widget** — the bundle icon set (`src-tauri/icons/`) was regenerated from the
    512×512 `icon.png` at the project root with `npx tauri icon`, and the widget rebuilt, so
    the executable's own icon is the new one.

  The root `icon.png` is the source for regeneration; `window/icon.png` is the copy that
  ships, since the page needs it at runtime.

### Verified

- `/icon.png` answers `HTTP 200`, `28239` bytes, `image/png`, and the served page carries the
  `rel="icon"` link.
- 94 tests still pass.

## [0.13.1] — 2026-10-12

### Fixed

- **The window no longer resets its position on every prompt.** Reported as "the positioning of
  ACM on the screen resets per prompt", and it was true: the per-prompt check re-applied the
  configured geometry, so a window the user had moved was yanked back to its configured corner
  every time they sent one. The check now has two modes — `place`, used once right after a
  browser is spawned, applies the geometry; `repair`, which runs on every prompt, restores and
  places a window that is hidden or minimised but **leaves an already-visible window exactly
  where it is** and only re-asserts the pin. Verified: parked at `700,300` with the pin off, a
  repair reported `mode=repair placed=no rect=700,300 420x260 topmost=yes` — position
  untouched, pin back.
- **The half second of full-screen window at startup is much shorter.** PowerShell's own
  startup (~300 ms) was being paid *after* the browser was spawned, so it landed inside the
  visible phase, and the poll loop then only looked every 150 ms. The placement script is now
  started **before** the browser — it is already polling when the window appears — and polls
  every 40 ms. What remains is the browser's own time to paint its window, which no amount of
  polling can remove; `backend: "tauri"` is the way to eliminate it entirely.
- **A repair could report `topmost=no` on an already-visible window.** Moving the pin without a
  show call did not take. Repairs now call `SW_SHOWNOACTIVATE` — deliberately not `SW_RESTORE`,
  which activates the window and would steal focus on every prompt.

### Verified

- Both halves on a live window, in one run: the position survived a repair and the pin came
  back; and a cold launch produced `mode=place placed=yes rect=40,80 225x300`.
- 94 tests still pass; the launcher's PowerShell has no unit tests, so its behaviour is checked
  against a real window — which is how each of its now-five defects was found.

## [0.13.0] — 2026-10-12

### Fixed

- **A turn's length now comes from the host's own lifecycle events, not from usage samples.**
  Reported as "my codex says clearly worked for 51 seconds, but ACM was still going after the
  turn ended, showing 40s and counting upwards… then x-axis suddenly froze at 0~18s". Both
  numbers reproduce from the real rollout:

  ```
  lifecycle (Codex's own):  21:42:53 -> 21:43:45  = 51.7s
  usage samples alone:      21:43:25 -> 21:43:42  = 17.6s
  ```

  The first *billed* call lands 32 seconds after the turn begins, so a duration measured
  between the first and last sample is not the turn — it is the billed part of it. Codex
  writes `event_msg/task_started` and `event_msg/task_complete` carrying `started_at`,
  `completed_at` and even its own `duration_ms`; the adapter now reads those, groups units by
  task, and reports the boundaries for the engine to use.
- **Turn counting was wrong for the same reason.** `turn_context` is written irregularly — a
  4-turn session counted as 2. Turns are now delimited by `task_started`, with `turn_context`
  kept as the fallback for a rollout that has no lifecycle events, and still used to name the
  model.
- **The clock no longer runs on after the turn has ended.** For Codex, liveness comes from the
  lifecycle (a `task_complete` ends the turn) rather than from the 30-second idle guess, so the
  frozen duration is the host's own figure and stops when the host says it stopped.
- **Claude Code turns now start at the prompt**, not at the first billed call: `collectUnits`
  reports the prompting entry's timestamp, so the elapsed time and the chart's origin cover the
  whole turn instead of beginning partway through it.

### Verified

- On the real rollout that exposed it: the parser now reports `turns=4` where it previously
  said 2, and `sawLifecycle=true` with the turn's true start.
- 93 tests, including six for the lifecycle path (task-delimited turns, the host's duration
  winning over the sample span, a new turn forgetting the previous duration, numeric as well
  as ISO timestamps, and the `turn_context` fallback) and two for the engine preferring host
  bounds over its own guess.

## [0.12.0] — 2026-10-12

### Changed

- **The chart now draws the way the DSH panel draws it** — the same axis, the same origin, the
  same freeze. Three differences were reported and all three are the same disagreement about
  what the picture means:

  1. **The x axis is the turn's time, not wall-clock time.** The panel records `atMs` relative
     to the turn's own start; this chart was plotting absolute timestamps and labelling them
     `HH:MM`, so a finished turn's chart slid out from under its own line. It now starts at
     `0:00`, runs to the turn's elapsed time, and **stops when the turn stops**.
  2. **The line is anchored at (0,0).** It previously began at the first settled sample, and
     that sample cannot exist until an API response reports usage — which is why nothing
     appeared for the first several seconds. `(0,0)` is prepended, exactly as the panel's
     client does.
  3. **The series is the current turn's, not the session's.** Both turns share one timeline, so
     mixing them put turn 2's samples on top of turn 1's.

  The right-hand label is now the turn's elapsed time, arrowed while the turn is still running
  (`→ 1:05`) and unarrowed once it has stopped — the panel's own convention, and the cue that
  distinguishes running from frozen. The trailing sample at the current elapsed time is appended
  **by the page**, as the panel's client does, so a live line reaches the axis edge and a frozen
  one stays frozen.

### Verified

- The payload is turn-relative on real data: the newest Claude Code turn's first sample is at
  `atMs = 0` and the series carries only that turn's points.
- Page tests cover the origin (`the first point sits on the y axis and on the baseline`),
  the arrow while live, its absence when ended, mm:ss instead of a time of day, and an empty
  series still drawing from `(0,0)`.

## [0.11.1] — 2026-10-12

### Fixed

- **A hidden window became a ghost that blocked the feature entirely.** Reported as "now ACM
  gives a blank widget with nothing, and also not floating on top", for the desktop apps and
  the CLI alike. The cause was two mistakes compounding:

  1. The placement script searched `Get-Process | Where MainWindowTitle`, which reports only
     a **visible** window. A window that had got itself hidden was therefore invisible to the
     search, so it was never placed, sized or pinned again.
  2. `--if-needed` asked the daemon whether anything had polled recently. A hidden Edge
     window **keeps its page running**, so it kept polling — the check answered "already
     open" and refused to open a new window.

  Together: a permanently invisible window, and a launcher that would not replace it. Every
  prompt confirmed the ghost.

  The search is now `EnumWindows`, which sees hidden windows too, and the probe **repairs**
  what it finds — `SWP_SHOWWINDOW` shows a hidden window, the geometry is re-applied, and
  `WS_EX_TOPMOST` is re-asserted and then verified from the window's own extended style.

  Verified on the actual broken window, live:

  ```
  before:  visible=False topmost=False 40,80 225x300
  HANDLED visible=yes wasHidden=yes topmost=yes 225x300 at 40,80
  after:   visible=True  topmost=True  40,80 225x300
  ```

  and a second probe reported `wasHidden=no` with the window still visible and pinned — the
  repair holds rather than oscillating.

### Notes

- The daemon's `/health` and its `windowPolledAt` remain, but nothing decides anything from
  them any more: a poll proves a *page* is running, not that a window can be seen.

## [0.11.0] — 2026-10-11

### Changed

- **The hook now fires on every prompt, not only at session start.** `SessionStart` alone
  works for a CLI launched per session and *fails in the desktop apps*, because those are
  long-lived: it fires once when the app opens and never again when a prompt is sent — which
  is exactly what was reported ("I don't see ACM autostarting when I sent a prompt"). Both
  hosts also expose `UserPromptSubmit` (verified present in the Codex binary, 41 hits), so
  both now get `SessionStart` **and** `UserPromptSubmit`.
- **`acm launch --if-needed`.** A per-prompt hook would otherwise stack a window on every
  prompt. The launcher asks the daemon whether a window has polled in the last five seconds
  and does nothing if one has: the page polls once a second, so a recent request *is* a live
  window. The daemon gained `GET /health` for this, and its own liveness probe moved there
  too — had it kept using `/data`, the probe itself would look like a window and
  `--if-needed` would always believe one was already open.
- **The check lives in the launcher, not in `acm`.** `acm` must return immediately because a
  hook is waiting on it, so it forwards `--if-needed` to the already-detached launcher,
  which decides. Measured: 191 ms.

### Verified

- **Idempotence, live**: `/health` reports `windowPolledAt=0` with no window open, a recent
  timestamp once one is polling, and `acm launch --if-needed` then printed "a window is
  already open" while the Edge process count stayed at 9 — no second window.
- **The upgrade path**: an entry written by 0.9.0 is replaced rather than treated as
  present, so re-running `acm hook on` is how a machine gets the new behaviour. Applied to
  both hosts here, with `codex doctor` still reporting `config loaded` and a4phone's hooks
  intact.
- 81 tests, including that the command carries `--if-needed` and that the Codex block
  contains both events.

## [0.10.0] — 2026-10-11

### Fixed

- **The chart's x-axis ended at the last settled point instead of at now.** During a long
  command no new usage is recorded, so the axis stopped minutes in the past — the reported
  screenshot showed `00:19` as the right-hand label while the clock said `00:26`. A quiet
  stretch now appears as a quiet stretch, with the current rate at the right edge. Verified
  on that same session: last settled `00:28:55`, chart's end `00:29:32`, which is now.
- **A turn with a tool call in flight was declared ended after 30 seconds.** That froze the
  clock and zeroed `β(t)` in the middle of a running turn — reported as "freezes and reports
  a wrong number when the agent is stuck on a time-demanding powershell command". Found by
  probing the transcript: a PowerShell call ran `00:26:10 → 00:27:11`, so for 61 seconds the
  newest usage-bearing entry was the message that *requested* the tool. `collectUnits` now
  reports `awaitingToolResult`, and a turn waiting on a tool is running however long it takes.
- **Overlapping polls could render a stale figure.** With `setInterval(tick, 3000)`, a request
  slower than three seconds — exactly what a large transcript produces — let the next tick
  start before the first answered, so responses could land out of order and the display
  jumped backwards.

### Changed

- **The window updates once a second** (`pollMs`, default `1000`, `ACM_POLL_MS`), down from
  every three. The page schedules its next request off the previous one *finishing* via
  `setTimeout`, which cannot overlap by construction, and the interval comes from the daemon
  so it is configured in one place.
- **The figures arithmetic moved to `src/figures.mjs`.** It lived in `window/serve.mjs`, which
  listens on import and therefore could not be tested — so the maths behind every headline
  number had no test at all. It now has eight.
- **The transcript search is remembered briefly** (2 s). At one request a second, rescanning
  every candidate file to find the one with usage was wasted work; the figures themselves are
  still recomputed on every request, so nothing shown is stale.

### Notes

- **The in-flight-tool detection is Claude Code only.** A Codex rollout's shapes for a pending
  command have not been verified, so Codex still uses the 30-second idle rule. The axis fix
  applies to both.
- 79 tests, including eight for the figures module and six for the waiting flag.

## [0.9.1] — 2026-10-11

### Fixed

- **`acm launch --dry-run started a real window.** It printed the plan and spawned the
  browser anyway, which matters more now that a hook runs this command: a flag that
  claims to change nothing must change nothing.

## [0.9.0] — 2026-10-11

### Added

- **`acm hook on|off|status [--host claude|codex|all]` — a `SessionStart` hook that
  opens the window with the session.** Both harnesses turned out to expose the same
  extension point under the same event name, and both were already using it on this
  machine: a4phone writes `[[hooks.Stop]]` into `~/.codex/config.toml`, and Claude Code's
  `~/.claude/settings.json` already carries three hooks. So this is configuration rather
  than a new mechanism, and it is the *right* mechanism — unlike the withdrawn shell
  shim, it fires on the event rather than on a command name and needs no shell-profile
  edits. Claude Code gets `hooks.SessionStart` with `matcher: "startup"` (a resume or a
  compact is not a new session); Codex gets a fenced `[[hooks.SessionStart]]` block.

### Verified

- **`codex doctor` accepts the edited config** (`config loaded`) — the TOML is valid,
  which is the one thing that had to be true and cannot be assumed from text editing.
- **Install then remove restores `~/.codex/config.toml` and `~/.claude/settings.json`
  byte for byte**, checked by SHA-256 against copies of the real files.
- **a4phone's three hooks survive** an install and a removal, and Claude Code's `hooks`
  object is not deleted while another tool still uses it.
- Idempotent (a second `acm hook on` reports "already installed" and writes nothing),
  and changing `--host` corrects the block instead of stacking a second one.
- 18 planner tests, including the trap that matters most: **TOML forbids redefining a
  table**, so appending a second `[features]` to a config that already has one would make
  the whole file unparseable and break the user's Codex. An existing `[features]` gets
  the key inserted into its body; only a missing one is appended. A first attempt also
  stripped trailing whitespace on install and collapsed blank-line runs on removal, which
  restored the real config only *approximately* — the round trip is now exact, with the
  CRLF and blank-line-run cases in the tests because the tidy synthetic file hid it.

### Notes

- **Codex will not run a hook it has not been told to trust.** Its config records a
  `trusted_hash` per hook under `[hooks.state]`, so the first session after installing
  may ask you to approve it once. That hash cannot be forged, and this does not try.
- **Removal leaves `features.hooks = true` in place**, on purpose: another tool may rely
  on the flag, and a flag that is on when it need not be is harmless where a missing one
  makes the hook silently dead.
- **The Claude Code side is untested end to end**, because no Claude Code desktop app is
  installed here — only `~/.claude` from the CLI. The Codex side was exercised against
  the real config file.

## [0.8.2] — 2026-10-11

### Fixed

- **`warn is not defined` — the window showed an error instead of any figures.**
  Shipped in 0.8.1 by me. The dot fix read `warn`, which is declared inside `chart()`,
  from `render()` — a scope error, not arithmetic. Only the no-data path worked, which
  is why it looked like a Codex-specific failure. The threshold is now read in
  `render()`'s own scope.
- **Nothing ever ran the page's script.** The window is one HTML file with inline
  JavaScript, so the build and the entire test suite could not see a runtime error in
  it. The 0.8.1 release was "verified" by reading the served HTML and comparing the
  expression's text — which was correct, and did not matter, because reading source is
  not running it. `test/window-page.test.js` now extracts that script and executes it
  against a stub DOM: ten assertions covering the dot threshold in both directions, the
  threshold coming from the payload rather than a constant, the named host, the spend
  line's five fields, the no-data path with its reasons, the approximation label, and
  the chart with an empty series. Against the broken page, six of them fail with
  `ReferenceError: warn is not defined` — checked before applying the fix, so the test
  is known to have teeth rather than assumed to.

## [0.8.1] — 2026-10-11

### Fixed

- **The status dot went amber on any spend at all, and stayed there.** It tested
  `liveBurn > 0` rather than the warning rate, so it lit up at a fraction of the
  threshold and only returned to green once the rate fell to exactly zero — which reads
  as a latch, not as a level. Reported as "once the dot goes amber it doesn't come back
  green though burn is lower than the warning value", and the live data showed it
  precisely: **3.45/h against a 15/h threshold, displayed as amber**. It now compares
  against the same `warnPerHour` the dashed line on the chart is drawn at, so the dot
  and the line cannot disagree about what "too fast" means. Verified by evaluating both
  rules against the same live payload: old `AMBER`, new `green`.

## [0.8.0] — 2026-10-11

### Changed

- **The default window is 225x300**, down from 380x600. At that width a fixed 12.5px
  line wraps, so the text now scales with the window (`clamp()` against `vw` — the
  window *is* the viewport) and stops growing again on a large one. The chart needs
  none of this: it is SVG with a viewBox, so its labels scale proportionally.
- **The live burn window is configurable, `burnWindowMs`, default `15000` (15 s)** — and
  it is read by the **Claude Code status line as well as the window**, from the same
  file, so `β(t)` cannot differ between the two renderers for the same session. It keeps
  the DSH plugin's name for the same setting rather than inventing a second one. Below
  1000 ms it clamps: a sub-second window does not measure a smaller rate, it reports
  whichever single call happened to land inside it.

### Fixed

- **The window stopped being pinned, and my own speed fix caused it.** Making placement
  fast made it apply `WS_EX_TOPMOST` to the handle that exists at ~100 ms — which can
  belong to a window the browser re-shows once the page paints, and re-showing drops the
  flag. The geometry is still applied immediately, and the topmost flag is now
  re-asserted over the next four seconds, re-finding the handle each time in case it
  changed. The script also *reads the window's extended style afterwards* and reports
  `topmost=yes (ws_ex_topmost=yes)` or `topmost=NO`, instead of reporting success
  because `SetWindowPos` returned true — verified on a real window.
- **A slow browser start left the window unplaced and unpinned.** The placement poll gave
  up after 20 seconds; a cold Edge start just after its previous window closed exceeded
  that, and the failure was silent in the log. It now waits 90 seconds and says
  `window not found within 90s` when it does.

## [0.7.0] — 2026-10-11

### Added

- **The window's geometry is configurable.** Width, height, position, always-on-top,
  warn line and port in `~/.agent-cost-monitor.json`, each with an environment
  override. Verified: a `520x340` config produced `window placed 520x340 at 900,12`.
  A zero, negative or non-numeric value falls back to the default rather than producing
  a window that cannot be seen, and a corrupt config file is ignored rather than obeyed.
- **`acm log [--lines N]`, and a log file at `~/.cache/agent-cost-monitor/window.log`.**
  The question "the window did not appear" used to be unanswerable after the fact: the
  launcher's output went to a discarded handle and nothing was written anywhere. Every
  launch, its geometry, every source resolution and every failure reason is now
  recorded, truncated past 256 KB. `acm doctor` prints the path.
- **A full configuration guide** in the README: every command, every config key, every
  environment variable, and a table of every path acm writes versus the ones it only
  reads.

### Fixed

- **A console window flashed on every launch.** The placement script was spawned
  without `windowsHide`, so a command prompt appeared each time. Spawned hidden now, and
  the spawned processes carry `windowsHide` as well.
- **The window appeared at the wrong size before snapping into place.** The placement
  call ran on a fixed 2.5-second timer, so a window that ignored `--window-size` sat
  filling the display for that whole time before jumping to the corner. It now polls
  every 100 ms and applies the geometry as soon as there is a handle — measured at
  **683 ms** from launch to placement, down from 2.5 s plus.
- **The Tauri widget ignored the configuration.** It hard-coded its own size and
  always-on-top; it now takes both from the launcher, so `backend: "tauri"` and
  `backend: "browser"` honour the same numbers.

### Notes

- The blank frame on a **cold** browser start is inherent to using a browser: Edge has
  to start before it can paint. `backend: "tauri"` avoids it entirely, which is the main
  reason to prefer the widget once it is built.

## [0.6.0] — 2026-10-11

### Added

- **A Codex adapter.** `src/codex.mjs` reads `~/.codex/sessions/**/rollout-*.jsonl` for
  the per-call cache split and `~/.codex/state_5.sqlite` for a whole-thread total when
  the rollout has none. Verified against a real 0.162.1 rollout: 18 usage records,
  priced to ¥1.4139 for the turn and ¥3.3825 for the session on `test-model`.
- **`acm launch --host codex`**, and the host rides in the window's URL. The window now
  reads that host's source first and **names it on screen**.
- **Honest reporting when there is nothing to show.** The window lists which sources
  were tried and why each failed, and labels a figure `≈` with its reason when only an
  approximation was possible.

### Changed

- **The balance row is gone from the window.** It is DeepSeek's and only DSH can read
  it, so in a window that also serves Codex and Claude Code it was a figure about a
  different provider than the one being measured — and one that would never move for
  two of the three hosts. Cost and burn rate are the whole job.
- **Auto-launch is withdrawn.** Wrapping `codex` and `dsh-tui` in a PowerShell function
  meant editing two profile files to save one command, and the window it opened was
  showing another host's numbers half the time. Nothing writes a shim any more;
  `acm clean-profiles` and `acm uninstall` still remove one written by an earlier
  version, because a withdrawn feature has to stay reversible on machines that ran it.

### Fixed

- **The burn chart's series was a running total, not a windowed rate.** Every call was
  added to one accumulator and nothing was ever removed as it aged out, so the line
  climbed forever — the opposite of what a burn rate is for. On the dsh source it read
  **6,146/h instead of 11.88/h**. Caught by reading an implausible axis label off a
  screenshot, not by a test; the windowed rate is now a trailing two-pointer window,
  with a test-shaped assertion comparing the cumulative figure against the real one.
- **One synchronous source broke every source.** The Claude Code reader returns a plain
  object, so chaining `.catch()` onto its result threw — and that error propagated out
  of the fallback loop, so asking for `--host claude` reported "no data" while dsh was
  answering fine one line later. Sources are now `await`ed, which handles both shapes.
- **The auto-launch message named hosts it no longer wrapped**, and `dsh-tui`
  reported "nothing to remove" as a failure once uninstall ran for every host.

## [0.5.0] — 2026-10-11

### Changed

- **Claude Code is no longer wrapped by auto-launch.** Its status line already shows
  these figures *inside* the tool, so a window riding along with `claude` was noise on
  top of a row that works. `codex` and `dsh-tui` keep the shim — they have no such
  row, which is the whole reason the window exists. The filter lives in
  `shimHosts()` rather than only in the defaults, so a config written before this
  decision cannot bring it back, and `/acm` remains for anyone who wants the window
  anyway.
- **`acm uninstall` is now total.** It previously removed one host; now it removes
  every host, both profile blocks, the `/acm` command, the config and the pricing
  cache — because a trail of edits across a settings file, two shell profiles and a
  command directory is what stops people installing something at all. `--host` still
  narrows it, `--keep-cache` leaves the cache, and `--self` also runs
  `npm uninstall -g agent-cost-monitor`, which is the one thing acm cannot quietly do
  from under its own feet.

### Fixed

- **"Not installed" stopped being reported as a failure.** With uninstall running for
  every host, `dsh-tui` will usually have nothing to remove; asking pnpm to remove a
  package that was never added reported a problem that was not one.
- **The auto-launch message named the wrong hosts.** It still said "typing `claude` or
  `codex`", which stopped being true the moment Claude Code was unwrapped. It is
  generated from the hosts actually shimmed.

### Verified

- **The whole thing reverses.** Ran `acm uninstall` for real and confirmed afterwards
  that the `statusLine`, both profile blocks, `~/.claude/commands/acm.md`,
  `~/.agent-cost-monitor.json` and `~/.cache/spend-watch` were all gone and that the
  unrelated settings (a4phone's three hooks, the whole `env` block) survived; then
  restored with `acm install` and confirmed a fresh shell resolves the way it should.
- **Command resolution, in a fresh shell with the profile loaded**: `claude` →
  `[ExternalScript]`, `codex` → `[Function]`, `dsh-tui` → `[Function]`, `acm` →
  `[ExternalScript]` from `%APPDATA%\npm`. That pairing is the proof: the shim wins
  where it should, and *does not* where it was removed.
- **`acm` is on PATH the way any global npm package is** — `npm link` produced
  `acm.ps1`, `acm.cmd` and `agent-cost-monitor.*` in `%APPDATA%\npm`, which is what
  `npm install -g` does for a new user with no configuration.

## [0.4.0] — 2026-10-11

### Added

- **Auto-launch: typing `claude` or `codex` brings the window up with it.** Neither
  harness lets a third party react to "the user started the CLI" — Codex's slash
  commands are a fixed registry (verified in its binary: no custom-prompt loader, and
  `custom prompt` appears zero times) and Claude Code's `statusLine` is a rendering
  hook, not a lifecycle one. So the shim uses the one mechanism needing no
  cooperation: a PowerShell **function** in the user's profile. PowerShell resolves a
  function ahead of an ExternalScript or Application, and `claude` and `codex` are npm
  shims, so a function of the same name wins — it starts the window, then hands over
  to the real command with its arguments untouched. Both profile files are written,
  because PowerShell 5.1 and 7 keep separate ones, and the block is fenced so
  `acm autostart off` removes exactly it.
- **`acm autostart on|off|status`**, and `acm launch [--quiet]` — what the shim calls.
  The launch is detached and `unref`'d so the harness starts at the same speed whether
  the window appears or not, and every failure path inside the shim falls through to
  running the real command: **a broken spend window must never stop someone's agent
  from starting.**
- **`/acm` inside Claude Code**, written to `~/.claude/commands/acm.md`. Its body is a
  plain instruction rather than a `!` shell expansion, because how a slash command
  executes shell text has varied across versions and an instruction works either way.
  It is written whether auto-launch is on or off — with it off, this is the whole
  mechanism.
- **Configuration at `~/.agent-cost-monitor.json`** (`autoLaunch`, `hosts`, `backend`),
  so the behaviour is something to edit rather than a flag to remember. `acm install`
  turns auto-launch on for a fresh install and **respects a deliberate `false`** on a
  re-install; `--no-autostart` leaves your profiles alone entirely.

### Notes

- **Codex has no custom slash commands, so `/acm` cannot exist there.** What it does
  have is the `!cmd` shell escape — verified in its binary, *"Run from Codex using `!`
  (e.g. `!ls`)"* — so inside Codex the command is `!acm launch`. The installer says
  this rather than writing a prompt file that would sit there doing nothing.
- **Written into a shell profile, so the generated text is tested and parse-checked.**
  The block is validated with PowerShell's own parser (0 errors) and the shim is
  confirmed to resolve: `Get-Command claude` returns a Function while
  `-CommandType ExternalScript,Application` still finds `claude.ps1`, which is what
  proves there is no recursion into itself.

## [0.3.0] — 2026-10-11

### Added

- **A window: the same figures, outside the TUI.** `window/serve.mjs` is a local
  daemon that serves one page and one JSON endpoint; `window/index.html` draws the
  balance, the one-line figures and the **burn chart** — the windowed rate over
  time, with the warn line across it — in the same visual language as the DSH panel.
  Two data sources, in order: the DSH plugin's own HTTP route when it answers (the
  dsh-tui path, which already carries the balance and the series), otherwise the
  newest Claude Code transcript priced by the same engine.
- **Two ways to put it on screen.** `node window/launch.mjs` uses an Edge or Chrome
  application window pinned always-on-top by `SetWindowPos` — no toolchain, works
  today. `node window/launch.mjs --tauri` builds and runs the real widget under
  `src-tauri/`, which needs no browser chrome and declares `always_on_top` in Rust.
  Both read the same daemon, so the data path is identical.
- **The Tauri project**, with icons generated from the panel screenshot, a
  frameless-capable config, and `Cargo.toml` sized for a small release binary.

### Fixed

- **Three bugs the screenshot caught that no test would have.** `FindWindow(null,
  title)` does not reliably match a browser's app window, and Edge ignores
  `--window-position` when restoring window state — so the window opened
  off-position and was never pinned; it now goes through the process's
  `MainWindowHandle` with a retry, and `SetWindowPos` carries the geometry. The
  headline burn rate was computed at the *last settled point* rather than *now*,
  so an idle session looked like it was still spending. And `$("balance").innerHTML`
  replaces the element's children, which destroyed the `<small id="balnote">` the
  very next line set `textContent` on — an exception mid-render that left the
  initial "waiting for data…" on screen while the balance above it updated. The
  render is now wrapped so a widget shows what broke instead of freezing.

### Notes

- **Codex CLI 0.162.1 keeps token usage in `state_5.sqlite`, not the rollout** (see
  the README's next-hosts note). `threads` carries `model`, `model_provider` and
  `tokens_used`. Verified against real rows: 3,272,214 and 316,945 tokens on
  `test-model`, 215,984 on `test-model`, and 0 on the newest thread — whose
  `error_json` reads *"You've hit your usage limit"*, so the run was refused rather
  than unrecorded.

## [0.2.0] — 2026-10-10

### Added

- **A one-command installer, `acm`.** `npx agent-cost-monitor install` detects which
  agents are present, writes the `statusLine` block for Claude Code, and prints what
  it did and what it skipped. `status`, `uninstall` and `doctor` round it out, with
  `--dry-run` to print the plan and `--force` to replace a status line belonging to
  something else.
- **The install is idempotent and self-repairing.** Running it twice changes nothing
  the second time; running it again after the repository moves updates the path
  rather than reporting a conflict, which is the whole reason the path is stored in
  the settings file. Every write is preceded by a timestamped backup of the file it
  is about to change.
- **dsh-tui support as far as it is real.** `--host dsh` fetches the
  dsh-budget-watcher plugin — a sibling checkout, or a shallow clone into
  `~/.cache/agent-cost-monitor/` — and links it into the `dsh-tui` profile, which is
  its own pnpm profile and does not contain the desktop plugin. This registers the
  data and the HTTP route. It does **not** put anything in the terminal: dsh-tui has
  no row to draw in, and the README says so plainly rather than implying otherwise.

### Fixed

- **Spawning through the shell without Node's DEP0190 warning.** On Windows `dsh` and
  `claude` are shell shims, so a shell is required — but passing an argument array
  *with* `shell: true` makes Node warn that the arguments are concatenated rather
  than escaped. Commands are now built as single quoted strings.

### Notes on what was learned building this

- **Another tool rewrote `~/.claude/settings.json` and silently dropped the installed
  `statusLine`.** Found live: the keys came back alphabetically sorted, the model
  environment had been switched, a4phone's hooks had been added, and our block was
  gone. The detector reported it correctly — which is precisely why `acm status`
  exists, and why re-running the installer must repair rather than conflict.
  Re-running `acm install` restored the block while leaving every other key, all
  three a4phone hooks and all sixteen environment entries intact. If your status line
  ever vanishes: `acm status`, then `acm install`.

## [0.1.0] — 2026-10-10

### Added

- **A Claude Code status line: one line of live spend, rendered where the agent
  already looks.** `claude/statusline.mjs` reads the status-line payload Claude
  Code passes on stdin, prices the transcript it points at, and prints
  `¥0.53 / ¥19.72 · β(t) ¥0.00/h · β ¥5.94/h · 5:21` — this turn / session, the
  live burn over a 15-second window, the turn's average burn, and the turn's
  clock. Verified against a real transcript on the author's machine
  (`¥0.02 / ¥0.48` on `glm-5.3-flash`, priced from the fetched list at the ECB
  rate of 6.6921).
- **The cost engine, extracted from [dsh-budget-watcher](https://github.com/NeutronStar714/dsh-budget-watcher)
  `0.7.2`.** `lib/cost.js` (rate card, peak hours, usage pricing),
  `lib/pricing.js` (the fetched third-party list and its canonical model-name
  matching), and `lib/fx.js` (the ECB's daily USD→CNY cross rate). Copied rather
  than shared so this project stands alone; the two will drift on purpose. See
  the README's limitations.
- **The cache discipline the plugin uses, scaled down to one file.** The rate
  card and the exchange rate live in `~/.cache/spend-watch/claude-pricing.json`
  for a day; a stale cache is refreshed by a detached child, and the hot path
  never waits on the network. The first ever run does one short inline fetch.

[0.1.0]: https://github.com/NeutronStar714/agent-cost-monitor/releases/tag/v0.1.0
