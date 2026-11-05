# Build-time only. Hash-verified tools are bundled into the portable EXE.
# This script is never run on the end user's PC.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('netpan-runtime-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

function Download-Pinned([string]$Name, [string]$Url, [string]$Sha256, [string]$Destination) {
  Write-Host "Fetching $Name from pinned upstream release"
  $downloaded = $false
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 300
      $downloaded = $true
      break
    } catch {
      if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
      Write-Warning "$Name download attempt $attempt/5 failed: $($_.Exception.Message)"
      if ($attempt -eq 5) { throw }
      Start-Sleep -Seconds (5 * $attempt)
    }
  }
  if (-not $downloaded) { throw "Could not download $Name" }
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256.ToLowerInvariant()) {
    Remove-Item -LiteralPath $Destination -Force
    throw "$Name SHA-256 mismatch. Expected $Sha256, got $actual"
  }
  Write-Host "$Name SHA-256 verified: $actual"
}
function Require-ExitZero([string]$Exe, [string]$Arg) {
  & $Exe $Arg | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed version check" }
}
try {
  $ariaZip = Join-Path $tmp 'aria2.zip'
  Download-Pinned 'aria2 1.37.0 Win64' 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip' '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288' $ariaZip
  $ariaExtract = Join-Path $tmp 'aria2'
  Expand-Archive -LiteralPath $ariaZip -DestinationPath $ariaExtract -Force
  $ariaExe = Get-ChildItem -Path $ariaExtract -Filter aria2c.exe -File -Recurse | Select-Object -First 1
  if (-not $ariaExe) { throw 'aria2c.exe missing from official archive' }
  $ariaExeHash = (Get-FileHash -LiteralPath $ariaExe.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ariaExeHash -ne 'be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2') {
    throw "Unexpected aria2c.exe digest: $ariaExeHash"
  }
  $ariaTarget = Join-Path $root 'resources\aria2\win'
  New-Item -ItemType Directory -Path $ariaTarget -Force | Out-Null
  Copy-Item -LiteralPath $ariaExe.FullName -Destination (Join-Path $ariaTarget 'aria2c.exe') -Force
  Require-ExitZero (Join-Path $ariaTarget 'aria2c.exe') '--version'

  $ytTarget = Join-Path $root 'resources\yt-dlp\win'
  New-Item -ItemType Directory -Path $ytTarget -Force | Out-Null
  $ytExe = Join-Path $ytTarget 'yt-dlp.exe'
  Download-Pinned 'yt-dlp 2026.10.26 Win64' 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe' 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d' $ytExe
  Require-ExitZero $ytExe '--version'

  $galleryTarget = Join-Path $root 'resources\gallery-dl\win'
  New-Item -ItemType Directory -Path $galleryTarget -Force | Out-Null
  $galleryExe = Join-Path $galleryTarget 'gallery-dl.exe'
  Download-Pinned 'gallery-dl Windows 2026.11.05' 'https://github.com/gdl-org/builds/releases/download/2026.11.05/gallery-dl_windows.exe' 'dcfc5b0d5e6059b21a72765cfd77d0691754aa0294dee62813ae2e1ca553560d' $galleryExe
  Require-ExitZero $galleryExe '--version'

  $ffmpegZip = Join-Path $tmp 'ffmpeg-lgpl.zip'
  Download-Pinned 'FFmpeg LGPL Win64 autobuild 2026-11-05' 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-05-12-48/ffmpeg-N-128433-gdb8537d8cc-win64-lgpl.zip' '0c813ecf72481a5ee39480423551e4bea230d8249b7d1d2130c7c8b2d61c4c44' $ffmpegZip
  $ffmpegExtract = Join-Path $tmp 'ffmpeg-extract'
  Expand-Archive -LiteralPath $ffmpegZip -DestinationPath $ffmpegExtract -Force
  $ffmpegExe = Get-ChildItem -Path $ffmpegExtract -Filter ffmpeg.exe -File -Recurse | Select-Object -First 1
  $ffprobeExe = Get-ChildItem -Path $ffmpegExtract -Filter ffprobe.exe -File -Recurse | Select-Object -First 1
  if (-not $ffmpegExe -or -not $ffprobeExe) { throw 'FFmpeg archive lacks ffmpeg.exe or ffprobe.exe' }
  $ffmpegTarget = Join-Path $root 'resources\ffmpeg\win'
  New-Item -ItemType Directory -Path $ffmpegTarget -Force | Out-Null
  Copy-Item -LiteralPath $ffmpegExe.FullName -Destination (Join-Path $ffmpegTarget 'ffmpeg.exe') -Force
  Copy-Item -LiteralPath $ffprobeExe.FullName -Destination (Join-Path $ffmpegTarget 'ffprobe.exe') -Force
  Get-ChildItem -LiteralPath $ffmpegExe.DirectoryName -Filter '*.dll' -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $ffmpegTarget $_.Name) -Force
  }
  $licenseTarget = Join-Path $root 'resources\ffmpeg\licenses'
  New-Item -ItemType Directory -Path $licenseTarget -Force | Out-Null
  Get-ChildItem -Path $ffmpegExtract -Recurse -File | Where-Object {
    $_.Name -match '^(LICENSE|COPYING|README|GPL|LGPL)(\..*)?$' -and $_.Length -lt 2000000
  } | Select-Object -First 12 | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $licenseTarget $_.Name) -Force
  }
  Require-ExitZero (Join-Path $ffmpegTarget 'ffmpeg.exe') '-version'
  Require-ExitZero (Join-Path $ffmpegTarget 'ffprobe.exe') '-version'
  Write-Host 'Pinned runtime dependencies are ready. End users do not install them.'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
