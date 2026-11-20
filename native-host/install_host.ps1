param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$HostDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $HostDir "com.hermes.wg_ovpn_host.json"
$BatPath = Join-Path $HostDir "host.bat"

$manifest = @{
  name = "com.hermes.wg_ovpn_host"
  description = "WG & OpenVPN Native Messaging Host"
  path = $BatPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8

$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.hermes.wg_ovpn_host"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath

Write-Host "Registered Native Messaging Host for chrome-extension://$ExtensionId/"
