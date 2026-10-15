#!/usr/bin/env node
// acm — one command to put the spend line in front of whichever agent you run.
//
//   npx agent-cost-monitor install        # detect, then configure what is there
//   npx agent-cost-monitor status         # what is detected, what is configured
//   npx agent-cost-monitor uninstall      # remove only what we added
//
// Downloading, detecting and installing are deliberately three separate steps:
// nothing is fetched until a host is found that needs it, and nothing is written
// until the plan for that host is known.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeHosts, looksLikePluginDir, planClaudeInstall, planClaudeUninstall, pluginSpec } from "../src/install.mjs";
import { pricingPaths, readPricingRecord } from "../src/pricing-doc.mjs";
// `acm pricing --refresh` and `acm update` both shell out to npm or to node. This import was
// missing, so `acm pricing --refresh` would have thrown the first time anyone ran it — shipped in
// 0.15.6 and not caught, because no test executes the CLI's command dispatch.
import { execFileSync } from "node:child_process";
import {
  claudeCommandFile,
  claudeCommandPath,
  configPath,
  hasBlock,
  mergeConfig,
  profilePaths,
  removeBlock,
  resolveConfig,
} from "../src/autostart.mjs";
import {
  CODEX_TRUST_NOTE,
  planClaudeHookInstall,
  planClaudeHookRemove,
  planCodexHookInstall,
  planCodexHookRemove,
} from "../src/hooks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const STATUSLINE = join(PACKAGE_ROOT, "claude", "statusline.mjs");
const CACHE_DIR = join(homedir(), ".cache", "agent-cost-monitor");
const PRICING_CACHE = process.env.SPEND_WATCH_CACHE ?? join(homedir(), ".cache", "spend-watch");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");

const DSH_PROFILE = process.env.ACM_DSH_PROFILE ?? "dsh-tui";
const PLUGIN_REPO = process.env.ACM_PLUGIN_REPO ?? "https://github.com/NeutronStar714/dsh-budget-watcher";
const LAUNCH_SCRIPT = join(PACKAGE_ROOT, "window", "launch.mjs");
const TRAY_SCRIPT = join(PACKAGE_ROOT, "window", "tray.ps1");
const TRAY_PID = join(CACHE_DIR, "tray.pid");
const TRAY_LOG = join(CACHE_DIR, "tray.log");
const TRAY_STARTUP = join(startupFolder(), "ACM Tray.vbs");
const CONFIG_FILE = configPath(homedir());
const LOG_FILE = join(homedir(), ".cache", "agent-cost-monitor", "window.log");
const WINDOW_URL = `http://127.0.0.1:${process.env.ACM_WINDOW_PORT ?? 7420}/`;

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("-")) ?? "status";
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hostArg = option("host") ?? "auto";
const dryRun = flag("dry-run");
const force = flag("force");
const say = (line = "") => process.stdout.write(line + "\n");

const settingsPath = () => join(homedir(), ".claude", "settings.json");

/**
 * One command line, through the shell.
 *
 * A single string rather than an args array on purpose. On Windows `dsh` and
 * `claude` are shell shims, so a shell is required — and passing an array *with*
 * `shell: true` makes Node warn (DEP0190), because the arguments are concatenated
 * rather than escaped. Callers quote what needs quoting.
 */
function run(commandLine, { inherit = false } = {}) {
  return spawnSync(commandLine, { shell: true, stdio: inherit ? "inherit" : "ignore", timeout: 120_000 });
}

function hasCommand(name) {
  return run(`${name} --version`).status === 0;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// --------------------------------------------------------------- detection ---

function detectClaude() {
  const path = settingsPath();
  const present = existsSync(path);
  const settings = present ? readJson(path, undefined) : {};
  const status = settings === undefined ? "unreadable settings.json" : settings.statusLine === undefined ? "not configured" : "configured";
  return {
    detected: present || hasCommand("claude"),
    settingsPath: path,
    settings,
    status,
    detail: settings?.statusLine === undefined ? `no statusLine in ${path}` : `statusLine -> ${settings.statusLine.command}`,
  };
}

function detectDsh() {
  const profileDir = join(homedir(), ".dsh", "profiles", DSH_PROFILE);
  const installed = existsSync(join(profileDir, "node_modules", "dsh-budget-watcher"));
  return {
    detected: hasCommand("dsh-tui") || existsSync(profileDir),
    profileDir,
    installed,
    status: installed ? `installed in profile "${DSH_PROFILE}"` : `not installed in profile "${DSH_PROFILE}"`,
    detail: `profile ${profileDir}`,
  };
}

function detectCodex() {
  const config = CODEX_CONFIG;
  if (!existsSync(config)) return { detected: false, status: "not found", detail: "" };
  let hooked = false;
  try {
    hooked = hasBlock(readFileSync(config, "utf8"));
  } catch {
    /* an unreadable config is still a detected host */
  }
  return {
    detected: true,
    status: hooked ? "hooks installed (the window opens on a prompt)" : "detected; no hooks yet",
    detail: hooked ? config : `${config}  (add the hooks with: acm hook on)`,
  };
}

// -------------------------------------------------------------- claude code ---

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, `${path}.bak-${stamp}`);
    say(`  backed up to ${path}.bak-${stamp}`);
  }
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
}

