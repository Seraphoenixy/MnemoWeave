#Requires -Version 5.1
<#
.SYNOPSIS
    Register, inspect or remove the "MnemoWeave Local Server" scheduled task.

.DESCRIPTION
    The local Server is hosted by a logon-triggered scheduled task, not by any host plugin.
    Registration is an install step; the plugins only detect the port, wake this task by name,
    and then connect directly.

    The task is registered with IgnoreNew, so three hosts waking it at the same moment produce
    one Server: Task Scheduler refuses the extra instances and every caller waits on the same
    address. The task binds to the user session, so signing out stops the Server — that is the
    recorded trade-off, not an oversight.

    The Server's configuration is NOT stored in the task: the launch wrapper reads
    MNEMOWEAVE_* and MNEMON_* from the environment file you point it at, so the task definition
    holds no token.

.PARAMETER Action
    register  (default) create or replace the task
    query     show whether it exists and its current state
    run       start it now (what a host plugin does when the port is refused)
    remove    delete the task

.PARAMETER Name
    Task name. Hosts wake this exact name, so only change it together with the plugin setting.

.PARAMETER ServerDir
    Repository checkout that contains dist/apps/server/src/main.js.

.PARAMETER EnvFile
    .env-style file holding MNEMOWEAVE_TOKEN, MNEMON_BINARY, MNEMON_DATA_DIR, MNEMON_STORE and
    MNEMOWEAVE_STATE_DIR. Defaults to <ServerDir>\.env.local-server.

.PARAMETER NodeExe
    Node executable. Defaults to the node on PATH.

.PARAMETER Force
    Replace an existing registration without prompting.

.EXAMPLE
    .\scripts\install-local-server-task.ps1 -ServerDir D:\projects\MnemoWeave -WhatIf

.EXAMPLE
    .\scripts\install-local-server-task.ps1 register -ServerDir D:\projects\MnemoWeave -EnvFile D:\secrets\mnemoweave.env
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('register', 'query', 'run', 'remove')]
    [string]$Action = 'register',

    [string]$Name = 'MnemoWeave Local Server',

    [string]$ServerDir,

    [string]$EnvFile,

    [string]$NodeExe,

    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ServerDir) { $ServerDir = Split-Path -Parent $PSScriptRoot }
if (-not $EnvFile) { $EnvFile = Join-Path $ServerDir '.env.local-server' }
if (-not $NodeExe) {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) { throw 'node was not found on PATH; pass -NodeExe' }
    $NodeExe = $command.Source
}

