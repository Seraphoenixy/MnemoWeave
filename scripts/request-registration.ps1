#Requires -Version 5.1
<#
.SYNOPSIS
    Raise one elevation request for the local Server task.

.DESCRIPTION
    This script is the action of the "MnemoWeave Server Install" bootstrap task. The bootstrap
    task is created without elevation by the host plugins when the real task is missing; it runs
    in the signed-in user's session, so the UAC prompt below is shown to that user instead of
    being raised from a plugin process. After the user answers, install-local-server-task.ps1
    registers "MnemoWeave Local Server".

    The outcome is written to a result file the caller polls, so "declined" and "failed" stay
    distinct. The script never stores or prints a token: the installer reads them from the user
    environment.

.PARAMETER ServerDir
    Published directory that contains apps/, packages/ and scripts/.

.PARAMETER EnvFile
    Environment file the registered task's launcher will read.

.PARAMETER NodeExe
    Node executable; omit to let the installer resolve node on PATH.

.PARAMETER ResultFile
    Where to write {state, detail, at}. The caller deletes it before starting.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerDir,
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$ResultFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Result {
    param([string]$State, [string]$Detail)
    $payload = @{ state = $State; detail = $Detail; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    $parent = Split-Path -Parent $ResultFile
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Set-Content -LiteralPath $ResultFile -Value $payload -Encoding UTF8
}

function Quote-Path {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

try {
    $installer = Join-Path $ServerDir 'scripts/install-local-server-task.ps1'
    if (-not (Test-Path -LiteralPath $installer)) { throw "installer not found: $installer" }
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw "environment file not found: $EnvFile" }

    # The elevated process has its own window; its output is redirected to a log so a failure
    # can be reported back instead of leaving the caller with a bare exit code.
    $log = Join-Path (Split-Path -Parent $ResultFile) 'registration.log'
    if (Test-Path -LiteralPath $log) { Remove-Item -LiteralPath $log -Force }
    $inner = "& $(Quote-Path $installer) register -ServerDir $(Quote-Path $ServerDir) -EnvFile $(Quote-Path $EnvFile)"
    if (-not [string]::IsNullOrWhiteSpace($NodeExe)) { $inner += " -NodeExe $(Quote-Path $NodeExe)" }
    $inner += " -Force *> $(Quote-Path $log); exit `$LASTEXITCODE"

    try {
        $elevated = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner) `
            -Verb RunAs -Wait -PassThru
    } catch {
        $exception = $_.Exception
        while ($null -ne $exception -and -not ($exception -is [System.ComponentModel.Win32Exception])) { $exception = $exception.InnerException }
        if ($null -ne $exception -and $exception.NativeErrorCode -eq 1223) {
            Write-Result -State 'denied' -Detail 'the elevation prompt was declined'
            exit 1223
        }
        Write-Result -State 'failed' -Detail ("elevation failed: " + $_.Exception.Message)
        exit 1
    }

    if ($elevated.ExitCode -eq 0) {
        Write-Result -State 'ok' -Detail 'task registered'
        exit 0
    }
    $tail = ''
    if (Test-Path -LiteralPath $log) {
        $tail = ((Get-Content -LiteralPath $log -Raw) -replace '\s+', ' ').Trim()
        if ($tail.Length -gt 300) { $tail = $tail.Substring($tail.Length - 300) }
    }
    $detail = "installer exited with " + $elevated.ExitCode
    if (-not [string]::IsNullOrWhiteSpace($tail)) { $detail += ": " + $tail }
    Write-Result -State 'failed' -Detail $detail
    exit 1
} catch {
    Write-Result -State 'failed' -Detail $_.Exception.Message
    exit 1
}
