# Header-aware OBD-II enumeration. ATCRA filtering is unreliable on this ELM327 v1.5
# clone, so we turn headers ON (ATH1) and demultiplex the ECU replies in software.
# Read-only: modes 01, 03, 07, 09. Nothing is written or cleared.

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

# Send a command, reassemble ISO-TP frames, return @{ '7E8' = 'payloadhex'; '7E9' = '...' }
function Ask([string]$cmd, [int]$waitMs = 9000) {
  $raw = E $cmd $waitMs
  $lines = ($raw -replace "`r","`n" -replace '>','') -split "`n" |
    ForEach-Object { ($_ -replace '\s','').ToUpper() } |
    Where-Object { $_ -match '^[0-9A-F]{5,}$' }

  $frames = @{}
  foreach ($t in $lines) {
    $hdr  = $t.Substring(0,3)
    $rest = $t.Substring(3)
    if ($rest.Length -lt 2) { continue }
    if (-not $frames.ContainsKey($hdr)) { $frames[$hdr] = '' }
    $pci  = [Convert]::ToInt32($rest.Substring(0,2),16)
    switch ($pci -band 0xF0) {
      0x00 { # single frame: low nibble = payload length
             $len = ($pci -band 0x0F) * 2
             $avail = $rest.Length - 2
             $frames[$hdr] = $rest.Substring(2, [Math]::Min($len, $avail)) }
      0x10 { $frames[$hdr] += $rest.Substring(4) }   # first frame (skip 12-bit length)
      0x20 { $frames[$hdr] += $rest.Substring(2) }   # consecutive frame
      default { $frames[$hdr] += $rest }
    }
  }
  $frames
}

function HexToBytes([string]$h) {
  $h = $h -replace '[^0-9A-F]',''
  if ($h.Length % 2) { $h = $h.Substring(0, $h.Length - 1) }
  $b = New-Object System.Collections.Generic.List[int]
  for ($i = 0; $i -lt $h.Length; $i += 2) { $b.Add([Convert]::ToInt32($h.Substring($i,2),16)) }
  ,$b.ToArray()
}

# ---------- init: headers ON, functional broadcast so every ECU answers ----------
E "ATZ" 9000 | Out-Null
foreach ($c in @('ATE0','ATL0','ATS0','ATH1','ATSP6','ATAT2','ATST FF','ATSH 7DF')) { E $c 4000 | Out-Null }
Write-Host ("Battery: " + ((E 'ATRV' 4000) -replace "[`r`n>]",''))

# ---------- supported-PID walk, both ECUs from one broadcast ----------
$ecuNames = @{ '7E8' = 'ECM  (engine, 7E8)'; '7E9' = 'TCM  (transmission, 7E9)' }
$supported = @{}

foreach ($bank in @(0x00,0x20,0x40,0x60,0x80,0xA0,0xC0)) {
  $frames = Ask ('01{0:X2}' -f $bank) 10000
  $more = $false
  foreach ($hdr in $frames.Keys) {
    $hex = $frames[$hdr]
    $tag = '41{0:X2}' -f $bank
    $idx = $hex.IndexOf($tag)
    if ($idx -lt 0) { continue }
    $bytes = HexToBytes $hex.Substring($idx + 4)
    if ($bytes.Count -lt 4) { continue }
    if (-not $supported.ContainsKey($hdr)) { $supported[$hdr] = New-Object System.Collections.Generic.List[int] }
    for ($k = 0; $k -lt 4; $k++) {
      for ($bit = 0; $bit -lt 8; $bit++) {
        if ($bytes[$k] -band (0x80 -shr $bit)) { $supported[$hdr].Add($bank + ($k*8) + $bit + 1) }
      }
    }
    if ($bytes[3] -band 1) { $more = $true }
  }
  if (-not $more) { break }
}

$names = @{
  0x01='Monitor status / MIL';        0x02='Freeze frame DTC';        0x03='Fuel system status'
  0x04='Calculated engine load';      0x05='Coolant temperature';     0x06='Short term fuel trim B1'
  0x07='Long term fuel trim B1';      0x0B='Intake manifold pressure';0x0C='Engine RPM'
  0x0D='Vehicle speed';               0x0E='Timing advance';          0x0F='Intake air temperature'
  0x10='MAF air flow rate';           0x11='Throttle position';       0x13='O2 sensors present'
  0x14='O2 sensor 1';                 0x15='O2 sensor 2';             0x1C='OBD standard'
  0x1F='Engine run time';             0x21='Distance with MIL on';    0x2E='Commanded eva. purge'
  0x2F='Fuel tank level';             0x30='Warm-ups since cleared';  0x31='Distance since cleared'
  0x33='Barometric pressure';         0x34='O2 S1 wide-range lambda'; 0x3C='Catalyst temp B1S1'
  0x40='PIDs supported 41-60';        0x42='Control module voltage';  0x43='Absolute load'
  0x44='Commanded equiv. ratio';      0x45='Relative throttle pos';   0x46='Ambient air temperature'
  0x47='Absolute throttle pos B';     0x49='Accel pedal position D';  0x4A='Accel pedal position E'
  0x4C='Commanded throttle actuator'; 0x4D='Time run with MIL on';    0x4E='Time since cleared'
  0x51='Fuel type';                   0x5C='Engine oil temperature';  0x5E='Engine fuel rate'
}

