Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Show-MessageBox {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [string]$Title = "DiscoverCars launcher",
    [ValidateSet("Info", "Error", "Warning")]
    [string]$Type = "Info"
  )

  Add-Type -AssemblyName System.Windows.Forms

  $icon = [System.Windows.Forms.MessageBoxIcon]::Information
  if ($Type -eq "Error") {
    $icon = [System.Windows.Forms.MessageBoxIcon]::Error
  } elseif ($Type -eq "Warning") {
    $icon = [System.Windows.Forms.MessageBoxIcon]::Warning
  }

  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    $Title,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    $icon
  )
}

function Ensure-Requirements {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    Show-MessageBox -Message "Node.js was not found. Install Node.js 18+ and run start.bat again." -Type Error
    throw "Node.js is required."
  }

  $entryPath = Join-Path $root "src\index.js"
  if (-not (Test-Path $entryPath)) {
    Show-MessageBox -Message "File src\index.js was not found. Check project files." -Type Error
    throw "Missing src\index.js."
  }

  $playwrightPackagePath = Join-Path $root "node_modules\playwright\package.json"
  if (-not (Test-Path $playwrightPackagePath)) {
    Write-Host "Dependencies not found. Running install.ps1..." -ForegroundColor Yellow
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "install.ps1")
    if ($LASTEXITCODE -ne 0) {
      Show-MessageBox -Message "install.ps1 failed. Fix installation issues and run start.bat again." -Type Error
      throw "Dependency installation failed."
    }
  }
}

function Show-RunPicker {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "DiscoverCars - Options"
  $form.StartPosition = "CenterScreen"
  $form.Width = 560
  $form.Height = 835
  $form.TopMost = $true

  $durationsLabel = New-Object System.Windows.Forms.Label
  $durationsLabel.Left = 20
  $durationsLabel.Top = 18
  $durationsLabel.Width = 500
  $durationsLabel.Height = 48
  $durationsLabel.Text = "Select rental durations. You can select multiple options.`nOption '2-10 (all)' selects the full range."
  $form.Controls.Add($durationsLabel)

  $checkedList = New-Object System.Windows.Forms.CheckedListBox
  $checkedList.Left = 20
  $checkedList.Top = 80
  $checkedList.Width = 500
  $checkedList.Height = 250
  $checkedList.CheckOnClick = $true
  [void]$checkedList.Items.Add("2-10 (all)")
  foreach ($day in 2..10) {
    [void]$checkedList.Items.Add("$day")
  }
  $checkedList.SetItemChecked(0, $true)
  $form.Controls.Add($checkedList)

  $startDatesLabel = New-Object System.Windows.Forms.Label
  $startDatesLabel.Left = 20
  $startDatesLabel.Top = 345
  $startDatesLabel.Width = 500
  $startDatesLabel.Height = 40
  $startDatesLabel.Text = "Select specific pickup start dates (day / month / year).`nYou can add multiple start dates."
  $form.Controls.Add($startDatesLabel)

  $datePicker = New-Object System.Windows.Forms.DateTimePicker
  $datePicker.Left = 20
  $datePicker.Top = 392
  $datePicker.Width = 170
  $datePicker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
  $datePicker.CustomFormat = "yyyy-MM-dd"
  $datePicker.Value = (Get-Date).Date.AddDays(1)
  $form.Controls.Add($datePicker)

  $addDateButton = New-Object System.Windows.Forms.Button
  $addDateButton.Left = 205
  $addDateButton.Top = 390
  $addDateButton.Width = 95
  $addDateButton.Height = 30
  $addDateButton.Text = "Add date"
  $form.Controls.Add($addDateButton)

  $removeDateButton = New-Object System.Windows.Forms.Button
  $removeDateButton.Left = 315
  $removeDateButton.Top = 390
  $removeDateButton.Width = 95
  $removeDateButton.Height = 30
  $removeDateButton.Text = "Remove"
  $form.Controls.Add($removeDateButton)

  $clearDatesButton = New-Object System.Windows.Forms.Button
  $clearDatesButton.Left = 425
  $clearDatesButton.Top = 390
  $clearDatesButton.Width = 95
  $clearDatesButton.Height = 30
  $clearDatesButton.Text = "Clear all"
  $form.Controls.Add($clearDatesButton)

  $datesList = New-Object System.Windows.Forms.ListBox
  $datesList.Left = 20
  $datesList.Top = 432
  $datesList.Width = 500
  $datesList.Height = 180
  $datesList.SelectionMode = [System.Windows.Forms.SelectionMode]::MultiExtended
  $form.Controls.Add($datesList)

  $speedLabel = New-Object System.Windows.Forms.Label
  $speedLabel.Left = 20
  $speedLabel.Top = 625
  $speedLabel.Width = 500
  $speedLabel.Height = 32
  $speedLabel.Text = "Speed mode. Use safe to return to the previous stable behavior."
  $form.Controls.Add($speedLabel)

  $speedCombo = New-Object System.Windows.Forms.ComboBox
  $speedCombo.Left = 20
  $speedCombo.Top = 660
  $speedCombo.Width = 250
  $speedCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$speedCombo.Items.Add("fast")
  [void]$speedCombo.Items.Add("safe")
  [void]$speedCombo.Items.Add("turbo")
  $speedCombo.SelectedIndex = 0
  $form.Controls.Add($speedCombo)

  function Add-DateToList([datetime]$value) {
    $iso = $value.ToString("yyyy-MM-dd")
    if ($datesList.Items.Contains($iso)) {
      return
    }

    [void]$datesList.Items.Add($iso)
    $sorted = @($datesList.Items | ForEach-Object { [string]$_ } | Sort-Object)
    $datesList.Items.Clear()
    foreach ($item in $sorted) {
      [void]$datesList.Items.Add($item)
    }
  }

  Add-DateToList -value $datePicker.Value

  $addDateButton.Add_Click({
    Add-DateToList -value $datePicker.Value
  })

  $removeDateButton.Add_Click({
    $selectedDates = @($datesList.SelectedItems | ForEach-Object { [string]$_ })
    foreach ($selectedDate in $selectedDates) {
      [void]$datesList.Items.Remove($selectedDate)
    }
  })

  $clearDatesButton.Add_Click({
    $datesList.Items.Clear()
  })

  $runButton = New-Object System.Windows.Forms.Button
  $runButton.Left = 20
  $runButton.Top = 715
  $runButton.Width = 170
  $runButton.Height = 30
  $runButton.Text = "Run"
  $form.Controls.Add($runButton)

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Left = 210
  $cancelButton.Top = 715
  $cancelButton.Width = 170
  $cancelButton.Height = 30
  $cancelButton.Text = "Cancel"
  $form.Controls.Add($cancelButton)

  $runButton.Add_Click({
    $picked = @()
    foreach ($item in $checkedList.CheckedItems) {
      $picked += [string]$item
    }

    if ($picked.Count -eq 0) {
      [void][System.Windows.Forms.MessageBox]::Show(
        "Select at least one duration option.",
        "Validation",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
      return
    }

    $pickedStartDates = @(
      $datesList.Items |
        ForEach-Object { [string]$_ } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Sort-Object -Unique
    )

    if ($pickedStartDates.Count -eq 0) {
      [void][System.Windows.Forms.MessageBox]::Show(
        "Add at least one start date.",
        "Validation",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
      return
    }

    $form.Tag = [PSCustomObject]@{
      selected_durations = @(
        $picked |
          ForEach-Object { [string]$_ } |
          Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
      )
      start_dates = $pickedStartDates
      speed_mode = [string]$speedCombo.SelectedItem
    }
    $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Close()
  })

  $cancelButton.Add_Click({
    $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Close()
  })

  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    return $null
  }

  return $form.Tag
}

function Resolve-Durations {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$SelectedItems
  )

  $selectedTokens = @(
    $SelectedItems |
      ForEach-Object { [string]$_ } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )

  if ($selectedTokens -contains "2-10 (all)") {
    return @(2, 3, 4, 5, 6, 7, 8, 9, 10)
  }

  $unique = New-Object System.Collections.Generic.HashSet[int]
  foreach ($item in $selectedTokens) {
    $raw = [string]$item
    if ($raw -match "^\s*(\d+)\s*$") {
      $value = [int]$matches[1]
      if ($value -ge 2 -and $value -le 10) {
        [void]$unique.Add($value)
      }
    }
  }

  if ($unique.Count -eq 0) {
    return @(2, 3, 4, 5, 6, 7, 8, 9, 10)
  }

  return @($unique | Sort-Object)
}

