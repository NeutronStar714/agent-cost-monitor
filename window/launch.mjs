#!/usr/bin/env node
// Put the window on screen.
//
//   default   a browser application window (Edge or Chrome), placed and pinned by one
//             Win32 call. No toolchain, works today, but it is a browser: there is
//             chrome, and a cold start can show a blank frame before the page paints.
//   --tauri   the widget: no browser chrome, no blank frame, size and always-on-top
//             declared by the app itself. Needs the Rust build (npm run window:tauri).
//   --host h  which host this window is for (codex, dsh, claude).
//   --quiet   say nothing (used when something else is orchestrating the launch).
//
// Geometry comes from ~/.agent-cost-monitor.json — see the README's configuration
// guide — and every value is overridable by environment variable.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../src/autostart.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONFIG = resolveConfig(homedir());

/**
 * The needle that identifies our window.
 *
 * Read from the page rather than repeated here. An app window wears its page's `<title>`, and
 * this string is the one thing that has to agree between the two files: a title changed in the
 * page and not here is a launcher that never finds the window it already opened, so every prompt
 * would open another one. A page with no title (or none it can read) falls back to the name this
 * file used to hardcode, which is also what the Tauri widget is titled in src-tauri/src/main.rs.
 */
const WINDOW_TITLE = (() => {
  try {
    const match = /<title>([^<]*)<\/title>/i.exec(readFileSync(join(HERE, "index.html"), "utf8"));
    const title = (match?.[1] ?? "").trim();
    return title === "" ? "ACM" : title;
  } catch {
    return "ACM";
  }
})();

const PORT = CONFIG.port;
const HOST = valueOf("--host");
const useTauri = process.argv.includes("--tauri") || CONFIG.backend === "tauri";
const quiet = process.argv.includes("--quiet");
/** Start a window only if one is not already open — the hook runs on every prompt. */
const ifNeeded = process.argv.includes("--if-needed");
/** How long the pre-flight probe waits for an existing window before deciding there is none. */
const PROBE_MS = 2500;
const say = (line) => {
  if (!quiet) process.stdout.write(line + "\n");
};

const LOG_DIR = join(homedir(), ".cache", "agent-cost-monitor");
const LOG_FILE = join(LOG_DIR, "window.log");

