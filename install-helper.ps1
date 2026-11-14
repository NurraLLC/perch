# Installs the Perch helper for the current Windows user (no admin needed).
# Builds it with the C# compiler that ships with Windows, copies it to %LOCALAPPDATA%\Perch,
# and registers it as a native-messaging host for Chrome, Edge and Brave.
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$ExtensionId = 'pnfdmflogbepmejlgfbifejmmmoileia'
$HostName = 'com.perch.helper'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'Perch'
$Exe = Join-Path $Dest 'perch-helper.exe'
$Manifest = Join-Path $Dest "$HostName.json"
$Keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)

Get-Process perch-helper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if ($Uninstall) {
  foreach ($k in $Keys) { if (Test-Path $k) { Remove-Item $k -Force } }
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
  Write-Host 'Perch helper removed.'
  exit 0
}

New-Item -ItemType Directory -Force $Dest | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "The .NET Framework C# compiler was not found at $csc" }
& $csc /nologo /optimize+ /target:winexe /platform:x64 "/out:$Exe" /r:System.Web.Extensions.dll (Join-Path $Root 'helper\PerchHelper.cs')
if ($LASTEXITCODE -ne 0) { throw 'Building the helper failed.' }

$json = [ordered]@{
  name = $HostName
  description = 'Perch helper: keeps floating videos above other apps'
  path = $Exe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
Set-Content -Path $Manifest -Value $json -Encoding UTF8

foreach ($k in $Keys) {
  New-Item -Path $k -Force | Out-Null
  Set-Item -Path $k -Value $Manifest
}

Write-Host "Perch helper installed to $Dest"
Write-Host 'Reload the Perch extension (or restart the browser) to connect.'
