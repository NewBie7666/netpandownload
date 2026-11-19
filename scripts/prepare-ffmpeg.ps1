param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$targetDir = Join-Path $repoRoot 'resources\ffmpeg\win'
$licenseDir = Join-Path $repoRoot 'resources\ffmpeg\licenses'
$ffmpegTarget = Join-Path $targetDir 'ffmpeg.exe'
$ffprobeTarget = Join-Path $targetDir 'ffprobe.exe'

# This is the LGPL Windows build used by the portable release. Keep the URL and
# digest together so a release cannot silently pick up a different binary.
$archiveUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-05-12-48/ffmpeg-N-128433-gdb8537d8cc-win64-lgpl.zip'
$archiveSha256 = '0c813ecf72481a5ee39480423551e4bea230d8249b7d1d2130c7c8b2d61c4c44'
$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$tempRoot = Join-Path $tempParent ('netpandownload-ffmpeg-' + [Guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot 'ffmpeg.zip'
$extractDir = Join-Path $tempRoot 'extract'

function Fail([string]$message) {
  throw "FFmpeg preparation failed: $message"
}

function Verify-Executable([string]$path, [string]$argument) {
  if (-not (Test-Path -LiteralPath $path)) { Fail "missing $path" }
  & $path $argument | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "$path $argument failed" }
}

try {
  if (-not $Force -and (Test-Path -LiteralPath $ffmpegTarget) -and (Test-Path -LiteralPath $ffprobeTarget) -and (Test-Path -LiteralPath $licenseDir)) {
    Verify-Executable $ffmpegTarget '-version'
    Verify-Executable $ffprobeTarget '-version'
    Write-Host "FFmpeg and FFprobe already prepared: $targetDir"
    exit 0
  }

  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing -TimeoutSec 300
  $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $archiveSha256) {
    Fail "archive SHA-256 mismatch. Expected $archiveSha256, got $actual"
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
  $ffmpeg = Get-ChildItem -LiteralPath $extractDir -Filter 'ffmpeg.exe' -File -Recurse | Select-Object -First 1
  $ffprobe = Get-ChildItem -LiteralPath $extractDir -Filter 'ffprobe.exe' -File -Recurse | Select-Object -First 1
  if (-not $ffmpeg -or -not $ffprobe) { Fail 'archive lacks ffmpeg.exe or ffprobe.exe' }
  Copy-Item -LiteralPath $ffmpeg.FullName -Destination $ffmpegTarget -Force
  Copy-Item -LiteralPath $ffprobe.FullName -Destination $ffprobeTarget -Force

  # Copy any side-by-side codec/runtime DLLs included in the archive.
  Get-ChildItem -LiteralPath $ffmpeg.DirectoryName -Filter '*.dll' -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetDir $_.Name) -Force
  }
  $notices = @(Get-ChildItem -LiteralPath $extractDir -File -Recurse | Where-Object {
    $_.Name -match '^(LICENSE|COPYING|README|GPL|LGPL)(\..*)?$'
  })
  if (-not $notices.Count) { Fail 'archive lacks upstream license notices' }
  New-Item -ItemType Directory -Path $licenseDir -Force | Out-Null
  $notices | Copy-Item -Destination $licenseDir -Force
  Verify-Executable $ffmpegTarget '-version'
  Verify-Executable $ffprobeTarget '-version'
  Write-Host "Prepared FFmpeg and FFprobe in $targetDir"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    $resolvedTemp = (Resolve-Path -LiteralPath $tempRoot).Path
    if ([IO.Path]::GetDirectoryName($resolvedTemp) -eq $tempParent -and [IO.Path]::GetFileName($resolvedTemp) -match '^netpandownload-ffmpeg-[0-9a-f]{32}$') {
      Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
