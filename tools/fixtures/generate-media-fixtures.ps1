$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$bundledFfmpeg = Join-Path $repoRoot "resources/ffmpeg/win-x64/ffmpeg.exe"
$ffmpeg = if ($env:AIVS_FFMPEG) {
  $env:AIVS_FFMPEG
} elseif (Test-Path -LiteralPath $bundledFfmpeg) {
  $bundledFfmpeg
} else {
  "ffmpeg"
}
$output = Join-Path $repoRoot "test-assets/generated"
New-Item -ItemType Directory -Force -Path $output | Out-Null

if (-not (Test-Path -LiteralPath $ffmpeg)) {
  $command = Get-Command $ffmpeg -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "FFmpeg executable not found. Set AIVS_FFMPEG to an absolute path or prepare resources/ffmpeg/win-x64/ffmpeg.exe."
  }
}
$encoderOutput = & $ffmpeg -hide_banner -encoders 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Unable to inspect FFmpeg encoders. Verify the executable with: $ffmpeg -hide_banner -encoders"
}
if (-not ($encoderOutput -match "libopenh264")) {
  throw "Required encoder libopenh264 is unavailable. Inspect encoders with: $ffmpeg -hide_banner -encoders"
}

function Invoke-Ffmpeg([string[]]$Arguments, [string]$Target) {
  & $ffmpeg @Arguments $Target
  if ($LASTEXITCODE -ne 0) { throw "FFmpeg fixture generation failed: $Target" }
}

Invoke-Ffmpeg @("-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest") (Join-Path $output "cfr-landscape-av.mp4")
Invoke-Ffmpeg @("-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-t", "3", "-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p") (Join-Path $output "cfr-portrait-video-only.mp4")
Invoke-Ffmpeg @("-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=641x359:rate=30", "-t", "2", "-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p") (Join-Path $output "short-odd-size.mp4")
Invoke-Ffmpeg @("-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "3", "-vf", "select='if(lt(t,1),1,not(mod(n,2)))'", "-fps_mode", "vfr", "-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest") (Join-Path $output "vfr-landscape-av.mp4")

$source = Join-Path $output "cfr-landscape-av.mp4"
$chineseName = [string]::Concat(
  [char]0x4e2d, [char]0x6587, [char]0x8def, [char]0x5f84,
  "-", [char]0x6a2a, [char]0x5c4f, [char]0x6709, [char]0x97f3, [char]0x8f68,
  ".mp4"
)
$chinese = Join-Path $output $chineseName
[System.IO.File]::Copy($source, $chinese, $true)
$corrupt = Join-Path $output "corrupt.mp4"
$bytes = [System.IO.File]::ReadAllBytes($source)
$cut = [Math]::Max(1, [int]($bytes.Length / 3))
[System.IO.File]::WriteAllBytes($corrupt, $bytes[0..$cut])
Write-Output "Fixtures generated in $output"
