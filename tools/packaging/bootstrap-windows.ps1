param(
  [switch]$PreflightOnly,
  [switch]$VerifyOnly,
  [string]$ElectronRuntimePath,
  [string]$ResourceRoot
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$desktop = Join-Path $root "apps/desktop"
$resourceRoot = if ($ResourceRoot) { [IO.Path]::GetFullPath($ResourceRoot) } else { Join-Path $root "resources" }
$readOnly = $VerifyOnly -or $PreflightOnly
$reportPath = if ($env:AIVS_BOOTSTRAP_REPORT) { $env:AIVS_BOOTSTRAP_REPORT } else {
  Join-Path $root "build/reports/bootstrap-windows.json"
}
$report = [ordered]@{
  schema_version = 1
  status = "running"
  mode = if ($VerifyOnly) { "verify" } elseif ($PreflightOnly) { "preflight" } else { "bootstrap" }
  started_at = [DateTime]::UtcNow.ToString("o")
  finished_at = $null
  report_path = $reportPath
  steps = [System.Collections.Generic.List[object]]::new()
  environment = [ordered]@{}
}

function Write-Report {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportPath) | Out-Null
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
}

function Add-Step {
  param(
    [string]$Name,
    [string]$Status,
    [string]$Message,
    [object]$Details = $null
  )
  $report.steps.Add([pscustomobject]@{
    name = $Name
    status = $Status
    message = $Message
    details = $Details
  })
  Write-Report
}

function Invoke-Native {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  $display = ($Arguments | ForEach-Object { if ($_ -match "\s") { '"' + $_ + '"' } else { $_ } }) -join " "
  Write-Output (">>> $FilePath $display")
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed (exit $LASTEXITCODE): $FilePath $display"
  }
}

function Get-CommandPath {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Required command is missing: '$Name'; install it and ensure it is on PATH." }
  return $command.Source
}

function Get-JsonFile {
  param([string]$Path, [string]$Description)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description file is missing: $Path"
  }
  try {
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
    return ([System.IO.File]::ReadAllText($Path, $encoding) | ConvertFrom-Json)
  }
  catch { throw "$Description is not valid JSON: $Path; $($_.Exception.Message)" }
}

function Get-ComponentState {
  $manifestPath = Join-Path $resourceRoot "manifests/components.json"
  $manifest = Get-JsonFile $manifestPath "component manifest"
  $required = @(
    "core/aivs-core/aivs-core.exe",
    "ffmpeg/win-x64/ffmpeg.exe",
    "ffmpeg/win-x64/ffprobe.exe",
    "licenses/THIRD_PARTY_NOTICES.txt"
  )
  $reasons = [System.Collections.Generic.List[string]]::new()
  if ($manifest.release_blocked_until_pinned -eq $true) {
    $reasons.Add("components.json release_blocked_until_pinned=true")
  }
  if (-not $manifest.components -or $manifest.components.Count -lt $required.Count) {
    $reasons.Add("components.json has an incomplete components list")
  }
  foreach ($relative in $required) {
    $component = @($manifest.components | Where-Object { $_.path -eq $relative }) | Select-Object -First 1
    $filePath = Join-Path $resourceRoot $relative
    if (-not $component) {
      $reasons.Add("manifest component is missing: $relative")
      continue
    }
    if ([string]::IsNullOrWhiteSpace([string]$component.license)) {
      $reasons.Add("component license field is missing: $relative")
    }
    if ([string]$component.sha256 -notmatch "^[0-9a-fA-F]{64}$") {
      $reasons.Add("component SHA-256 is not a fixed 64-character value: $relative")
      continue
    }
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      $reasons.Add("component file is missing: $relative")
      continue
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$component.sha256).ToLowerInvariant()) {
      $reasons.Add("component SHA-256 mismatch: $relative (expected $($component.sha256), actual $actual)")
    }
  }
  return [pscustomobject]@{
    valid = $reasons.Count -eq 0
    manifest = $manifest
    reasons = @($reasons)
  }
}

function Get-FfmpegManifest {
  $manifestPath = Join-Path $PSScriptRoot "../dependencies/ffmpeg-manifest.json"
  $manifest = Get-JsonFile $manifestPath "FFmpeg manifest"
  if ($manifest.release_blocked_until_pinned -ne $false) {
    throw "FFmpeg manifest is not approved or is release-blocked: $manifestPath"
  }
  if ([string]$manifest.archive_sha256 -notmatch "^[0-9a-fA-F]{64}$") {
    throw "FFmpeg manifest has no fixed archive_sha256: $manifestPath"
  }
  if (-not $manifest.binary_layout -or @($manifest.binary_layout).Count -ne 2) {
    throw "FFmpeg manifest binary_layout must contain ffmpeg.exe and ffprobe.exe."
  }
  if (@($manifest.binary_layout) -notcontains "ffmpeg.exe" -or @($manifest.binary_layout) -notcontains "ffprobe.exe") {
    throw "FFmpeg manifest binary_layout is missing ffmpeg.exe or ffprobe.exe."
  }
  return $manifest
}

