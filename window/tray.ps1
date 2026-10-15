<#
  acm tray — the spend figures in the notification area.

  Started by `acm tray`, or at login by the Startup entry that command writes. Every figure here
  comes from the daemon the window already runs (window/serve.mjs), so this is one more renderer
  over the same engine rather than a second engine: it prices nothing, reads no transcript, and
  writes nothing but its own log.

  The figure it exists for is the last turn that actually FINISHED — `completed` in
  src/figures.mjs, not the turn still running. A total that is still climbing, under a label
  that calls it final, is the one thing this must never show.

  Windows-only by nature: the icon is a Windows shell object. That is why it lives beside the
  window's placement script instead of in the engine.

  One icon per session (a second `acm tray`, or a double-clicked Startup entry, leaves), and it
  exits through its own 退出 item or `acm tray --stop`.

  The icon is shown while there is an agent behind the figure — any host whose transcript or
  rollout has been written recently, or an acm window polling the daemon — and hides itself when
  there is not. A figure that outlives its session is clutter, and the tray is meant to be there
  without being asked for.
#>
[CmdletBinding()]
param(
  [int]$Port = 7420,
  [int]$IntervalMs = 5000,
  # Five minutes of silence from every host, with no acm window open and no turn in flight, and the
  # icon takes itself away. Short enough that stepping away clears it; the turn-in-flight condition
  # is what keeps a single long tool call (a build, a test run) from hiding it mid-work.
  [int]$IdleHideMs = 300000,
  # The node that started this tray, passed in rather than looked up: the login entry and the CLI
  # both already know it, and "node" is not necessarily on PATH in either context.
  [string]$Node = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$inv = [System.Globalization.CultureInfo]::InvariantCulture
$cache = Join-Path $env:USERPROFILE ".cache\agent-cost-monitor"
$logFile = Join-Path $cache "tray.log"
$pidFile = Join-Path $cache "tray.pid"
$iconFile = Join-Path $PSScriptRoot "icon.ico"
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) "window\launch.mjs"

# A named mutex, not a lock file: it is released by the operating system if this process is
# killed, so a crashed tray cannot leave the next one locked out of ever starting again.
$mutex = [System.Threading.Mutex]::new($false, "Local\agent-cost-monitor-tray")
if (-not $mutex.WaitOne(0, $false)) { exit 0 }

function Write-Log([string]$line) {
  try {
    if (-not (Test-Path $cache)) { New-Item -ItemType Directory -Force -Path $cache | Out-Null }
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 262144)) { Set-Content -Path $logFile -Value "" }
    Add-Content -Path $logFile -Value ((Get-Date).ToUniversalTime().ToString("s") + "Z  tray  " + $line)
  } catch { }
}

# ---------------------------------------------------------------- formatting ---

function Money($amount, [string]$symbol) {
  if ($null -eq $amount) { return "-" }
  return $symbol + ([double]$amount).ToString("0.00", $inv)
}

function Clock($ms) {
  if ($null -eq $ms) { return "-" }
  $total = [int][math]::Round(([double]$ms) / 1000)
  if ($total -lt 0) { $total = 0 }
  return ([math]::Floor($total / 60)).ToString($inv) + ":" + ($total % 60).ToString("00", $inv)
}

function Tokens($n) {
  if ($null -eq $n) { return "-" }
  $v = [double]$n
  if ($v -ge 1000000) { return ($v / 1000000).ToString("0.0", $inv) + "M" }
  if ($v -ge 1000) { return ($v / 1000).ToString("0.0", $inv) + "K" }
  return ([int]$v).ToString($inv)
}

function Burn($perHour, [string]$symbol) {
  if ($null -eq $perHour) { return "-" }
  return (Money $perHour $symbol) + "/h"
}

# --------------------------------------------------------------------- data ---

