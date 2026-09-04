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
  $current = $Element.Current
  return [ordered]@{
    name = [string]$current.Name
    automationId = [string]$current.AutomationId
    className = [string]$current.ClassName
    controlType = [string]$current.ControlType.ProgrammaticName
    processId = [int]$current.ProcessId
    isKeyboardFocusable = [bool]$current.IsKeyboardFocusable
    hasKeyboardFocus = [bool]$current.HasKeyboardFocus
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

$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) {
  [ordered]@{ ok = $false; error = 'Windows UI Automation did not report a focused element.' } | ConvertTo-Json -Compress -Depth 8
  exit 0
}

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$current = $focused
$depth = 0
$ancestors = @()
$match = $null

while ($null -ne $current -and $depth -lt 10) {
  $description = Describe-Element $current
  $read = Read-ElementText $current
  $ancestors += [ordered]@{
    depth = $depth
    element = $description
    readablePattern = if ($null -ne $read) { $read.pattern } else { $null }
    readableLength = if ($null -ne $read) { ([string]$read.text).Length } else { 0 }
  }

  if ($null -eq $match -and $null -ne $read -and -not [string]::IsNullOrWhiteSpace([string]$read.text)) {
    $match = [ordered]@{
      element = $description
      text = [string]$read.text
      pattern = [string]$read.pattern
      depth = $depth
    }
  }

  $current = $walker.GetParent($current)
  $depth += 1
}

if ($null -ne $match) {
  [ordered]@{
    ok = $true
    text = [string]$match.text
    pattern = [string]$match.pattern
    focused = Describe-Element $focused
    matched = $match.element
    matchedDepth = [int]$match.depth
    ancestors = $ancestors
  } | ConvertTo-Json -Compress -Depth 8
  exit 0
}

[ordered]@{
  ok = $false
  error = 'The focused Codex control did not expose editable text through Windows UI Automation.'
  focused = Describe-Element $focused
  ancestors = $ancestors
} | ConvertTo-Json -Compress -Depth 8
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
    timeout: 5000,
    maxBuffer: 1024 * 1024,
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
  const error = new Error(
    `${result.error || 'No draft text was exposed by the focused control.'} Focused control: ${focused}`,
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
