param(
  [string]$ReleaseRoot = "release",
  [string]$ReleaseName = "discovercars-tool",
  [switch]$NoZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$releaseRootPath = Join-Path $projectRoot $ReleaseRoot
$releaseDir = Join-Path $releaseRootPath $ReleaseName
$zipPath = Join-Path $releaseRootPath "$ReleaseName.zip"

if (Test-Path $releaseDir) {
  Remove-Item -Path $releaseDir -Recurse -Force
}

if (Test-Path $zipPath) {
  Remove-Item -Path $zipPath -Force
}

[void](New-Item -ItemType Directory -Path $releaseDir -Force)

$itemsToCopy = @(
  "package.json",
  "package-lock.json",
  "README.md",
  "README-USER.txt",
  "install.ps1",
  "setup.bat",
  "start.bat",
  "run-ui.ps1",
  "run-tables.ps1",
  "src"
)

foreach ($item in $itemsToCopy) {
  $sourcePath = Join-Path $projectRoot $item
  if (-not (Test-Path $sourcePath)) {
    throw "Required item not found: $item"
  }

  $targetPath = Join-Path $releaseDir $item
  if (Test-Path $sourcePath -PathType Container) {
    [void](New-Item -ItemType Directory -Path $targetPath -Force)
    Copy-Item -Path (Join-Path $sourcePath "*") -Destination $targetPath -Recurse -Force
  } else {
    $targetParent = Split-Path -Parent $targetPath
    if (-not (Test-Path $targetParent)) {
      [void](New-Item -ItemType Directory -Path $targetParent -Force)
    }
    Copy-Item -Path $sourcePath -Destination $targetPath -Force
  }
}

if (-not $NoZip) {
  Compress-Archive -Path (Join-Path $releaseDir "*") -DestinationPath $zipPath -Force
}

Write-Host "Release folder ready: $releaseDir" -ForegroundColor Green
if (-not $NoZip) {
  Write-Host "Release ZIP ready   : $zipPath" -ForegroundColor Green
}