function Get-Data([string]$hostName) {
  # `client=tray` keeps this reader from counting as a window in the daemon's `windowPolledAt`,
  # which is what says whether a window is open.
  $uri = "http://127.0.0.1:$Port/data?client=tray"
  if ($hostName -ne "") { $uri = $uri + "&host=" + $hostName }
  try { return Invoke-RestMethod -Uri $uri -TimeoutSec 4 } catch { return $null }
}

function Get-Health {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 } catch { return $null }
}

# --------------------------------------------------------------- the figure ---

<#
  The icon IS the figure.

  A notification area gives sixteen pixels (measured: SmallIconSize is 16x16 at 100% scaling), so
  the number worth watching — THIS turn's, which moves while the work happens — has to be drawn to
  fill that box, because a glyph four pixels wide is not a figure, it is a smudge. Two things do
  that:

    * at most three glyphs, so each one gets a third of the box instead of a quarter;
    * the text is taken as geometry and scaled into the box, allowed to grow taller than it is
      wide. In sixteen pixels a digit may only be so wide, and the height it is not using is free
      legibility: a condensed figure is read far more easily than a small one.

  It is rendered at the size the shell asks for rather than at some larger size for the shell to
  resample, because resampling is the other half of why small text goes grey.

  White with a dark outline, because the taskbar is dark on one machine and light on the next and
  a white figure on a white bar is an invisible icon. Over the configured warning rate it turns
  amber, which is the same thing the window's dot does.
#>
Add-Type -Namespace AcmTray -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr handle);'

$script:iconHandle = [IntPtr]::Zero

function Icon-Text($amount) {
  if ($null -eq $amount) { return "--" }
  $v = [double]$amount
  if ($v -lt 0) { $v = 0 }
  # Three glyphs at most, whatever the magnitude — a turn can cost 0.53 or 523 and both have to
  # fit the same sixteen pixels. Below one, the leading zero is the glyph that earns its place
  # least: ".53" says the same thing as "0.53" and is a third larger.
  if ($v -ge 1000) { return ([int][math]::Round($v / 1000)).ToString($inv) + "k" }
  if ($v -ge 10) { return ([int][math]::Round($v)).ToString($inv) }
  if ($v -ge 1) { return $v.ToString("0.0", $inv) }
  return $v.ToString(".00", $inv)
}

# Whether this machine's taskbar is a light one.
#
# The light theme makes the taskbar light, where a white figure is invisible — so the colours swap
# instead of one outline trying to serve both. Read on every redraw: a theme change does not
# restart the tray, and a registry read costs nothing next to drawing a bitmap.
function Taskbar-IsLight {
  try {
    $personalize = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name SystemUsesLightTheme -ErrorAction Stop
    return ([int]$personalize.SystemUsesLightTheme -eq 1)
  } catch {
    # Windows 11's taskbar is dark unless the user says otherwise, so that is the safer guess.
    return $false
  }
}