/** Any file acm edits gets a timestamped copy first — config.toml as much as settings.json. */
function withBackup(path, write) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(path, `${path}.bak-${stamp}`);
    say(`  backed up to ${path}.bak-${stamp}`);
  }
  write();
}

// ------------------------------------------------------------------ hooks ---

/**
 * A `SessionStart` hook, so the window comes up with the session.
 *
 * This is the extension point both harnesses now offer, and it is the right one: unlike
 * the withdrawn shell shim, it needs no edits to a shell profile and it fires on the
 * event rather than on a command name.
 */
function hookClaude(mode) {
  // Claude Code's CLI gets the status line and NOTHING else. A window on top of a line that
  // already shows the same figures is noise, and "the injection never showed up but a pop-up did"
  // is what that looks like from the outside. The window hooks exist for harnesses with no status
  // row — and because the CLI and the desktop app share one settings.json, this cannot be decided
  // per app, so it is opt-in: `on` without `--window` actively REMOVES what an earlier version
  // installed, which is how an existing machine gets back to line-only.
  const wantsWindow = flag("window") === true;
  if (mode === "on" && !wantsWindow) {
    say("  Claude Code uses the status line, so no window hook is installed.");
    say("  (its CLI and desktop app share one settings file, so a hook would open a window in the CLI too)");
    say("  on the desktop app and want the window as well?  acm hook on --host claude --window");
  }
  const effective = mode === "on" && !wantsWindow ? "off" : mode;
  let settings;
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
  } catch (error) {
    say(`  skipped: ${CLAUDE_SETTINGS} ${existsSync(CLAUDE_SETTINGS) ? "does not parse" : "does not exist"} (${error.code ?? error.message})`);
    return 1;
  }
  const planned = effective === "on" ? planClaudeHookInstall(settings, "claude") : planClaudeHookRemove(settings);
  // Every message below follows `effective`, not `mode`: when the rule above turned an `on` into a
  // removal, a line claiming it "would add" a hook was the exact opposite of what happened.
  if (!planned.changed) {
    say(effective === "on" ? "  already installed" : "  not installed");
    return 0;
  }
  if (dryRun) {
    say(`  would ${effective === "on" ? "add" : "remove"} hooks.SessionStart in ${CLAUDE_SETTINGS}`);
    return 0;
  }
  withBackup(CLAUDE_SETTINGS, () => writeFileSync(CLAUDE_SETTINGS, JSON.stringify(planned.settings, null, 2) + "\n"));
  say(`  ${effective === "on" ? "installed" : "removed"}  hooks.SessionStart (startup) in ${CLAUDE_SETTINGS}`);
  return 0;
}

function hookCodex(mode) {
  if (!existsSync(CODEX_CONFIG)) {
    say(`  skipped: ${CODEX_CONFIG} does not exist`);
    return 1;
  }
  const text = readFileSync(CODEX_CONFIG, "utf8");
  const planned = mode === "on" ? planCodexHookInstall(text, "codex") : planCodexHookRemove(text);
  if (!planned.changed) {
    say(mode === "on" ? "  already installed" : "  not installed");
    return 0;
  }
  if (dryRun) {
    say(`  would ${mode === "on" ? "add" : "remove"} the SessionStart block in ${CODEX_CONFIG}`);
    return 0;
  }
  withBackup(CODEX_CONFIG, () => writeFileSync(CODEX_CONFIG, planned.text));
  say(`  ${mode === "on" ? "installed" : "removed"}  [[hooks.SessionStart]] in ${CODEX_CONFIG}`);
  if (mode === "on") say(`  note: ${CODEX_TRUST_NOTE}`);
  return 0;
}

function hookStatus() {
  let claude = "no settings file";
  try {
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    claude = (settings.hooks?.SessionStart ?? []).some((e) => (e.hooks ?? []).some((h) => String(h.command ?? "").includes("acm launch")))
      ? "installed"
      : "not installed";
  } catch {
    /* leave the message above */
  }
  let codex = "no config.toml";
  try {
    codex = hasBlock(readFileSync(CODEX_CONFIG, "utf8")) ? "installed" : "not installed";
  } catch {
    /* leave the message above */
  }
  say(`  claude code  ${claude}  ${CLAUDE_SETTINGS}`);
  say(`  codex        ${codex}  ${CODEX_CONFIG}`);
  say("  The window starts on SessionStart, so `acm launch` stays available by hand too.");
  return 0;
}

