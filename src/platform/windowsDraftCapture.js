'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function isWslEnvironment({ platform = process.platform, env = process.env, procVersion } = {}) {
  if (platform !== 'linux') {
    return false;
  }
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return true;
  }
  let version = procVersion;
  if (version === undefined) {
    try {
      version = fs.readFileSync('/proc/version', 'utf8');
    } catch {
      version = '';
    }
  }
  return /microsoft|wsl/i.test(version || '');
}

function getPowerShellCommand() {
  if (process.platform === 'win32') {
    return 'powershell.exe';
  }
  if (isWslEnvironment()) {
    const systemPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    return fs.existsSync(systemPowerShell) ? systemPowerShell : 'powershell.exe';
  }
  return null;
}

function buildUiaInspectionScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Describe-Element([System.Windows.Automation.AutomationElement]$Element) {
  if ($null -eq $Element) { return $null }
  try {
    $current = $Element.Current
    $rect = $current.BoundingRectangle
    return [ordered]@{
      name = [string]$current.Name
      automationId = [string]$current.AutomationId
      className = [string]$current.ClassName
      controlType = [string]$current.ControlType.ProgrammaticName
      processId = [int]$current.ProcessId
      isKeyboardFocusable = [bool]$current.IsKeyboardFocusable
      hasKeyboardFocus = [bool]$current.HasKeyboardFocus
      isOffscreen = [bool]$current.IsOffscreen
      bounding = [ordered]@{
        x = [math]::Round([double]$rect.X, 1)
        y = [math]::Round([double]$rect.Y, 1)
        width = [math]::Round([double]$rect.Width, 1)
        height = [math]::Round([double]$rect.Height, 1)
      }
    }
  } catch {
    return [ordered]@{ error = $_.Exception.Message }
  }
}

function Read-ElementText([System.Windows.Automation.AutomationElement]$Element) {
  if ($null -eq $Element) { return $null }

  try {
    $valuePattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $valuePattern) {
      $value = [string]$valuePattern.Current.Value
      if (-not [string]::IsNullOrEmpty($value)) {
        return [ordered]@{ text = $value; pattern = 'ValuePattern' }
      }
    }
  } catch {}

  try {
    $textPattern = $Element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($null -ne $textPattern) {
      $value = [string]$textPattern.DocumentRange.GetText(-1)
      if (-not [string]::IsNullOrEmpty($value)) {
        return [ordered]@{ text = $value; pattern = 'TextPattern' }
      }
    }
  } catch {}

  return $null
}

function Score-Candidate($Description, $Read, [int]$SearchDepth) {
  if ($null -eq $Description -or $null -eq $Read) { return -1000 }
  $score = 0
  $type = [string]$Description.controlType
  $name = [string]$Description.name
  $automationId = [string]$Description.automationId
  $className = [string]$Description.className
  $length = ([string]$Read.text).Length

  if ($type -eq 'ControlType.Edit') { $score += 140 }
  elseif ($type -eq 'ControlType.Document') { $score += 75 }
  elseif ($type -eq 'ControlType.Text') { $score += 20 }

  if ([bool]$Description.hasKeyboardFocus) { $score += 120 }
  if ([bool]$Description.isKeyboardFocusable) { $score += 55 }
  if (-not [bool]$Description.isOffscreen) { $score += 10 } else { $score -= 100 }

  $identity = "$name $automationId $className"
  if ($identity -match '(?i)prompt|message|ask|composer|input|textarea|editor|codex|chat') { $score += 45 }
  if ($identity -match '(?i)history|conversation|transcript|messages-list') { $score -= 70 }

  if ($length -gt 0 -and $length -le 20000) { $score += 15 }
  elseif ($length -gt 50000) { $score -= 80 }

  # Prefer the focused pane itself over progressively broader ancestors.
  $score -= ($SearchDepth * 8)
  return $score
}

function Inspect-Subtree([System.Windows.Automation.AutomationElement]$Root, [int]$SearchDepth) {
  $found = @()
  if ($null -eq $Root) { return $found }

  try {
    $all = $Root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
  } catch {
    return $found
  }

  $count = [math]::Min($all.Count, 600)
  for ($i = 0; $i -lt $count; $i++) {
    try {
      $element = $all.Item($i)
      $read = Read-ElementText $element
      if ($null -eq $read -or [string]::IsNullOrWhiteSpace([string]$read.text)) { continue }
      $description = Describe-Element $element
      $score = Score-Candidate $description $read $SearchDepth
      $found += [ordered]@{
        score = [int]$score
        searchDepth = [int]$SearchDepth
        element = $description
        pattern = [string]$read.pattern
        readableLength = ([string]$read.text).Length
        text = [string]$read.text
      }
    } catch {}
  }
  return $found
}

function Diagnostic-Candidate($Candidate) {
  if ($null -eq $Candidate) { return $null }
  return [ordered]@{
    score = [int]$Candidate.score
    searchDepth = [int]$Candidate.searchDepth
    element = $Candidate.element
    pattern = [string]$Candidate.pattern
    readableLength = [int]$Candidate.readableLength
  }
}

