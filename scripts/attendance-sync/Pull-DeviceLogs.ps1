<#
    Read punches straight off the attendance devices and write them to a CSV.

    This exists because the punches only reach eTimeTrackLite's database when
    something pulls them, and nothing was doing that on a schedule - the file
    was as old as the last time Start Download was pressed by hand. The devices
    themselves always have the truth, so they are asked directly.

    Runs 32-bit on purpose: the ZKTeco SDK is a 32-bit COM library, while the
    Access driver that reads the database is 64-bit, so the two cannot share a
    process. This half writes a CSV; Build-AttendanceCsv.ps1 reads it.

    Strictly read-only. It connects, reads, and disconnects. It never writes to
    a device and never clears its logs - the devices stay the record of last
    resort, and eTimeTrackLite goes on downloading from them as before.
#>
[CmdletBinding()]
param(
    [string[]] $Devices = @('192.168.1.112', '192.168.1.111'),
    [int]      $Port    = 4370,
    [int]      $Days    = 3,
    [string]   $OutFile = ''
)

$ErrorActionPreference = 'Continue'

<#  -File passes everything as plain strings, so a caller can only hand an array
    over as one comma-separated value ("a,b"); given two bare values the second
    binds to -Port instead. Accept either and end up with a list. #>
$Devices = @($Devices | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

<#  A background run must never stop on a message box. When Windows cannot start
    a program - which it could not at 09:32 on 16 September, seconds after logon,
    for the 32-bit reader pull - it shows "The operating system is not presently
    configured to run this application" and waits for OK. Nobody is there to
    press it: the run sat on that dialog for hours, the box could not be closed,
    and no attendance was rebuilt. This turns those dialogs into plain errors,
    for this process and for anything it starts. #>
try {
    Add-Type -Namespace HWSync -Name Win -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);' -ErrorAction Stop
    # SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
    [void] [HWSync.Win]::SetErrorMode(0x8003)
} catch { }
$since = (Get-Date).Date.AddDays(-$Days)

# $PSScriptRoot is not filled in yet while the param block is being bound, so
# the default lands here instead of beside the parameter. It writes to the data
# folder, not beside the script: this file is a list of who was at a reader and
# when, and the script itself lives in a git repository.
if (-not $OutFile) {
    $OutFile = Join-Path 'E:\Drive H- Desktop\ZAFAR LISTING\AI Projects\Attendance backup' 'device-punches.csv'
}

if ([Environment]::Is64BitProcess) {
    Write-Error 'Run this with the 32-bit PowerShell: the ZKTeco SDK is a 32-bit library.'
    exit 1
}

try {
    $zk = New-Object -ComObject zkemkeeper.ZKEM
} catch {
    Write-Error ('ZKTeco SDK not available: ' + $_.Exception.Message)
    exit 1
}

$rows = [System.Collections.ArrayList]::new()
$reached = 0

<#  A reader answers one session at a time. Asked while it is busy - the other
    reader being read, or eSSL's downloader talking to it - it connects happily
    and then reports an empty log, which looks exactly like "nothing to fetch".
    On 21 September that is how a day's in-punches went missing. So an empty
    read is tried once more after a pause before it is believed. #>
