# Push Sentinel to production: GitHub main → Render sales-audit-2.0-2
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
git checkout main
if (-not $args[0]) {
  Write-Host 'Usage: .\scripts\push-main.ps1 "commit message"' -ForegroundColor Yellow
  exit 1
}
git add -A
$status = git status --porcelain
if ($status) {
  git commit -m $args[0]
}
git push origin main
Write-Host 'Pushed to https://github.com/cavinkarecia/sales-audit-2.0 (branch main)' -ForegroundColor Green
Write-Host 'Render sales-audit-2.0-2 should auto-deploy.' -ForegroundColor Green
