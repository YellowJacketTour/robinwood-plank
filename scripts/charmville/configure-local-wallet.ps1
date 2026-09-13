$ErrorActionPreference = 'Stop'
# Use only the two public values used by the master deployment workflow.
# Production database credentials and other environment variables are never read.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$envPath = Join-Path $repoRoot '.env.local'
$lines = if (Test-Path -LiteralPath $envPath) { @(Get-Content -LiteralPath $envPath) } else { @() }
$newValues = @()
foreach ($key in @('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID','NEXT_PUBLIC_WALLET_UI')) {
  $raw = & gh api "repos/YellowJacketTour/robinwood-plank/actions/variables/$key"
  if ($LASTEXITCODE -ne 0) { throw "Could not load public build variable $key" }
  $entry = $raw | ConvertFrom-Json
  if ($entry.value -match '[\r\n]') { throw "Invalid public build variable $key" }
  if ($key -eq 'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID' -and $entry.value -notmatch '^[a-fA-F0-9]{32}$') { throw 'Invalid WalletConnect project ID' }
  if ($key -eq 'NEXT_PUBLIC_WALLET_UI' -and $entry.value -notin @('','legacy','reown')) { throw 'Unknown wallet UI mode' }
  $lines = @($lines | Where-Object { $_ -notmatch ('^'+$key+'=') })
  $newValues += "$key=$($entry.value)"
}
[IO.File]::WriteAllLines($envPath, @($lines)+@($newValues), (New-Object Text.UTF8Encoding($false)))
Write-Output 'Local public wallet configuration now matches the deployment variables. Restart the dev server if it does not reload .env.local.'
