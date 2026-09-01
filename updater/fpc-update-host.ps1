# Full Page Capture - native messaging updater host.
#
# Chrome launches this when the popup's "Update now" button is clicked. It reads
# Chrome's length-prefixed message, fast-forwards the extension/repo folder to the
# remote (git fetch + reset --hard, guarded - see below), and writes a length-prefixed
# JSON response ({ ok, output }). It must NEVER write anything else to stdout, or
# Chrome will reject the (malformed) response. Keep this file pure ASCII: Windows
# PowerShell reads -File scripts as ANSI, so non-ASCII chars in a string break parsing.

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

  # ---- do the work: fetch, then fast-forward the repo (parent folder of this script)
  # to the remote branch. Teammates run plain clones (never edit the code), so this just
  # advances them to the latest. Safety: only reset AFTER a successful fetch, and REFUSE
  # to touch a working tree that has local changes, so an actively-edited copy (e.g. the
  # developer's own) is never silently wiped. ----
  $repo = Split-Path -Parent $PSScriptRoot
  $fetch = & git -C "$repo" fetch --prune origin 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    $payload = @{ ok = $false; output = ("Fetch failed (offline / no access?):`n" + $fetch).Trim() }
  } else {
    $branch = (& git -C "$repo" rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
    if (-not $branch -or $branch -eq "HEAD") { $branch = "main" }
    $dirty = (& git -C "$repo" status --porcelain 2>&1 | Out-String).Trim()
    if ($dirty) {
      $payload = @{ ok = $false; output = ("Update skipped: this copy has uncommitted local changes, so it was NOT overwritten. Commit or discard them, then update:`n" + $dirty).Trim() }
    } else {
      $reset = & git -C "$repo" reset --hard "origin/$branch" 2>&1 | Out-String
      $ok = ($LASTEXITCODE -eq 0)
      $payload = @{ ok = $ok; output = ($fetch + $reset).Trim() }
    }
  }
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
