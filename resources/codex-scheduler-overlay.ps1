param(
  [Parameter(Mandatory = $true)]
  [string]$EventPath
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexSchedulerNative {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
"@

[CodexSchedulerNative]::SetProcessDPIAware() | Out-Null

function Get-Rect($Element) {
  if ($null -eq $Element) { return $null }
  try {
    $rect = $Element.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return $null }
    return [ordered]@{
      x = [double]$rect.X
      y = [double]$rect.Y
      width = [double]$rect.Width
      height = [double]$rect.Height
      right = [double]$rect.Right
      bottom = [double]$rect.Bottom
      centerX = [double]($rect.X + ($rect.Width / 2))
      centerY = [double]($rect.Y + ($rect.Height / 2))
    }
  } catch {
    return $null
  }
}

function Read-ElementText($Element) {
  if ($null -eq $Element) { return '' }

  try {
    $valuePattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $valuePattern) {
      return [string]$valuePattern.Current.Value
    }
  } catch {}

  try {
    $textPattern = $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $textPattern) {
      return [string]$textPattern.DocumentRange.GetText(-1)
    }
  } catch {}

  return ''
}

function Get-ForegroundVsCodeRoot {
  try {
    $handle = [CodexSchedulerNative]::GetForegroundWindow()
    if ($handle -eq [IntPtr]::Zero) { return $null }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($null -eq $root) { return $null }

    $pidValue = [int]$root.Current.ProcessId
    if ($pidValue -eq $PID) {
      return [ordered]@{ overlay = $true; root = $null }
    }

    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    if ($process.ProcessName -notmatch '^(Code|Code - Insiders)$') { return $null }

    return [ordered]@{ overlay = $false; root = $root }
  } catch {
    return $null
  }
}

function Get-Descendants($Root) {
  try {
    return $Root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
  } catch {
    return $null
  }
}

function Find-ComposerAnchor($Root) {
  if ($null -eq $Root) { return $null }

  $windowRect = Get-Rect $Root
  if ($null -eq $windowRect) { return $null }

  $all = Get-Descendants $Root
  if ($null -eq $all) { return $null }

  $buttons = @()
  $editors = @()
  $count = [math]::Min($all.Count, 3000)

  for ($i = 0; $i -lt $count; $i++) {
    try {
      $element = $all.Item($i)
      $current = $element.Current
      if ([bool]$current.IsOffscreen) { continue }

      $rect = Get-Rect $element
      if ($null -eq $rect) { continue }

      $type = [string]$current.ControlType.ProgrammaticName
      $name = [string]$current.Name
      $automationId = [string]$current.AutomationId
      $className = [string]$current.ClassName
      $identity = "$name $automationId $className"

      if ($type -eq 'ControlType.Button') {
        $score = 0
        if ($identity -match '(?i)send|submit') { $score += 240 }
        elseif ($identity -match '(?i)run|go|arrow') { $score += 40 }

        if ($rect.width -ge 20 -and $rect.width -le 80 -and $rect.height -ge 20 -and $rect.height -le 80) { $score += 35 }
        if ($rect.centerX -ge ($windowRect.x + ($windowRect.width * 0.55))) { $score += 25 }
        if ($rect.centerY -ge ($windowRect.y + ($windowRect.height * 0.55))) { $score += 25 }
        if ($rect.centerX -ge ($windowRect.x + ($windowRect.width * 0.78))) { $score += 20 }
        if ($rect.centerY -ge ($windowRect.y + ($windowRect.height * 0.72))) { $score += 20 }

        $buttons += [ordered]@{
          element = $element
          rect = $rect
          score = [int]$score
          identity = $identity
          name = $name
        }
        continue
      }

      if ($type -eq 'ControlType.Edit' -or $type -eq 'ControlType.Document') {
        if ($rect.width -lt 120 -or $rect.height -lt 24) { continue }

        $text = Read-ElementText $element
        $score = if ($type -eq 'ControlType.Edit') { 100 } else { 55 }
        if ($identity -match '(?i)prompt|message|ask|composer|input|textarea|codex|chat') { $score += 110 }
        elseif ($identity -match '(?i)editor') { $score += 15 }
        if ([bool]$current.IsKeyboardFocusable) { $score += 25 }
        if ([bool]$current.HasKeyboardFocus) { $score += 80 }
        if ($rect.centerY -ge ($windowRect.y + ($windowRect.height * 0.55))) { $score += 25 }
        if ($rect.centerY -ge ($windowRect.y + ($windowRect.height * 0.72))) { $score += 30 }
        if (-not [string]::IsNullOrWhiteSpace($text)) { $score += 40 }

        $editors += [ordered]@{
          element = $element
          rect = $rect
          score = [int]$score
          identity = $identity
          text = $text
        }
      }
    } catch {}
  }

  if ($buttons.Count -eq 0 -or $editors.Count -eq 0) { return $null }

  $bestPair = $null
  $bestPairScore = -99999

  foreach ($button in $buttons) {
    foreach ($editor in $editors) {
      $pairScore = [int]$button.score + [int]$editor.score
      $verticalDelta = [math]::Abs([double]$button.rect.centerY - [double]$editor.rect.centerY)
      $rightDelta = [math]::Abs([double]$button.rect.centerX - [double]$editor.rect.right)

      if ($verticalDelta -le [math]::Max(90, ($editor.rect.height / 2) + 45)) { $pairScore += 90 }
      else { $pairScore -= [math]::Min(180, [int]$verticalDelta) }

      if ($button.rect.centerX -ge ($editor.rect.x + ($editor.rect.width * 0.55)) -and $button.rect.centerX -le ($editor.rect.right + 140)) {
        $pairScore += 110
      }

      if ($rightDelta -le 140) { $pairScore += 70 }
      if ($button.rect.centerY -ge ($editor.rect.y - 35) -and $button.rect.centerY -le ($editor.rect.bottom + 35)) { $pairScore += 60 }

      if ($pairScore -gt $bestPairScore) {
        $bestPairScore = $pairScore
        $bestPair = [ordered]@{
          button = $button
          editor = $editor
          score = [int]$pairScore
        }
      }
    }
  }

  if ($null -eq $bestPair -or $bestPair.score -lt 270) { return $null }
  return $bestPair
}

