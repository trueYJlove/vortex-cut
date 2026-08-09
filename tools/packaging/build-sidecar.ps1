param([string]$OutputRoot = (Join-Path $PSScriptRoot "../../dist/sidecar"))
$ErrorActionPreference = "Stop"
uv run pyinstaller --clean --noconfirm (Join-Path $PSScriptRoot "../../services/core/aivs-core.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }
$core = Join-Path $OutputRoot "core/aivs-core"
New-Item -ItemType Directory -Force -Path $core | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "../../dist/aivs-core/*") $core
 $resourceCore = Join-Path $PSScriptRoot "../../resources/core/aivs-core"
if (Test-Path $resourceCore) { Remove-Item -LiteralPath $resourceCore -Recurse -Force }
New-Item -ItemType Directory -Force -Path $resourceCore | Out-Null
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "../../dist/aivs-core/*") $resourceCore
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "../../resources/ffmpeg") (Join-Path $OutputRoot "ffmpeg")
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "../../resources/licenses") (Join-Path $OutputRoot "licenses")
New-Item -ItemType Directory -Force -Path (Join-Path $OutputRoot "manifests") | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../../resources/manifests/components.json") -Destination (Join-Path $OutputRoot "manifests/components.json") -Force
$manifestPath = Join-Path $PSScriptRoot "../../resources/manifests/components.json"
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
Write-Output "Sidecar onedir built in $core"
