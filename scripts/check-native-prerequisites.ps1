param(
  [switch]$Strict
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifactsDirectory = Join-Path $projectRoot "artifacts"
$reportPath = Join-Path $artifactsDirectory "native-readiness.json"
New-Item -ItemType Directory -Force -Path $artifactsDirectory | Out-Null

function Get-FirstLine([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  return (($Text -split "`r?`n")[0]).Trim()
}

function Find-Executable {
  param(
    [string]$Name,
    [string[]]$Candidates = @(),
    [string[]]$VersionArguments = @("--version"),
    [switch]$SkipVersionProbe
  )

  $path = $null
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $path = $command.Source }
  if (-not $path) {
    $path = $Candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  }
  if (-not $path) {
    return [pscustomobject]@{ found = $false; path = $null; version = $null }
  }

  $version = "Detected"
  if (-not $SkipVersionProbe -and $VersionArguments.Count -gt 0) {
    try {
      $version = Get-FirstLine ((& $path @VersionArguments 2>&1 | Out-String))
    } catch {
      $version = "Detected; version probe failed: $($_.Exception.Message)"
    }
  }
  return [pscustomobject]@{ found = $true; path = $path; version = $version }
}

function New-Check {
  param(
    [string]$Id,
    [string]$Label,
    [bool]$Found,
    [string]$RequiredFor,
    [string]$Path = $null,
    [string]$Version = $null,
    [string]$Detail = $null
  )
  return [pscustomobject]@{
    id = $Id
    label = $Label
    found = $Found
    requiredFor = $RequiredFor
    path = $Path
    version = $Version
    detail = $Detail
  }
}

$checks = [System.Collections.Generic.List[object]]::new()

$node = Find-Executable -Name "node.exe"
$checks.Add((New-Check -Id "node" -Label "Node.js" -Found $node.found -RequiredFor "web-build" -Path $node.path -Version $node.version))

$rustc = Find-Executable -Name "rustc.exe"
$checks.Add((New-Check -Id "rustc" -Label "Rust compiler" -Found $rustc.found -RequiredFor "tauri-build" -Path $rustc.path -Version $rustc.version))

$cargo = Find-Executable -Name "cargo.exe"
$checks.Add((New-Check -Id "cargo" -Label "Cargo" -Found $cargo.found -RequiredFor "tauri-build" -Path $cargo.path -Version $cargo.version))

$programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
$programFiles = [Environment]::GetFolderPath("ProgramFiles")
$vswherePath = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
$msvcPath = $null
if (Test-Path -LiteralPath $vswherePath) {
  try {
    $msvcPath = (& $vswherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
  } catch { $msvcPath = $null }
}
$checks.Add((New-Check -Id "msvc" -Label "MSVC C++ Build Tools" -Found ([bool]$msvcPath) -RequiredFor "tauri-build" -Path $msvcPath -Detail "Requires the Desktop development with C++ workload."))

$windowsKitsBin = Join-Path $programFilesX86 "Windows Kits\10\bin"
$sdkVersions = @()
if (Test-Path -LiteralPath $windowsKitsBin) {
  $sdkVersions = Get-ChildItem -LiteralPath $windowsKitsBin -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } |
    Sort-Object Name -Descending
}
$sdkPath = $sdkVersions | Select-Object -First 1 -ExpandProperty FullName
$checks.Add((New-Check -Id "windows-sdk" -Label "Windows SDK" -Found ([bool]$sdkPath) -RequiredFor "tauri-build" -Path $sdkPath))

$signToolPath = $null
foreach ($sdkVersion in $sdkVersions) {
  $candidate = Join-Path $sdkVersion.FullName "x64\signtool.exe"
  if (Test-Path -LiteralPath $candidate) { $signToolPath = $candidate; break }
}
$checks.Add((New-Check -Id "signtool" -Label "SignTool" -Found ([bool]$signToolPath) -RequiredFor "signed-release" -Path $signToolPath))

$webViewVersion = $null
$webViewPath = $null
$edgeClientRoots = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients"
)
foreach ($root in $edgeClientRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
    $properties = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if ($properties.name -match "WebView2") {
      $webViewVersion = $properties.pv
      $webViewPath = $key.Name
      break
    }
  }
  if ($webViewVersion) { break }
}
$checks.Add((New-Check -Id "webview2" -Label "Microsoft Edge WebView2 Runtime" -Found ([bool]$webViewVersion) -RequiredFor "tauri-runtime" -Path $webViewPath -Version $webViewVersion))