function runHookCommand(mode) {
  const scopes = hostArg === "all" || hostArg === "auto" ? ["claude", "codex"] : [hostArg];
  if (mode === "status") return hookStatus();
  let failures = 0;
  for (const scope of scopes) {
    if (scope === "claude") failures += hookClaude(mode);
    else if (scope === "codex") failures += hookCodex(mode);
    else {
      say(`  unknown host "${scope}" (use claude, codex or all)`);
      failures += 1;
    }
  }
  return failures;
}

function claudeInstall(claude) {
  if (claude.settings === undefined) {
    say("  skipped: settings.json exists but does not parse as JSON");
    return 1;
  }
  const plan = planClaudeInstall(claude.settings, STATUSLINE, { force });
  say(`  ${plan.message}`);
  if (plan.action === "conflict") return 1;
  if (plan.action === "unchanged" || dryRun) return 0;
  writeSettings(claude.settingsPath, plan.settings);
  return 0;
}

function claudeUninstall(claude) {
  if (claude.settings === undefined) return 1;
  const plan = planClaudeUninstall(claude.settings);
  say(`  ${plan.message}`);
  if (plan.action === "unchanged" || dryRun) return 0;
  writeSettings(claude.settingsPath, plan.settings);
  return 0;
}

// ------------------------------------------------------------------ dsh-tui ---

/** The plugin is a separate repository, so fetch it if it is not already around. */
function ensurePlugin() {
  const local = process.env.ACM_PLUGIN_DIR;
  if (local !== undefined && looksLikePluginDir(readJson(join(local, "package.json"), {}))) return local;

  // A sibling checkout is the normal case when working on both at once.
  const sibling = resolve(PACKAGE_ROOT, "..", "dsh-budget-watcher");
  if (looksLikePluginDir(readJson(join(sibling, "package.json"), {}))) return sibling;

  const cached = join(CACHE_DIR, "dsh-budget-watcher");
  if (looksLikePluginDir(readJson(join(cached, "package.json"), {}))) return cached;

  if (dryRun) {
    say(`  would clone ${PLUGIN_REPO} into ${cached}`);
    return cached;
  }
  say(`  downloading the plugin into ${cached}`);
  mkdirSync(dirname(cached), { recursive: true });
  const clone = run(`git clone --depth 1 "${PLUGIN_REPO}" "${cached}"`, { inherit: true });
  if (clone.status !== 0) {
    say("  clone failed — is git installed and the repository reachable?");
    return undefined;
  }
  return cached;
}

function dshInstall() {
  if (!hasCommand("dsh")) {
    say("  skipped: the dsh command is not on PATH");
    return 1;
  }
  const pluginDir = ensurePlugin();
  if (pluginDir === undefined) return 1;
  say(`  plugin at ${pluginDir}`);
  if (dryRun) {
    say(`  would run: dsh plugin --profile ${DSH_PROFILE} add ${pluginSpec(pluginDir)}`);
    return 0;
  }
  const add = run(`dsh plugin --profile ${DSH_PROFILE} add "${pluginSpec(pluginDir)}"`, { inherit: true });
  if (add.status !== 0) {
    say("  `dsh plugin add` failed; the profile was left as it was");
    return 1;
  }
  say(`  installed into profile "${DSH_PROFILE}"`);
  say("  note: this gives DSH the cost data and its HTTP route. dsh-tui has no");
  say("        status row to draw it in yet, so nothing appears in the terminal.");
  return 0;
}

function dshUninstall(installed) {
  if (!hasCommand("dsh")) {
    say("  the dsh command is not on PATH; nothing to remove here");
    return 0;
  }
  // Uninstall now runs for every host, so "not installed" is the normal case rather
  // than a failure — asking pnpm to remove a package that was never added would
  // report a problem that is not one.
  if (installed !== true) {
    say(`  nothing of ours in profile "${DSH_PROFILE}"`);
    return 0;
  }
  if (dryRun) {
    say(`  would run: dsh plugin --profile ${DSH_PROFILE} remove dsh-budget-watcher`);
    return 0;
  }
  return run(`dsh plugin --profile ${DSH_PROFILE} remove dsh-budget-watcher`, { inherit: true }).status === 0 ? 0 : 1;
}

// ------------------------------------------------------------------- status ---

