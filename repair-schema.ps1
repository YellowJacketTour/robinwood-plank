$ErrorActionPreference = "Stop"

$schemaPath = "integrations/plankspace-app/db/schema.ts"
if (-not (Test-Path $schemaPath)) {
  throw "Run this script from the project root. Missing $schemaPath"
}

$current = Get-Content $schemaPath -Raw
$widgetNames = @("profileWidgets", "profileTips", "liveRooms", "liveRoomMembers")
$widgetBlocks = @()

foreach ($name in $widgetNames) {
  $match = [regex]::Match($current, "(?ms)^export const $name\s*=.*?(?=^export const |\z)")
  if (-not $match.Success) {
    throw "The current schema is missing the new $name definition. No files were changed."
  }
  $widgetBlocks += $match.Value.TrimEnd()
}

$commits = @(git log --format=%H -- $schemaPath)
if ($LASTEXITCODE -ne 0 -or $commits.Count -eq 0) {
  throw "Could not read schema history from Git."
}

$base = $null
$baseCommit = $null
foreach ($commit in $commits) {
  $candidate = git show "${commit}:$schemaPath" 2>$null | Out-String
  if ($LASTEXITCODE -ne 0) { continue }
  if (
    $candidate -match "(?m)^export const profiles\s*=" -and
    $candidate -match "viewCount" -and
    $candidate -match "(?m)^export const profileVisits\s*=" -and
    $candidate -match "(?m)^export const publications\s*="
  ) {
    $base = $candidate.TrimEnd()
    $baseCommit = $commit
    break
  }
}

if (-not $base) {
  throw "Could not find the complete pre-widget profile schema in Git history. No files were changed."
}

# Restore the complete newer profile/social schema, then add only the four new
# widget/Woodstock definitions. This avoids chasing missing fields one by one.
foreach ($block in $widgetBlocks) {
  $base += "`r`n`r`n" + $block
}
$base += "`r`n"

# Widget definitions use boolean. Ensure the restored pg-core import includes it.
$importPattern = '(?m)^import\s*\{([^}]*)\}\s*from\s*"drizzle-orm/pg-core";'
$importMatch = [regex]::Match($base, $importPattern)
if (-not $importMatch.Success) {
  throw "Could not locate the drizzle pg-core import. No files were changed."
}
$imports = @($importMatch.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($imports -notcontains "boolean") { $imports += "boolean" }
$imports = @($imports | Sort-Object -Unique)
$replacement = 'import { ' + ($imports -join ', ') + ' } from "drizzle-orm/pg-core";'
$base = [regex]::Replace($base, $importPattern, $replacement, 1)

$backup = "$schemaPath.before-widget-repair"
Copy-Item $schemaPath $backup -Force
Set-Content -Path $schemaPath -Value $base -Encoding utf8

Write-Host "Restored complete profile schema from $baseCommit"
Write-Host "Preserved widget and Woodstock tables."
Write-Host "Backup: $backup"
Write-Host "Now run: npm run build"
