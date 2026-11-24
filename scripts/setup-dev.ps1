<#
.SYNOPSIS
  One-click developer environment setup for CvSU CSSO Event QR Attendance System (Windows).
.DESCRIPTION
  Checks Git and Node.js 22+ (installing via winget if missing), installs npm dependencies,
  installs Playwright Chromium, optionally installs @google/clasp (-WithClasp), and runs npm test.
.EXAMPLE
  .\scripts\setup-dev.ps1
  .\scripts\setup-dev.ps1 -WithClasp
#>
param(
  [switch]$WithClasp,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

function Require-Command($cmd, $wingetId, $label) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) {
    Write-Host "[OK] $label found: $((Get-Command $cmd).Source)" -ForegroundColor Green
    return
  }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "$label ($cmd) is not installed and winget is unavailable. Install $label manually and re-run."
  }
  Write-Host "[INSTALL] Installing $label via winget ($wingetId)..." -ForegroundColor Cyan
  winget install --id $wingetId --exact --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install $label via winget (exit $LASTEXITCODE)."
  }
  Write-Host "[INFO] $label installed. You may need to reopen your terminal if PATH did not refresh." -ForegroundColor Yellow
}

Write-Host "=== CvSU CSSO Attendance - One-Click Dev Setup ===" -ForegroundColor Cyan
Require-Command 'git' 'Git.Git' 'Git'
Require-Command 'node' 'OpenJS.NodeJS.LTS' 'Node.js LTS'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repoRoot
try {
  Write-Host "`n[1/4] Installing npm dependencies (npm ci)..." -ForegroundColor Cyan
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }

  Write-Host "`n[2/4] Installing Playwright Chromium..." -ForegroundColor Cyan
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw "playwright install failed ($LASTEXITCODE)" }

  if ($WithClasp) {
    Write-Host "`n[3/4] Installing @google/clasp globally..." -ForegroundColor Cyan
    npm install -g @google/clasp
    if ($LASTEXITCODE -ne 0) { throw "clasp install failed ($LASTEXITCODE)" }
    Write-Host "[INFO] Run 'clasp login' and update .clasp.json with your Script ID to push via CLI." -ForegroundColor Yellow
  } else {
    Write-Host "`n[3/4] Skipping @google/clasp (pass -WithClasp to install)." -ForegroundColor DarkGray
  }

  if (-not $SkipTests) {
    Write-Host "`n[4/4] Running full verification suite (npm test)..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) { throw "npm test failed ($LASTEXITCODE)" }
  }

  Write-Host "`n[DONE] Developer environment is ready!" -ForegroundColor Green
} finally {
  Pop-Location
}
