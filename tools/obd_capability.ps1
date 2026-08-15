# Does better hardware actually buy more data on this car?
# Test 1: is there free-running broadcast CAN traffic on the OBD port (sniffer worth it)?
# Test 2: does the ECM answer UDS service 0x22 (ReadDataByIdentifier)?
# Both read-only. No session changes, no writes, no routine control.

$ErrorActionPreference = 'Continue'

function Open-Elm {
  for ($i = 1; $i -le 8; $i++) {
    $p = New-Object System.IO.Ports.SerialPort "COM5",38400,"None",8,"One"
    $p.ReadTimeout = 12000; $p.WriteTimeout = 5000; $p.NewLine = "`r"
    try { $p.Open(); Write-Host "Opened COM5 (attempt $i)"; return $p }
    catch { Write-Host ("  open attempt {0}: {1}" -f $i, $_.Exception.Message.Trim())
            try { $p.Dispose() } catch {}; Start-Sleep -Seconds 3 }
  }
  return $null
}
$sp = Open-Elm
if ($null -eq $sp) { Write-Host "FATAL: COM5 would not open."; exit 1 }

function E([string]$cmd, [int]$waitMs = 9000) {
  try { $sp.DiscardInBuffer() } catch {}
  $sp.Write("$cmd`r")
  $sb = New-Object System.Text.StringBuilder
  $deadline = [Environment]::TickCount + $waitMs
  while ([Environment]::TickCount -lt $deadline) {
    if ($sp.BytesToRead -gt 0) { [void]$sb.Append($sp.ReadExisting()); if ($sb.ToString().Contains('>')) { break } }
    else { Start-Sleep -Milliseconds 30 }
  }
  $sb.ToString()
}
function Clean($raw) {
  ($raw -replace "`r","`n" -replace '>','') -split "`n" |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
}

E "ATZ" 9000 | Out-Null
foreach ($c in @('ATE0','ATL0','ATS0','ATH1','ATSP6','ATAT2','ATST FF')) { E $c 4000 | Out-Null }

# ---------------- TEST 1: passive bus monitor ----------------
Write-Host "`n===== TEST 1: free-running CAN traffic on OBD pins 6/14 ====="
E "ATCRA" 4000 | Out-Null      # clear any receive filter
E "ATAR"  4000 | Out-Null      # automatic receive address

foreach ($secs in @(8)) {
  try { $sp.DiscardInBuffer() } catch {}
  $sp.Write("ATMA`r")
  Start-Sleep -Seconds $secs
  $mon = $sp.ReadExisting()
  $sp.Write([char]0x0D)          # any character stops ATMA
  Start-Sleep -Milliseconds 1200
  try { $sp.ReadExisting() | Out-Null } catch {}

  $frames = (Clean $mon) | Where-Object { $_ -match '^[0-9A-Fa-f]{3,}$' -and $_ -notmatch '^ATMA' }
  Write-Host ("  Monitored {0}s -> {1} frame(s) captured" -f $secs, $frames.Count)
  if ($frames.Count -gt 0) {
    $ids = $frames | ForEach-Object { $_.Substring(0, [Math]::Min(3, $_.Length)) } | Sort-Object -Unique
    Write-Host ("  Distinct CAN IDs seen ({0}): {1}" -f $ids.Count, ($ids -join ' '))
    Write-Host "  Sample frames:"
    $frames | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" }
  } else {
    Write-Host "  (bus is silent unless a tester polls it)"
  }
}

# ---------------- TEST 2: UDS service 0x22 ----------------
Write-Host "`n===== TEST 2: UDS ReadDataByIdentifier (service 0x22) ====="
Write-Host "  Positive reply = 62 <did>.  7F 22 11/31 = service or DID not supported."

E "ATSH 7E0" 4000 | Out-Null
E "ATCRA 7E8" 4000 | Out-Null

# Standard ISO 14229 identification DIDs - safe, read-only.
$dids = @(
  @('F190','VIN'),
  @('F18C','ECU serial number'),
  @('F191','ECU hardware number'),
  @('F194','ECU software number'),
  @('F195','ECU software version'),
  @('F197','System name'),
  @('F1A0','Vehicle manufacturer data'),
  @('0100','manufacturer-range probe')
)
foreach ($d in $dids) {
  $reply = (Clean (E ("22" + $d[0]) 9000)) -join ' | '
  Write-Host ("  22 {0}  {1,-26} {2}" -f $d[0], $d[1], $reply)
}

Write-Host "`n===== TEST 3: which standard modes answer at all ====="
foreach ($m in @(@('01 00','mode 01 live data'), @('02 02','mode 02 freeze frame'), @('06 00','mode 06 monitor tests'), @('08 00','mode 08 control'), @('09 00','mode 09 info'), @('0A','mode 0A permanent DTCs'))) {
  $reply = (Clean (E ($m[0] -replace ' ','') 9000)) -join ' | '
  Write-Host ("  {0,-24} -> {1}" -f $m[1], $reply)
}

$sp.Close()
Write-Host "`nPort closed."
