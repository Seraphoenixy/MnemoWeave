#Requires -Version 5.1
<#
.SYNOPSIS
    Launch the local MnemoWeave Server for the scheduled task.

.DESCRIPTION
    Started by "MnemoWeave Local Server". Reads the environment file so the task definition
    itself holds no credentials, then runs the compiled Server in the foreground of this
    process. The task owns the lifetime: when this wrapper exits, the Server is gone.

    The Server binds 127.0.0.1 only. Nothing here supervises it — Task Scheduler does, with
    IgnoreNew for concurrency and a restart policy for crashes.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerDir,
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [Parameter(Mandatory = $true)][string]$NodeExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $EnvFile)) { throw "environment file not found: $EnvFile" }
# Published directory: apps/ directly (scripts/publish-server.mjs), or a checkout that has it
# under dist/. Both layouts are accepted so the wrapper works before and after publishing.
$main = Join-Path $ServerDir 'apps/server/src/main.js'
if (-not (Test-Path -LiteralPath $main)) { $main = Join-Path $ServerDir 'dist/apps/server/src/main.js' }
if (-not (Test-Path -LiteralPath $main)) { throw "compiled Server entry not found under $ServerDir (run tsc and scripts/publish-server.mjs)" }

# .env-style KEY=VALUE, one per line; comments and blank lines ignored. Values are not echoed.
#
# Credentials are NOT stored here. MNEMOWEAVE_TOKEN and MNEMOWEAVE_OPERATOR_TOKEN come from the
# signed-in user's environment (set once with install-local-server-task.ps1), which a logon
# task inherits — verified on this machine. Keeping them out of the file means the token has a
# single source of truth instead of one copy per consumer.
foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $index = $trimmed.IndexOf('=')
    if ($index -lt 1) { continue }
    $key = $trimmed.Substring(0, $index).Trim()
    $value = $trimmed.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:\$key" -Value $value
}

# The task inherits the user environment, but only what the profile had at logon. Fail loudly
# rather than starting a Server that rejects every host because it has no credential.
if (-not $env:MNEMOWEAVE_TOKEN -or $env:MNEMOWEAVE_TOKEN.Length -lt 24) {
    throw 'MNEMOWEAVE_TOKEN is not set in the signed-in user environment; run scripts/install-local-server-task.ps1 register (elevated) to set it'
}

# The Server requires an absolute Mnemon directory; resolving here keeps the env file readable.
if ($env:MNEMON_DATA_DIR -and -not [System.IO.Path]::IsPathRooted($env:MNEMON_DATA_DIR)) {
    $env:MNEMON_DATA_DIR = Join-Path $ServerDir $env:MNEMON_DATA_DIR
}
if ($env:MNEMOWEAVE_STATE_DIR -and -not [System.IO.Path]::IsPathRooted($env:MNEMOWEAVE_STATE_DIR)) {
    $env:MNEMOWEAVE_STATE_DIR = Join-Path $ServerDir $env:MNEMOWEAVE_STATE_DIR
}

Set-Location -LiteralPath $ServerDir
# Foreground, so the task's instance state reflects the Server's real lifetime.
& $NodeExe $main
exit $LASTEXITCODE
