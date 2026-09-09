<#
    Build DailyAttendanceLogsDetails.csv straight from eTimeTrackLite's database,
    so the daily export-and-copy step is not needed.

    Two sources, and the choice between them is the whole point of this script:

      * AttendanceLogs is eSSL's own processed row for a day. Its Duration
        accounts for breaks and duplicate punches in ways this script does not
        try to reproduce, and the dashboard reads that figure as time worked, so
        where eSSL has a row it is taken verbatim.

      * DeviceLogs holds the raw punches, current the moment a download
        finishes. eSSL only fills AttendanceLogs when it processes a day, so
        today has no row there at all - and a day processed early (7 September
        was processed at 10:38 in the morning) has a row that stopped when it
        was written, with in-times and no out-times.

    So: eSSL's row wins wherever it has one it finished - meaning it has an
    out-time - and is taken verbatim, duration included. A day it never closed,
    or never processed at all, is rebuilt from the punches, with the duration
    summed over each in-to-out pair. Both counts are reported when the script
    runs, so how much of the file is rebuilt is never a guess.

    Days with no punches at all are left out of the file entirely rather than
    written as absences, so importing this can add and correct but never
    overwrite a good record with a guess.

    Read-only throughout: the live .mdb is copied and the copy is queried, so
    eTimeTrackLite is never touched while it is running.