function Test-ComponentPaths {
  param(
    [object]$Manifest,
    [string[]]$Paths
  )
  foreach ($relative in $Paths) {
    $component = @($Manifest.components | Where-Object { $_.path -eq $relative }) | Select-Object -First 1
    $filePath = Join-Path $resourceRoot $relative
    if (-not $component -or [string]$component.sha256 -notmatch "^[0-9a-fA-F]{64}$" -or
      -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      return $false
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$component.sha256).ToLowerInvariant()) { return $false }
  }
  return $true
}

function Get-ElectronRuntimeInfo {
  param([string]$Path)
  $electronPackage = Join-Path $desktop "node_modules/electron/package.json"
  $electronDir = Split-Path -Parent $electronPackage
  $versionFile = Join-Path $electronDir "dist/version"
  $pathFile = Join-Path $electronDir "path.txt"
  $valid = $true
  $reasons = [System.Collections.Generic.List[string]]::new()
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $valid = $false
    $reasons.Add("Electron runtime file is missing: $Path")
  } else {
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -le 0) {
      $valid = $false
      $reasons.Add("Electron runtime file is empty: $Path")
    }
    $header = @(Get-Content -LiteralPath $Path -Encoding Byte -TotalCount 2)
    if ($header.Count -ne 2 -or $header[0] -ne 0x4d -or $header[1] -ne 0x5a) {
      $valid = $false
      $reasons.Add("Electron runtime is not a Windows PE executable: $Path")
    }
  }
  if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf) -or
    (Get-Content -Raw -LiteralPath $versionFile).Trim() -ne [string]$electronPackageData.version) {
    $valid = $false
    $reasons.Add("Electron runtime version marker is missing or mismatched: $versionFile")
  }
  if (-not (Test-Path -LiteralPath $pathFile -PathType Leaf) -or
    (Get-Content -Raw -LiteralPath $pathFile).Trim() -ne "electron.exe") {
    $valid = $false
    $reasons.Add("Electron runtime path marker is missing or not electron.exe: $pathFile")
  }
  return [pscustomobject]@{ valid = $valid; path = $Path; reasons = @($reasons) }
}

function Get-ElectronDownloadInfo {
  param([string]$Version)
  $mirror = if ($env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR } elseif ($env:NPM_CONFIG_ELECTRON_MIRROR) {
    $env:NPM_CONFIG_ELECTRON_MIRROR
  } else { "https://github.com/electron/electron/releases/download" }
  $base = $mirror.TrimEnd("/")
  $url = if ($base -like "*/download") {
    "$base/v$Version/electron-v$Version-win32-x64.zip"
  } else {
    "$base/$Version/electron-v$Version-win32-x64.zip"
  }
  $cache = if ($env:AIVS_ELECTRON_CACHE) { $env:AIVS_ELECTRON_CACHE } elseif ($env:electron_config_cache) {
    $env:electron_config_cache
  } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "electron/Cache" } else { $null }
  return [pscustomobject]@{ cache = $cache; mirror = $base; url = $url; platform = "win32"; arch = "x64" }
}

