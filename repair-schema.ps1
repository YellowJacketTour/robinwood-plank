$ErrorActionPreference = "Stop"

$schemaPath = "integrations/plankspace-app/db/schema.ts"
if (-not (Test-Path $schemaPath)) {
  throw "Run this script from the project root. Missing $schemaPath"
}

$current = Get-Content $schemaPath -Raw
$required = @("profileVisits", "publications")
$missing = @($required | Where-Object { $current -notmatch "(?m)^export const $($_)\s*=" })

if ($missing.Count -eq 0) {
  Write-Host "Schema exports are already present."
  exit 0
}

$commits = @(git log --format=%H -- $schemaPath)
if ($LASTEXITCODE -ne 0 -or $commits.Count -eq 0) {
  throw "Could not read schema history from Git."
}

$blocks = @()
foreach ($name in $missing) {
  $found = $null
  foreach ($commit in $commits) {
    $old = git show "${commit}:$schemaPath" 2>$null | Out-String
    if ($LASTEXITCODE -ne 0) { continue }
    $match = [regex]::Match(
      $old,
      "(?ms)^export const $name\s*=.*?(?=^export const |\z)"
    )
    if ($match.Success) {
      $found = $match.Value.TrimEnd()
      break
    }
  }
  if (-not $found) {
    throw "Could not find the previous $name definition in Git history. No files were changed."
  }
  $blocks += $found
}

$backup = "$schemaPath.before-widget-repair"
Copy-Item $schemaPath $backup -Force
$addition = "`r`n`r`n" + ($blocks -join "`r`n`r`n") + "`r`n"
Set-Content -Path $schemaPath -Value ($current.TrimEnd() + $addition) -Encoding utf8

Write-Host "Restored: $($missing -join ', ')"
Write-Host "Backup: $backup"
Write-Host "Now run: npm run build"