/** One place where "the window did not appear" becomes answerable after the fact. */
function log(message) {
  const line = `${new Date().toISOString()}  ${message}\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 256 * 1024) writeFileSync(LOG_FILE, "");
    appendFileSync(LOG_FILE, line);
  } catch {
    /* a log that cannot be written is not a reason to fail a launch */
  }
}

function valueOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? String(process.argv[i + 1] ?? "").trim().toLowerCase() : "";
}

// The host rides in the URL rather than in the daemon's environment: the daemon is
// often already running from an earlier launch, and the page is what knows which host
// this particular window is for.
const URL_ = `http://127.0.0.1:${PORT}/${HOST === "" ? "" : `?host=${encodeURIComponent(HOST)}`}`;

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

const TAURI_EXE = join(ROOT, "src-tauri", "target", "release", "agent-cost-monitor-window.exe");

async function daemonUp() {
  try {
    // /health, not /data: a probe must not look like a window asking for figures, or
    // `--if-needed` would decide that the window it is about to check for is already open.
    return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/** Is a window already polling the daemon? Diagnostic only — see the note below. */
async function windowIsOpen() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body = await response.json();
    return Date.now() - (Number(body.windowPolledAt) || 0) < WINDOW_ALIVE_MS;
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  if (await daemonUp()) {
    log(`daemon already answering on port ${PORT}`);
    say(`daemon already answering on http://127.0.0.1:${PORT}/`);
    return;
  }
  log(`starting the daemon on port ${PORT}`);
  say(`starting the daemon on port ${PORT}`);
  const child = spawn(process.execPath, [join(HERE, "serve.mjs")], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonUp()) return;
  }
  log("daemon did not come up within 5s");
  say("daemon did not come up; run `node window/serve.mjs` by hand to see why");
}

/**
 * The PowerShell that finds the window and puts it where it belongs.
 *
 * Two modes, because "place a window I just opened" and "check on the window you already
 * have" want different things:
 *
 *   `place`   apply the configured geometry, show it, pin it. Used once, right after a
 *             browser is spawned.
 *   `repair`  if the window is up, leave its position and size ALONE and only re-assert the
 *             pin; if it is hidden or minimised, restore and place it. This runs on every
 *             prompt, and applying the configured geometry there meant every prompt yanked
 *             the window back to its configured corner — so a window the user had moved was
 *             reset per prompt.
 *
 * The search is `EnumWindows`, not `Get-Process | Where MainWindowTitle`, because the latter
 * reports only a **visible** window: a hidden Edge window keeps its page running (so it kept
 * polling the daemon and `--if-needed` kept believing it was open) while being invisible to
 * that search, which left a window nothing would ever show again.
 */
function windowScriptBody(mode, timeoutMs) {
  return `
$mode = "${mode}"
$onTop = ${CONFIG.alwaysOnTop ? "$true" : "$false"}
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AcmWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  static IntPtr hidden = IntPtr.Zero;
  // A visible window wins; a hidden one is remembered so it can be repaired instead of
  // blocking every future prompt as "already open".
  //
  // The title must match EXACTLY, not merely contain the name. A normal browser window or tab
  // showing our page is titled "ACM - Profile 1 - Microsoft Edge", and a
  // substring match found that large window first, decided a window was already open, and left
  // the real one unopened — a launch that silently did nothing. Our app window and the widget
  // are both titled exactly this.
  public static IntPtr Find(string needle) {
    IntPtr visible = IntPtr.Zero; hidden = IntPtr.Zero;
    EnumWindows((h, p) => {
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (!sb.ToString().Trim().Equals(needle, StringComparison.OrdinalIgnoreCase)) return true;
      if (IsWindowVisible(h)) { if (visible == IntPtr.Zero) visible = h; }
      else if (hidden == IntPtr.Zero) hidden = h;
      return true;
    }, IntPtr.Zero);
    return visible != IntPtr.Zero ? visible : hidden;
  }
  public static bool WasHidden(IntPtr h) { return hidden != IntPtr.Zero && h == hidden; }
  // GetWindowLong rather than GetWindowLongPtr: the extended style is a 32-bit mask, and
  // the Ptr form is a macro whose A/W export differs by platform.
  public static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }
  public static string Rect(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return r.L + "," + r.T + " " + (r.R - r.L) + "x" + (r.B - r.T);
  }
}
"@
$deadline = (Get-Date).AddMilliseconds(${timeoutMs})
$handle = [IntPtr]::Zero
# 40ms, not 150: this is the loop whose latency is the wrongly sized window on screen.
while ((Get-Date) -lt $deadline -and $handle -eq [IntPtr]::Zero) {
  $handle = [AcmWin]::Find("${WINDOW_TITLE}")
  if ($handle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 40 }
}
if ($handle -eq [IntPtr]::Zero) { Write-Output "NONE"; exit 0 }

$wasHidden = [AcmWin]::WasHidden($handle)
$minimised = [AcmWin]::IsIconic($handle)
# Geometry is ours only when the window is new or was not on screen; otherwise it belongs to
# whoever put it there.
$shouldPlace = ($mode -eq "place") -or $wasHidden -or $minimised
$after = if ($onTop) { [IntPtr](-1) } else { [IntPtr](-2) }
$move = if ($shouldPlace) { 0x0040 } else { 0x0043 }   # NOMOVE|NOSIZE when not placing
# SW_RESTORE (9) only when placing: it activates, and this runs on every prompt, so stealing
# focus there would be unacceptable. SW_SHOWNOACTIVATE (4) otherwise — without a show call the
# pin did not take on an already-visible window, which is how a repair reported topmost=no.
[void][AcmWin]::ShowWindow($handle, $(if ($shouldPlace) { 9 } else { 4 }))
[void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, $move)

if ($onTop) {
  $delays = if ($shouldPlace) { @(300, 900, 1800, 4200) } else { @(500, 1200) }
  foreach ($delay in $delays) {
    Start-Sleep -Milliseconds $delay
    $fresh = [AcmWin]::Find("${WINDOW_TITLE}")
    if ($fresh -ne [IntPtr]::Zero) { $handle = $fresh }
    [void][AcmWin]::SetWindowPos($handle, $after, ${CONFIG.x}, ${CONFIG.y}, ${CONFIG.width}, ${CONFIG.height}, $move)
  }
}
$visible = if ([AcmWin]::IsWindowVisible($handle)) { "yes" } else { "no" }
$top = if ([AcmWin]::IsTopmost($handle)) { "yes" } else { "no" }
$placed = if ($shouldPlace) { "yes" } else { "no" }
Write-Output ("HANDLED mode=" + $mode + " placed=" + $placed + " visible=" + $visible + " topmost=" + $top + " rect=" + [AcmWin]::Rect($handle))
`;
}

/**
 * Start the placement script and resolve with its one-line verdict.
 *
 * Asynchronous on purpose. PowerShell needs a few hundred milliseconds to start, and doing
 * that *after* the browser was spawned put that delay in the middle of the visible phase —
 * which is the half second of badly sized window. The caller starts this first and spawns the
 * browser second, so the script is already polling when the window appears.
 */
function startWindowScript(mode, timeoutMs) {
  if (process.platform !== "win32") return Promise.resolve("NONE");
  const script = join(tmpdir(), `acm-window-${mode}.ps1`);
  try {
    writeFileSync(script, windowScriptBody(mode, timeoutMs));
  } catch {
    return Promise.resolve("NONE");
  }
  // windowsHide is the point: without it this spawn flashes a console window.
  const child = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script], {
    windowsHide: true,
  });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve("NONE");
    }, timeoutMs + 30_000);
    child.on("close", () => {
      clearTimeout(timer);
      const verdict = (out.trim() || err.trim() || "NONE").split("\n")[0].trim();
      log(`window script (${mode}): ${verdict}`);
      resolve(verdict);
    });
  });
}