function Find-ElectronArchive {
  param(
    [string]$Cache,
    [string]$Version
  )
  if (-not $Cache -or -not (Test-Path -LiteralPath $Cache -PathType Container)) { return $null }
  $name = "electron-v$Version-win32-x64.zip"
  return Get-ChildItem -LiteralPath $Cache -Recurse -File -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Restore-ElectronRuntimeFromArchive {
  param(
    [string]$Archive,
    [string]$Version,
    [string]$ElectronDir
  )
  $checksumsPath = Join-Path $ElectronDir "checksums.json"
  $checksums = Get-JsonFile $checksumsPath "Electron checksums.json"
  $archiveName = Split-Path -Leaf $Archive
  $property = $checksums.PSObject.Properties[$archiveName]
  if (-not $property -or [string]$property.Value -notmatch "^[0-9a-fA-F]{64}$") {
    throw "Electron checksums.json has no fixed SHA-256 for ${archiveName}: $checksumsPath"
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
  $expected = ([string]$property.Value).ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "Electron archive SHA-256 mismatch: $Archive (expected $expected, actual $actual)"
  }
  $dist = Join-Path $ElectronDir "dist"
  $tar = Get-CommandPath "tar"
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  Invoke-Native $tar @("-xf", $Archive, "-C", $dist) | Out-Host
  [System.IO.File]::WriteAllText((Join-Path $dist "version"), $Version)
  [System.IO.File]::WriteAllText((Join-Path $ElectronDir "path.txt"), "electron.exe")
  return [pscustomobject]@{ archive = $Archive; archive_sha256 = $actual; method = "tar-fallback" }
}

function Ensure-ElectronRuntime {
  param([string]$RuntimePath)
  $scriptPath = Join-Path $desktop "node_modules/electron/install.js"
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Electron install script is missing: $scriptPath; run pnpm install --frozen-lockfile."
  }
  $scriptPackagePath = Join-Path $desktop "node_modules/electron/package.json"
  $scriptPackage = Get-JsonFile $scriptPackagePath "Electron package.json"
  $script:electronPackageData = $scriptPackage
  $info = Get-ElectronDownloadInfo ([string]$scriptPackage.version)
  $current = Get-ElectronRuntimeInfo $RuntimePath
  if ($current.valid) {
    Add-Step "electron-runtime" "passed" "Electron Windows runtime is present and verified." ([ordered]@{
      path = $RuntimePath
      version = $scriptPackage.version
      cache = $info.cache
      source = $info.url
      platform = $info.platform
      arch = $info.arch
    })
    return
  }
  if ($readOnly) {
    throw "Electron Windows runtime verification failed: $($current.reasons -join '; '); run pnpm bootstrap:windows with network access or a populated Electron cache."
  }
  if (-not $info.cache) {
    throw "Electron runtime is missing and no Electron cache is configured; set AIVS_ELECTRON_CACHE or LOCALAPPDATA. Expected source: $($info.url)"
  }
  New-Item -ItemType Directory -Force -Path $info.cache | Out-Null
  $electronDir = Split-Path -Parent $scriptPath
  $installFailure = $null
  $oldSkip = $env:ELECTRON_SKIP_BINARY_DOWNLOAD
  $oldPlatform = $env:npm_config_platform
  $oldArch = $env:npm_config_arch
  $oldCache = $env:electron_config_cache
  try {
    Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
    $env:npm_config_platform = "win32"
    $env:npm_config_arch = "x64"
    $env:electron_config_cache = $info.cache
    Push-Location (Split-Path -Parent $scriptPath)
    try {
      Invoke-Native $node @("install.js")
    } catch {
      $installFailure = $_.Exception.Message
    } finally {
      Pop-Location
    }
  } catch {
    throw "Electron Windows runtime download/extract failed; source=$($info.url); cache=$($info.cache); ensure network access or prepopulate this cache. Original error: $($_.Exception.Message)"
  } finally {
    if ($null -eq $oldSkip) { Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue } else { $env:ELECTRON_SKIP_BINARY_DOWNLOAD = $oldSkip }
    if ($null -eq $oldPlatform) { Remove-Item Env:npm_config_platform -ErrorAction SilentlyContinue } else { $env:npm_config_platform = $oldPlatform }
    if ($null -eq $oldArch) { Remove-Item Env:npm_config_arch -ErrorAction SilentlyContinue } else { $env:npm_config_arch = $oldArch }
    if ($null -eq $oldCache) { Remove-Item Env:electron_config_cache -ErrorAction SilentlyContinue } else { $env:electron_config_cache = $oldCache }
  }
  $current = Get-ElectronRuntimeInfo $RuntimePath
  if (-not $current.valid) {
    $archive = Find-ElectronArchive $info.cache ([string]$scriptPackage.version)
    if ($archive) {
      $fallback = Restore-ElectronRuntimeFromArchive $archive.FullName ([string]$scriptPackage.version) $electronDir
      $current = Get-ElectronRuntimeInfo $RuntimePath
      if ($current.valid) {
        Add-Step "electron-runtime" "passed" "Electron Windows runtime was restored from a verified cache archive." ([ordered]@{
          path = $RuntimePath
          version = $scriptPackage.version
          cache = $info.cache
          source = $info.url
          archive = $fallback.archive
          archive_sha256 = $fallback.archive_sha256
          method = $fallback.method
          platform = $info.platform
          arch = $info.arch
        })
        return
      }
    }
    $installDetail = if ($installFailure) { "; install.js error=$installFailure" } else { "" }
    throw "Electron install did not produce a verified Windows runtime: $($current.reasons -join '; '); source=$($info.url); cache=$($info.cache)$installDetail"
  }
  Add-Step "electron-runtime" "passed" "Electron Windows runtime was downloaded/extracted and verified." ([ordered]@{
    path = $RuntimePath
    version = $scriptPackage.version
    cache = $info.cache
    source = $info.url
    platform = $info.platform
    arch = $info.arch
  })
}

