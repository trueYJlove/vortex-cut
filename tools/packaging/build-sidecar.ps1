param([string]$OutputRoot = (Join-Path $PSScriptRoot "../../dist/sidecar"))
$ErrorActionPreference = "Stop"
python -m PyInstaller --clean --noconfirm --onedir --name aivs-core (Join-Path $PSScriptRoot "../../services/core/aivs-core.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }
$core = Join-Path $OutputRoot "core/aivs-core"
New-Item -ItemType Directory -Force -Path $core | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "../../dist/aivs-core/*") $core
Write-Output "Sidecar onedir built in $core"