$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) {
  [ordered]@{ ok = $false; error = 'Windows UI Automation did not report a focused element.' } | ConvertTo-Json -Compress -Depth 10
  exit 0
}

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$current = $focused
$ancestors = @()
$candidates = @()
$searchDepth = 0

while ($null -ne $current -and $searchDepth -lt 5) {
  $description = Describe-Element $current
  $directRead = Read-ElementText $current
  $ancestors += [ordered]@{
    depth = [int]$searchDepth
    element = $description
    readablePattern = if ($null -ne $directRead) { [string]$directRead.pattern } else { $null }
    readableLength = if ($null -ne $directRead) { ([string]$directRead.text).Length } else { 0 }
  }

  if ($null -ne $directRead -and -not [string]::IsNullOrWhiteSpace([string]$directRead.text)) {
    $score = Score-Candidate $description $directRead $searchDepth
    $candidates += [ordered]@{
      score = [int]$score
      searchDepth = [int]$searchDepth
      element = $description
      pattern = [string]$directRead.pattern
      readableLength = ([string]$directRead.text).Length
      text = [string]$directRead.text
    }
  }

  # The Codex webview may expose keyboard focus only on its Pane host while the
  # contenteditable composer is a descendant accessibility node.
  $candidates += Inspect-Subtree $current $searchDepth

  if ($candidates.Count -gt 0) { break }
  $current = $walker.GetParent($current)
  $searchDepth += 1
}

$ordered = @($candidates | Sort-Object -Property @{Expression='score'; Descending=$true}, @{Expression='readableLength'; Descending=$false})
$diagnostic = @()
foreach ($candidate in ($ordered | Select-Object -First 20)) {
  $diagnostic += Diagnostic-Candidate $candidate
}

if ($ordered.Count -gt 0) {
  $best = $ordered[0]
  $secondScore = if ($ordered.Count -gt 1) { [int]$ordered[1].score } else { -999 }
  $bestType = [string]$best.element.controlType
  $strong = ([int]$best.score -ge 100) -and (
    $bestType -eq 'ControlType.Edit' -or
    [bool]$best.element.hasKeyboardFocus -or
    [bool]$best.element.isKeyboardFocusable
  )
  $clearLead = ([int]$best.score - $secondScore) -ge 10 -or $ordered.Count -eq 1

  if ($strong -and $clearLead) {
    [ordered]@{
      ok = $true
      text = [string]$best.text
      pattern = [string]$best.pattern
      score = [int]$best.score
      focused = Describe-Element $focused
      matched = $best.element
      candidates = $diagnostic
      ancestors = $ancestors
    } | ConvertTo-Json -Compress -Depth 10
    exit 0
  }
}

[ordered]@{
  ok = $false
  error = if ($ordered.Count -gt 0) {
    'Windows UI Automation found text-bearing controls under the Codex pane, but could not identify the composer with enough confidence.'
  } else {
    'The focused Codex pane did not expose any readable descendant controls through Windows UI Automation.'
  }
  focused = Describe-Element $focused
  candidates = $diagnostic
  ancestors = $ancestors
} | ConvertTo-Json -Compress -Depth 10
`;
}

function parseUiaInspection(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error('Windows UI Automation returned no diagnostic output.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Windows UI Automation returned invalid JSON: ${error.message}`);
  }
  return parsed;
}

function summarizeElement(element) {
  if (!element) return '(unknown control)';
  const parts = [
    element.controlType,
    element.className && `class=${element.className}`,
    element.automationId && `id=${element.automationId}`,
    element.name && `name=${JSON.stringify(element.name)}`,
  ].filter(Boolean);
  return parts.join(' | ') || '(unnamed control)';
}

async function inspectFocusedControl() {
  const powershell = getPowerShellCommand();
  if (!powershell) {
    throw new Error('Automatic Codex draft capture currently requires a Windows VS Code UI (native Windows or WSL Remote).');
  }

  const { stdout, stderr } = await execFileAsync(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    buildUiaInspectionScript(),
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 2 * 1024 * 1024,
  });

  const result = parseUiaInspection(stdout);
  if (stderr && stderr.trim()) {
    result.stderr = stderr.trim();
  }
  return result;
}

async function captureFocusedText() {
  const result = await inspectFocusedControl();
  if (result.ok && typeof result.text === 'string' && result.text.trim()) {
    return result.text;
  }

  const focused = summarizeElement(result.focused);
  const candidateSummary = Array.isArray(result.candidates) && result.candidates.length
    ? ` Found ${result.candidates.length} readable candidate control(s); see Codex Scheduler output for details.`
    : '';
  const error = new Error(
    `${result.error || 'No draft text was exposed by the focused control.'} Focused control: ${focused}.${candidateSummary}`,
  );
  error.captureDiagnostics = result;
  throw error;
}

module.exports = {
  buildUiaInspectionScript,
  captureFocusedText,
  getPowerShellCommand,
  inspectFocusedControl,
  isWslEnvironment,
  parseUiaInspection,
  summarizeElement,
};
