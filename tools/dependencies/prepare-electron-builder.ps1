param(
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$archive = if ($env:AIVS_ELECTRON_BUILDER_7ZIP_ARCHIVE) {
  $env:AIVS_ELECTRON_BUILDER_7ZIP_ARCHIVE
} else {
  Join-Path $root ".deps-download/7zip-bin-5.2.0.tgz"
}
$extracted = Join-Path $root ".deps-download/7zip-bin-extracted"
$sevenZip = if ($env:AIVS_ELECTRON_BUILDER_7ZIP_PATH) { $env:AIVS_ELECTRON_BUILDER_7ZIP_PATH } else {
  Join-Path $extracted "package/win/x64/7za.exe"
}

if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
  if ($env:AIVS_ELECTRON_BUILDER_7ZIP_PATH) {
    throw "Configured electron-builder 7-Zip tool is missing: $sevenZip"
  }
  if ($VerifyOnly) {
    throw "electron-builder 7-Zip tool is missing: $sevenZip; prepare fixed 7zip-bin-5.2.0.tgz or set AIVS_ELECTRON_BUILDER_7ZIP_PATH."
  }
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "electron-builder 7-Zip archive is missing: $archive; set AIVS_ELECTRON_BUILDER_7ZIP_ARCHIVE to 7zip-bin-5.2.0.tgz."
  }
  New-Item -ItemType Directory -Force -Path $extracted | Out-Null
  & tar -xzf $archive -C $extracted
  if ($LASTEXITCODE -ne 0) { throw "Unable to extract electron-builder 7-Zip archive: $archive" }
}

$packageJson = if ($env:AIVS_ELECTRON_BUILDER_7ZIP_PATH) { $null } else { Join-Path $extracted "package/package.json" }
if ($env:AIVS_ELECTRON_BUILDER_7ZIP_PATH) {
  Write-Output "electron-builder 7-Zip ready: $sevenZip (custom path)"
  exit 0
}
if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
  throw "7-Zip archive is missing package/package.json: $packageJson"
}
$package = Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json
if ([string]$package.version -ne "5.2.0") {
  throw "Unsupported 7-Zip tool version: $($package.version); expected 5.2.0."
}
if (-not (Test-Path -LiteralPath $sevenZip -PathType Leaf)) {
  throw "7za.exe is still missing after extraction: $sevenZip"
}
Write-Output "electron-builder 7-Zip ready: $sevenZip (7zip-bin $($package.version))"