function New-FigureIcon([string]$text, [bool]$alarm, [bool]$lightTaskbar) {
  # What the shell will actually draw, so nothing is resampled on the way into the tray.
  $box = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
  $margin = [single]1
  $strokeWidth = [single]1.2
  # An outline only where the figure is the light one. A light figure needs a dark edge to stand
  # against a bar that may not be uniformly dark, and amber is bright on either theme; a dark figure
  # on a light bar needs nothing, and a white halo around it would eat strokes that are one pixel
  # wide to begin with.
  $outlined = $alarm -or -not $lightTaskbar
  $bitmap = [System.Drawing.Bitmap]::new($box, $box, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  # The glyphs as geometry, so they can be scaled into the box rather than living at whatever size
  # a font size happens to produce. AddString is called at a font size of 100 and everything after
  # this is a ratio, which is what makes the fit exact instead of nearly right.
  $family = [System.Drawing.FontFamily]::new("Segoe UI")
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddString($text, $family, [int][System.Drawing.FontStyle]::Bold, [single]100, [System.Drawing.PointF]::new(0, 0), [System.Drawing.StringFormat]::GenericTypographic)
  $bounds = $path.GetBounds()

  # The pen straddles the glyph outline, so half its width lands OUTSIDE the geometry. Leaving it
  # out of the fit put ink on the last column of the icon (measured: x 1..15 of 0..15), which is
  # what "it spills out of the tray" looks like; the ink box is what has to stay inside.
  $target = [single]($box - 2 * $margin - $(if ($outlined) { $strokeWidth } else { 0 }))
  $scaleX = $target / $bounds.Width
  $scaleY = $target / $bounds.Height
  # A square box and three digits are not the same shape, so both axes cannot be filled without
  # distorting. The short one is grown, but only this far: past this the figure stops looking like
  # a figure.
  $limit = [single]1.7
  if ($scaleY -gt $scaleX * $limit) { $scaleY = $scaleX * $limit }
  if ($scaleX -gt $scaleY * $limit) { $scaleX = $scaleY * $limit }

  # The points are moved one at a time rather than through a Matrix. GDI+ composes matrix
  # operations in the opposite order to the one they are written in — the obvious three calls
  # measured out as an empty icon — and an affine transform written out in full is both shorter to
  # read and impossible to get backwards.
  $offsetX = [single](($box - $bounds.Width * $scaleX) / 2)
  $offsetY = [single](($box - $bounds.Height * $scaleY) / 2)
  $points = $path.PathPoints
  $types = $path.PathTypes
  $placed = [System.Drawing.PointF[]]::new($points.Count)
  for ($i = 0; $i -lt $points.Count; $i++) {
    $placed[$i] = [System.Drawing.PointF]::new(
      [single](($points[$i].X - $bounds.X) * $scaleX + $offsetX),
      [single](($points[$i].Y - $bounds.Y) * $scaleY + $offsetY)
    )
  }
  $shape = [System.Drawing.Drawing2D.GraphicsPath]::new($placed, $types)
  $path.Dispose()

  # A stroked outline rather than six offset copies: it follows the glyphs at any size, and it is
  # what keeps white figures visible when the taskbar is light.
  if ($outlined) {
    $outline = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 0, 0, 0), $strokeWidth)
    $outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($outline, $shape)
    $outline.Dispose()
  }

  $colour = if ($alarm) {
    [System.Drawing.Color]::FromArgb(255, 255, 176, 32)
  } elseif ($lightTaskbar) {
    [System.Drawing.Color]::FromArgb(255, 20, 20, 20)
  } else {
    [System.Drawing.Color]::White
  }
  $brush = [System.Drawing.SolidBrush]::new($colour)
  $g.FillPath($brush, $shape)
  $brush.Dispose()
  $shape.Dispose()
  $family.Dispose()
  $g.Dispose()

  # FromHandle does not take ownership, so the handle is kept and destroyed when the next figure
  # replaces this one. Without that this leaks a GDI icon every five seconds, which is a resource
  # the whole desktop shares.
  $handle = $bitmap.GetHicon()
  $bitmap.Dispose()
  return @{ Icon = [System.Drawing.Icon]::FromHandle($handle); Handle = $handle }
}

function Set-Figure([string]$text, [bool]$alarm) {
  $drawn = New-FigureIcon $text $alarm (Taskbar-IsLight)
  $previous = $icon.Icon
  $previousHandle = $script:iconHandle
  $icon.Icon = $drawn.Icon
  $script:iconHandle = $drawn.Handle
  if ($previousHandle -ne [IntPtr]::Zero) { [void][AcmTray.Native]::DestroyIcon($previousHandle) }
  if ($null -ne $previous) { $previous.Dispose() }
}

# --------------------------------------------------------------------- menu ---

$menu = [System.Windows.Forms.ContextMenuStrip]::new()

function Add-Info([string]$text) {
  $item = [System.Windows.Forms.ToolStripMenuItem]::new($text)
  $item.Enabled = $false
  $menu.Items.Add($item) | Out-Null
}

function Add-Action([string]$text, [scriptblock]$body) {
  $item = [System.Windows.Forms.ToolStripMenuItem]::new($text)
  $item.add_Click($body)
  $menu.Items.Add($item) | Out-Null
}

