# Full Page Capture — native messaging updater host.
#
# Chrome launches this when the popup's "Update now" button is clicked. It reads
# Chrome's length-prefixed message, runs `git pull` in the extension/repo folder,
# and writes a length-prefixed JSON response ({ ok, output }). It must NEVER write
# anything else to stdout, or Chrome will reject the (malformed) response.

try {
  $ErrorActionPreference = 'Stop'
  $stdin  = [Console]::OpenStandardInput()

  # ---- read the 4-byte little-endian length, then that many bytes (the request) ----
  $lenBuf = New-Object byte[] 4
  $got = 0
  while ($got -lt 4) {
    $n = $stdin.Read($lenBuf, $got, 4 - $got)
    if ($n -le 0) { break }
    $got += $n
  }
  if ($got -ge 4) {
    $msgLen = [BitConverter]::ToInt32($lenBuf, 0)
    if ($msgLen -gt 0 -and $msgLen -lt 1048576) {
      $msgBuf = New-Object byte[] $msgLen
      $got = 0
      while ($got -lt $msgLen) {
        $n = $stdin.Read($msgBuf, $got, $msgLen - $got)
        if ($n -le 0) { break }
        $got += $n
      }
    }
  }

  # ---- do the work: git pull in the repo (parent folder of this script) ----
  $repo = Split-Path -Parent $PSScriptRoot
  $out  = & git -C "$repo" pull 2>&1 | Out-String
  $ok   = ($LASTEXITCODE -eq 0)
  $payload = @{ ok = $ok; output = $out.Trim() }
}
catch {
  $payload = @{ ok = $false; output = "$_" }
}

# ---- write the length-prefixed JSON response ----
$json   = ($payload | ConvertTo-Json -Compress)
$bytes  = [Text.Encoding]::UTF8.GetBytes($json)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