function Refresh-CachedAnchor($Anchor) {
  if ($null -eq $Anchor) { return $null }
  try {
    if ([bool]$Anchor.button.element.Current.IsOffscreen -or [bool]$Anchor.editor.element.Current.IsOffscreen) {
      return $null
    }
    $buttonRect = Get-Rect $Anchor.button.element
    $editorRect = Get-Rect $Anchor.editor.element
    if ($null -eq $buttonRect -or $null -eq $editorRect) { return $null }

    return [ordered]@{
      button = [ordered]@{
        element = $Anchor.button.element
        rect = $buttonRect
        score = $Anchor.button.score
        identity = $Anchor.button.identity
        name = $Anchor.button.name
      }
      editor = [ordered]@{
        element = $Anchor.editor.element
        rect = $editorRect
        score = $Anchor.editor.score
        identity = $Anchor.editor.identity
        text = $Anchor.editor.text
      }
      score = $Anchor.score
    }
  } catch {
    return $null
  }
}

function Get-ThreadTitleCandidates($Root, $Anchor) {
  if ($null -eq $Root -or $null -eq $Anchor) { return @() }
  $windowRect = Get-Rect $Root
  $all = Get-Descendants $Root
  if ($null -eq $windowRect -or $null -eq $all) { return @() }

  $editorTop = [double]$Anchor.editor.rect.y
  $headerBandBottom = [math]::Min(
    $editorTop - 40,
    $windowRect.y + [math]::Max(180, ($windowRect.height * 0.30))
  )
  $candidates = @()
  $count = [math]::Min($all.Count, 3000)

  for ($i = 0; $i -lt $count; $i++) {
    try {
      $element = $all.Item($i)
      $current = $element.Current
      if ([bool]$current.IsOffscreen) { continue }
      $name = ([string]$current.Name).Trim()
      if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -lt 3 -or $name.Length -gt 160) { continue }
      if ($name -match '^(?i:Chat|Codex|Claude Code|Work locally|Full access|Send|Submit|Schedule Codex prompt)$') { continue }
      if ($name -match '^(?i:GPT-|GPT |Model |Screen Reader|WSL:)') { continue }

      $type = [string]$current.ControlType.ProgrammaticName
      if ($type -notin @('ControlType.Text', 'ControlType.Button', 'ControlType.Hyperlink', 'ControlType.TabItem')) { continue }
      $rect = Get-Rect $element
      if ($null -eq $rect) { continue }
      if ($rect.y -lt ($windowRect.y + 18) -or $rect.y -gt $headerBandBottom) { continue }
      if ($rect.width -lt 20 -or $rect.width -gt 760) { continue }

      $score = 0
      if ($type -eq 'ControlType.Text') { $score += 40 }
      if ($rect.y -le ($windowRect.y + 170)) { $score += 80 }
      elseif ($rect.y -le ($windowRect.y + 250)) { $score += 35 }
      if ([math]::Abs($rect.x - $Anchor.editor.rect.x) -le 140) { $score += 65 }
      if ($rect.x -ge ($windowRect.x + 10) -and $rect.x -le ($windowRect.x + ($windowRect.width * 0.55))) { $score += 30 }
      if ($name -match '\s') { $score += 15 }

      $candidates += [pscustomobject]@{
        name = $name
        score = [int]$score
      }
    } catch {}
  }

  return @(
    $candidates |
      Sort-Object score -Descending |
      ForEach-Object { $_.name } |
      Select-Object -Unique |
      Select-Object -First 12
  )
}

