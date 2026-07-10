param(
  [string]$ScenarioMode = "rolling",
  [string]$StartDay = "both",
  [string]$Durations = "2,3,4,5,6,7,8,9,10",
  [int]$RollingDays = 30,
  [string]$Locations = "",
  [string]$Strategy = "legacy-batch",
  [ValidateSet("safe", "fast", "turbo")]
  [string]$SpeedMode = "safe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if ([string]::IsNullOrWhiteSpace($Locations)) {
  $locationsConfig = Get-Content -LiteralPath (Join-Path $root "excel-rate-update.config.example.json") -Raw | ConvertFrom-Json
  $Locations = (@($locationsConfig.daily_locations) -join ",")
}
if ([string]::IsNullOrWhiteSpace($Locations)) {
  throw "No locations provided and no daily_locations found in excel-rate-update.config.example.json"
}

if ($ScenarioMode -eq "weekday") {
  node src/index.js --scenario-mode=weekday --start-day=$StartDay --durations=$Durations --locations=$Locations --strategy=$Strategy --speed-mode=$SpeedMode
} else {
  node src/index.js --scenario-mode=rolling --rolling-days=$RollingDays --durations=$Durations --locations=$Locations --strategy=$Strategy --speed-mode=$SpeedMode
}
