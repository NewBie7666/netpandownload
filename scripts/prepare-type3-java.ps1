[CmdletBinding()]
param(
  [string]$ArchivePath = '',
  [string]$OutputPath = '',
  [string]$ExpectedSha256 = '9E067163D60AD677BD85028D32DCE31B870C5F40DAA5DC07D74311604BBAC4E0',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot '..\resources\type3\java' }

function Require-File([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
}

function Require-Directory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label is missing: $Path"
  }
}

if (-not $ArchivePath) {
  $ArchivePath = [Environment]::GetEnvironmentVariable('NETPAN_TYPE3_TVBOXPC_ARCHIVE')
}
if (-not $ArchivePath) {
  throw 'Pass -ArchivePath with TVBoxPC_v1.8.1.zip, or set NETPAN_TYPE3_TVBOXPC_ARCHIVE. The script never downloads a third-party runtime implicitly.'
}
$ArchivePath = [IO.Path]::GetFullPath($ArchivePath)
Require-File $ArchivePath 'TVBoxPC runtime archive'
if ($ExpectedSha256) {
  $actualSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
  if ($actualSha256 -notmatch ('^' + [regex]::Escape($ExpectedSha256) + '$')) {
    throw "TVBoxPC archive SHA256 mismatch: expected $ExpectedSha256, got $actualSha256"
  }
}

$sourceTemplate = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\resources\type3\java\src\NetPanSpiderRunner.java'))
Require-File $sourceTemplate 'NetPanSpiderRunner.java'

$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ((Test-Path -LiteralPath $OutputPath) -and -not $Force) {
  $existing = Get-ChildItem -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) { throw "Output directory is not empty: $OutputPath; use -Force to replace it" }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('netpan-type3-java-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  $sourceStaged = Join-Path $work 'NetPanSpiderRunner.java'
  Copy-Item -LiteralPath $sourceTemplate -Destination $sourceStaged -Force
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $work -Force

  $stubs = Get-ChildItem -LiteralPath $work -Filter 'stubs.jar' -File -Recurse |
    Where-Object {
      $_.FullName -match '[\\/]jvm[\\/]stubs[\\/]stubs\.jar$' -and
      (Test-Path -LiteralPath (Join-Path (Split-Path (Split-Path $_.FullName -Parent) -Parent) 'jre') -PathType Container)
    } | Select-Object -First 1
  if (-not $stubs) { throw 'jvm/stubs/stubs.jar was not found in the archive' }
  $runtime = Split-Path (Split-Path $stubs.FullName -Parent) -Parent
  foreach ($required in @('jre', 'libs', 'd2j', 'stubs')) {
    Require-Directory (Join-Path $runtime $required) "JVM runtime directory $required"
  }

  if (Test-Path -LiteralPath $OutputPath) {
    if ($Force) {
      # Replace only generated runtime directories and preserve maintained src.
      $outputPrefix = $OutputPath.TrimEnd('\') + '\'
      foreach ($managed in @('jre', 'libs', 'd2j', 'stubs', 'tools', 'runner')) {
        $targetDirectory = [IO.Path]::GetFullPath((Join-Path $OutputPath $managed))
        if (-not $targetDirectory.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) {
          throw "Refusing to remove a path outside the runtime directory: $targetDirectory"
        }
        if (Test-Path -LiteralPath $targetDirectory) { Remove-Item -LiteralPath $targetDirectory -Recurse -Force }
      }
    }
  }
  New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
  foreach ($directory in @('jre', 'libs', 'd2j', 'stubs')) {
    Copy-Item -LiteralPath (Join-Path $runtime $directory) -Destination $OutputPath -Recurse -Force
  }
  $toolsOutput = Join-Path $OutputPath 'tools'
  New-Item -ItemType Directory -Path $toolsOutput -Force | Out-Null
  $ecjRuntime = Join-Path $runtime 'tools\ecj.jar'
  if (Test-Path -LiteralPath $ecjRuntime -PathType Leaf) { Copy-Item -LiteralPath $ecjRuntime -Destination $toolsOutput -Force }

  $sourceDirectory = Join-Path $OutputPath 'src'
  New-Item -ItemType Directory -Path $sourceDirectory -Force | Out-Null
  $source = Join-Path $sourceDirectory 'NetPanSpiderRunner.java'
  Copy-Item -LiteralPath $sourceStaged -Destination $source -Force
  $runnerDirectory = Join-Path $OutputPath 'runner'
  New-Item -ItemType Directory -Path $runnerDirectory -Force | Out-Null
  $stubsJar = Join-Path $OutputPath 'stubs\stubs.jar'
  $javac = Get-Command javac -ErrorAction SilentlyContinue
  if ($javac) {
    & $javac.Source -encoding UTF-8 -source 11 -target 11 -cp $stubsJar -d $runnerDirectory $source
    if ($LASTEXITCODE -ne 0) { throw "javac failed to compile Runner (exit code $LASTEXITCODE)" }
  } else {
    $ecj = Join-Path $runtime 'tools\ecj.jar'
    Require-File $ecj 'ECJ compiler'
    $java = Join-Path $OutputPath 'jre\bin\java.exe'
    Require-File $java 'JRE java.exe'
    & $java -cp $ecj org.eclipse.jdt.internal.compiler.batch.Main -encoding UTF-8 -source 11 -target 11 -cp $stubsJar -d $runnerDirectory $source
    if ($LASTEXITCODE -ne 0) { throw "ECJ failed to compile Runner (exit code $LASTEXITCODE)" }
  }
  Require-File (Join-Path $runnerDirectory 'NetPanSpiderRunner.class') 'compiled Runner'

  # TVBoxPC's bridge and dex-tools are redistributed only with their notices.
  $license = Get-ChildItem -LiteralPath $runtime -Filter 'WinBox-LICENSE.txt' -File -Recurse |
    Select-Object -First 1
  if ($license) { Copy-Item -LiteralPath $license.FullName -Destination $OutputPath -Force }
  $d2jLicense = Get-ChildItem -LiteralPath (Join-Path $OutputPath 'd2j') -Filter 'LICENSE.txt' -File |
    Select-Object -First 1
  if ($d2jLicense) { Copy-Item -LiteralPath $d2jLicense.FullName -Destination (Join-Path $OutputPath 'd2j-LICENSE.txt') -Force }

  Write-Host "Type3 JVM runtime prepared: $OutputPath"
  Write-Host 'Included JRE, Android stubs, dex2jar, libraries, and NetPanSpiderRunner.'
} finally {
  $resolvedWork = [IO.Path]::GetFullPath($work)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $workName = Split-Path -Leaf $resolvedWork
  if (-not $resolvedWork.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      $workName -notmatch '^netpan-type3-java-[0-9a-f]+$') {
    throw "Refusing to remove an unexpected temporary path: $resolvedWork"
  }
  if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
}