function pricingCache() {
  const file = join(PRICING_CACHE, "claude-pricing.json");
  const cache = readJson(file, undefined);
  if (cache === undefined) return `  pricing cache: none yet at ${file} (the first run fetches it)`;
  const age = Number.isFinite(Date.parse(cache.fetchedAt)) ? Math.round((Date.now() - Date.parse(cache.fetchedAt)) / 3_600_000) : undefined;
  return `  pricing cache: ${Object.keys(cache.models ?? {}).length} models, USD->CNY ${cache.usdToCny ?? "unknown"}, ${age === undefined ? "age unknown" : `${age}h old`}`;
}

function status() {
  const hosts = { claude: detectClaude(), dsh: detectDsh(), codex: detectCodex() };
  say(describeHosts(hosts));
  say(pricingCache());
  return 0;
}

// --------------------------------------------------------------- autostart ---

function readConfig() {
  return readJson(CONFIG_FILE, undefined);
}

function writeConfig(next) {
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Start the window now. This is what `/acm` and the user call. */
function launch({ quiet }) {
  if (!existsSync(LAUNCH_SCRIPT)) {
    if (!quiet) say(`  the window is not in this install (${LAUNCH_SCRIPT} is missing)`);
    return 1;
  }
  const host = option("host") ?? "";
  // `--dry-run` has to mean it here too: the hook runs this command, and a flag that
  // prints a plan while starting a real browser window is worse than no flag.
  if (dryRun) {
    say(`  would start the window at ${WINDOW_URL}${host === "" ? "" : ` (host: ${host})`}`);
    return 0;
  }
  // Reuse an open window unless another one is asked for.
  //
  // A manual launch used to always open a new window, so `acm launch` with one already up left
  // two on screen — which is what a launch "failing" looked like in the log: an existing window
  // at 1132x713, then a second placed at the corner. `--new` is there for a deliberate second
  // window, and the hook uses this same reuse path.
  const args = [LAUNCH_SCRIPT, ...(host === "" ? [] : ["--host", host])];
  if (flag("new")) args.push("--new");
  else args.push("--if-needed");
  // Detached and unref'd: a GUI process must never hold this one open, and the window
  // takes long enough to start that waiting on it would be felt.
  spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
  if (!quiet) say(`  window starting at ${WINDOW_URL}${host === "" ? "" : ` (host: ${host})`}${flag("new") ? " (a second window)" : " (if one is not already open)"}`);
  return 0;
}

/** The `/acm` command, for the harness whose slash commands are extensible. */
function writeClaudeCommand() {
  const path = claudeCommandPath(homedir());
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, claudeCommandFile());
    say(`  /acm      ${path}`);
    return true;
  } catch (error) {
    say(`  /acm      failed: ${error.message}`);
    return false;
  }
}

/**
 * Remove a shim block written by a version that had auto-launch.
 *
 * Nothing writes one any more — both remaining hosts were given up, because the
 * window that rode along with them showed the wrong host's numbers half the time. But
 * a withdrawn feature still has to be cleanly reversible on machines that ran it, so
 * this stays and `uninstall` calls it.
 */
function removeShimBlock() {
  let removed = 0;
  for (const path of profilePaths(homedir())) {
    if (!existsSync(path)) continue;
    const existing = readFileSync(path, "utf8");
    if (!hasBlock(existing)) continue;
    if (dryRun) {
      say(`  would remove an old auto-launch block from ${path}`);
      continue;
    }
    writeFileSync(path, removeBlock(existing).text);
    removed += 1;
    say(`  removed   ${path}`);
  }
  if (!dryRun) say(removed === 0 ? "  (no old auto-launch block in either profile)" : "  (old auto-launch block removed)");
  return removed;
}

/**
 * Undo everything acm wrote, in one command.
 *
 * A trail of edits across a settings file, two shell profiles, a slash-command
 * directory and a cache is exactly what stops people installing something at all, so
 * `uninstall` means *all of it* rather than whichever host happens to be the default.
 * The package itself is the one thing acm cannot quietly delete from under its own
 * feet, so it is printed, and `--self` does it anyway.
 */
function removeEverything({ self, keepCache }) {
  let failures = 0;

  say("\nsession-start hooks");
  runHookCommand("off");

  say("\nold auto-launch block");
  removeShimBlock();

  say("\n/acm");
  const commandFile = claudeCommandPath(homedir());
  failures += removePath(commandFile, "file");

  say("\ntray");
  failures += removePath(TRAY_STARTUP, "file");
  failures += trayStop();

  say("\nconfig");
  failures += removePath(CONFIG_FILE, "file");

  if (!keepCache) {
    say("\npricing cache");
    failures += removePath(PRICING_CACHE, "dir");
  }

  say("\nthe package itself");
  if (self) {
    if (dryRun) say("  would run: npm uninstall -g agent-cost-monitor");
    else {
      const removed = run("npm uninstall -g agent-cost-monitor", { inherit: true });
      if (removed.status === 0) say("  removed the global package");
      else {
        say("  npm could not remove it; run it yourself: npm uninstall -g agent-cost-monitor");
        failures += 1;
      }
    }
  } else {
    say("  still installed. Remove it with: npm uninstall -g agent-cost-monitor");
    say("  (or re-run as `acm uninstall --self` and acm will do it)");
  }
  return failures;
}

