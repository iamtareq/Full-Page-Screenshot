# Full Page Capture - native messaging updater host.
#
# Chrome launches this when the popup's "Update now" button is clicked. It reads
# Chrome's length-prefixed message, fast-forwards the extension/repo folder to the
# remote, and writes a length-prefixed JSON response ({ ok, repo, version, output }).
# It must NEVER write anything else to stdout, or Chrome rejects the response.
#
# Keep this file pure ASCII: Windows PowerShell reads -File scripts as ANSI, so a
# non-ASCII character inside a string breaks parsing.

function Get-GitPath {
  $c = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($c -and $c.Source) { return $c.Source }
  # Chrome can launch us with a PATH that has no git; look in the usual places.
  $cands = @(
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
    "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
  )
  foreach ($p in $cands) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

# Run git and return its combined output as plain text. Native stderr must never
# become a terminating error (git writes normal progress there), so callers judge
# success by $LASTEXITCODE only.
function Invoke-Git {
  param([string[]]$GitArgs)
  (& $script:git @GitArgs 2>&1 | ForEach-Object { "$_" }) -join "`n"
}

try {
  $ErrorActionPreference = 'Stop'
  $stdin = [Console]::OpenStandardInput()

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

  $ErrorActionPreference = 'Continue'
  $script:git = Get-GitPath
  if (-not $script:git) {
    $payload = @{ ok = $false; output = "Git was not found on this PC. Install Git for Windows (git-scm.com), reopen Chrome, then click Update now again." }
  } else {
    $repo = Split-Path -Parent $PSScriptRoot
    # Journal file: written before a reset, removed only after it succeeds. If it is
    # still here on the next run, a previous update was interrupted (AV / OneDrive /
    # power loss) and left half-written files, so a "dirty" tree is our own debris
    # rather than the user's work - force through it instead of refusing forever.
    $sentinel = Join-Path $repo ".git\fpc-update-in-progress"
    $recovering = Test-Path $sentinel

    $fetch = (Invoke-Git @("-C", "$repo", "fetch", "--prune", "origin")).Trim()
    if ($LASTEXITCODE -ne 0) {
      $payload = @{ ok = $false; repo = $repo; output = ("Fetch failed (offline / no access?):`n" + $fetch).Trim() }
    } else {
      $branch = (Invoke-Git @("-C", "$repo", "rev-parse", "--abbrev-ref", "HEAD")).Trim()
      if (-not $branch -or $branch -eq "HEAD") { $branch = "main" }

      # stdout only: stray stderr must never be mistaken for a dirty working tree
      $dirty = ""
      if (-not $recovering) {
        $dirty = ((& $script:git -C "$repo" status --porcelain --untracked-files=no) | Out-String).Trim()
      }

      if ($dirty) {
        $payload = @{ ok = $false; repo = $repo; output = ("Update skipped: this copy has uncommitted local changes, so it was NOT overwritten. Commit or discard them, then update:`n" + $dirty).Trim() }
      } else {
        New-Item -ItemType File -Path $sentinel -Force -ErrorAction SilentlyContinue | Out-Null
        $reset = (Invoke-Git @("-C", "$repo", "reset", "--hard", "origin/$branch")).Trim()
        $ok = ($LASTEXITCODE -eq 0)
        # A locked file (antivirus / OneDrive / open editor) fails the checkout. Those
        # handles are usually transient, so give it one more go before giving up.
        if (-not $ok -and ($reset -match "unable to unlink|Invalid argument|Permission denied|Access is denied")) {
          Start-Sleep -Milliseconds 1500
          $reset = (Invoke-Git @("-C", "$repo", "reset", "--hard", "origin/$branch")).Trim()
          $ok = ($LASTEXITCODE -eq 0)
        }
        if ($ok) {
          Remove-Item $sentinel -Force -ErrorAction SilentlyContinue
        } elseif ($reset -match "unable to unlink|Invalid argument|Permission denied|Access is denied") {
          $reset = "A program is holding one of the extension files open (antivirus, OneDrive sync, or an open editor). Close it or exclude this folder, then click Retry.`n" + $reset
        }
        $newVer = ""
        try { $newVer = (Get-Content -Raw "$repo\manifest.json" | ConvertFrom-Json).version } catch {}
        $payload = @{ ok = $ok; repo = $repo; version = $newVer; output = ($fetch + "`n" + $reset).Trim() }
      }
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
