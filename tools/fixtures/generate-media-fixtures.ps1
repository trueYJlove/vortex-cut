$ErrorActionPreference = "Stop"
$ffmpeg = if ($env:AIVS_FFMPEG) { $env:AIVS_FFMPEG } else { "ffmpeg" }
$output = Join-Path $PSScriptRoot "../../test-assets/generated"
New-Item -ItemType Directory -Force -Path $output | Out-Null

function Invoke-Ffmpeg([string[]]$Arguments, [string]$Target) {
  & $ffmpeg @Arguments $Target
  if ($LASTEXITCODE -ne 0) { throw "FFmpeg fixture generation failed: $Target" }
}

Invoke-Ffmpeg @("-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest") (Join-Path $output "cfr-landscape-av.mp4")
Invoke-Ffmpeg @("-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p") (Join-Path $output "cfr-portrait-video-only.mp4")
Invoke-Ffmpeg @("-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=641x359:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p") (Join-Path $output "short-odd-size.mp4")

$source = Join-Path $output "cfr-landscape-av.mp4"
$corrupt = Join-Path $output "corrupt.mp4"
$bytes = [System.IO.File]::ReadAllBytes($source)
$cut = [Math]::Max(1, [int]($bytes.Length / 3))
[System.IO.File]::WriteAllBytes($corrupt, $bytes[0..$cut])
Write-Output "Fixtures generated in $output"