function Decode([int]$num, $b) {
  if ($null -eq $b -or $b.Count -eq 0) { return $null }
  $A = $b[0]; $B = if ($b.Count -gt 1) { $b[1] } else { 0 }
  switch ($num) {
    0x03 { 'raw {0:X2}' -f $A }
    0x04 { '{0:N1} %'   -f ($A * 100 / 255) }
    0x05 { '{0} C'      -f ($A - 40) }
    0x06 { '{0:N1} %'   -f (($A - 128) * 100 / 128) }
    0x07 { '{0:N1} %'   -f (($A - 128) * 100 / 128) }
    0x0B { '{0} kPa'    -f $A }
    0x0C { '{0:N0} rpm' -f ((256 * $A + $B) / 4) }
    0x0D { '{0} km/h'   -f $A }
    0x0E { '{0:N1} deg BTDC' -f ($A / 2 - 64) }
    0x0F { '{0} C'      -f ($A - 40) }
    0x10 { '{0:N2} g/s' -f ((256 * $A + $B) / 100) }
    0x11 { '{0:N1} %'   -f ($A * 100 / 255) }
    0x14 { '{0:N3} V'   -f ($A / 200) }
    0x15 { '{0:N3} V'   -f ($A / 200) }
    0x1C { 'code {0}'   -f $A }
    0x1F { '{0} s'      -f (256 * $A + $B) }
    0x21 { '{0} km'     -f (256 * $A + $B) }
    0x2E { '{0:N1} %'   -f ($A * 100 / 255) }
    0x2F { '{0:N1} %'   -f ($A * 100 / 255) }
    0x30 { '{0}'        -f $A }
    0x31 { '{0} km'     -f (256 * $A + $B) }
    0x33 { '{0} kPa'    -f $A }
    0x34 { '{0:N3} lambda' -f ((256 * $A + $B) / 32768) }
    0x3C { '{0:N1} C'   -f (((256 * $A + $B) / 10) - 40) }
    0x42 { '{0:N2} V'   -f ((256 * $A + $B) / 1000) }
    0x43 { '{0:N1} %'   -f ((256 * $A + $B) * 100 / 255) }
    0x44 { '{0:N3}'     -f ((256 * $A + $B) / 32768) }
    0x45 { '{0:N1} %'   -f ($A * 100 / 255) }
    0x46 { '{0} C'      -f ($A - 40) }
    0x47 { '{0:N1} %'   -f ($A * 100 / 255) }
    0x49 { '{0:N1} %'   -f ($A * 100 / 255) }
    0x4A { '{0:N1} %'   -f ($A * 100 / 255) }
    0x4C { '{0:N1} %'   -f ($A * 100 / 255) }
    0x4D { '{0} min'    -f (256 * $A + $B) }
    0x4E { '{0} min'    -f (256 * $A + $B) }
    0x5C { '{0} C'      -f ($A - 40) }
    0x5E { '{0:N2} L/h' -f ((256 * $A + $B) / 20) }
    default { 'raw ' + (($b | ForEach-Object { '{0:X2}' -f $_ }) -join ' ') }
  }
}

foreach ($hdr in @('7E8','7E9')) {
  if (-not $supported.ContainsKey($hdr)) { continue }
  $list = $supported[$hdr]
  Write-Host ("`n=== {0} : {1} PIDs ===" -f $ecuNames[$hdr], $list.Count)
  Write-Host ('  ' + (($list | ForEach-Object { '{0:X2}' -f $_ }) -join ' '))
  Write-Host ''
  foreach ($num in $list) {
    if ($num -in @(0x20,0x40,0x60,0x80,0xA0,0xC0)) { continue }
    $frames = Ask ('01{0:X2}' -f $num) 8000
    if (-not $frames.ContainsKey($hdr)) { continue }
    $hex = $frames[$hdr]
    $tag = '41{0:X2}' -f $num
    $idx = $hex.IndexOf($tag)
    if ($idx -lt 0) { continue }
    $b = HexToBytes $hex.Substring($idx + 4)
    $n = if ($names.ContainsKey($num)) { $names[$num] } else { '(unnamed)' }
    Write-Host ("  {0}  {1,-30} {2}" -f ('{0:X2}' -f $num), $n, (Decode $num $b))
  }
}

# ---------- fault codes ----------
Write-Host "`n=== FAULT CODES ==="
foreach ($m in @(@('03','stored'), @('07','pending'))) {
  $frames = Ask $m[0] 10000
  foreach ($hdr in ($frames.Keys | Sort-Object)) {
    Write-Host ("  {0} mode {1} ({2}): {3}" -f $hdr, $m[0], $m[1], $frames[$hdr])
  }
}

# ---------- mode 09 ----------
Write-Host "`n=== MODE 09 VEHICLE INFO ==="
$m9names = @{ '02'='VIN'; '04'='Calibration ID'; '06'='Cal verification number'; '0A'='ECU name' }
foreach ($item in @('02','04','06','0A')) {
  $frames = Ask "09$item" 12000
  foreach ($hdr in ($frames.Keys | Sort-Object)) {
    $hex = $frames[$hdr]
    $idx = $hex.IndexOf("49$item")
    if ($idx -lt 0) { continue }
    $bytes = HexToBytes $hex.Substring($idx + 6)
    $ascii = -join ($bytes | Where-Object { $_ -ge 32 -and $_ -lt 127 } | ForEach-Object { [char]$_ })
    Write-Host ("  {0}  09{1} {2,-24} {3}" -f $hdr, $item, $m9names[$item], $ascii)
  }
}

$sp.Close()
Write-Host "`nPort closed."
