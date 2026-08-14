param([string]$OutputRoot = (Join-Path $PSScriptRoot "../../dist/sidecar"))
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$sourceResourceRoot = Join-Path $repoRoot "resources"
if ($OutputRoot -eq $repoRoot) { throw "OutputRoot must not be the repository root." }
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
$resourceCore = Join-Path $OutputRoot "core/aivs-core"
if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $resourceCore "aivs-core.exe")).Hash.ToLowerInvariant() -ne $generatedHash) { throw "Resource Sidecar hash does not match the current PyInstaller output" }
if (-not (Test-Path -LiteralPath (Join-Path $OutputRoot "ffmpeg") -PathType Container)) {
  Copy-Item -Recurse -Force (Join-Path $sourceResourceRoot "ffmpeg") (Join-Path $OutputRoot "ffmpeg")
}
if (-not (Test-Path -LiteralPath (Join-Path $OutputRoot "licenses") -PathType Container)) {
  Copy-Item -Recurse -Force (Join-Path $sourceResourceRoot "licenses") (Join-Path $OutputRoot "licenses")
}
New-Item -ItemType Directory -Force -Path (Join-Path $OutputRoot "manifests") | Out-Null
$manifestPath = Join-Path $OutputRoot "manifests/components.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  Copy-Item -LiteralPath (Join-Path $sourceResourceRoot "manifests/components.json") -Destination $manifestPath -Force
}
$manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
$hashTargets = @{
  "core/aivs-core/aivs-core.exe" = (Join-Path $resourceCore "aivs-core.exe")
  "ffmpeg/win-x64/ffmpeg.exe" = (Join-Path $OutputRoot "ffmpeg/win-x64/ffmpeg.exe")
  "ffmpeg/win-x64/ffprobe.exe" = (Join-Path $OutputRoot "ffmpeg/win-x64/ffprobe.exe")
  "licenses/THIRD_PARTY_NOTICES.txt" = (Join-Path $OutputRoot "licenses/THIRD_PARTY_NOTICES.txt")
}
foreach ($component in $manifest.components) {
  if ($hashTargets.ContainsKey($component.path)) {
    $component.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $hashTargets[$component.path]).Hash.ToLowerInvariant()
    $component.hash_status = "verified"
  }
}
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output "Sidecar onedir built in $core from $generatedCore (sha256=$generatedHash, generated_at=$generatedAt)"
