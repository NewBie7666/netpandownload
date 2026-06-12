param(
  [string]$Version = "1.37.0",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $repoRoot "resources\aria2\win"
$targetExe = Join-Path $targetDir "aria2c.exe"
$releaseTag = "release-$Version"
$assetName = "aria2-$Version-win-64bit-build1.zip"
$downloadUrl = "https://github.com/aria2/aria2/releases/download/$releaseTag/$assetName"
$tempRoot = Join-Path $env:TEMP "netpandownload-aria2-$Version"
$zipPath = Join-Path $tempRoot $assetName
$extractDir = Join-Path $tempRoot "extract"

function Fail($message) {
  Write-Error $message
  exit 1
}

try {
  if ((Test-Path -LiteralPath $targetExe) -and -not $Force) {
    Write-Host "aria2c.exe already exists: $targetExe"
    Write-Host "Use -Force to download and replace it."
    & $targetExe --version
    if ($LASTEXITCODE -ne 0) {
      Fail "Existing aria2c.exe failed --version verification. Rerun with -Force."
    }
    exit 0
  }

  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

  if (Test-Path -LiteralPath $extractDir) {
    Remove-Item -LiteralPath $extractDir -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

  Write-Host "Downloading aria2 $Version from:"
  Write-Host $downloadUrl
  Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing

  Write-Host "Extracting $zipPath"
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

  $downloadedExe = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter "aria2c.exe" | Select-Object -First 1
  if (-not $downloadedExe) {
    Fail "aria2c.exe was not found in the downloaded archive."
  }

  Copy-Item -LiteralPath $downloadedExe.FullName -Destination $targetExe -Force

  Write-Host "Verifying aria2c.exe"
  & $targetExe --version
  if ($LASTEXITCODE -ne 0) {
    Fail "aria2c.exe --version failed."
  }

  Write-Host "aria2c.exe is ready: $targetExe"
} catch {
  Fail $_.Exception.Message
}
