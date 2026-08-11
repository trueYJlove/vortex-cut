$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$bootstrap = Join-Path $PSScriptRoot "bootstrap-windows.ps1"
$powershell = (Get-Command powershell.exe).Source

& $powershell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -VerifyOnly
if ($LASTEXITCODE -ne 0) { throw "Windows dependency preflight failed; see build/reports/bootstrap-windows.json." }

$desktop = Join-Path $root "apps/desktop"
$packageReport = if ($env:AIVS_PACKAGE_REPORT) { $env:AIVS_PACKAGE_REPORT } else { Join-Path $root "build/reports/windows-package-latest.json" }
$oldPackageDir = $env:AIVS_PACKAGE_DIR
$oldPackageReport = $env:AIVS_PACKAGE_REPORT
try {
  if (Test-Path -LiteralPath $packageReport -PathType Leaf) {
    $report = Get-Content -Raw -LiteralPath $packageReport | ConvertFrom-Json
    if ($report.schema_version -ne 1 -or $report.status -ne "built" -or [string]::IsNullOrWhiteSpace([string]$report.package_root)) {
      throw "Windows package report is not a completed build: $packageReport"
    }
    $env:AIVS_PACKAGE_DIR = [System.IO.Path]::GetFullPath([string]$report.package_root)
  } elseif ([string]::IsNullOrWhiteSpace($env:AIVS_PACKAGE_DIR)) {
    throw "Windows package report is missing; refusing to verify an unspecified or stale release directory: $packageReport"
  }
  $env:AIVS_PACKAGE_REPORT = [System.IO.Path]::GetFullPath($packageReport)
  Push-Location $desktop
  & node scripts/verify-package.mjs
  if ($LASTEXITCODE -ne 0) { throw "Packaged component verification failed." }
}
finally {
  Pop-Location
  if ($null -eq $oldPackageDir) { Remove-Item Env:AIVS_PACKAGE_DIR -ErrorAction SilentlyContinue }
  else { $env:AIVS_PACKAGE_DIR = $oldPackageDir }
  if ($null -eq $oldPackageReport) { Remove-Item Env:AIVS_PACKAGE_REPORT -ErrorAction SilentlyContinue }
  else { $env:AIVS_PACKAGE_REPORT = $oldPackageReport }
}
Write-Output "Windows package verify passed; report: build/reports/bootstrap-windows.json"
