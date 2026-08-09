param([string]$OutputRoot = (Join-Path $PSScriptRoot "../../dist/sidecar"))
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$pyInstallerDist = Join-Path $repoRoot "dist/aivs-core"
$pyInstallerWork = Join-Path $repoRoot "build/aivs-core"
$specPath = Join-Path $repoRoot "services/core/aivs-core.spec"
$buildStarted = [DateTime]::UtcNow
$uv = (Get-Command uv -ErrorAction Stop).Source
& $uv run --locked --extra dev pyinstaller --version
if ($LASTEXITCODE -ne 0) { throw "PyInstaller dependency is unavailable; run uv sync --locked --extra dev and ensure network or uv cache access." }
if (Test-Path $pyInstallerDist) { Remove-Item -LiteralPath $pyInstallerDist -Recurse -Force }
if (Test-Path $pyInstallerWork) { Remove-Item -LiteralPath $pyInstallerWork -Recurse -Force }
& $uv run --locked --extra dev pyinstaller --clean --noconfirm --distpath $pyInstallerDist --workpath $pyInstallerWork $specPath
if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }
$generatedCore = Join-Path $pyInstallerDist "aivs-core"
$generatedExe = Join-Path $generatedCore "aivs-core.exe"
if (-not (Test-Path $generatedExe)) { throw "PyInstaller did not produce the expected current Sidecar: $generatedExe" }
$generatedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $generatedExe).Hash.ToLowerInvariant()
$generatedAt = (Get-Item -LiteralPath $generatedExe).LastWriteTimeUtc
if ($generatedAt -lt $buildStarted) { throw "PyInstaller output is older than this build: $generatedExe" }
$core = Join-Path $OutputRoot "core/aivs-core"
if (Test-Path $core) { Remove-Item -LiteralPath $core -Recurse -Force }
New-Item -ItemType Directory -Force -Path $core | Out-Null
Copy-Item -Recurse -Force (Join-Path $generatedCore "*") $core
if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $core "aivs-core.exe")).Hash.ToLowerInvariant() -ne $generatedHash) { throw "Sidecar staging hash does not match the current PyInstaller output" }
$resourceCore = Join-Path $repoRoot "resources/core/aivs-core"
if (Test-Path $resourceCore) { Remove-Item -LiteralPath $resourceCore -Recurse -Force }
New-Item -ItemType Directory -Force -Path $resourceCore | Out-Null
Copy-Item -Recurse -Force (Join-Path $generatedCore "*") $resourceCore
if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $resourceCore "aivs-core.exe")).Hash.ToLowerInvariant() -ne $generatedHash) { throw "Resource Sidecar hash does not match the current PyInstaller output" }
Copy-Item -Recurse -Force (Join-Path $repoRoot "resources/ffmpeg") (Join-Path $OutputRoot "ffmpeg")
Copy-Item -Recurse -Force (Join-Path $repoRoot "resources/licenses") (Join-Path $OutputRoot "licenses")
New-Item -ItemType Directory -Force -Path (Join-Path $OutputRoot "manifests") | Out-Null
Copy-Item -LiteralPath (Join-Path $repoRoot "resources/manifests/components.json") -Destination (Join-Path $OutputRoot "manifests/components.json") -Force
$manifestPath = Join-Path $repoRoot "resources/manifests/components.json"
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$hashTargets = @{
  "core/aivs-core/aivs-core.exe" = (Join-Path $resourceCore "aivs-core.exe")
  "ffmpeg/win-x64/ffmpeg.exe" = (Join-Path $PSScriptRoot "../../resources/ffmpeg/win-x64/ffmpeg.exe")
  "ffmpeg/win-x64/ffprobe.exe" = (Join-Path $PSScriptRoot "../../resources/ffmpeg/win-x64/ffprobe.exe")
  "licenses/THIRD_PARTY_NOTICES.txt" = (Join-Path $PSScriptRoot "../../resources/licenses/THIRD_PARTY_NOTICES.txt")
}
foreach ($component in $manifest.components) {
  if ($hashTargets.ContainsKey($component.path)) {
    $component.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $hashTargets[$component.path]).Hash.ToLowerInvariant()
    $component.hash_status = "verified"
  }
}
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.UTF8Encoding]::new($false))
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $OutputRoot "manifests/components.json") -Force
Write-Output "Sidecar onedir built in $core from $generatedCore (sha256=$generatedHash, generated_at=$generatedAt)"
