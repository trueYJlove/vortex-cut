$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$powershell = (Get-Command powershell.exe).Source
$report = Join-Path $env:TEMP ("aivs-bootstrap-runtime-test-" + $PID + ".json")
$missingRuntime = Join-Path $env:TEMP ("aivs-missing-electron-runtime-" + $PID + "\\electron.exe")
Remove-Item -LiteralPath $report -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Split-Path -Parent $missingRuntime) -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $missingRuntime) | Out-Null
$env:AIVS_BOOTSTRAP_REPORT = $report
try {
  & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "tools/packaging/bootstrap-windows.ps1") -VerifyOnly -ElectronRuntimePath $missingRuntime
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) { throw "Expected missing Electron runtime verification to fail." }
  $result = Get-Content -Raw -LiteralPath $report | ConvertFrom-Json
  if ($result.status -ne "failed" -or [string]$result.error -notmatch "Electron Windows runtime") {
    throw "Missing Electron runtime failure was not classified correctly: $($result.error)"
  }
  Write-Output "bootstrap runtime negative test passed: exit=$exitCode report=$report"
}
finally {
  Remove-Item Env:AIVS_BOOTSTRAP_REPORT -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Split-Path -Parent $missingRuntime) -Recurse -Force -ErrorAction SilentlyContinue
}