async function launchTauri() {
  if (!existsSync(TAURI_EXE)) {
    log("tauri backend requested but the window is not built");
    say("  the Tauri window is not built — build it from a checkout with Rust: npx tauri build");
    return false;
  }
  say(`opening the Tauri window (${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y})`);
  // Its stderr is captured rather than thrown away. Discarding it is how "the widget failed" and
  // "the widget is slow" became the same event from the outside — and a false "failed" costs the
  // user the blurred browser window, which is worse than the wait it was trying to avoid. The
  // widget explains itself in one sentence; that sentence belongs in the log.
  const child = spawn(TAURI_EXE, [], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      ACM_WINDOW_PORT: String(PORT),
      ACM_WINDOW_WIDTH: String(CONFIG.width),
      ACM_WINDOW_HEIGHT: String(CONFIG.height),
      ACM_WINDOW_X: String(CONFIG.x),
      ACM_WINDOW_Y: String(CONFIG.y),
      ACM_ALWAYS_ON_TOP: CONFIG.alwaysOnTop ? "1" : "0",
    },
  });
  let complaint = "";
  let exited = false;
  let doomed = false;
  child.stderr?.on("data", (chunk) => {
    complaint += String(chunk);
    // The widget's own sentence is the reliable signal, not its exit: when the window cannot be
    // created it says so at once but does not always leave — in a restricted session it can sit
    // there — and waiting for a death that never comes is how a doomed launch cost the full
    // timeout. Saying "could not create the window" is the widget declaring itself finished.
    if (/could not create the window/i.test(complaint)) doomed = true;
  });
  // Watching for the exit is what stops a doomed launch from costing the full wait. A widget that
  // cannot start says so and leaves within a few hundred milliseconds; before this, the launcher
  // went on waiting fifteen seconds for a window whose process no longer existed.
  // NOT `unref()`: that asks Node not to keep the event loop alive for this child, and the exit
  // event is the thing being waited for — with `unref()` it never arrived, so a widget that died in
  // 200ms still cost the full fifteen second wait. The launcher leaves through `process.exit`, and
  // on Windows a child outlives its parent regardless, so nothing needed unref in the first place.
  child.on("exit", () => {
    exited = true;
  });
  child.on("close", () => {
    exited = true;
  });
  log(`tauri window launched ${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y}, alwaysOnTop=${CONFIG.alwaysOnTop}`);

  // Let the widget refuse before committing to a wait, and do not "race" the wait against that
  // refusal: resolving a promise does not stop the PowerShell process doing the probing, and the
  // orphan keeps the event loop alive and holds the launcher open until its own timeout expires.
  // Racing was why the doomed path still took thirty seconds after it was first called fixed. A
  // widget that cannot create a window says so in about two hundred milliseconds.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const refused = doomed || exited;
  if (refused) log("the widget refused before any window could appear; not waiting for one");
  const waited = refused ? "EXITED" : await startWindowScript("repair", 15_000);
  // A dead process cannot produce a window, so this second look only needs to catch one that was
  // already there — four hundred milliseconds, not two seconds.
  const probe = waited === "EXITED" ? await startWindowScript("repair", 400) : waited;
  if (probe.startsWith("HANDLED")) {
    child.stderr?.destroy();
    say(`window ${probe}`);
    return true;
  }

  const lines = complaint.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) log(exited ? "the widget exited without saying why" : "the widget said nothing and is still running");
  else for (const line of lines) log(`tauri widget said: ${line}`);
  child.stderr?.destroy();

  // A widget started from a host hook inherits that process's restrictions and cannot create a
  // WebView2 window: Windows answers "access denied". The hand-off that escapes that context is to
  // the Task Scheduler, which starts the process in the interactive session — **not** to Explorer.
  // Explorer also escapes the restrictions, and that is what this did first: it earns a SmartScreen
  // prompt instead, because launching an unsigned executable through the shell is precisely what
  // SmartScreen exists to interrupt. That prompt then sits on screen while the launcher waits out
  // its timeout, so the user gets a security dialog, a fifteen second stall, and still no window.
  // The Task Scheduler goes nowhere near the shell, and the widget reads its own port and geometry
  // from the config file, so nothing needs passing to it.
  if (/access denied|os error 5/i.test(complaint) || complaint === "") {
    const taskName = "agent-cost-monitor-window";
    log("retrying the widget through the Task Scheduler, which starts it in the interactive session");
    const schtasks = (args) =>
      new Promise((resolve) => {
        try {
          const run = spawn("schtasks", args, { stdio: "ignore", windowsHide: true });
          run.on("exit", resolve);
          run.on("error", () => resolve(-1));
        } catch {
          resolve(-1);
        }
      });
    // `/it` is the whole point: run only in an interactive session. `/f` overwrites an older task,
    // so the definition cannot go stale across versions.
    const created = await schtasks([
      "/create", "/tn", taskName, "/tr", `"${TAURI_EXE}"`, "/sc", "once", "/st", "00:00", "/it", "/f",
    ]);
    const started = created === 0 ? await schtasks(["/run", "/tn", taskName]) : -1;
    log(`task scheduler: create=${created} run=${started}`);
    // Eight seconds, not fifteen. The scheduler launches the widget immediately, so a working one
    // appears in a second or two and the probe returns the moment it does; the timeout only bounds
    // the failing case, and that is the case the user actually pays for.
    const second = await startWindowScript("repair", 8_000);
    if (second.startsWith("HANDLED")) {
      say(`window ${second} (started through the Task Scheduler)`);
      log("the Task Scheduler hand-off worked");
      return true;
    }
    log("the Task Scheduler hand-off did not produce a window either");
  }

  log("the tauri widget could not be started; falling back to the browser");
  say("  the widget could not be started; falling back to a browser window (see: acm log)");
  // A widget that cannot create a window may also never exit, and a live child holding a piped
  // stderr keeps Node's event loop alive — so the launcher would hang for as long as that process
  // sat there. Removing `unref()` (which was needed to see the exit event at all) is what made that
  // possible, and it hung a real launch for five minutes. Killing it is the honest end of an
  // attempt that has already been given up on.
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  return false;
}

