[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Target,
  [ValidateSet('global', 'workspace', 'custom', 'workspaces')]
  [string]$StorageScope,
  [string]$StorageDir,
  [string]$Workspace,
  [string]$DataDir,
  [string]$SyncUrl,
  [string]$SyncPassword,
  [switch]$NoBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repoRoot
try {
  $cliArgs = @('scripts/install-antigravity.mjs')
  if ($NoBuild) {
    $cliArgs += '--no-build'
  } else {
    $cliArgs += '--build'
  }
  if ($Target) { $cliArgs += @('--target', $Target) }
  if ($StorageScope) { $cliArgs += @('--storage-scope', $StorageScope) }
  if ($StorageDir) { $cliArgs += @('--storage-dir', $StorageDir) }
  if ($Workspace) { $cliArgs += @('--workspace', $Workspace) }
  if ($DataDir) { $cliArgs += @('--data-dir', $DataDir) }
  if ($SyncUrl) { $cliArgs += @('--sync-url', $SyncUrl) }
  if ($SyncPassword) { $cliArgs += @('--sync-password', $SyncPassword) }
  if ($DryRun) { $cliArgs += '--dry-run' }

  & node @cliArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
