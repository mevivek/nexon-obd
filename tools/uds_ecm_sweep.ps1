# ECM-focused UDS DID sweep with corrected timing.
# Fixes vs the first pass: ATST raised so responsePending (0x78) replies aren't cut off,
# explicit re-read on 0x78, and ranges where Bosch-family ECUs usually put live data.
# Service 0x22 ONLY - read-only. No 0x10 / 0x11 / 0x27 / 0x2E / 0x31.

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

function E([string]$cmd, [int]$waitMs = 3000) {
  try { $sp.DiscardInBuffer() } catch {}
  $sp.Write("$cmd`r")
  $sb = New-Object System.Text.StringBuilder
  $deadline = [Environment]::TickCount + $waitMs
  while ([Environment]::TickCount -lt $deadline) {
    if ($sp.BytesToRead -gt 0) { [void]$sb.Append($sp.ReadExisting()); if ($sb.ToString().Contains('>')) { break } }
    else { Start-Sleep -Milliseconds 10 }
  }
  $sb.ToString()
}

function AskHdr([string]$cmd, [string]$hdr, [int]$waitMs) {
  $raw = E $cmd $waitMs
  $lines = ($raw -replace "`r","`n" -replace '>','') -split "`n" |
    ForEach-Object { ($_ -replace '\s','').ToUpper() } |
    Where-Object { $_ -match '^[0-9A-F]{5,}$' -and $_.StartsWith($hdr) }
  $out = ''
  foreach ($t in $lines) {
    $rest = $t.Substring(3)
    if ($rest.Length -lt 2) { continue }
    $pci = [Convert]::ToInt32($rest.Substring(0,2),16)
    switch ($pci -band 0xF0) {
      0x00 { $len = ($pci -band 0x0F) * 2
             $out = $rest.Substring(2, [Math]::Min($len, $rest.Length - 2)) }
      0x10 { $out += $rest.Substring(4) }
      0x20 { $out += $rest.Substring(2) }
      default { $out += $rest }
    }
  }
  $out
}

function HexToBytes([string]$h) {
  $h = $h -replace '[^0-9A-F]',''
  if ($h.Length % 2) { $h = $h.Substring(0, $h.Length - 1) }
  $b = New-Object System.Collections.Generic.List[int]
  for ($i = 0; $i -lt $h.Length; $i += 2) { $b.Add([Convert]::ToInt32($h.Substring($i,2),16)) }
  ,$b.ToArray()
}

E "ATZ" 9000 | Out-Null
# ATST 32 = ~200ms per-response timeout: long enough for a real reply, short enough to sweep.
foreach ($c in @('ATE0','ATL0','ATS0','ATH1','ATSP6','ATAT0','ATST 32','ATSH 7E0','ATCRA 7E8')) { E $c 3000 | Out-Null }
Write-Host ("Battery: " + ((E 'ATRV' 3000) -replace "[`r`n>]",''))
Write-Host "Sweeping ECM (7E0/7E8) - 5 ranges x 256 = 1280 identifiers`n"

$hits    = New-Object System.Collections.Generic.List[object]
$pending = 0
$negCodes = @{}
$start = [Environment]::TickCount

foreach ($base in @(0xF100, 0x0200, 0x0300, 0x2000, 0xF300)) {
  $found = 0
  for ($lo = 0; $lo -lt 256; $lo++) {
    $did = $base + $lo
    $cmd = '22{0:X4}' -f $did
    $resp = AskHdr $cmd '7E8' 1200

    if ($resp -match '^7F2278') {          # responsePending - give the ECU real time
      $pending++
      Start-Sleep -Milliseconds 150
      $resp = AskHdr $cmd '7E8' 4000
      if ($resp -eq '') { $resp = AskHdr '' '7E8' 2000 }   # drain a late frame
    }
    if ($resp -eq '') { continue }
    if ($resp -match '^7F22(..)') {
      $c = $Matches[1]
      if ($negCodes.ContainsKey($c)) { $negCodes[$c]++ } else { $negCodes[$c] = 1 }
      continue
    }

    $tag = '62{0:X4}' -f $did
    $idx = $resp.IndexOf($tag)
    if ($idx -lt 0) { continue }

    $bytes = HexToBytes $resp.Substring($idx + 6)
    if ($bytes.Count -eq 0) { continue }
    $ascii = -join ($bytes | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { '.' } })
    $hits.Add([pscustomobject]@{
      DID = ('{0:X4}' -f $did); Len = $bytes.Count
      Hex = (($bytes | ForEach-Object { '{0:X2}' -f $_ }) -join ' '); Ascii = $ascii })
    $found++
  }
  Write-Host ("  range {0:X2}xx : {1} responded" -f ($base -shr 8), $found)
}

$el = [math]::Round(([Environment]::TickCount - $start)/1000, 0)
Write-Host ("`nElapsed {0}s | hits {1} | responsePending seen {2}x" -f $el, $hits.Count, $pending)
if ($negCodes.Count) {
  Write-Host "Negative response codes returned (proves the ECU is listening):"
  foreach ($k in ($negCodes.Keys | Sort-Object)) {
    $meaning = switch ($k) {
      '11' { 'serviceNotSupported' }; '12' { 'subFunctionNotSupported' }
      '13' { 'incorrectMessageLength' }; '22' { 'conditionsNotCorrect' }
      '31' { 'requestOutOfRange (DID does not exist)' }
      '33' { 'securityAccessDenied' }; '7F' { 'serviceNotSupportedInActiveSession' }
      default { 'see ISO 14229 table' }
    }
    Write-Host ("  7F 22 {0} x{1,-5} {2}" -f $k, $negCodes[$k], $meaning)
  }
}

Write-Host "`n=== ECM RESPONDING DIDs ==="
if ($hits.Count -eq 0) { Write-Host "  (none)" }
foreach ($h in $hits) {
  $sh = if ($h.Hex.Length -gt 56) { $h.Hex.Substring(0,56) + '...' } else { $h.Hex }
  Write-Host ("  {0}  {1,3}B  {2,-60}  |{3}|" -f $h.DID, $h.Len, $sh, $h.Ascii)
}

$csv = Join-Path $PSScriptRoot 'ecm_did_hits.csv'
$hits | Export-Csv -NoTypeInformation -Path $csv
Write-Host "`nSaved: $csv"
$sp.Close()
Write-Host "Port closed."