function Add-Separator {
  $menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new()) | Out-Null
}

function Start-Window {
  try {
    $exe = if ($Node -ne "") { $Node } else { "node" }
    Start-Process -FilePath $exe -ArgumentList @($launcher, "--if-needed") -WindowStyle Hidden
  } catch {
    Write-Log ("could not start the window: " + $_.Exception.Message)
  }
}

# The daemon alone, without the window: the tray reads it for every figure, and at login there is
# usually nothing running yet — `acm launch` would open a window the user did not ask for, and a
# tray with no daemon is a tray showing "no data" until some agent session happens to start one.
function Start-Daemon {
  try {
    $exe = if ($Node -ne "") { $Node } else { "node" }
    $serve = Join-Path (Split-Path -Parent $PSScriptRoot) "window\serve.mjs"
    Start-Process -FilePath $exe -ArgumentList @($serve) -WindowStyle Hidden
    Write-Log "started the daemon, nothing was answering on the port"
  } catch {
    Write-Log ("could not start the daemon: " + $_.Exception.Message)
  }
}

function Stop-Tray {
  Write-Log "stopping (asked from the menu)"
  try { $timer.Stop() } catch { }
  try { $icon.Visible = $false; $icon.Dispose() } catch { }
  try { Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue } catch { }
  [System.Windows.Forms.Application]::ExitThread()
}

# One host's line: what it has spent this session, and what its last finished turn cost.
#
# The label is the host that ASKED, and a host that has nothing to read says so. The daemon
# answers a host-specific request by falling back to whichever host does have data, so labelling
# by the answer would put Codex's numbers under "dsh" on a machine that has no dsh — three lines
# that look like three hosts and are really one or two.
function Host-Line([string]$key, $data) {
  if ($null -eq $data -or $data.state -ne "ok") { return ("{0,-7} -" -f $key) }
  # The route named "claude" answers with the source "claude-code"; everything else answers as
  # itself.
  $expected = if ($key -eq "claude") { "claude-code" } else { $key }
  if ([string]$data.source -ne $expected) { return ("{0,-7} 无数据" -f $key) }
  $symbol = if ($data.symbol) { [string]$data.symbol } else { "¥" }
  $line = ("{0,-7} 会话 {1}" -f $key, (Money $data.sessionCost $symbol))
  if ($null -ne $data.completed) {
    $line = $line + " · 上轮 " + (Money $data.completed.cost $symbol) + " " + (Clock $data.completed.durationMs)
  }
  return $line
}

