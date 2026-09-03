# Writes the Chrome native-messaging host manifest as PURE ASCII JSON.
#
# Any non-ASCII character in the install path (e.g. a user folder with accents) is
# escaped to \uXXXX, so the file stays valid JSON whatever the machine's code page
# is. Writing it raw used to silently produce a corrupt manifest while the installer
# still reported success, leaving "Update now" permanently broken.
param(
  [Parameter(Mandatory = $true)][string]$HostBat,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$ExtensionId
)

$m = [ordered]@{
  name            = 'com.fpc.updater'
  description     = 'Full Page Capture updater'
  path            = $HostBat
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$json = $m | ConvertTo-Json -Depth 4
$sb = New-Object System.Text.StringBuilder
foreach ($ch in $json.ToCharArray()) {
  if ([int]$ch -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) }
  else { [void]$sb.Append($ch) }
}
[IO.File]::WriteAllText($OutFile, $sb.ToString(), [Text.Encoding]::ASCII)

# Prove it round-trips before we claim success.
$check = Get-Content -Raw $OutFile | ConvertFrom-Json
if ($check.path -ne $HostBat) { throw "manifest path did not round-trip" }
