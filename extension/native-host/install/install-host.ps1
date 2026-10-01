# Installs the Myrmidon sign helper as a Chrome/Edge native messaging host on
# Windows. Parameters:
#   -ExtensionId <id>  required, the Chrome/Edge extension ID allowed to talk to the host
#   -HostPath <path>   required, absolute path to the host launcher (host.cmd)
#   -ManifestDir <dir> optional, where to write the manifest (default: %LOCALAPPDATA%\Myrmidon\SignHelper)
#   -Browser <chrome|edge>  which browser registry to write (default: chrome)
#
# The manifest pins allowed_origins to exactly one extension ID: the browser
# will only launch the host for that extension. The host itself has no network
# interfaces, so this registration is the single trust boundary.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [Parameter(Mandatory = $true)]
  [string]$HostPath,

  [string]$ManifestDir = (Join-Path $env:LOCALAPPDATA 'Myrmidon\SignHelper'),

  [ValidateSet('chrome', 'edge')]
  [string]$Browser = 'chrome'
)

$ErrorActionPreference = 'Stop'

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "ExtensionId must be a 32-character Chrome extension ID (a-p), got: $ExtensionId"
}

if (-not (Test-Path $HostPath)) {
  throw "HostPath does not exist: $HostPath"
}

$hostName = 'com.myrmidon.sign-helper'
New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null
$manifestPath = Join-Path $ManifestDir "$hostName.json"

$manifest = [ordered]@{
  name = $hostName
  description = 'Myrmidon local signing helper (native messaging host)'
  path = $HostPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

$browserRoots = @{
  chrome = 'HKCU:\Software\Google\Chrome\NativeMessageHosts'
  edge   = 'HKCU:\Software\Microsoft\Edge\NativeMessageHosts'
}
$regPath = Join-Path $browserRoots[$Browser] $hostName
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name '(Default)' -Value $manifestPath

Write-Host "Registered $hostName ($Browser) at $regPath"
Write-Host "Manifest: $manifestPath (allowed origin: chrome-extension://$ExtensionId/)"
