param(
  [switch]$Force,
  [string]$ArchiveUrl,
  [string]$ArchiveSha256
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$targetDir = Join-Path $repoRoot 'resources\ffmpeg\win'
$licenseDir = Join-Path $repoRoot 'resources\ffmpeg\licenses'
$ffmpegTarget = Join-Path $targetDir 'ffmpeg.exe'
$ffprobeTarget = Join-Path $targetDir 'ffprobe.exe'

# BtbN's old autobuild tags are pruned. Resolve the current LGPL asset from
# the renamed official FFmpeg-Builds repository and verify GitHub's SHA-256
# asset digest before extracting anything. An explicit URL + digest pair can
# be supplied for fully pinned/reproducible packaging.
$assetName = 'ffmpeg-n9.0-latest-win64-lgpl-9.0.zip'
$officialBase = 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/'
if ([string]::IsNullOrWhiteSpace($ArchiveUrl) -xor [string]::IsNullOrWhiteSpace($ArchiveSha256)) {
  throw 'Provide both -ArchiveUrl and -ArchiveSha256 for a pinned FFmpeg archive'
}
if ($ArchiveUrl) {
  if ($ArchiveUrl -notmatch '^https://github\.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/[a-zA-Z0-9_.-]+/ffmpeg-[a-zA-Z0-9_.-]+-win64-lgpl(?:-shared)?(?:-[0-9.]+)?\.zip$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
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
 -or
      $ArchiveSha256 -notmatch '^[0-9a-fA-F]{64}$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
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
) {
    throw 'Pinned FFmpeg URL must reference official LGPL release and a SHA-256 digest'
  }
  $archiveUrl = $ArchiveUrl
  $archiveSha256 = $ArchiveSha256.ToLowerInvariant()
} else {
  $headers = @{ 'User-Agent' = 'NetPanDownload-CI'; 'Accept' = 'application/vnd.github+json' }
  if ($env:GITHUB_TOKEN) { $headers['Authorization'] = 'Bearer ' + $env:GITHUB_TOKEN }
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/FFmpeg-Builds/FFmpeg-Builds/releases/latest' -Headers $headers -TimeoutSec 60
  $asset = @($release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1)
  if ($asset.Count -ne 1 -or $asset[0].digest -notmatch '^sha256:([0-9a-fA-F]{64})$tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
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
) {
    throw 'Official FFmpeg release missing requested LGPL asset or SHA-256 digest'
  }
  $archiveSha256 = $Matches[1].ToLowerInvariant()
  $archiveUrl = [string]$asset[0].browser_download_url
  if ($archiveUrl -ne ($officialBase + $assetName) -or
      [long]$asset[0].size -lt 30000000 -or [long]$asset[0].size -gt 300000000) {
    throw 'Official FFmpeg release returned unexpected asset metadata'
  }
}
Write-Host "Preparing official FFmpeg LGPL archive: $archiveUrl"
Write-Host "Expected SHA-256: $archiveSha256"
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
