<#
    The daily look at build-log.txt, so a chain that quietly stops is noticed.

    The hourly job writes a line per run. Everything that can go wrong shows up
    there: the job stopping, the readers going unreachable, punches not arriving.
    Nobody reads a log file on purpose, so this reads it at 10:00 and says on
    screen whether attendance is flowing or not.

    It changes nothing. It reads the log and the CSV and reports.
#>
[CmdletBinding()]
param(
    # The data folder, not the script folder - the logs and the watched file
    # live with the attendance data, which is deliberately outside the repo.
    [string] $Base   = 'E:\Drive H- Desktop\ZAFAR LISTING\AI Projects\Attendance backup',
    [int]    $StaleHours = 3          # an hourly job silent this long is wrong
)

$ErrorActionPreference = 'Continue'

# $PSCommandPath is still empty while the param block binds, so the folder is
# settled here. Left in the param default it came back empty under Task
# Scheduler, and the check then read nothing, wrote nothing, and still exited 0
# - a health check that reports success while doing nothing is worse than none.
if (-not $Base) { throw 'Cannot work out which folder to check.' }

$log = Join-Path $Base 'build-log.txt'
$csv = Join-Path $Base '1_Daily Attendace file\DailyAttendanceLogsDetails.csv'

$problems = @()
$notes    = @()

# --- did the job run at all, and recently? -----------------------------------
if (-not (Test-Path -LiteralPath $log)) {
    $problems += 'No build log at all - the hourly job has never run.'
} else {
    $last = (Get-Content -LiteralPath $log -Tail 1)
    $when = $null
    if ($last -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})') {
        $when = [datetime]::ParseExact($matches[1], 'yyyy-MM-dd HH:mm', $null)
    }
    if (-not $when) {
        $problems += 'The last log line is not readable.'
    } else {
        $age = (Get-Date) - $when
        $notes += ('Last run {0} ({1:n0} min ago)' -f $when.ToString('HH:mm'), $age.TotalMinutes)
        if ($age.TotalHours -gt $StaleHours) {
            $problems += ('The job has not run for {0:n1} hours - it should run hourly.' -f $age.TotalHours)
        }
    }

    # --- is attendance data actually arriving? -------------------------------
    if ($last -match 'lastPunch=(\d{2}-\d{2} \d{2}:\d{2})') {
        $notes += ('Newest punch ' + $matches[1])
        $stamp = $matches[1]
        $today = (Get-Date).ToString('MM-dd')
        # Before anyone has arrived there is nothing to see, so only judge this
        # once the morning is under way, and only on a working day.
        $weekday = (Get-Date).DayOfWeek -ne 'Sunday'
        if ($weekday -and (Get-Date).Hour -ge 10 -and -not $stamp.StartsWith($today)) {
            $problems += ("No punch recorded today - newest is $stamp. The readers may be unreachable.")
        }
    } else {
        $notes += 'No punch figure in the log yet'
    }

    <#  Has anything ever come off the readers that the database did not
        already have? Until that number goes above zero it is unproven that
        punches arrive without somebody pressing Start Download by hand, so the
        whole log is scanned rather than just the last line - it only has to
        have happened once. #>
    $everFromReaders = 0
    foreach ($l in (Get-Content -LiteralPath $log)) {
        if ($l -match 'newFromReaders=(\d+)' -and [int] $matches[1] -gt 0) { $everFromReaders++ }
    }
    if ($everFromReaders -gt 0) {
        $notes += ("Readers have supplied punches the database lacked, on $everFromReaders run(s) - the pull works")
    } else {
        $notes += 'Readers have never yet supplied a punch the database lacked (not proven either way)'
    }

    if ($last -match 'rows=(\d+)') {
        $notes += ('Rows in file ' + $matches[1])
        if ([int] $matches[1] -eq 0) { $problems += 'The file was written with no rows in it.' }
    }
}

<#  A finished day with no out-time is the failure this check exists for and
    missed once already. The machine sleeps in the early evening, around when
    people are punching out, so the last runs of the day never happen and the
    day is left half-recorded until something rebuilds it. Yesterday sat like
    that all night and nobody knew. Any past day carrying an in-time and no
    out-time is worth saying out loud. #>
if (Test-Path -LiteralPath $csv) {
    $today = (Get-Date).Date
    $openPast = @(Import-Csv -LiteralPath $csv | Where-Object {
        $d = $_.Date -as [datetime]
        $in = ($_.PSObject.Properties | Where-Object { $_.Name.Trim() -eq 'In Time' }  | Select-Object -First 1).Value
        $out = ($_.PSObject.Properties | Where-Object { $_.Name.Trim() -eq 'Out Time' } | Select-Object -First 1).Value
        $d -and $d.Date -lt $today -and $in -and -not $out
    })
    if ($openPast.Count -gt 0) {
        $days = ($openPast | ForEach-Object { ($_.Date -as [datetime]).ToString('MMM d') } | Sort-Object -Unique) -join ', '
        $problems += ("$($openPast.Count) finished day(s) still have no out-time ($days). " +
                      'Run Build-AttendanceCsv.ps1, then import in the dashboard.')
    } else {
        $notes += 'Every finished day has its out-time'
    }
}

# --- is the file the dashboard reads actually fresh? -------------------------
if (-not (Test-Path -LiteralPath $csv)) {
    $problems += 'The attendance CSV is missing from the watched folder.'
} else {
    $age = (Get-Date) - (Get-Item -LiteralPath $csv).LastWriteTime
    if ($age.TotalHours -gt $StaleHours) {
        $problems += ('The CSV has not been rewritten for {0:n1} hours.' -f $age.TotalHours)
    }
}

# --- say so ------------------------------------------------------------------
$ok      = $problems.Count -eq 0
$title   = if ($ok) { 'Attendance: all good' } else { 'Attendance needs a look' }
$message = if ($ok) { ($notes -join "`n") } else { ($problems -join "`n") }

Write-Output ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm'), $title)
foreach ($n in $notes)    { Write-Output ('   ' + $n) }
foreach ($p in $problems) { Write-Output ('   PROBLEM: ' + $p) }

Add-Content -LiteralPath (Join-Path $Base 'health-log.txt') -Value (
    '{0}  {1} | {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm'), $title,
    (($notes + ($problems | ForEach-Object { 'PROBLEM: ' + $_ })) -join ' | '))

# A balloon in the tray, because a log nobody opens is not a check.
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.BalloonTipIcon  = if ($ok) { 'Info' } else { 'Warning' }
    $icon.BalloonTipTitle = $title
    $icon.BalloonTipText  = $message
    $icon.Visible = $true
    $icon.ShowBalloonTip(20000)
    Start-Sleep -Seconds 20
    $icon.Dispose()
} catch {
    Write-Output ('could not show a notification: ' + $_.Exception.Message)
}
