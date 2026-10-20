<#
.SYNOPSIS
  Create (or remove) a development worktree outside the repo, with node_modules junctioned to the main checkout,
  then check it with tsc and the capture harness GPU probe.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worktree-setup.ps1 -Id renderer-fix
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worktree-setup.ps1 -Id smoke -Base main
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/worktree-setup.ps1 -Id smoke -Remove -DeleteBranch

.NOTES
  - The worktree goes to <Root>/<Id>; Root defaults to a sibling <main-checkout-name>-wt directory.
  - Defaults are the current HEAD and branch codex/<id in lower case>; -Base and -Branch override them.
  - node_modules is a directory junction to the main checkout's node_modules: never run npm install/ci/update inside.
  - -Remove deletes the junction itself first (without traversing its target), then the worktree.
#>
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [string]$Base = 'HEAD',
  [string]$Branch,
  [string]$Root,
  [switch]$SkipChecks,
  [switch]$Remove,
  [switch]$DeleteBranch
)
$ErrorActionPreference = 'Stop'

function Invoke-Native([string]$What, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid -Id '$Id': use letters, digits, '.', '_' or '-'" }
if (-not $Branch) { $Branch = 'codex/' + $Id.ToLowerInvariant() }

# The main checkout owns node_modules and the shared git directory.
$here = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$commonDir = (git -C $here rev-parse --path-format=absolute --git-common-dir)
if ($LASTEXITCODE -ne 0 -or -not $commonDir) { throw "$here is not inside a git repository" }
$main = Split-Path -Parent $commonDir.Trim()
$modules = Join-Path $main 'node_modules'
if (-not $Root) { $Root = Join-Path (Split-Path -Parent $main) ((Split-Path -Leaf $main) + '-wt') }
$Root = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Root)
$rootPrefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$target = [IO.Path]::GetFullPath((Join-Path $Root $Id))
if (-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Worktree target $target is outside root $Root" }

if ($Remove) {
  if (-not (Test-Path -LiteralPath $target)) { throw "$target does not exist" }
  $link = Join-Path $target 'node_modules'
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($link) }
    else { throw "$link is a real directory, not a junction; refusing to delete it" }
  }
  Invoke-Native 'git worktree remove' { git -C $main worktree remove --force "$target" }
  if ($DeleteBranch) { Invoke-Native 'git branch -D' { git -C $main branch -D $Branch } }
  Write-Host "Removed worktree $target$(if ($DeleteBranch) { " and branch $Branch" })."
  return
}

if (-not (Test-Path -LiteralPath $modules)) { throw "No node_modules in the main checkout $main; run npm ci there first" }
if (Test-Path -LiteralPath $target) { throw "$target already exists" }
New-Item -ItemType Directory -Force -Path $Root | Out-Null

Invoke-Native 'git worktree add' { git -C $main worktree add -b $Branch "$target" $Base }
New-Item -ItemType Junction -Path (Join-Path $target 'node_modules') -Target $modules | Out-Null

# The junction must stay invisible to git (.gitignore lists 'node_modules' without a trailing slash).
$status = (git -C $target status --porcelain) -join "`n"
if ($status -match 'node_modules') { throw "node_modules shows up in git status of $target; check .gitignore" }

if (-not $SkipChecks) {
  Push-Location -LiteralPath $target
  try {
    Invoke-Native 'npx tsc --noEmit' { npx tsc --noEmit }
    Invoke-Native 'capture.ts --gpu' { npx tsx scripts/capture.ts --gpu }
  } finally { Pop-Location }
}
Write-Host "Worktree ready: $target on $Branch (from $Base), node_modules -> $modules"
