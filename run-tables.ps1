param(
  [string]$ScenarioMode = "rolling",
  [string]$StartDay = "both",
  [string]$Durations = "2,3,4,5,6,7,8,9,10",
  [int]$RollingDays = 30,
  [string]$Locations = "Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan",
  [string]$Strategy = "legacy-batch",
  [ValidateSet("safe", "fast", "turbo")]
  [string]$SpeedMode = "safe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if ($ScenarioMode -eq "weekday") {
  node src/index.js --scenario-mode=weekday --start-day=$StartDay --durations=$Durations --locations=$Locations --strategy=$Strategy --speed-mode=$SpeedMode
} else {
  node src/index.js --scenario-mode=rolling --rolling-days=$RollingDays --durations=$Durations --locations=$Locations --strategy=$Strategy --speed-mode=$SpeedMode
}