foreach ($ip in $Devices) {
    if (-not $zk.Connect_Net($ip, $Port)) {
        $err = 0; [void] $zk.GetLastError([ref] $err)
        Write-Output ("{0}: could not connect (sdk error {1})" -f $ip, $err)
        continue
    }
    $reached++

    # Pull the log buffer over, then walk it. The device holds its whole
    # history, so what is wanted gets filtered on this side.
    <#  The reader is deliberately left enabled while its log is read. The SDK's
        usual advice is to disable it first so the buffer cannot shift mid-read,
        but that stops anyone punching for the twenty-odd seconds it takes, and
        this runs every hour. A punch nobody could make is lost for good; a log
        line missed because the buffer moved is picked up on the next run, and
        the database has it regardless. #>
    $kept = 0; $seen = 0
    for ($try = 1; $try -le 2; $try++) {
    if ($try -eq 2) {
        # Nothing at all came back. Let go, wait, and ask once more before
        # believing a reader that has 26,000 punches on it is empty.
        Write-Output ("{0}: read came back empty, trying again in 8s" -f $ip)
        try { $zk.Disconnect() } catch { }
        Start-Sleep -Seconds 8
        if (-not $zk.Connect_Net($ip, $Port)) { break }
    }
    try {
        if ($zk.ReadGeneralLogData(1)) {
            $id = ''; $vfy = 0; $inout = 0
            $y = 0; $mo = 0; $d = 0; $h = 0; $mi = 0; $s = 0; $wc = 0
            while ($zk.SSR_GetGeneralLogData(1, [ref] $id, [ref] $vfy, [ref] $inout,
                                             [ref] $y, [ref] $mo, [ref] $d,
                                             [ref] $h, [ref] $mi, [ref] $s, [ref] $wc)) {
                $seen++
                $when = $null
                try { $when = Get-Date -Year $y -Month $mo -Day $d -Hour $h -Minute $mi -Second $s } catch { }
                if (-not $when -or $when -lt $since) { continue }
                [void] $rows.Add([pscustomobject]@{
                    UserId  = $id
                    LogDate = $when.ToString('yyyy-MM-dd HH:mm:ss')
                    Device  = $ip
                    # 0 = check-in, 1 = check-out on these readers, but the
                    # device this came from is the reliable signal: one reader
                    # is mounted as IN and the other as OUT.
                    InOut   = $inout
                })
                $kept++
            }
        }
    } catch {
        Write-Output ('{0}: {1}' -f $ip, $_.Exception.Message)
    }
    if ($seen -gt 0) { break }
    }
    try { $zk.Disconnect() } catch { }
    Write-Output ("{0}: {1} records on device, {2} within the last {3} day(s)" -f $ip, $seen, $kept, $Days)
}

if ($reached -eq 0) {
    Write-Error 'No device could be reached; leaving any existing file alone.'
    exit 1
}

<#  Add to what is already on file rather than replace it. A reader that could
    not be reached this time, or a log read cut short, used to take its punches
    out of the file - and that morning's in-times out of the dashboard - until
    the next good run; on 11 September a run at 09:57 dropped four of the day's
    rows that way. A punch does not change once made, so keeping the ones
    already seen costs nothing. #>
$carried = 0
if (Test-Path -LiteralPath $OutFile) {
    $known = @{}
    foreach ($p in $rows) { $known['{0}|{1}|{2}' -f $p.UserId, $p.LogDate, $p.Device] = $true }
    try {
        foreach ($p in @(Import-Csv -LiteralPath $OutFile)) {
            $when = $p.LogDate -as [datetime]
            if (-not $when -or $when -lt $since) { continue }
            $key = '{0}|{1}|{2}' -f $p.UserId, $p.LogDate, $p.Device
            if ($known.ContainsKey($key)) { continue }
            $known[$key] = $true
            [void] $rows.Add([pscustomobject]@{
                UserId = $p.UserId; LogDate = $p.LogDate; Device = $p.Device; InOut = $p.InOut
            })
            $carried++
        }
    } catch {
        Write-Output ('previous file unreadable, starting afresh: ' + $_.Exception.Message)
    }
}

# Written aside and swapped in: if this is stopped mid-write (the build gives it
# three minutes), the punches already on file must not be left half a file.
$partial = $OutFile + '.partial'
$rows | Sort-Object LogDate | Export-Csv -LiteralPath $partial -NoTypeInformation -Encoding UTF8
Move-Item -LiteralPath $partial -Destination $OutFile -Force
Write-Output ("written: {0} ({1} punches from {2} device(s), {3} kept from earlier runs)" -f $OutFile, $rows.Count, $reached, $carried)