/** Delete one path, reporting honestly whether there was anything to delete. */
function removePath(path, kind) {
  if (!existsSync(path)) {
    say(`  nothing at ${path}`);
    return 0;
  }
  if (dryRun) {
    say(`  would remove ${path}`);
    return 0;
  }
  try {
    if (kind === "dir") rmSync(path, { recursive: true, force: true });
    else unlinkSync(path);
    say(`  removed   ${path}`);
    return 0;
  } catch (error) {
    say(`  failed    ${path}: ${error.message}`);
    return 1;
  }
}

// -------------------------------------------------------------------- tray ---

/**
 * Where Windows keeps the per-user Startup folder.
 *
 * Asked of the environment rather than assumed to be C:\Users\..., because the login entry only
 * does anything at all if it lands in the folder Windows actually reads.
 */
function startupFolder() {
  const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/**
 * Which PowerShell to hand the tray to: 7 if it answers, else Windows PowerShell.
 *
 * Neither is required, so this asks instead of assuming: `pwsh` is preferred because it reads a
 * UTF-8 script without a byte-order mark and starts in an STA apartment, which is what a WinForms
 * notification icon wants; Windows PowerShell is the fallback, and works because window/tray.ps1
 * is saved with a BOM. A machine with neither gets told so.
 */
function powershellExe() {
  for (const exe of ["pwsh", "powershell"]) {
    try {
      const probe = spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 20_000 });
      if (probe.status === 0) return exe;
    } catch {
      /* not installed, or not on PATH */
    }
  }
  return "";
}

/**
 * The tray's own pid, or undefined when nothing is behind it any more.
 *
 * The pid file can outlive its process — a kill, a logoff, a crash — and a stale pid that looks
 * like a running tray would make `acm tray` refuse to start the one the user is asking for, so
 * the process itself is asked whether it exists before the file is believed.
 */
function trayPid() {
  let pid;
  try {
    pid = Number(readFileSync(TRAY_PID, "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // EPERM is "it exists, and not as this user" — alive is all the question asks.
    return error?.code === "EPERM" ? pid : undefined;
  }
}

/** A synchronous sleep, because the CLI's own flow is synchronous. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function trayStart() {
  if (!existsSync(TRAY_SCRIPT)) {
    say(`  the tray is not in this install (${TRAY_SCRIPT} is missing)`);
    return 1;
  }
  const running = trayPid();
  if (running !== undefined) {
    say(`  already running (pid ${running})`);
    return 0;
  }
  const exe = dryRun ? "powershell" : powershellExe();
  if (exe === "") {
    say("  no PowerShell found (tried pwsh and powershell)");
    return 1;
  }
  const port = String(resolveConfig(homedir()).port);
  if (dryRun) {
    say(`  would start: ${exe} -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${TRAY_SCRIPT} -Port ${port}`);
    return 0;
  }
  // Detached, so a GUI helper never holds this command open — and its stderr goes to the tray's
  // own log rather than to nowhere. A script that dies while being parsed never reaches its own
  // Write-Log, so without this the entire symptom of a broken install is "it did not come up",
  // with an empty log to explain it.
  let errFd;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    errFd = openSync(TRAY_LOG, "a");
  } catch {
    /* a tray with nowhere to log is still a tray */
  }
  // NOT `detached: true`, which is what a GUI helper normally wants — and which here means the
  // tray silently does nothing at all. On Windows `detached` means DETACHED_PROCESS: a console
  // with no window AND no console at all, and PowerShell started that way exits 0 before running
  // a single line of the script (measured: with `detached` the pid file is never written and
  // stderr is empty; without it, everything runs). `windowsHide` plus `unref` is what this wants
  // anyway: CREATE_NO_WINDOW gives the tray its own hidden console, so it is not attached to the
  // console that ran `acm` and survives that console closing, and on Windows a child outlives its
  // parent regardless — which is why the launcher next door relies on the same property.
  const child = spawn(exe, ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", TRAY_SCRIPT, "-Port", port, "-Node", process.execPath], {
    stdio: ["ignore", "ignore", errFd ?? "ignore"],
    windowsHide: true,
  });
  child.unref();
  // The child holds its own descriptor from here on; closing the parent's copy is what stops this
  // command from holding the log open.
  if (errFd !== undefined) {
    try {
      closeSync(errFd);
    } catch {
      /* already closed */
    }
  }

  // Then wait for the pid rather than assuming: a detached process says nothing, so a tray that
  // died on its first line — old PowerShell, no WinForms, a bad flag — would otherwise look
  // exactly like one that is up. The log is where it explains itself, so the log is what gets read.
  // Six seconds, not two: PowerShell has to start and `Add-Type` compiles the one P/Invoke stub
  // the icon needs, which measured out at over three seconds on this machine — long enough that a
  // two-second cap called a working tray broken. Success returns as soon as the pid appears, so
  // only the failing case ever waits this long.
  for (let i = 0; i < 24 && trayPid() === undefined; i += 1) sleepSync(250);
  const pid = trayPid();
  if (pid === undefined) {
    say(`  the tray did not come up (${exe}); it said:`);
    const tail = existsSync(TRAY_LOG) ? readFileSync(TRAY_LOG, "utf8").split("\n").filter(Boolean).slice(-6) : [];
    if (tail.length === 0) say(`  (nothing in ${TRAY_LOG})`);
    else for (const line of tail) say(`  ${line}`);
    return 1;
  }
  say(`  tray        running (pid ${pid}, ${exe}, port ${port})`);
  say(`  log         ${TRAY_LOG}`);
  // Windows hides a new notification icon by default. Saying so once is cheaper than the user
  // deciding the feature does not work.
  say("  Windows hides a new notification icon: click the ^ overflow and drag it onto the taskbar");
  return 0;
}