# 48 hex characters: above the 24-character floor every consumer enforces.
function New-RandomToken {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-Task {
    param([string]$TaskName)
    # schtasks writes "the system cannot find the file specified" to stderr and exits non-zero
    # when the task is absent. That is an answer, not a failure — but under
    # $ErrorActionPreference='Stop', redirecting a native command's stderr with 2>&1 turns it
    # into a terminating error. Capture stdout only and read the exit code instead.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & schtasks /query /tn $TaskName /fo LIST /v 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return ($output | Out-String)
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Show-State {
    param([string]$TaskName)
    $state = Get-Task -TaskName $TaskName
    if ($null -eq $state) {
        Write-Host "task '$TaskName' is not registered"
        return $false
    }
    Write-Host "task '$TaskName' is registered:"
    # Field names are localised by Windows, so match the labels in both languages and the
    # values that matter; an unmatched label is skipped rather than shown as noise.
    $wanted = '^(TaskName|Status|Task To Run|Scheduled Task State|Multiple Instances|Logon Mode|Run As User|Schedule Type|Last Run Time|Last Result|'
    $wanted += '任务名|模式|登录状态|要运行的任务|计划任务状态|作为用户运行|上次运行时间|上次结果)\s*:'
    foreach ($line in ($state -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '') { continue }
        if ($trimmed -match $wanted) { Write-Host "  $trimmed" }
    }
    return $true
}

switch ($Action) {
    'query' {
        $present = Show-State -TaskName $Name
        exit ([int](-not $present))
    }

    'run' {
        if (-not (Show-State -TaskName $Name)) { exit 1 }
        & schtasks /run /tn $Name
        # A successful trigger only means the request was accepted; the caller still has to
        # probe /health/live before treating the Server as connected.
        exit $LASTEXITCODE
    }

    'remove' {
        if (-not (Show-State -TaskName $Name)) { exit 0 }
        if (-not $PSCmdlet.ShouldProcess($Name, 'delete scheduled task')) { exit 0 }
        & schtasks /delete /tn $Name /f
        exit $LASTEXITCODE
    }

    'register' {
        $main = Join-Path $ServerDir 'dist/apps/server/src/main.js'
        if (-not (Test-Path -LiteralPath $main)) {
            throw "compiled Server entry not found: $main (run node node_modules/typescript/bin/tsc first)"
        }
        if (-not (Test-Path -LiteralPath $EnvFile)) {
            throw "environment file not found: $EnvFile (see scripts/local-server.env.example)"
        }

        # The service and operator tokens live in the signed-in user's environment: that is the
        # single place every consumer reads them from (Server, launcher, all three host plugins).
        # A logon task inherits this environment, so the env file holds no credential and the
        # profile patch holds no copy. Missing values are generated once, never duplicated.
        $userToken = [Environment]::GetEnvironmentVariable('MNEMOWEAVE_TOKEN', 'User')
        $userOperator = [Environment]::GetEnvironmentVariable('MNEMOWEAVE_OPERATOR_TOKEN', 'User')
        if (-not $userToken -or $userToken.Length -lt 24) {
            $userToken = New-RandomToken
            [Environment]::SetEnvironmentVariable('MNEMOWEAVE_TOKEN', $userToken, 'User')
            Write-Host 'generated MNEMOWEAVE_TOKEN in the user environment'
        }
        if (-not $userOperator -or $userOperator.Length -lt 24) {
            $userOperator = New-RandomToken
            [Environment]::SetEnvironmentVariable('MNEMOWEAVE_OPERATOR_TOKEN', $userOperator, 'User')
            Write-Host 'generated MNEMOWEAVE_OPERATOR_TOKEN in the user environment'
        }
        if ($userOperator -eq $userToken) {
            throw 'MNEMOWEAVE_OPERATOR_TOKEN must differ from MNEMOWEAVE_TOKEN'
        }
        if (-not [Environment]::GetEnvironmentVariable('MNEMOWEAVE_HOST_ID', 'User')) {
            # Each host overrides this in its own plugin config; the Server only needs a default.
            [Environment]::SetEnvironmentVariable('MNEMOWEAVE_HOST_ID', 'local-server', 'User')
        }
        # The running process needs them too: the task is only inherited at logon.
        $env:MNEMOWEAVE_TOKEN = $userToken
        $env:MNEMOWEAVE_OPERATOR_TOKEN = $userOperator

        if ((Get-Task -TaskName $Name) -and -not $Force) {
            throw "task '$Name' already exists; pass -Force to replace it"
        }

        # The launcher loads the environment file before node starts, so the task definition
        # holds no token — only the path to the file that holds it.
        $launcher = Join-Path $ServerDir 'scripts/run-local-server.ps1'
        if (-not (Test-Path -LiteralPath $launcher)) { throw "launcher not found: $launcher" }

        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw "registering a scheduled task requires an elevated PowerShell window (current user: $($identity.Name))"
        }

        if (-not $PSCmdlet.ShouldProcess($Name, "register scheduled task running $launcher")) { exit 0 }

        # Built through the Task Scheduler COM API rather than `schtasks /tr`. The action already
        # contains quoted paths, and forwarding that through schtasks needs three levels of quote
        # escaping, which fails with "invalid argument" on paths containing spaces. Here the
        # command line is a property, so no shell re-parses it.
        $execute = 'powershell.exe'
        $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -ServerDir `"$ServerDir`" -EnvFile `"$EnvFile`" -NodeExe `"$NodeExe`""

        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $folder = $service.GetFolder('\')

        $definition = $service.NewTask(0)
        $definition.RegistrationInfo.Description = 'MnemoWeave local Server (HTTP 127.0.0.1). Woken by host plugins when the port is refused.'
        # Logon-triggered and bound to the user session: signing out stops the Server (recorded trade-off).
        $definition.Triggers.Clear()
        $logonTrigger = $definition.Triggers.Create(9)   # 9 = TASK_TRIGGER_LOGON
        $logonTrigger.Enabled = $true
        $definition.Principal.LogonType = 3               # 3 = TASK_LOGON_INTERACTIVE_TOKEN
        $definition.Principal.RunLevel = 0                # 0 = least privilege
        # IgnoreNew is the concurrency guarantee: three hosts waking at once produce one Server.
        $definition.Settings.MultipleInstances = 0        # 0 = IgnoreNew
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $definition.Settings.ExecutionTimeLimit = 'PT0S'  # no limit: a resident Server
        $definition.Settings.RestartCount = 3
        $definition.Settings.RestartInterval = 'PT1M'
        $definition.Settings.StartWhenAvailable = $true

        # NB: not `$action` — PowerShell variable names are case-insensitive, so it would
        # collide with this script's own `-Action` parameter.
        $execAction = $definition.Actions.Create(0)       # 0 = TASK_ACTION_EXEC
        $execAction.Path = $execute
        $execAction.Arguments = $arguments
        $execAction.WorkingDirectory = $ServerDir

        # 6 = TASK_CREATE_OR_UPDATE, logon type 3, no explicit credentials.
        $folder.RegisterTaskDefinition($Name, $definition, 6, $null, $null, 3, $null) | Out-Null

        Write-Output "registered '$Name'"
        Show-State -TaskName $Name | Out-Null
        exit 0
    }
}