Ensure-Requirements

$pickedOptions = Show-RunPicker
if (-not $pickedOptions) {
  Write-Host "Run cancelled." -ForegroundColor Yellow
  exit 0
}

$selected = @(
  @($pickedOptions.selected_durations) |
    ForEach-Object { [string]$_ } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($selected.Count -eq 0) {
  Write-Host "Run cancelled." -ForegroundColor Yellow
  exit 0
}

$startDates = @(
  @($pickedOptions.start_dates) |
    ForEach-Object { [string]$_ } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    Sort-Object -Unique
)
if ($startDates.Count -eq 0) {
  Write-Host "Run cancelled (no start dates)." -ForegroundColor Yellow
  exit 0
}

$durations = Resolve-Durations -SelectedItems $selected
$durationsCsv = ($durations | ForEach-Object { $_.ToString() }) -join ","
$startDatesCsv = ($startDates -join ",")
$speedMode = [string]$pickedOptions.speed_mode
if ([string]::IsNullOrWhiteSpace($speedMode)) {
  $speedMode = "safe"
}

Write-Host ""
Write-Host "Running DiscoverCars with durations: $durationsCsv | start-dates: $startDatesCsv | speed-mode: $speedMode" -ForegroundColor Cyan
Write-Host ""

$outputDir = Join-Path $root "output"
if (-not (Test-Path $outputDir)) {
  [void](New-Item -ItemType Directory -Path $outputDir -Force)
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$jsonPath = Join-Path $outputDir "results-$timestamp.json"
$jsonLatestPath = Join-Path $outputDir "results-latest.json"

$nodeArgs = @(
  "src/index.js",
  "--start-dates=$startDatesCsv",
  "--durations=$durationsCsv",
  "--locations=Warsaw,Krakow,Gdansk,Katowice,Wroclaw,Poznan",
  "--strategy=legacy-batch",
  "--retries=1",
  "--direct-candidate-limit=2",
  "--direct-offers-wait=6000",
  "--speed-mode=$speedMode",
  "--resume",
  "--save=$jsonPath"
)

& node @nodeArgs

$exitCode = $LASTEXITCODE

if (Test-Path $jsonPath) {
  Copy-Item -Path $jsonPath -Destination $jsonLatestPath -Force
}

Write-Host ""
Write-Host "Saved JSON: $jsonPath" -ForegroundColor DarkCyan
Write-Host "Latest JSON alias: $jsonLatestPath" -ForegroundColor DarkCyan

if ($exitCode -eq 0) {
  Write-Host ""
  Write-Host "Completed successfully." -ForegroundColor Green
  exit 0
}

Write-Host ""
Write-Host "Finished with error code: $exitCode" -ForegroundColor Red
exit $exitCode
