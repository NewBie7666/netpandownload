param(
  [string]$Version = "latest",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $repoRoot "resources\yt-dlp\win"
$targetExe = Join-Path $targetDir "yt-dlp.exe"
if ($Version -eq "latest") {
  $downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
} else {
  $downloadUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/$Version/yt-dlp.exe"
}

function Fail($message) {
  Write-Error $message
  exit 1
}

try {
  if ((Test-Path -LiteralPath $targetExe) -and -not $Force) {
    Write-Host "yt-dlp.exe already exists: $targetExe"
    Write-Host "Use -Force to download and replace it."
    & $targetExe --version
    if ($LASTEXITCODE -ne 0) {
      Fail "Existing yt-dlp.exe failed --version verification. Rerun with -Force."
    }
    exit 0
  }

  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  Write-Host "Downloading yt-dlp $Version from:"
  Write-Host $downloadUrl
  Invoke-WebRequest -Uri $downloadUrl -OutFile $targetExe -UseBasicParsing

  Write-Host "Verifying yt-dlp.exe"
  & $targetExe --version
  if ($LASTEXITCODE -ne 0) {
    Fail "yt-dlp.exe --version failed."
  }

  Write-Host "yt-dlp.exe is ready: $targetExe"
} catch {
  Fail $_.Exception.Message
}