function Resolve-FfmpegArchive {
  if ($env:AIVS_FFMPEG_ARCHIVE) { return (Resolve-Path -LiteralPath $env:AIVS_FFMPEG_ARCHIVE -ErrorAction Stop).Path }
  $default = Join-Path $root ".deps-download/ffmpeg-lgpl-8.0.zip"
  if (Test-Path -LiteralPath $default -PathType Leaf) { return (Resolve-Path -LiteralPath $default).Path }
  return $null
}

function Test-ElectronBuilderTools {
  $cache = if ($env:AIVS_ELECTRON_BUILDER_CACHE) { $env:AIVS_ELECTRON_BUILDER_CACHE } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "electron-builder/Cache"
  } else { $null }
  $sevenZip = if ($env:AIVS_ELECTRON_BUILDER_7ZIP_PATH) { $env:AIVS_ELECTRON_BUILDER_7ZIP_PATH } else {
    Join-Path $root ".deps-download/7zip-bin-extracted/package/win/x64/7za.exe"
  }
  $checks = [ordered]@{
    electron_builder_cache = $cache
    nsis = if ($cache) { Join-Path $cache "nsis/nsis-3.0.4.1/Bin/makensis.exe" } else { $null }
    nsis_resources = if ($cache) { Join-Path $cache "nsis/nsis-resources-3.4.1/plugins" } else { $null }
    win_code_sign = if ($cache) { Join-Path $cache "winCodeSign/winCodeSign-2.6.0" } else { $null }
    seven_zip = $sevenZip
  }
  $missing = [System.Collections.Generic.List[string]]::new()
  if (-not $cache) { $missing.Add("LOCALAPPDATA or AIVS_ELECTRON_BUILDER_CACHE") }
  foreach ($key in @("nsis", "nsis_resources", "win_code_sign", "seven_zip")) {
    if (-not $checks[$key] -or -not (Test-Path -LiteralPath $checks[$key])) { $missing.Add("${key}: $($checks[$key])") }
  }
  return [pscustomobject]@{ valid = $missing.Count -eq 0; checks = $checks; missing = @($missing) }
}

