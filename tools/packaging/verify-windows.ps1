$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$bootstrap = Join-Path $PSScriptRoot "bootstrap-windows.ps1"
$powershell = (Get-Command powershell.exe).Source

& $powershell -NoProfile -ExecutionPolicy Bypass -File $bootstrap -VerifyOnly
if ($LASTEXITCODE -ne 0) { throw "Windows dependency preflight failed; see build/reports/bootstrap-windows.json." }

$desktop = Join-Path $root "apps/desktop"
$oldPackageDir = $env:AIVS_PACKAGE_DIR
try {
  Push-Location $desktop
  & node scripts/verify-package.mjs
  if ($LASTEXITCODE -ne 0) { throw "Packaged component verification failed." }
}
finally {
  Pop-Location
  if ($null -eq $oldPackageDir) { Remove-Item Env:AIVS_PACKAGE_DIR -ErrorAction SilentlyContinue }
  else { $env:AIVS_PACKAGE_DIR = $oldPackageDir }
}
Write-Output "Windows package verify passed; report: build/reports/bootstrap-windows.json"
