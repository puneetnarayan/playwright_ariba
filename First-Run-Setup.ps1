param(
  [Parameter(Mandatory = $true)][string]$NodeRoot,
  [string]$NodeVersion = 'v22.16.0'
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path -Parent $NodeRoot
$archiveName = "node-$NodeVersion-win-x64.zip"
$downloadUrl = "https://nodejs.org/dist/$NodeVersion/$archiveName"

if (Test-Path (Join-Path $NodeRoot 'node.exe')) {
  Write-Host 'Portable Node.js is already available.'
  exit 0
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$archivePath = Join-Path $runtimeRoot $archiveName
$tempExtract = Join-Path $runtimeRoot 'extract'
Write-Host "Downloading official portable Node.js $NodeVersion (Windows x64) into the shared folder..."
Write-Host 'This happens once per Node.js version and is reused by all app versions. Internet is required.'
try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
  if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
  New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null
  Expand-Archive -Path $archivePath -DestinationPath $tempExtract -Force
  $extracted = Join-Path $tempExtract "node-$NodeVersion-win-x64"
  if (-not (Test-Path (Join-Path $extracted 'node.exe'))) { throw 'The downloaded Node.js archive did not contain node.exe.' }
  if (Test-Path $NodeRoot) { Remove-Item $NodeRoot -Recurse -Force }
  Move-Item -Path $extracted -Destination $NodeRoot
  Remove-Item $tempExtract -Recurse -Force
  Remove-Item $archivePath -Force
  Write-Host 'Portable Node.js is ready.'
} catch {
  Write-Host ''
  Write-Host 'Portable Node.js setup failed.' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host 'Check internet access and whether your office proxy permits downloads from nodejs.org.'
  exit 1
}