try {
  if ($env:OS -ne "Windows_NT") { throw "G0-3 supports Windows only; current OS=$env:OS." }

  $rootPackage = Get-JsonFile (Join-Path $root "package.json") "root package.json"
  $report.environment.node_required = [string]$rootPackage.engines.node
  $report.environment.pnpm_required = [string]$rootPackage.packageManager
  $report.environment.platform = [Environment]::OSVersion.VersionString

  $node = Get-CommandPath "node"
  $nodeVersion = (& $node --version).Trim()
  $report.environment.node = $nodeVersion
  if ($nodeVersion -notmatch "^v24\.") { throw "Node version does not satisfy package.json engines: $nodeVersion; expected >=24 <25." }
  $pnpm = Get-CommandPath "pnpm"
  $pnpmVersion = (& $pnpm --version).Trim()
  $report.environment.pnpm = $pnpmVersion
  $requiredPnpm = ([string]$rootPackage.packageManager -replace "^pnpm@", "")
  if ($requiredPnpm -and $pnpmVersion -ne $requiredPnpm) { throw "pnpm version mismatch: $pnpmVersion; expected $requiredPnpm." }
  $uv = Get-CommandPath "uv"
  $report.environment.uv = (& $uv --version).Trim()
  Add-Step "toolchain" "passed" "Node, pnpm and uv versions are supported." $report.environment

  $ffmpegManifest = Get-FfmpegManifest
  Add-Step "ffmpeg-manifest" "passed" "FFmpeg manifest has a fixed version, layout and archive SHA-256." ([ordered]@{version=$ffmpegManifest.version; archive_sha256=$ffmpegManifest.archive_sha256})

  $nodeModulesReady = (Test-Path -LiteralPath (Join-Path $desktop "node_modules/electron-builder/package.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $desktop "node_modules/electron/package.json") -PathType Leaf)
  if (-not $nodeModulesReady) {
    if ($readOnly) { throw "Desktop Node dependencies are not installed; run pnpm ci or pnpm install --frozen-lockfile." }
    Invoke-Native $pnpm @("install", "--frozen-lockfile")
  }
  if (-not (Test-Path -LiteralPath (Join-Path $desktop "node_modules/electron-builder/package.json") -PathType Leaf)) {
    throw "electron-builder dependency is still missing; check pnpm install --frozen-lockfile and pnpm-lock.yaml."
  }
  if (-not $readOnly) {
    Push-Location $desktop
    try { Invoke-Native $node @("scripts/prepare-electron-builder.mjs") }
    finally { Pop-Location }
  }
  $builderPackage = Get-JsonFile (Join-Path $desktop "node_modules/electron-builder/package.json") "electron-builder package.json"
  $electronPackage = Get-JsonFile (Join-Path $desktop "node_modules/electron/package.json") "electron package.json"
  if ([string]$builderPackage.version -ne "26.15.3") { throw "electron-builder version is not pinned to 26.15.3: $($builderPackage.version)" }
  if ([string]$electronPackage.version -ne "36.2.1") { throw "Electron version is not pinned to 36.2.1: $($electronPackage.version)" }
  $runtimePath = if ($ElectronRuntimePath) { $ElectronRuntimePath } else { Join-Path $desktop "node_modules/electron/dist/electron.exe" }
  Ensure-ElectronRuntime $runtimePath
  $prepareArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "../dependencies/prepare-electron-builder.ps1"))
  if ($readOnly) { $prepareArgs += "-VerifyOnly" }
  & (Get-Command powershell.exe).Source @prepareArgs
  if ($LASTEXITCODE -ne 0) { throw "electron-builder 7-Zip preparation failed." }
  $builderState = Test-ElectronBuilderTools
  if (-not $builderState.valid) {
    throw "electron-builder cache/tools are incomplete: $($builderState.missing -join '; '); set AIVS_ELECTRON_BUILDER_CACHE or AIVS_ELECTRON_BUILDER_7ZIP_PATH, and ensure the network is available for electron-builder's fixed tools."
  }
  Add-Step "electron-builder" "passed" "electron-builder, Electron, NSIS, NSIS resources, winCodeSign and 7-Zip are ready." $builderState.checks

  $state = Get-ComponentState
  $ffmpegTrusted = Test-ComponentPaths $state.manifest @(
    "ffmpeg/win-x64/ffmpeg.exe",
    "ffmpeg/win-x64/ffprobe.exe"
  )
  if (-not $ffmpegTrusted) {
    if ($readOnly) { throw "FFmpeg/FFprobe failed component manifest SHA-256 verification: $($state.reasons -join '; ')" }
    $archive = Resolve-FfmpegArchive
    if (-not $archive) {
      throw "Approved FFmpeg archive is missing; set AIVS_FFMPEG_ARCHIVE or prepare .deps-download/ffmpeg-lgpl-8.0.zip. Expected archive SHA-256=$($ffmpegManifest.archive_sha256)."
    }
    $env:AIVS_FFMPEG_ARCHIVE = $archive
    & (Get-Command powershell.exe).Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "../dependencies/prepare-ffmpeg.ps1") -Destination (Join-Path $resourceRoot "ffmpeg/win-x64")
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg preparation failed; check archive path and SHA-256." }
    Add-Step "ffmpeg" "passed" "FFmpeg/FFprobe prepared and verified from the approved archive." ([ordered]@{archive=$archive; archive_sha256=$ffmpegManifest.archive_sha256})
  } else {
    Add-Step "ffmpeg" "passed" "Existing FFmpeg/FFprobe passed component manifest SHA-256 verification." $null
  }

  $state = Get-ComponentState
  if (-not $state.valid) {
    if ($readOnly) { throw "Sidecar, FFmpeg, license or component manifest verification failed: $($state.reasons -join '; ')" }
    & (Get-Command powershell.exe).Source -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "build-sidecar.ps1") -OutputRoot $resourceRoot
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller Sidecar build failed." }
    Add-Step "sidecar" "passed" "PyInstaller Sidecar was built into the resources directory." $null
  } else {
    Add-Step "sidecar" "passed" "Existing Sidecar, FFmpeg, license and component manifest passed SHA-256 verification." $null
  }

  $state = Get-ComponentState
  if (-not $state.valid) { throw "Final resource gate failed: $($state.reasons -join '; ')" }
  Add-Step "resources" "passed" "Final resources and component manifest verification passed." ([ordered]@{manifest=(Join-Path $resourceRoot "manifests/components.json")})
  $report.status = "passed"
}
catch {
  $report.status = if ($VerifyOnly) { "failed" } else { "blocked" }
  $report.error = $_.Exception.Message
  Add-Step "result" $report.status $report.error $null
  throw
}
finally {
  $report.finished_at = [DateTime]::UtcNow.ToString("o")
  Write-Report
  Write-Output "Windows bootstrap report: $reportPath"
}