function Refresh-Tray {
  try {
    $menu.Items.Clear()
    $active = Get-Data ""
    $hosts = @{}
    foreach ($key in @("dsh", "codex", "claude")) { $hosts[$key] = Get-Data $key }

    # Whether the icon should exist at all.
    #
    # The figure is about an agent that is running, so the icon is shown while one is (or was
    # recently) and taken away when none is: a number that outlives its session is clutter in the
    # corner of the screen, and the whole point of putting it in the tray was to have it there
    # without asking for it. An acm window being open also counts, so the two surfaces come and go
    # together — open the window and the icon is there, close it and a quiet machine takes the icon
    # with it.
    #
    # "There" is answered by the hosts' own files (`activityAt`, the mtime of the transcript or
    # rollout the figures came from), not by whether anything was spent: a turn that has ended and
    # a session that is silent look identical in every other field, and zero spend is not absence.
    $health = Get-Health
    $windowTouched = if ($null -ne $health -and $null -ne $health.windowPolledAt) { [double]$health.windowPolledAt } else { 0 }
    $nowMs = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    # A window polls this daemon once a second, so anything inside a few seconds is a window.
    $windowOpen = $windowTouched -gt 0 -and ($nowMs - $windowTouched) -lt 10000
    $activityAt = $null
    $turnInFlight = $false
    foreach ($payload in @($active, $hosts["dsh"], $hosts["codex"], $hosts["claude"])) {
      if ($null -eq $payload) { continue }
      if ($null -ne $payload.activityAt) {
        $at = [double]$payload.activityAt
        if ($null -eq $activityAt -or $at -gt $activityAt) { $activityAt = $at }
      }
      # A turn that is still going counts as being there even when nothing has been written for a
      # while: a ten-minute build writes nothing, and hiding the figure in the middle of the work
      # is the one moment it must not vanish.
      if ($payload.live -eq $true) { $turnInFlight = $true }
    }
    $idleMs = if ($null -eq $activityAt) { [double]::MaxValue } else { $nowMs - $activityAt }
    $show = $windowOpen -or $turnInFlight -or ($idleMs -lt [double]$IdleHideMs)
    # Logged on the first decision as well as on every change, so the log always answers "is the
    # icon there, and why" — a tray that starts shown and never changes otherwise says nothing at
    # all, which is indistinguishable from one whose timer never ran.
    if ($script:lastShow -ne $show) {
      $script:lastShow = $show
      $quiet = if ($null -eq $activityAt) { "nothing has ever run" } else { "quiet for " + [int]($idleMs / 1000) + "s" }
      Write-Log ("icon " + $(if ($show) { "shown" } else { "hidden" }) + ": " + $quiet + ", window " + $(if ($windowOpen) { "open" } else { "closed" }) + ", turn " + $(if ($turnInFlight) { "running" } else { "none" }))
    }
    $icon.Visible = $show

    if ($null -eq $active -or $active.state -ne "ok") {
      $why = if ($null -eq $active) { "守护进程没有响应 (http://127.0.0.1:$Port)" } else { [string]$active.hint }
      Set-Figure "--" $false
      $icon.Text = "acm · 没有数据"
      Add-Info "acm · 没有数据"
      Add-Info $why
      # One attempt per outage, and only when nothing answers at all: a tray started at login has
      # no daemon to read, and retrying every five seconds would spawn one per tick if the port is
      # held by something else.
      if ($null -eq $active -and -not $script:daemonTried) {
        $script:daemonTried = $true
        Start-Daemon
      }
      Add-Separator
      Add-Action "打开窗口  (会顺带把守护进程起起来)" { Start-Window }
      Add-Action "刷新" { Refresh-Tray }
      Add-Action "退出（关掉这个图标）" { Stop-Tray }
      return
    }

    $symbol = if ($active.symbol) { [string]$active.symbol } else { "¥" }
    $source = [string]$active.source
    $models = @($active.models) | Where-Object { $_ -ne $null -and [string]$_ -ne "" }
    $model = if ($models.Count -gt 0) { $models -join ", " } else { "?" }
    $completed = $active.completed
    $burn = $active.liveBurn
    $warn = $active.warnPerHour

    # The number on the icon, and the reason this beats clicking something to see a figure.
    $figure = Icon-Text $active.turnCost
    $over = ($null -ne $warn -and $null -ne $burn -and ([double]$burn) -gt ([double]$warn))
    Set-Figure $figure $over
    # Data is back, so the next outage gets its own attempt.
    $script:daemonTried = $false

    Add-Info ("acm · " + $source + " · " + $model)
    if ($null -eq $completed) {
      Add-Info "上一个完成的 turn：—（本会话还没有已完成的 turn）"
    } else {
      # The two bases are different measurements and the menu says which one it is showing: a
      # host that records its own turn bounds gives the turn's real length, and one that does not
      # gives the span between the first and last billed call, which is shorter.
      $basis = if ($completed.basis -eq "host") { "" } else { "（按调用时间估算，比整轮短）" }
      $tokens = if ($null -eq $completed.tokens) {
        ""
      } else {
        " · in " + (Tokens $completed.tokens.input) + " / out " + (Tokens $completed.tokens.output)
      }
      Add-Info ("上一个完成的 turn：" + (Money $completed.cost $symbol) + " · " + (Clock $completed.durationMs) + $tokens + $basis)
    }
    Add-Info ("本轮（图标上的数字）：" + (Money $active.turnCost $symbol) + $(if ($active.live) { "（进行中）" } else { "（已结束）" }))
    Add-Info ("会话累计：" + (Money $active.sessionCost $symbol))
    Add-Info ("实时燃烧：" + (Burn $burn $symbol) + " · 平均：" + (Burn $active.averageBurn $symbol))

    Add-Separator
    foreach ($key in @("dsh", "codex", "claude")) { Add-Info (Host-Line $key $hosts[$key]) }
    Add-Separator
    # Whether a window is open is answerable, so the item below stops being a mystery: it says
    # what it would find, not merely that it is possible. The hide rule is stated here too, because
    # an icon that vanishes on its own is otherwise indistinguishable from one that crashed.
    Add-Info ("窗口：" + $(if ($windowOpen) { "开着（正在轮询）" } else { "未开" }))
    Add-Info ("图标：本轮进行中，或 " + [int]($IdleHideMs / 60000) + " 分钟内有过写入时显示；窗口开着时始终显示")
    Add-Action "打开窗口  (acm launch)" { Start-Window }
    Add-Action "刷新" { Refresh-Tray }
    Add-Action "退出（关掉这个图标）" { Stop-Tray }

    # The tooltip is capped at 63 characters by the shell and throws past it, so three figures
    # and the host they belong to is the whole budget. The first of the three is the one on the
    # icon, so hovering explains what the number is.
    $tip = "acm" + $(if ($over) { " !超速" } else { "" }) + " · " + $source + " · 本轮 " + (Money $active.turnCost $symbol) +
      " · 上轮 " + $(if ($null -eq $completed) { "-" } else { Money $completed.cost $symbol }) +
      " · 会话 " + (Money $active.sessionCost $symbol)
    if ($tip.Length -gt 60) { $tip = $tip.Substring(0, 60) }
    $icon.Text = $tip
    # Only when it changes, so `acm tray --status`-style inspection of the log answers "what is
    # the icon showing right now" without the log filling with one identical line per tick.
    if ($tip -ne $script:lastTip) {
      $script:lastTip = $tip
      Write-Log ("tooltip: " + $tip)
    }
  } catch {
    # A tick that throws would leave the icon frozen with no way to see why.
    Write-Log ("refresh failed: " + $_.Exception.Message)
    try { $icon.Text = "acm · 出错了（见 tray.log）" } catch { }
  }
}