#>
[CmdletBinding()]
param(
    [string] $Mdb     = 'C:\Program Files (x86)\essl\eTimeTrackLite\eTimeTrackLite1.mdb',
    [string] $OutFile = 'E:\Drive H- Desktop\ZAFAR LISTING\AI Projects\Attendance backup\1_Daily Attendace file\DailyAttendanceLogsDetails.csv',
    <#  Where the data lives. The scripts are tracked in the repository; the
        punch files, the logs and the folder the dashboard watches are not, and
        must not be - they carry employee names and times. Keeping the two apart
        means the repo can be checked out anywhere without dragging attendance
        data along, and a log written by a scheduled run never lands in a commit. #>
    [string] $DataDir = 'E:\Drive H- Desktop\ZAFAR LISTING\AI Projects\Attendance backup',
    [int]    $Days    = 30,
    [switch] $NoDeviceRead,          # skip the readers, use the database alone
    [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$from = (Get-Date).Date.AddDays(-$Days)
$to   = (Get-Date).Date

$work = Join-Path $env:TEMP ('ett_build_{0}.mdb' -f $PID)
Copy-Item -LiteralPath $Mdb -Destination $work -Force
$cs = "Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=$work;ReadOnly=1;"

function Get-Rows([string] $sql) {
    $a = New-Object System.Data.Odbc.OdbcDataAdapter($sql, $cs)
    $t = New-Object System.Data.DataTable
    [void] $a.Fill($t)
    , $t
}

try {
    # Punches live in a table per month, so ask only for the months in range.
    $punches = @()
    $cursor  = Get-Date -Year $from.Year -Month $from.Month -Day 1
    while ($cursor -le $to) {
        $table = 'DeviceLogs_{0}_{1}' -f $cursor.Month, $cursor.Year
        try   { $punches += (Get-Rows "SELECT UserId, LogDate, Direction, DeviceId FROM $table") }
        catch { Write-Verbose "no table $table" }
        $cursor = $cursor.AddMonths(1)
    }

    $employees = Get-Rows 'SELECT EmployeeId, EmployeeCode, EmployeeName, EmployeeCodeInDevice FROM Employees'
    $shifts    = Get-Rows 'SELECT ShiftId, ShiftSName, BeginTime, EndTime FROM Shifts'
    # IpAddress matters: punches read straight off a reader arrive labelled by
    # its address, and that is the only way to tell which reader they came from.
    $devices   = Get-Rows 'SELECT DeviceId, DeviceFName, IpAddress FROM Devices'
    $processed = Get-Rows ('SELECT EmployeeId, AttendanceDate, InTime, OutTime, Duration, LateBy, EarlyBy, ' +
                           'Status, PunchRecords, OverTime, ShiftId FROM AttendanceLogs ' +
                           "WHERE AttendanceDate >= #$($from.ToString('MM/dd/yyyy'))#")

    <#  When the devices were last heard from. Logged on every run so the
        question "is anything still pressing Start Download by hand?" answers
        itself: if this time keeps advancing through the day, the punches are
        arriving on their own. #>
    $devs = Get-Rows "SELECT DeviceFName, LastLogDownloadDate FROM Devices WHERE IpAddress <> ''"
    $lastPull = ($devs | ForEach-Object { $_.LastLogDownloadDate -as [datetime] } |
                 Where-Object { $_ -and $_.Year -gt 1900 } | Sort-Object | Select-Object -Last 1)
} finally {
    if (Test-Path -LiteralPath $work) { [System.IO.File]::Delete($work) }
}

# ---------------------------------------------------------------- lookups ----
$byDeviceCode = @{}
foreach ($e in $employees) {
    $code = ('' + $e.EmployeeCodeInDevice).Trim()
    if ($code) { $byDeviceCode[$code] = $e }
}
$empById = @{}
foreach ($e in $employees) { $empById['' + $e.EmployeeId] = $e }

$deviceName = @{}
foreach ($d in $devices) { $deviceName['' + $d.DeviceId] = ('' + $d.DeviceFName).Trim() }

$shiftById = @{}
foreach ($s in $shifts) { $shiftById['' + $s.ShiftId] = $s }

$shiftOf = @{}
foreach ($r in ($processed | Sort-Object AttendanceDate)) { $shiftOf['' + $r.EmployeeId] = '' + $r.ShiftId }

# eSSL prints the shift span in the Category column as 8:30-5:30
function Format-ShiftSpan($begin, $end) {
    function Short($hhmm) {
        if (-not $hhmm) { return '' }
        $p = ('' + $hhmm).Split(':')
        if ($p.Count -lt 2) { return '' + $hhmm }
        $h = [int] $p[0]; $h12 = $h % 12; if ($h12 -eq 0) { $h12 = 12 }
        '{0}:{1}' -f $h12, $p[1]
    }
    $b = Short $begin; $e = Short $end
    if ($b -and $e -and "$b$e" -ne '12:0012:00') { "$b-$e" } else { '' }
}
# [int] in PowerShell rounds rather than truncates, so [int](475/60) is 8 and
# 7:55 prints as 8:55. Every hour has to be floored, not rounded.
function HM([int] $minutes) { '{0}:{1:d2}' -f [math]::Floor($minutes / 60), ($minutes % 60) }
function Clock($value) {
    $t = $value -as [datetime]
    # A day with no punch is stored as a zero date, not as an empty field; left
    # alone it formats as 0:00 and reads as somebody clocking in at midnight.
    if ($t -and $t.Year -gt 1900) { '{0}:{1:d2}' -f $t.Hour, $t.Minute } else { '' }
}
function Count-Punches($record) {
    if (-not $record) { return 0 }
    ([regex]::Matches(('' + $record), ':(in|out)\(')).Count
}

<#  Time inside, summed over each in-to-out pair.

    Only for days eSSL has no figure for. Where it has one, that is used as it
    stands - it is exactly what the exported file carries, checked row by row
    against a day already imported.

    These are IN and OUT readers and people step out during the day, so the span
    from first punch to last overstates the time worked by however long they
    were gone. Pairing gets the time inside. An in with no out after it is a day
    still running and adds nothing yet. #>
function Sum-Paired($stamps) {
    $total = 0.0
    $openAt = $null
    foreach ($p in $stamps) {
        if ($p.Direction -eq 'in') { if (-not $openAt) { $openAt = $p.At } }
        elseif ($openAt) { $total += ($p.At - $openAt).TotalMinutes; $openAt = $null }
    }
    [int] [math]::Round($total)
}

# eSSL's own punch string, back into stamps: 09:40:in(IN),15:23:out(OUT),
function Read-PunchRecord($record, [datetime] $day) {
    $out = @()
    foreach ($m in [regex]::Matches(('' + $record), '(\d{1,2}):(\d{2}):(in|out)\(')) {
        $out += [pscustomobject]@{
            At        = $day.Date.AddHours([int] $m.Groups[1].Value).AddMinutes([int] $m.Groups[2].Value)
            Direction = $m.Groups[3].Value
        }
    }
    , @($out | Sort-Object At)
}

<#  Ask the readers themselves for anything the database has not been told
    about yet. The database only learns of a punch when something downloads it,
    and nothing was doing that on a schedule, so a day could sit half-recorded
    for hours. The devices always have it.

    A separate 32-bit process, because the reader SDK is 32-bit COM and the
    Access driver is 64-bit; they cannot share one. Failure here is not fatal -
    the database is still a perfectly good source, just an older one - so a
    reader that is off or unreachable costs freshness, not the whole run. #>
$devicePunches = @()
if (-not $NoDeviceRead) {
    $puller = Join-Path (Split-Path -Parent $PSCommandPath) 'Pull-DeviceLogs.ps1'   # code, beside this
    $dump   = Join-Path $DataDir 'device-punches.csv'                                # data, kept out of the repo
    $ps32   = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
    if ((Test-Path -LiteralPath $puller) -and (Test-Path -LiteralPath $ps32)) {
        & $ps32 -NoProfile -ExecutionPolicy Bypass -File $puller -Days 3 -OutFile $dump 2>&1 | Out-Null
        if (Test-Path -LiteralPath $dump) {
            $devicePunches = @(Import-Csv -LiteralPath $dump)
        }
    }
}

# ------------------------------------------------- raw punches, by day -------
$rawByKey = @{}
foreach ($p in $punches) {
    $when = $p.LogDate -as [datetime]
    if (-not $when -or $when.Date -lt $from -or $when.Date -gt $to) { continue }
    $emp = $byDeviceCode[('' + $p.UserId).Trim()]
    if (-not $emp) { continue }
    $key = '{0}|{1}' -f $emp.EmployeeId, $when.ToString('yyyy-MM-dd')
    if (-not $rawByKey.ContainsKey($key)) { $rawByKey[$key] = [System.Collections.ArrayList]::new() }
    [void] $rawByKey[$key].Add([pscustomobject]@{
        At = $when; Direction = ('' + $p.Direction).Trim().ToLower(); Device = $deviceName['' + $p.DeviceId]
    })
}

<#  Fold in whatever the readers gave that the database had not. A punch is the
    same punch if it is the same person at the same minute, whichever route it
    arrived by, so matching on that keeps a duplicate from turning one arrival
    into two. #>
$fromDevice = 0
$deviceByIp = @{}
foreach ($d in $devices) {
    $ip = ('' + $d.IpAddress).Trim()
    if ($ip) { $deviceByIp[$ip] = ('' + $d.DeviceFName).Trim() }
}
foreach ($p in $devicePunches) {
    $when = $p.LogDate -as [datetime]
    if (-not $when -or $when.Date -lt $from -or $when.Date -gt $to) { continue }
    $emp = $byDeviceCode[('' + $p.UserId).Trim()]
    if (-not $emp) { continue }
    $key = '{0}|{1}' -f $emp.EmployeeId, $when.ToString('yyyy-MM-dd')
    if (-not $rawByKey.ContainsKey($key)) { $rawByKey[$key] = [System.Collections.ArrayList]::new() }
    $stamp = $when.ToString('HH:mm')
    if ($rawByKey[$key] | Where-Object { $_.At.ToString('HH:mm') -eq $stamp }) { continue }
    <#  Which reader a punch came from decides whether it is an arrival or a
        departure - one is mounted as IN, the other as OUT. Without a name there
        is no way to tell, and guessing "in" turns somebody's departure into a
        second arrival and loses their out time for the day. So an unknown
        reader is skipped rather than assumed. #>
    $name = $deviceByIp[('' + $p.Device).Trim()]
    if (-not $name) { continue }
    [void] $rawByKey[$key].Add([pscustomobject]@{
        At = $when
        # Which reader it came from says in or out; these are mounted one each.
        Direction = if ($name -eq 'OUT') { 'out' } else { 'in' }
        Device    = $name
    })
    $fromDevice++
}

# --------------------------------------------- eSSL's own rows, by day -------
$essl = @{}
foreach ($r in $processed) {
    $d = $r.AttendanceDate -as [datetime]
    if (-not $d -or $d.Date -lt $from -or $d.Date -gt $to) { continue }
    $essl['{0}|{1}' -f $r.EmployeeId, $d.ToString('yyyy-MM-dd')] = $r
}

# ------------------------------------------------------------- the rows ------
$fromEssl = 0; $fromPunches = 0; $stale = 0; $open = 0
$rows = foreach ($key in ($rawByKey.Keys + $essl.Keys | Select-Object -Unique)) {
    $parts = $key.Split('|')
    $emp   = $empById[$parts[0]]
    if (-not $emp) { continue }
    $day   = [datetime]::ParseExact($parts[1], 'yyyy-MM-dd', $null)

    $list  = if ($rawByKey.ContainsKey($key)) { @($rawByKey[$key] | Sort-Object At) } else { @() }
    $their = $essl[$key]

    <#  Say nothing about a day with no punches. A weekly off, a holiday or a
        genuine absence has an eSSL row too, and emitting those would let an
        import overwrite a leave or WFH mark already set in the dashboard with
        a bare "Absent". The file carries days somebody attended; everything
        else is left as the dashboard has it. #>
    if ($list.Count -eq 0 -and -not ('' + $their.PunchRecords).Trim()) { continue }

    <#  Trust eSSL's row only while it accounts for every punch the readers
        hold for that day.

        Asking merely whether it has an out-time is not enough, which cost a
        whole day: 7 September was processed mid-morning, and eSSL wrote the
        out-time equal to the in-time - one punch, in and out at 9:52. That
        looks like a finished day and is not, so the truncated row was copied
        over the full one the readers had.

        Comparing punch counts catches it. That comparison was tried first and
        backed out because durations then moved by an hour on days eSSL had got
        right - but that gap was a rounding bug in this script, not eSSL and the
        readers disagreeing, so counting is safe now. #>
    $useEssl = $false
    if ($their) {
        $useEssl = (Count-Punches $their.PunchRecords) -ge $list.Count
    }

    if ($useEssl) {
        $fromEssl++
        $inTime   = Clock $their.InTime
        $outTime  = Clock $their.OutTime
        $duration = HM ([int] ([double] ('' + $their.Duration)))   # the file's own figure, verbatim
        $lateBy   = HM ([int] ('0' + $their.LateBy))
        $earlyBy  = HM ([int] ('0' + $their.EarlyBy))
        $status   = ('' + $their.Status)
        $record   = (('' + $their.PunchRecords).Trim() -replace ',', ' ')
        $overtime = HM ([int] ('0' + $their.OverTime))
        $sid      = '' + $their.ShiftId
    } else {
        if ($list.Count -eq 0) { continue }        # nothing to say about this day
        if ($their) { $stale++ } else { $fromPunches++ }

        $first = $list[0]
        $outs  = @($list | Where-Object { $_.Direction -eq 'out' })
        $last  = if ($outs.Count) { $outs[-1] } else { $null }

        $inTime   = '{0}:{1:d2}' -f $first.At.Hour, $first.At.Minute
        $outTime  = if ($last) { '{0}:{1:d2}' -f $last.At.Hour, $last.At.Minute } else { '' }
        $duration = HM (Sum-Paired $list)
        $lateBy   = '0:00'; $earlyBy = '0:00'; $overtime = '0:00'
        # An in-punch with nothing after it is a day still running, not an absence.
        $status   = if ($last) { 'Present ' } else { 'Present (No OutPunch)' }
        if (-not $last) { $open++ }
        $record   = (($list | ForEach-Object {
            '{0}:{1}({2})' -f $_.At.ToString('HH:mm'), $_.Direction, $_.Device
        }) -join ' ')
        $sid      = $shiftOf['' + $emp.EmployeeId]
    }

    $sh = if ($sid) { $shiftById[$sid] } else { $null }

    [pscustomobject] [ordered] @{
        'Date'            = $day.ToString('M/d/yyyy')
        ' Employee Code ' = '' + $emp.EmployeeCode
        'Employee Name'   = ('' + $emp.EmployeeName).Trim()
        'Company '        = 'Default'
        'Department'      = 'Default'
        'Category '       = if ($sh) { Format-ShiftSpan $sh.BeginTime $sh.EndTime } else { '' }
        'Degination'      = ''
        'Grade'           = ''
        'Team'            = ''
        'Shift'           = if ($sh) { ('' + $sh.ShiftSName).Trim() } else { '' }
        ' In Time '       = $inTime
        'Out Time '       = $outTime
        ' Duration '      = $duration
        'Late By '        = $lateBy
        'Early By '       = $earlyBy
        'Status '         = $status
        'Punch Records '  = ($record.TrimEnd() + ' ')
        'Overtime'        = $overtime
    }
}

$rows = @($rows | Sort-Object { [datetime] $_.'Date' }, 'Employee Name')

Write-Output ('days covered        : {0} to {1}' -f $from.ToString('yyyy-MM-dd'), $to.ToString('yyyy-MM-dd'))
Write-Output ('rows                : {0}  ({1} people)' -f $rows.Count,
              (@($rows | Select-Object -ExpandProperty 'Employee Name' -Unique).Count))
Write-Output ('  taken from eSSL   : {0}' -f $fromEssl)
Write-Output ('  built from punches: {0}   (days eSSL has not processed)' -f $fromPunches)
Write-Output ('  eSSL row was stale: {0}   (written before the day finished)' -f $stale)
Write-Output ('  still open        : {0}   (in-punch, no out-punch yet)' -f $open)
Write-Output ('  straight off the readers: {0} punch(es) the database did not have' -f $fromDevice)

if ($WhatIfOnly) { Write-Output 'WhatIfOnly - nothing written'; return }

$dir = Split-Path -Parent $OutFile
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$rows | Export-Csv -LiteralPath $OutFile -NoTypeInformation -Encoding UTF8
Write-Output ('written             : {0}' -f $OutFile)

# A scheduled run has nobody watching it, so leave a line behind. One line per
# run, newest last, trimmed so it cannot grow without limit.
$log = Join-Path $DataDir 'build-log.txt'
$newest = ($rawByKey.Values | ForEach-Object { $_ } | ForEach-Object { $_.At } |
           Sort-Object | Select-Object -Last 1)
$line = '{0}  rows={1} fromEssl={2} rebuilt={3} stale={4} open={5} newFromReaders={8} lastPunch={6} lastDevicePull={7}' -f `
        (Get-Date).ToString('yyyy-MM-dd HH:mm'), $rows.Count, $fromEssl, $fromPunches, $stale, $open,
        $(if ($newest)  { $newest.ToString('MM-dd HH:mm') }  else { 'none' }),
        $(if ($lastPull){ $lastPull.ToString('MM-dd HH:mm') } else { 'never' }),
        $fromDevice
Add-Content -LiteralPath $log -Value $line
$keep = Get-Content -LiteralPath $log -Tail 400
Set-Content -LiteralPath $log -Value $keep
