# Prints what the Figaf App Manager's CLI calls did, from `cf logs <app> --recent`,
# in a readable form: local time, exit code, command, and what the CLI said.
# Read-only: it only reads logs. Nothing is changed.
#
# Usage (PowerShell 5.1+, cf CLI logged in and targeted at the space):
#   .\manager-log-failures.ps1                    # failed CLI calls + failed actions of figaf-manager
#   .\manager-log-failures.ps1 -All               # every CLI call, ok and failed
#   .\manager-log-failures.ps1 -App my-manager    # another app name
#   .\manager-log-failures.ps1 -LogFile saved.log # read a saved `cf logs --recent` output instead
#
# What it reads: the manager writes one JSON record per CLI call to its log
# (kind "cli.spawn" with the command, kind "cli.exit" with the exit code and
# the last lines of stdout/stderr, paired by "id"), and one plain line
# "[action] <channel> failed ..." per failed console action (manager builds
# from 2026-09-03 on). Router lines and everything else are ignored.
# Setup-token lines are never printed.
#
# Note: `cf logs --recent` holds only the last part of the log. Read it soon
# after the failure. A log drain keeps history.

param(
    [string]$App = 'figaf-manager',
    [switch]$All,
    [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'

if ($LogFile) {
    if (-not (Test-Path $LogFile)) { throw "log file not found: $LogFile" }
    $lines = @(Get-Content -Path $LogFile)
} else {
    $lines = @(& cf logs $App --recent)
    if ($LASTEXITCODE -ne 0) {
        throw "cf logs $App --recent failed (exit $LASTEXITCODE). Is cf logged in and targeted at the right space?"
    }
}

$spawns = @{}
$rows = @()
$actions = @()

foreach ($raw in $lines) {
    $line = [string]$raw
    if ($line -match '\[SETUP\] Token') { continue }
    if ($line -match '\[action\] ') {
        $ts = ''
        if ($line -match '^\s*(\S+)\s') { $ts = $Matches[1] }
        $actions += [pscustomobject]@{ ts = $ts; text = ($line -replace '^.*?\[action\] ', '[action] ') }
        continue
    }
    $idx = $line.IndexOf('{"ts"')
    if ($idx -lt 0) { continue }
    $json = $line.Substring($idx)
    $rec = $null
    try { $rec = $json | ConvertFrom-Json } catch { continue }
    if ($null -eq $rec) { continue }
    if ($rec.kind -eq 'cli.spawn') {
        $spawns[[string]$rec.id] = $rec
    } elseif ($rec.kind -eq 'cli.exit') {
        $sp = $spawns[[string]$rec.id]
        $cmd = ''
        if ($null -ne $sp) {
            $exe = [string]$sp.cmd
            $exe = $exe -replace '^.*[\\/]', ''
            $argText = ''
            if ($null -ne $sp.args) { $argText = (@($sp.args) | ForEach-Object { [string]$_ }) -join ' ' }
            $cmd = ($exe + ' ' + $argText).Trim()
        }
        $rows += [pscustomobject]@{
            ts = [string]$rec.ts
            code = [int]$rec.code
            ms = [int]$rec.durationMs
            cmd = $cmd
            stderr = [string]$rec.stderrTail
            stdout = [string]$rec.stdoutTail
            err = [string]$rec.error
        }
    }
}

function LocalTime([string]$iso) {
    try { return ([datetime]$iso).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss') } catch { return $iso }
}

function LastLines([string]$text, [int]$n) {
    $parts = @($text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne 'FAILED' })
    if ($parts.Count -eq 0) { return @() }
    $start = [Math]::Max(0, $parts.Count - $n)
    return @($parts[$start..($parts.Count - 1)])
}

$failedRows = @($rows | Where-Object { $_.code -ne 0 })
$shown = if ($All) { @($rows) } else { $failedRows }

Write-Host ('CLI calls in the recent log: {0}; failed: {1}; failed console actions: {2}' -f $rows.Count, $failedRows.Count, $actions.Count)
Write-Host ''
foreach ($r in $shown) {
    $mark = 'FAIL'
    if ($r.code -eq 0) { $mark = 'ok  ' }
    Write-Host ('{0}  {1}  exit {2}  {3} ms' -f (LocalTime $r.ts), $mark, $r.code, $r.ms)
    Write-Host ('      $ {0}' -f $r.cmd)
    if ($r.code -ne 0) {
        $said = LastLines $r.stderr 3
        if ($said.Count -eq 0) { $said = LastLines $r.stdout 1 }
        if ($said.Count -eq 0 -and $r.err) { $said = @($r.err) }
        foreach ($s in $said) { Write-Host ('      > {0}' -f $s) }
    }
}
if ($actions.Count -gt 0) {
    Write-Host ''
    Write-Host 'Failed console actions (one line per action):'
    foreach ($a in $actions) { Write-Host ('  {0}  {1}' -f $a.ts, $a.text) }
}
if ((-not $All) -and $shown.Count -eq 0 -and $actions.Count -eq 0) {
    Write-Host 'No failed CLI calls and no failed actions in the recent log.'
    Write-Host 'If the failure is older than the log buffer, it is gone: cf logs --recent keeps only the last part.'
}