# --------------------------------------------------------------------- main ---

$icon = [System.Windows.Forms.NotifyIcon]::new()
$icon.Icon = if (Test-Path $iconFile) { [System.Drawing.Icon]::new($iconFile) } else { [System.Drawing.SystemIcons]::Application }
$icon.Text = "acm"
$icon.ContextMenuStrip = $menu

# A left click opens the same menu. NotifyIcon's own menu is right-click only, and the figures are
# the point of the icon — a left click that did nothing would read as a dead tray.
$icon.add_MouseClick({
  param($sender, $event)
  try {
    if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $menu.Show([System.Windows.Forms.Cursor]::Position)
    }
  } catch {
    Write-Log ("could not open the menu: " + $_.Exception.Message)
  }
})

$icon.Visible = $true
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = [math]::Max(1000, $IntervalMs)
$timer.add_Tick({ Refresh-Tray })
$timer.Start()

try {
  if (-not (Test-Path $cache)) { New-Item -ItemType Directory -Force -Path $cache | Out-Null }
  Set-Content -Path $pidFile -Value $PID -Encoding Ascii
  Write-Log ("started: port " + $Port + ", every " + $timer.Interval + "ms, powershell " + $PSVersionTable.PSVersion.ToString())
  Refresh-Tray
  [System.Windows.Forms.Application]::Run()
} finally {
  Write-Log "stopped"
  try { $icon.Visible = $false; $icon.Dispose() } catch { }
  try { Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue } catch { }
  try { $mutex.ReleaseMutex() } catch { }
  try { $mutex.Dispose() } catch { }
}
