$ErrorActionPreference = "Stop"
$manifestPath = Join-Path $PSScriptRoot "ffmpeg-manifest.json"
$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
if ($manifest.release_blocked_until_pinned -or [string]::IsNullOrWhiteSpace($manifest.archive_sha256)) { throw "FFmpeg manifest is intentionally unpinned; provide approval and SHA-256 first." }
if (-not $env:AIVS_FFMPEG_ARCHIVE) { throw "Set AIVS_FFMPEG_ARCHIVE to the approved archive." }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $env:AIVS_FFMPEG_ARCHIVE).Hash.ToLowerInvariant()
if ($hash -ne $manifest.archive_sha256.ToLowerInvariant()) { throw "FFmpeg archive SHA-256 mismatch." }
$destination = Join-Path $PSScriptRoot "../../resources/ffmpeg/win-x64"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Expand-Archive -LiteralPath $env:AIVS_FFMPEG_ARCHIVE -DestinationPath $destination -Force
foreach ($file in $manifest.binary_layout) { if (-not (Get-ChildItem -Path $destination -Recurse -Filter $file | Select-Object -First 1)) { throw "Missing $file" } }
Write-Output "FFmpeg prepared and verified."
