#Requires -Version 5.1
<#
.SYNOPSIS
    Ask the scheduler to run one elevation request, and report what the user answered.

.DESCRIPTION
    Hosts cannot elevate themselves: the process that wants the Server task registered is a
    plugin inside another application, and a UAC prompt raised there is both surprising and
    fragile. This script creates a one-shot interactive scheduled task ("MnemoWeave Server
    Install") whose action is request-registration.ps1, runs it, and waits for that action's
    result file. The scheduler therefore starts the request in the signed-in user's session and
    the user answers the UAC prompt it raises.

    Creation does not need elevation: the bootstrap task runs at the user's own privilege level
    and only asks for elevation inside request-registration.ps1. Registering a logon-triggered
    highest-privilege task directly would need an administrator window, which is exactly what
    this indirection avoids.

    The bootstrap task is deleted again before this script exits, whatever the outcome.

.PARAMETER ServerDir
    Published directory that contains scripts/request-registration.ps1.

.PARAMETER EnvFile
    Environment file passed through to the installer.

.PARAMETER NodeExe
    Node executable passed through to the installer; omit to resolve node on PATH.

.PARAMETER ResultFile
    Result file written by request-registration.ps1 and read back here.

.PARAMETER TimeoutSeconds
    How long to wait for the user to answer the prompt.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ServerDir,
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$ResultFile,
    [int]$TimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'MnemoWeave Server Install'
$requestor = Join-Path $ServerDir 'scripts/request-registration.ps1'

if (-not (Test-Path -LiteralPath $requestor)) {
    @{ state = 'failed'; detail = "requestor not found: $requestor"; at = (Get-Date).ToUniversalTime().ToString('o') } |
        ConvertTo-Json -Compress
    exit 1
}

$arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ('"' + $requestor + '"'),
    '-ServerDir', ('"' + $ServerDir + '"'),
    '-EnvFile', ('"' + $EnvFile + '"'),
    '-ResultFile', ('"' + $ResultFile + '"')
)
if (-not [string]::IsNullOrWhiteSpace($NodeExe)) { $arguments += @('-NodeExe', ('"' + $NodeExe + '"')) }

if (Test-Path -LiteralPath $ResultFile) { Remove-Item -LiteralPath $ResultFile -Force }

$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')

# A leftover bootstrap task from an interrupted attempt is replaced, not reused.
try { $folder.DeleteTask($taskName, 0) } catch { }

$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'One-time elevation request for the MnemoWeave local Server task. Deleted after use.'
$definition.Triggers.Clear()
$trigger = $definition.Triggers.Create(1)                     # 1 = TASK_TRIGGER_TIME
$trigger.StartBoundary = (Get-Date).AddDays(1).ToString('yyyy-MM-ddTHH:mm:ss')
$definition.Principal.LogonType = 3                           # interactive token: it must run as this signed-in user
$definition.Principal.RunLevel = 0                            # least privilege; elevation happens inside the action
$definition.Settings.MultipleInstances = 0                    # IgnoreNew
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT10M'
$definition.Settings.StartWhenAvailable = $true
$action = $definition.Actions.Create(0)
$action.Path = 'powershell.exe'
$action.Arguments = ($arguments -join ' ')
$action.WorkingDirectory = $ServerDir

try {
    $folder.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3, $null) | Out-Null
    & schtasks /run /tn $taskName | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $state = $null
    $detail = $null
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $ResultFile) {
            try {
                $parsed = Get-Content -LiteralPath $ResultFile -Raw | ConvertFrom-Json
                $state = [string]$parsed.state
                $detail = [string]$parsed.detail
                break
            } catch { }
        }
        Start-Sleep -Milliseconds 500
        try {
            $instance = $folder.GetTask($taskName)
            if ($instance.State -eq 3) { break }                 # 3 = TASK_STATE_READY: it finished
        } catch { }
    }

    if ($null -eq $state) {
        if (Test-Path -LiteralPath $ResultFile) {
            try {
                $parsed = Get-Content -LiteralPath $ResultFile -Raw | ConvertFrom-Json
                $state = [string]$parsed.state
                $detail = [string]$parsed.detail
            } catch { }
        }
    }
    if ($null -eq $state) {
        $state = 'failed'
        $detail = "no answer within $TimeoutSeconds s"
    }

    @{ state = $state; detail = $detail; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    if ($state -eq 'ok') { exit 0 }
    if ($state -eq 'denied') { exit 1223 }
    exit 1
} finally {
    try { $folder.DeleteTask($taskName, 0) } catch { }
}
