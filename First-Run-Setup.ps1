$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $root 'runtime'
$nodeRoot = Join-Path $runtimeRoot 'node'
$nodeVersion = 'v22.16.0'
$archiveName = "node-$nodeVersion-win-x64.zip"
$downloadUrl = "https://nodejs.org/dist/$nodeVersion/$archiveName"

if (Test-Path (Join-Path $nodeRoot 'node.exe')) {
  Write-Host 'Portable Node.js is already available.'
  exit 0
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$archivePath = Join-Path $runtimeRoot $archiveName
$tempExtract = Join-Path $runtimeRoot 'extract'
Write-Host "Downloading official portable Node.js $nodeVersion (Windows x64)..."
Write-Host 'This is a one-time setup and requires an internet connection.'
try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
  if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
  New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null
  Expand-Archive -Path $archivePath -DestinationPath $tempExtract -Force
  $extracted = Join-Path $tempExtract "node-$nodeVersion-win-x64"
  if (-not (Test-Path (Join-Path $extracted 'node.exe'))) { throw 'The downloaded Node.js archive did not contain node.exe.' }
  if (Test-Path $nodeRoot) { Remove-Item $nodeRoot -Recurse -Force }
  Move-Item -Path $extracted -Destination $nodeRoot
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
