<#
.SYNOPSIS
  Build QuietPad and copy the deliverables back into the (Dropbox-synced) repo.

.DESCRIPTION
  The Rust build runs against a local target dir (see src-tauri/.cargo/config.toml,
  default D:\work\quietpad-target) to avoid Dropbox file-lock failures. This script
  runs `tauri build`, then copies the installer, MSI, portable exe, and a freshly
  zipped portable bundle back into the repo so the deliverables stay versioned with
  the source.

.EXAMPLE
  ./build.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot

# Resolve the cargo target dir from the cargo config (fallback to the default).
$targetDir = "D:\work\quietpad-target"
$cfg = Join-Path $repo "src-tauri\.cargo\config.toml"
if (Test-Path $cfg) {
    $m = Select-String -Path $cfg -Pattern '^\s*target-dir\s*=\s*"(.+?)"' | Select-Object -First 1
    if ($m) { $targetDir = $m.Matches[0].Groups[1].Value -replace '/', '\' }
}
if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }

Write-Host "Building (target-dir: $targetDir) ..." -ForegroundColor Cyan
# Vite's emptyDir on dist/ intermittently loses to Dropbox syncing that folder,
# failing the build. The lock is transient, so retry a couple of times.
$maxAttempts = 3
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    npm run tauri:build
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq $maxAttempts) { throw "tauri build failed after $maxAttempts attempts (exit $LASTEXITCODE)" }
    Write-Host "Build failed (likely a Dropbox lock on dist/); retrying $attempt/$maxAttempts..." -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}

$rel = Join-Path $targetDir "release"
$setup = Join-Path $rel "bundle\nsis\QuietPad_0.1.0_x64-setup.exe"
$msi   = Join-Path $rel "bundle\msi\QuietPad_0.1.0_x64_en-US.msi"
$exe   = Join-Path $rel "quietpad.exe"
foreach ($f in @($setup, $msi, $exe)) {
    if (-not (Test-Path $f)) { throw "Expected build artifact not found: $f" }
}

# A running QuietPad (or Dropbox mid-sync) locks the portable exe/zip. Close any
# running instance, and retry file ops that race with Dropbox.
function Invoke-WithRetry([scriptblock]$Action, [string]$What) {
    for ($i = 1; $i -le 6; $i++) {
        try { & $Action; return } catch {
            if ($i -eq 6) { throw "Failed: $What -> $($_.Exception.Message)" }
            Start-Sleep -Seconds 2
        }
    }
}

Get-Process -Name QuietPad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

Write-Host "Copying deliverables back into the repo ..." -ForegroundColor Cyan
$installers = Join-Path $repo "installers"
New-Item -ItemType Directory -Force -Path $installers | Out-Null
$portableExe = Join-Path $repo "portable\QuietPad.exe"
Invoke-WithRetry { Copy-Item $setup (Join-Path $installers "QuietPad_0.1.0_x64-setup.exe") -Force -ErrorAction Stop } "copy setup.exe"
Invoke-WithRetry { Copy-Item $msi   (Join-Path $installers "QuietPad_0.1.0_x64_en-US.msi")  -Force -ErrorAction Stop } "copy msi"
Invoke-WithRetry { Copy-Item $exe   $portableExe -Force -ErrorAction Stop } "copy portable exe"

$zip = Join-Path $repo "QuietPad_0.1.0_x64_portable.zip"
Invoke-WithRetry {
    if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction Stop }
    Compress-Archive -Path $portableExe, (Join-Path $repo "portable\README.txt") `
        -DestinationPath $zip -CompressionLevel Optimal -ErrorAction Stop
} "zip portable bundle"

Write-Host "Done. Deliverables refreshed:" -ForegroundColor Green
Get-Item `
    (Join-Path $installers "QuietPad_0.1.0_x64-setup.exe"),
    (Join-Path $installers "QuietPad_0.1.0_x64_en-US.msi"),
    (Join-Path $repo "portable\QuietPad.exe"),
    $zip | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
