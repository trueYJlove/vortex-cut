param([string]$PackageRoot = (Join-Path $PSScriptRoot "../../dist/sidecar"))
$ErrorActionPreference = "Stop"
$required = @(
  "core/aivs-core/aivs-core.exe",
  "ffmpeg/win-x64/ffmpeg.exe",
  "ffmpeg/win-x64/ffprobe.exe",
  "licenses/THIRD_PARTY_NOTICES.txt",
  "manifests/components.json"
)
foreach ($relative in $required) {
  $path = Join-Path $PackageRoot $relative
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Package missing: $relative" }
}
Write-Output "package verify: PASS ($PackageRoot)"