function trayStop() {
  const pid = trayPid();
  if (pid === undefined) {
    try {
      unlinkSync(TRAY_PID);
    } catch {
      /* nothing to clean */
    }
    say("  tray        not running");
    return 0;
  }
  if (dryRun) {
    say(`  would stop  pid ${pid}`);
    return 0;
  }
  try {
    process.kill(pid);
  } catch (error) {
    say(`  could not stop pid ${pid}: ${error.message}`);
    return 1;
  }
  say(`  stopped     pid ${pid}`);
  return 0;
}

function trayStatus() {
  const pid = trayPid();
  say(`  tray        ${pid === undefined ? "not running" : `running (pid ${pid})`}`);
  say(`  script      ${existsSync(TRAY_SCRIPT) ? TRAY_SCRIPT : `${TRAY_SCRIPT} (missing)`}`);
  say(`  log         ${existsSync(TRAY_LOG) ? TRAY_LOG : `${TRAY_LOG} (nothing logged yet)`}`);
  say(`  at login    ${existsSync(TRAY_STARTUP) ? TRAY_STARTUP : "not installed"}`);
  say("  it reads the window's daemon, so it needs one running: `acm launch` starts it");
  return 0;
}

/**
 * Start it now and at every login.
 *
 * A .vbs rather than a shortcut, because `Run(..., 0, False)` is the one way to start a console
 * program with no console at all — and a console window flashing at login is exactly what a tray
 * icon must not do.
 */