function Write-OverlayEvent([string]$Action) {
  try {
    $foreground = Get-ForegroundVsCodeRoot
    $root = $null
    if ($null -ne $foreground -and -not [bool]$foreground.overlay) {
      $root = $foreground.root
    } elseif ($null -ne $script:lastVsCodeRoot) {
      $root = $script:lastVsCodeRoot
    }

    $anchor = Find-ComposerAnchor $root
    if ($null -eq $anchor) {
      [System.Windows.Forms.MessageBox]::Show(
        'Codex Scheduler could not locate the visible Codex composer. Click inside the Codex prompt box and try again.',
        'Codex Scheduler',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      ) | Out-Null
      return
    }

    $prompt = Read-ElementText $anchor.editor.element
    $threadTitleCandidates = @(Get-ThreadTitleCandidates $root $anchor)
    $payload = [ordered]@{
      action = $Action
      prompt = [string]$prompt
      threadTitleCandidates = $threadTitleCandidates
      capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      anchorScore = [int]$anchor.score
      sendName = [string]$anchor.button.name
      editorIdentity = [string]$anchor.editor.identity
    }

    $json = $payload | ConvertTo-Json -Compress -Depth 6
    [System.IO.File]::AppendAllText($EventPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  } catch {
    [System.Windows.Forms.MessageBox]::Show(
      "Codex Scheduler overlay error: $($_.Exception.Message)",
      'Codex Scheduler',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  }
}

$script:lastVsCodeRoot = $null
$script:lastRootHandle = 0
$script:lastAnchor = $null
$script:scanCounter = 0

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.ClientSize = New-Object System.Drawing.Size(28, 28)
$form.MinimumSize = New-Object System.Drawing.Size(1, 1)
$form.MaximumSize = New-Object System.Drawing.Size(64, 64)
$form.Padding = New-Object System.Windows.Forms.Padding(0)
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
$form.Opacity = 1.0
$form.Visible = $false

$button = New-Object System.Windows.Forms.Button
$button.AutoSize = $false
$button.Location = New-Object System.Drawing.Point(0, 0)
$button.Size = New-Object System.Drawing.Size(28, 28)
$button.Text = [char]0x25F7
$button.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$button.Font = New-Object System.Drawing.Font('Segoe UI Symbol', 9, [System.Drawing.FontStyle]::Regular)
$button.ForeColor = [System.Drawing.Color]::White
$button.BackColor = [System.Drawing.Color]::FromArgb(54, 54, 60)
$button.UseVisualStyleBackColor = $false
$button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$button.FlatAppearance.BorderSize = 1
$button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(150, 150, 158)
$button.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(72, 72, 80)
$button.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(84, 84, 92)
$button.Cursor = [System.Windows.Forms.Cursors]::Hand
$button.TabStop = $false
$button.Margin = New-Object System.Windows.Forms.Padding(0)
$form.Controls.Add($button)

$buttonPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$buttonPath.AddEllipse(0, 0, 27, 27)
$button.Region = New-Object System.Drawing.Region($buttonPath)
$form.Region = New-Object System.Drawing.Region($buttonPath)

$tooltip = New-Object System.Windows.Forms.ToolTip
$tooltip.SetToolTip($button, 'Schedule Codex prompt')

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false
$menu.BackColor = [System.Drawing.Color]::FromArgb(37, 37, 38)
$menu.ForeColor = [System.Drawing.Color]::Gainsboro

$resetItem = New-Object System.Windows.Forms.ToolStripMenuItem
$resetItem.Text = 'Send when quota resets'
$timeItem = New-Object System.Windows.Forms.ToolStripMenuItem
$timeItem.Text = 'Send at specific time...'
$menu.Items.Add($resetItem) | Out-Null
$menu.Items.Add($timeItem) | Out-Null

$button.Add_MouseDown({
  param($sender, $eventArgs)
  if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $menu.Show([System.Windows.Forms.Cursor]::Position)
  }
})
$resetItem.Add_Click({ Write-OverlayEvent 'usageReset' })
$timeItem.Add_Click({ Write-OverlayEvent 'atTime' })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 90
$timer.Add_Tick({
  $foreground = Get-ForegroundVsCodeRoot
  if ($null -eq $foreground) {
    # Intentional: this helper is TopMost, so hide it whenever VS Code is not the
    # foreground application rather than leaving a floating clock over other apps.
    $form.Hide()
    return
  }

  if ([bool]$foreground.overlay) {
    return
  }

  $root = $foreground.root
  $rootHandle = 0
  try { $rootHandle = [int]$root.Current.NativeWindowHandle } catch {}
  if ($script:lastRootHandle -ne 0 -and $rootHandle -ne 0 -and $rootHandle -ne $script:lastRootHandle) {
    $script:lastAnchor = $null
    $script:scanCounter = 99
  }

  $script:lastVsCodeRoot = $root
  $script:lastRootHandle = $rootHandle
  $script:scanCounter += 1

  # During resize/fullscreen transitions, reuse the live UI Automation elements and
  # read only their current bounding rectangles. A full descendant scan is much more
  # expensive and was the source of the visible 300ms 'jump then settle' behavior.
  $anchor = Refresh-CachedAnchor $script:lastAnchor
  if ($null -eq $anchor -or $script:scanCounter -ge 7) {
    $rescanned = Find-ComposerAnchor $root
    $script:scanCounter = 0
    if ($null -ne $rescanned) {
      $anchor = $rescanned
    }
  }

  if ($null -eq $anchor) {
    $form.Hide()
    $script:lastAnchor = $null
    return
  }

  $script:lastAnchor = $anchor
  $send = $anchor.button.rect
  $targetSize = [int][math]::Round([math]::Max(24, [math]::Min(30, $send.height - 1)))
  if ($targetSize -ne $form.ClientSize.Width -or $targetSize -ne $form.ClientSize.Height) {
    $form.ClientSize = New-Object System.Drawing.Size($targetSize, $targetSize)
    $button.Location = New-Object System.Drawing.Point(0, 0)
    $button.Size = New-Object System.Drawing.Size($targetSize, $targetSize)
    $diameter = [math]::Max(1, $targetSize - 1)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $diameter, $diameter)
    $button.Region = New-Object System.Drawing.Region($path)
    $form.Region = New-Object System.Drawing.Region($path)
  }

  $gap = 7
  $x = [int][math]::Round($send.centerX - ($form.ClientSize.Width / 2))
  $y = [int][math]::Round($send.y - $form.ClientSize.Height - $gap)
  $target = New-Object System.Drawing.Point($x, $y)
  if ($form.Location.X -ne $target.X -or $form.Location.Y -ne $target.Y) {
    $form.Location = $target
  }

  if (-not $form.Visible) {
    $form.Show()
  }
})

$timer.Start()
[System.Windows.Forms.Application]::Run($form)
