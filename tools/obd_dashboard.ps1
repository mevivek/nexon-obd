# Live OBD-II dashboard for the Tata Nexon.
# Serves dashboard.html on http://localhost:8787/ and polls the ECU on demand.
# Uses batched multi-PID mode 01 requests (6 PIDs per message ~ 4x faster than one at a time).
# Read-only: mode 01 only. Also appends every sample to obd_log.csv.

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$htmlPath = Join-Path $here 'dashboard.html'
$csvPath  = Join-Path $here 'obd_log.csv'
$PORT     = 8787

# ---------------- serial ----------------
$script:sp = $null
function Connect-Elm {
  if ($script:sp -and $script:sp.IsOpen) { return $true }
  try { if ($script:sp) { $script:sp.Dispose() } } catch {}
  $script:sp = $null
  for ($i = 1; $i -le 3; $i++) {
    $p = New-Object System.IO.Ports.SerialPort "COM5",38400,"None",8,"One"
    $p.ReadTimeout = 4000; $p.WriteTimeout = 3000; $p.NewLine = "`r"
    try {
      $p.Open()
      $script:sp = $p
      Send "ATZ" 6000 | Out-Null
      foreach ($c in @('ATE0','ATL0','ATS0','ATH1','ATSP6','ATAT2','ATST 32','ATSH 7E0','ATCRA 7E8')) {
        Send $c 2000 | Out-Null
      }
      Write-Host "[obd] adapter ready"
      return $true
    } catch {
      Write-Host ("[obd] open failed: {0}" -f $_.Exception.Message.Trim())
      try { $p.Dispose() } catch {}
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

function Send([string]$cmd, [int]$waitMs = 2500) {
  if (-not ($script:sp -and $script:sp.IsOpen)) { return '' }
  try {
    $script:sp.DiscardInBuffer()
    $script:sp.Write("$cmd`r")
    $sb = New-Object System.Text.StringBuilder
    $deadline = [Environment]::TickCount + $waitMs
    while ([Environment]::TickCount -lt $deadline) {
      if ($script:sp.BytesToRead -gt 0) {
        [void]$sb.Append($script:sp.ReadExisting())
        if ($sb.ToString().Contains('>')) { break }
      } else { Start-Sleep -Milliseconds 5 }
    }
    return $sb.ToString()
  } catch {
    try { $script:sp.Close() } catch {}
    $script:sp = $null
    return ''
  }
}

# Reassemble ISO-TP frames from header 7E8 into one payload hex string.
function AskEcm([string]$cmd, [int]$waitMs = 2500) {
  $raw = Send $cmd $waitMs
  if ($raw -eq '') { return '' }
  $lines = ($raw -replace "`r","`n" -replace '>','') -split "`n" |
    ForEach-Object { ($_ -replace '\s','').ToUpper() } |
    Where-Object { $_ -match '^7E8[0-9A-F]{2,}$' }
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

# Byte count of each mode-01 PID's data field (SAE J1979).
$PLEN = @{
  0x04=1; 0x05=1; 0x06=1; 0x07=1; 0x0B=1; 0x0C=2; 0x0D=1; 0x0E=1; 0x0F=1
  0x11=1; 0x1F=2; 0x2F=1; 0x33=1; 0x34=4; 0x3C=2; 0x42=2; 0x46=1; 0x5C=1; 0x5E=2
}

# Walk "41 <pid> <data...> <pid> <data...>" and return @{ pid = int[] }
function ParseBatch([string]$payload) {
  $res = @{}
  if ($payload.Length -lt 4 -or $payload.Substring(0,2) -ne '41') { return $res }
  $i = 2
  while ($i + 2 -le $payload.Length) {
    $pid = [Convert]::ToInt32($payload.Substring($i,2),16)
    if (-not $PLEN.ContainsKey($pid)) { break }
    $n = $PLEN[$pid]
    $i += 2
    if ($i + $n*2 -gt $payload.Length) { break }
    $bytes = @()
    for ($k = 0; $k -lt $n; $k++) { $bytes += [Convert]::ToInt32($payload.Substring($i + $k*2, 2),16) }
    $res[$pid] = $bytes
    $i += $n * 2
  }
  $res
}

$BATCHES = @(
  @(0x0C,0x0D,0x0B,0x11,0x04,0x05),
  @(0x5C,0x0F,0x42,0x06,0x07,0x5E),
  @(0x34,0x3C,0x0E,0x1F,0x46,0x2F)
)

$script:baro = $null
$script:failCount = 0
$script:lastPoll = 0
$script:lastJson = '{"ok":false,"error":"starting"}'

function Poll {
  if (-not (Connect-Elm)) { return '{"ok":false,"error":"adapter disconnected"}' }

  $all = @{}
  foreach ($batch in $BATCHES) {
    $cmd = '01' + (($batch | ForEach-Object { '{0:X2}' -f $_ }) -join '')
    $p = ParseBatch (AskEcm $cmd 2500)
    foreach ($k in $p.Keys) { $all[$k] = $p[$k] }
  }

  if ($all.Count -eq 0) {
    # Ignition off / ECU asleep gives "UNABLE TO CONNECT"; the ELM then needs a
    # protocol re-init before it will retry, so nudge it every few failures.
    $script:failCount++
    if ($script:failCount % 4 -eq 0) {
      foreach ($c in @('ATSP6','ATAT2','ATST 32','ATSH 7E0','ATCRA 7E8')) { Send $c 2000 | Out-Null }
    }
    $v = (Send 'ATRV' 2000) -replace "[`r`n>]",''
    $hint = if ($v -match '^\s*1[0-2]\.') { "ignition off (battery $v)" } else { "no response from ECU ($v)" }
    return ('{"ok":false,"error":"' + $hint + '"}')
  }
  $script:failCount = 0

  if ($null -eq $script:baro) {
    $b = ParseBatch (AskEcm '0133' 2500)
    if ($b.ContainsKey(0x33)) { $script:baro = $b[0x33][0] }
  }

  function V($pid) { if ($all.ContainsKey($pid)) { $all[$pid] } else { $null } }
  function Num($x) { if ($null -eq $x) { 'null' } else { ([string][math]::Round($x,3)) } }

  $rpm      = if ($null -ne (V 0x0C)) { ((V 0x0C)[0]*256 + (V 0x0C)[1]) / 4 } else { $null }
  $speed    = if ($null -ne (V 0x0D)) { (V 0x0D)[0] } else { $null }
  $map      = if ($null -ne (V 0x0B)) { (V 0x0B)[0] } else { $null }
  $throttle = if ($null -ne (V 0x11)) { (V 0x11)[0] * 100 / 255 } else { $null }
  $load     = if ($null -ne (V 0x04)) { (V 0x04)[0] * 100 / 255 } else { $null }
  $coolant  = if ($null -ne (V 0x05)) { (V 0x05)[0] - 40 } else { $null }
  $oil      = if ($null -ne (V 0x5C)) { (V 0x5C)[0] - 40 } else { $null }
  $iat      = if ($null -ne (V 0x0F)) { (V 0x0F)[0] - 40 } else { $null }
  $volt     = if ($null -ne (V 0x42)) { ((V 0x42)[0]*256 + (V 0x42)[1]) / 1000 } else { $null }
  $stft     = if ($null -ne (V 0x06)) { ((V 0x06)[0] - 128) * 100 / 128 } else { $null }
  $ltft     = if ($null -ne (V 0x07)) { ((V 0x07)[0] - 128) * 100 / 128 } else { $null }
  $fuelRate = if ($null -ne (V 0x5E)) { ((V 0x5E)[0]*256 + (V 0x5E)[1]) / 20 } else { $null }
  $lambda   = if ($null -ne (V 0x34)) { ((V 0x34)[0]*256 + (V 0x34)[1]) / 32768 } else { $null }
  $cat      = if ($null -ne (V 0x3C)) { (((V 0x3C)[0]*256 + (V 0x3C)[1]) / 10) - 40 } else { $null }
  $timing   = if ($null -ne (V 0x0E)) { (V 0x0E)[0] / 2 - 64 } else { $null }
  $runtime  = if ($null -ne (V 0x1F)) { (V 0x1F)[0]*256 + (V 0x1F)[1] } else { $null }
  $ambient  = if ($null -ne (V 0x46)) { (V 0x46)[0] - 40 } else { $null }
  $fuel     = if ($null -ne (V 0x2F)) { (V 0x2F)[0] * 100 / 255 } else { $null }

  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
  if (-not (Test-Path $csvPath)) {
    'timestamp,rpm,speed_kmh,map_kpa,baro_kpa,throttle_pct,load_pct,coolant_c,oil_c,iat_c,ambient_c,volt,stft_pct,ltft_pct,lambda,cat_c,timing_deg,fuel_rate_lph,fuel_pct,runtime_s' |
      Out-File -FilePath $csvPath -Encoding utf8
  }
  ((@($stamp, (Num $rpm), (Num $speed), (Num $map), (Num $script:baro), (Num $throttle), (Num $load),
      (Num $coolant), (Num $oil), (Num $iat), (Num $ambient), (Num $volt), (Num $stft), (Num $ltft),
      (Num $lambda), (Num $cat), (Num $timing), (Num $fuelRate), (Num $fuel), (Num $runtime))) -join ',') |
    Out-File -FilePath $csvPath -Encoding utf8 -Append

  @"
{"ok":true,"v":{"rpm":$(Num $rpm),"speed":$(Num $speed),"map":$(Num $map),"baro":$(Num $script:baro),
"throttle":$(Num $throttle),"load":$(Num $load),"coolant":$(Num $coolant),"oil":$(Num $oil),
"iat":$(Num $iat),"ambient":$(Num $ambient),"volt":$(Num $volt),"stft":$(Num $stft),"ltft":$(Num $ltft),
"lambda":$(Num $lambda),"cat":$(Num $cat),"timing":$(Num $timing),"fuelRate":$(Num $fuelRate),
"fuel":$(Num $fuel),"runtime":$(Num $runtime)}}
"@ -replace "`r?`n",''
}

# ---------------- http ----------------
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$PORT/")
try { $listener.Start() }
catch {
  Write-Host "[http] could not bind port $PORT : $($_.Exception.Message)"
  Write-Host "       another process may be using it, or run:"
  Write-Host "       netsh http add urlacl url=http://localhost:$PORT/ user=$env:USERNAME"
  exit 1
}
Write-Host "[http] dashboard on http://localhost:$PORT/   (Ctrl+C to stop)"
Start-Process "http://localhost:$PORT/"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.AbsolutePath
    $resp = $ctx.Response
    try {
      if ($path -eq '/data') {
        # throttle: reuse the last sample if it is younger than 200ms
        if (([Environment]::TickCount - $script:lastPoll) -ge 200) {
          $script:lastJson = Poll
          $script:lastPoll = [Environment]::TickCount
        }
        $buf = [Text.Encoding]::UTF8.GetBytes($script:lastJson)
        $resp.ContentType = 'application/json'
        $resp.Headers.Add('Cache-Control','no-store')
      }
      elseif ($path -eq '/' -or $path -eq '/index.html') {
        $buf = [Text.Encoding]::UTF8.GetBytes((Get-Content $htmlPath -Raw))
        $resp.ContentType = 'text/html; charset=utf-8'
      }
      else { $resp.StatusCode = 404; $buf = [Text.Encoding]::UTF8.GetBytes('not found') }

      $resp.ContentLength64 = $buf.Length
      $resp.OutputStream.Write($buf, 0, $buf.Length)
    } catch {
      Write-Host "[http] $($_.Exception.Message)"
    } finally { try { $resp.OutputStream.Close() } catch {} }
  }
} finally {
  try { $listener.Stop() } catch {}
  try { if ($script:sp -and $script:sp.IsOpen) { $script:sp.Close() } } catch {}
  Write-Host "[obd] stopped"
}