function trayInstallStartup() {
  const port = String(resolveConfig(homedir()).port);
  const exe = powershellExe() || "powershell";
  const body = [
    "' acm tray — the spend figures in the notification area, started at login.",
    "' Written by `acm tray --install`; remove it with `acm tray --uninstall`.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "${exe} -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${TRAY_SCRIPT}"" -Port ${port} -Node ""${process.execPath}""", 0, False`,
    "",
  ].join("\r\n");
  if (dryRun) {
    say(`  would write ${TRAY_STARTUP}`);
    return 0;
  }
  try {
    mkdirSync(dirname(TRAY_STARTUP), { recursive: true });
    writeFileSync(TRAY_STARTUP, body);
    say(`  at login    ${TRAY_STARTUP}`);
    return 0;
  } catch (error) {
    say(`  could not write the login entry: ${error.message}`);
    return 1;
  }
}

// --------------------------------------------------------------------- main ---

/**
 * Which hosts a command applies to.
 *
 * Install is conservative — Claude Code by default, the one host every install can
 * configure — but uninstall is total: "remove it all" has to mean all, or reversing
 * an install becomes a list of flags to remember.
 */
const wants = (name) =>
  hostArg === "all" || hostArg === name || (hostArg === "auto" && (command === "uninstall" ? true : name === "claude"));

function main() {
  const hosts = { claude: detectClaude(), dsh: detectDsh(), codex: detectCodex() };

  if (command === "help" || flag("help")) {
    say("acm — live spend for your coding agent\n");
    say("  acm install [--host h]     configure a host (claude | dsh | all; default: claude)");
    say("  acm launch [--host h]      start the window now (--host codex points it at Codex)");
    say("                             reuses an open window; --new opens a second one");
    say("  acm tray                   the same figures in the notification area (Windows)");
    say("                             --install also starts it at every login");
    say("                             --status | --stop | --uninstall");
    say("  acm status                 what is detected and configured");
    say("  acm uninstall              remove everything acm added to your machine");
    say("                             (--self also uninstalls the npm package)");
    say("                             (--keep-cache leaves the pricing cache)");
    say("  acm clean-profiles         remove an old auto-launch block, if you have one");
    say("  acm hook on|off|status     a SessionStart hook that opens the window");
    say("    [--host claude|codex|all]  (default: both, when their config exists)");
    say("  acm doctor                 check the pieces the status line needs\n");
    say("  acm pricing [--refresh]    the offline rate card: what it holds, when it changed\n");
    say("  --dry-run                  print the plan, change nothing");
    say("  --force                    replace a status line configured by something else");
    return 0;
  }
  if (command === "status") return status();
  if (command === "launch") return launch({ quiet: flag("quiet") });
  if (command === "tray") {
    if (flag("status")) return trayStatus();
    if (flag("stop")) return trayStop();
    if (flag("uninstall")) {
      const removed = removePath(TRAY_STARTUP, "file");
      return trayStop() + removed;
    }
    if (flag("install")) return trayInstallStartup() + trayStart();
    return trayStart();
  }
  if (command === "clean-profiles") {
    // Auto-launch is withdrawn, but machines that ran it still carry the block.
    say("old auto-launch block");
    removeShimBlock();
    return 0;
  }

  if (command === "hook") {
    const mode = argv.find((a) => ["on", "off", "status"].includes(a)) ?? "status";
    if (mode !== "status") say(`hook ${mode}${dryRun ? " (dry run)" : ""}`);
    return runHookCommand(mode) === 0 ? 0 : 1;
  }

  if (command === "update") {
    // Updating means asking npm for the published version, because the installed copy is what
    // runs. `--local` reinstalls from this checkout instead, which is how a fix reaches a machine
    // before it is published. Either way both versions are printed: "updated" that moved nothing
    // is not an update, and saying so is the point of reporting the before and the after.
    const packageRoot = join(process.argv[1] ?? ".", "..", "..");
    const versionAt = (root) => {
      try {
        return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? undefined;
      } catch {
        return undefined;
      }
    };
    // What is INSTALLED is not what is RUNNING: this command is normally run from a checkout, so
    // `packageRoot` describes the source, and reporting its version as "installed" is a claim about
    // the wrong directory. That is how this command reported "already current (0.15.15)" while the
    // question being asked was whether the global copy had been refreshed. Ask npm where its global
    // prefix is and read the version there instead.
    const globalRoot = (() => {
      try {
        return execFileSync("npm root -g", { encoding: "utf8", shell: true }).trim();
      } catch {
        return "";
      }
    })();
    const installedAt = globalRoot === "" ? undefined : join(globalRoot, "agent-cost-monitor");
    const before = installedAt === undefined ? undefined : versionAt(installedAt);
    say(`  installed   ${before ?? "unknown"}   ${installedAt ?? "(npm root -g unavailable)"}`);
    say(`  source      ${versionAt(packageRoot) ?? "unknown"}   ${packageRoot}`);
    const local = flag("local");
    const target = local ? `"${packageRoot}"` : "agent-cost-monitor@latest";
    // A directory install over an existing global one fails with EEXIST: npm will not overwrite
    // the files it just finished writing. `--force` is the documented answer for that case and is
    // applied only here, where the source is the checkout you are standing in, not to a registry
    // install where it would also wave through peer-dependency mismatches.
    const options = local ? " --force" : "";
    say(`  installing  ${target}${local ? "  (this checkout)" : "  from npm"}`);
    let status = 1;
    try {
      execFileSync(`npm install -g ${target}${options}`, { stdio: "inherit", shell: true });
      status = 0;
    } catch (error) {
      say(`  npm failed: ${error.message}`);
    }
    const after = installedAt === undefined ? undefined : versionAt(installedAt);
    if (status === 0) {
      say(before !== undefined && after === before ? `  already current (${after})` : `  updated     ${before ?? "?"} -> ${after ?? "?"}`);
      // Verified, not assumed: a directory install can report success while leaving the old files in
      // place, and "updated" that changed nothing is the one outcome worth shouting about.
      const wanted = versionAt(packageRoot);
      if (after !== undefined && wanted !== undefined && after !== wanted) {
        say(`  WARNING: the global copy still says ${after}, not ${wanted}. Try: npm uninstall -g agent-cost-monitor`);
      }
      say("  restart the window for the new code to be drawn:  acm launch --new");
    }
    return status;
  }

  if (command === "pricing") {
    // The offline rate card. `--refresh` fetches it; without that flag this only reads what is
    // already on disk, which is the whole point — the numbers stay available on a machine whose
    // network cannot reach the list, and the document records when it last actually changed.
    const paths = pricingPaths();
    if (flag("refresh")) {
      say("  fetching the model list...");
      try {
        execFileSync(process.execPath, [STATUSLINE, "--refresh"], { stdio: "inherit" });
      } catch (error) {
        say(`  fetch failed: ${error.message}`);
      }
    }
    const record = readPricingRecord(paths.rows);
    if (record === undefined) {
      say("  no record yet - nothing has been fetched successfully");
      say("  run: acm pricing --refresh   (needs the model list host to be reachable)");
    } else {
      say(`  models      ${record.rows.length}`);
      say(`  fetched     ${record.fetchedAt ?? "never"}`);
      say(`  changed     ${record.changedAt ?? "never"}   (only a real change moves this)`);
      say(`  checked     ${record.checkedAt ?? "never"}`);
      say(`  USD -> CNY  ${Number.isFinite(record.usdToCny) ? record.usdToCny.toFixed(4) : "-"}`);
      if (typeof record.lastChange === "string" && record.lastChange !== "") say(`  last change ${record.lastChange}`);
    }
    say(`  record      ${paths.rows}`);
    say(`  document    ${paths.doc}${existsSync(paths.doc) ? "" : "   (not written yet)"}`);
    return 0;
  }

  if (command === "doctor") {
    say(`  node            ${process.version}`);
    say(`  statusline.mjs  ${existsSync(STATUSLINE) ? "present" : "MISSING"} ${STATUSLINE}`);
    say(`  git             ${hasCommand("git") ? "present" : "missing"}`);
    say(`  dsh             ${hasCommand("dsh") ? "present" : "missing"}`);
    const cfg = resolveConfig(homedir());
    say(`  window          ${cfg.width}x${cfg.height} at ${cfg.x},${cfg.y}  backend=${cfg.backend}  onTop=${cfg.alwaysOnTop}  port=${cfg.port}`);
    say(`  tray            ${existsSync(TRAY_SCRIPT) ? "present" : "MISSING"}  ${trayPid() === undefined ? "not running" : `running (pid ${trayPid()})`}  ${TRAY_SCRIPT}`);
    say(`  config file     ${existsSync(CONFIG_FILE) ? CONFIG_FILE : `${CONFIG_FILE} (not written yet; defaults apply)`}`);
    say(`  log file        ${existsSync(LOG_FILE) ? LOG_FILE : `${LOG_FILE} (nothing logged yet)`}`);
    say(pricingCache());
    return 0;
  }

  if (command === "log") {
    const count = Number(option("lines") ?? 40);
    if (!existsSync(LOG_FILE)) {
      say(`nothing logged yet at ${LOG_FILE}`);
      return 0;
    }
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(-count)) say(`  ${line}`);
    return 0;
  }

  say(`${command}${dryRun ? " (dry run)" : ""}`);
  let failures = 0;

  if (wants("claude")) {
    say("\nclaude code");
    if (!hosts.claude.detected) say("  not detected; skipping");
    else failures += command === "install" ? claudeInstall(hosts.claude) : claudeUninstall(hosts.claude);
  }
  if (wants("dsh")) {
    say("\ndsh-tui");
    if (!hosts.dsh.detected) say("  not detected; skipping");
    else failures += command === "install" ? dshInstall() : dshUninstall(hosts.dsh.installed);
  }
  if (command === "install" && hostArg === "auto" && hosts.dsh.detected && !hosts.dsh.installed) {
    say(`\ndsh-tui is present but untouched. Add it with: acm install --host dsh`);
  }

  if (command === "install") {
    // The config is written so there is something to edit, and `/acm` is written so
    // the window is always one command away. There is no auto-launch step any more:
    // wrapping the host commands meant editing two shell profiles to save one command,
    // and the window it opened showed the wrong host's numbers half the time.
    const config = mergeConfig(readConfig(), {});
    say("\nconfig and /acm");
    if (!dryRun && !writeConfig(config)) say(`  could not write ${CONFIG_FILE}`);
    else if (!dryRun) say(`  config    ${CONFIG_FILE}`);
    if (!dryRun) writeClaudeCommand();
    say("  Codex has no custom slash commands, so inside it use: !acm launch");
  }

  if (command === "uninstall") {
    failures += removeEverything({ self: flag("self"), keepCache: flag("keep-cache") });
  }

  say(failures === 0 ? "\ndone." : `\ndone, with ${failures} problem(s).`);
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