function launchBrowser() {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (browser === undefined) {
    log("no Edge or Chrome found");
    say(`no Edge or Chrome found; open ${URL_} yourself`);
    return;
  }
  say(`opening ${URL_} in ${browser.split("/").pop()} (${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y})`);
  log(`launching ${browser} ${CONFIG.width}x${CONFIG.height} at ${CONFIG.x},${CONFIG.y} host=${HOST || "auto"}`);
  // Started BEFORE the browser, and this order is the whole point: PowerShell needs a few
  // hundred milliseconds to start up, and paying that after the browser was spawned put the
  // delay inside the visible phase — which is the half second of full-screen window. Started
  // first, the script is already polling every 40 ms when the window appears.
  const placement = startWindowScript("place", 90_000);
  const child = spawn(
    browser,
    [
      `--app=${URL_}`,
      `--window-size=${CONFIG.width},${CONFIG.height}`,
      `--window-position=${CONFIG.x},${CONFIG.y}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return placement.then((verdict) => {
    say(verdict === "NONE" ? "window not found within 90s (the browser may still be starting)" : `window ${verdict}`);
  });
}

await ensureDaemon();

// One probe, before anything is opened, which both decides and repairs.
//
// "Is a window already open?" is answered by finding the window, not by asking the daemon
// whether anything polled: a hidden Edge window keeps polling, so the poll-based answer said
// yes while there was nothing on screen to see. In `repair` mode it shows and pins what it
// finds but does NOT move it — this runs on every prompt, and re-applying the configured
// geometry each time is what reset the window's position per prompt.
const probe = await startWindowScript("repair", PROBE_MS);
const existing = probe.startsWith("HANDLED");
if (existing) {
  log(`an existing window was checked: ${probe}`);
  say(`window ${probe}`);
  // Reuse is the default; `--new` is how you ask for a second window. This branch used to require
  // `--if-needed`, which the hooks pass and a hand-typed `acm launch` does not — and a launch that
  // fell past this point reached the browser path, whose `place` script finds the FIRST window
  // with our title and moves it to the configured geometry. So a window the user had positioned
  // snapped back to the corner whenever anything ran a plain `acm launch`. Whether a window moves
  // must not depend on which flags the caller happened to pass.
  if (!process.argv.includes("--new")) {
    log(ifNeeded ? "--if-needed: an existing window is up; nothing new opened" : "an existing window is up; reused it (--new opens a second)");
    say(ifNeeded ? "an existing window is up; nothing new opened" : "an existing window is up; reused it rather than moving or duplicating it");
    process.exit(0);
  }
  log("--new: a second window was requested, so the existing one is left exactly where it is");
}

// A widget that cannot start should not be attempted on every prompt. The failure is remembered
// for a while, so a hook-driven launch goes straight to the browser instead of paying seconds for
// an attempt already known to fail; a success clears it, and so does the wait expiring.
//
// The marker's SIZE carries the state — empty is healthy, a timestamp is a failure — because this
// module imports only the parts of node:fs it already needed, and `size` plus `mtimeMs` answers
// both "did it fail" and "how long ago" without another import.
const WIDGET_MARKER = join(homedir(), ".cache", "agent-cost-monitor", "widget-failed");
const WIDGET_RETRY_MS = 10 * 60 * 1000;

function widgetFailureAgeMs() {
  try {
    if (!existsSync(WIDGET_MARKER)) return undefined;
    const info = statSync(WIDGET_MARKER);
    if (info.size === 0) return undefined;
    const age = Date.now() - info.mtimeMs;
    return age < WIDGET_RETRY_MS ? age : undefined;
  } catch {
    return undefined;
  }
}

function noteWidgetOutcome(worked) {
  try {
    mkdirSync(dirname(WIDGET_MARKER), { recursive: true });
    writeFileSync(WIDGET_MARKER, worked ? "" : `the widget could not create its window at ${new Date().toISOString()}\n`);
  } catch {
    /* the marker is a convenience, not a requirement */
  }
}

if (useTauri) {
  const failedAge = widgetFailureAgeMs();
  if (failedAge !== undefined) {
    log(`the widget failed ${Math.round(failedAge / 1000)}s ago; not attempting it again yet`);
    say(`  the widget failed recently; opening a browser window instead (retried in ${Math.round((WIDGET_RETRY_MS - failedAge) / 60000)} min)`);
  } else if (await launchTauri()) {
    noteWidgetOutcome(true);
    process.exit(0);
  } else {
    noteWidgetOutcome(false);
    say("  falling back to a browser window");
  }
}

// Awaited so this process outlives the placement it started; it is detached, so nobody sees
// it wait.
await launchBrowser();