$powerPointPath = $null
$powerPointCandidates = @(
  (Join-Path $programFiles "Microsoft Office\root\Office16\POWERPNT.EXE"),
  (Join-Path $programFilesX86 "Microsoft Office\root\Office16\POWERPNT.EXE")
)
$powerPoint = Find-Executable -Name "POWERPNT.EXE" -Candidates $powerPointCandidates -SkipVersionProbe
if ($powerPoint.found) { $powerPointPath = $powerPoint.path }
$powerPointCom = Test-Path "Registry::HKEY_CLASSES_ROOT\PowerPoint.Application\CLSID"
$checks.Add((New-Check -Id "powerpoint" -Label "Microsoft PowerPoint converter" -Found ($powerPointCom -or [bool]$powerPointPath) -RequiredFor "ppt-high-fidelity-conversion" -Path $powerPointPath -Detail "PowerPoint is optional; manual PDF export remains the permanent fallback."))

$soffice = Find-Executable -Name "soffice.com" -Candidates @(
  (Join-Path $programFiles "LibreOffice\program\soffice.com"),
  (Join-Path $programFilesX86 "LibreOffice\program\soffice.com")
)
$checks.Add((New-Check -Id "libreoffice" -Label "LibreOffice converter" -Found $soffice.found -RequiredFor "optional-ppt-fallback" -Path $soffice.path -Version $soffice.version -Detail "Optional external fallback; not bundled in the lightweight installer."))

$ffmpeg = Find-Executable -Name "ffmpeg.exe" -VersionArguments @("-version")
$checks.Add((New-Check -Id "ffmpeg" -Label "FFmpeg development probe" -Found $ffmpeg.found -RequiredFor "recording-finalizer-development" -Path $ffmpeg.path -Version $ffmpeg.version -Detail "A distributable sidecar needs a separate pinned LGPL-only build and license audit."))

$ffprobe = Find-Executable -Name "ffprobe.exe" -VersionArguments @("-version")
$checks.Add((New-Check -Id "ffprobe" -Label "ffprobe" -Found $ffprobe.found -RequiredFor "media-verification" -Path $ffprobe.path -Version $ffprobe.version))

$byId = @{}
foreach ($check in $checks) { $byId[$check.id] = $check }
$tauriReady = $byId["rustc"].found -and $byId["cargo"].found -and $byId["msvc"].found -and $byId["windows-sdk"].found -and $byId["webview2"].found
$signedReleaseReady = $tauriReady -and $byId["signtool"].found

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
$report = [pscustomobject]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  machine = [pscustomobject]@{
    os = if ($os) { $os.Caption } else { [Environment]::OSVersion.VersionString }
    osVersion = if ($os) { $os.Version } else { [Environment]::OSVersion.Version.ToString() }
    architecture = $env:PROCESSOR_ARCHITECTURE
  }
  readiness = [pscustomobject]@{
    webBuild = $byId["node"].found
    tauriBuild = $tauriReady
    signedRelease = $signedReleaseReady
    automaticPptConversion = $byId["powerpoint"].found -or $byId["libreoffice"].found
    mediaVerification = $byId["ffprobe"].found
  }
  checks = $checks
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8
$checks | Select-Object label, found, requiredFor, version, path | Format-Table -AutoSize
Write-Host ""
Write-Host "Tauri build ready: $tauriReady"
Write-Host "Signed release ready: $signedReleaseReady"
Write-Host "Report: $reportPath"

if ($Strict -and -not $signedReleaseReady) { exit 1 }
