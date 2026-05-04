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
  $form.Height = 910
  $form.TopMost = $true

  $durationsLabel = New-Object System.Windows.Forms.Label
  $durationsLabel.Left = 20
  $durationsLabel.Top = 18
  $durationsLabel.Width = 500
  $durationsLabel.Height = 48
  $durationsLabel.Text = "Select rental durations. You can select multiple options.`nOptions '2-20 (all)' and '2-10 (all)' select common ranges."
  $form.Controls.Add($durationsLabel)

  $checkedList = New-Object System.Windows.Forms.CheckedListBox
  $checkedList.Left = 20
  $checkedList.Top = 80
  $checkedList.Width = 500
  $checkedList.Height = 250
  $checkedList.CheckOnClick = $true
  [void]$checkedList.Items.Add("2-20 (all)")
  [void]$checkedList.Items.Add("2-10 (all)")
  foreach ($day in 2..20) {
    [void]$checkedList.Items.Add("$day")
  }
  $checkedList.SetItemChecked(1, $true)
  $checkedList.Tag = $false

  $checkedList.Add_ItemCheck({
    param($sender, $eventArgs)

    if ($sender.Tag -eq $true) {
      return
    }

    if ($eventArgs.NewValue -ne [System.Windows.Forms.CheckState]::Checked) {
      return
    }

    try {
      $sender.Tag = $true

      if ($eventArgs.Index -eq 0) {
        for ($i = 1; $i -lt $sender.Items.Count; $i++) {
          $sender.SetItemChecked($i, $false)
        }
        return
      }

      if ($eventArgs.Index -eq 1) {
        $sender.SetItemChecked(0, $false)
        for ($i = 2; $i -lt $sender.Items.Count; $i++) {
          $sender.SetItemChecked($i, $false)
        }
        return
      }

      $sender.SetItemChecked(0, $false)
      $sender.SetItemChecked(1, $false)
    } finally {
      $sender.Tag = $false
    }
  })
  $form.Controls.Add($checkedList)

  $startDatesLabel = New-Object System.Windows.Forms.Label
  $startDatesLabel.Left = 20
  $startDatesLabel.Top = 345
  $startDatesLabel.Width = 500
  $startDatesLabel.Height = 44
  $startDatesLabel.Text = "Choose pickup start dates. Use a date range, or paste specific dates at once.`nNo Add date button needed."
  $form.Controls.Add($startDatesLabel)

  $rangeRadio = New-Object System.Windows.Forms.RadioButton
  $rangeRadio.Left = 20
  $rangeRadio.Top = 398
  $rangeRadio.Width = 220
  $rangeRadio.Height = 24
  $rangeRadio.Text = "Date range (from - to)"
  $rangeRadio.Checked = $true
  $form.Controls.Add($rangeRadio)

  $specificRadio = New-Object System.Windows.Forms.RadioButton
  $specificRadio.Left = 280
  $specificRadio.Top = 398
  $specificRadio.Width = 220
  $specificRadio.Height = 24
  $specificRadio.Text = "Specific dates"
  $form.Controls.Add($specificRadio)

  $fromLabel = New-Object System.Windows.Forms.Label
  $fromLabel.Left = 20
  $fromLabel.Top = 438
  $fromLabel.Width = 80
  $fromLabel.Height = 22
  $fromLabel.Text = "From:"
  $form.Controls.Add($fromLabel)

  $fromDatePicker = New-Object System.Windows.Forms.DateTimePicker
  $fromDatePicker.Left = 95
  $fromDatePicker.Top = 432
  $fromDatePicker.Width = 150
  $fromDatePicker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
  $fromDatePicker.CustomFormat = "yyyy-MM-dd"
  $fromDatePicker.Value = (Get-Date).Date.AddDays(1)
  $form.Controls.Add($fromDatePicker)

  $toLabel = New-Object System.Windows.Forms.Label
  $toLabel.Left = 280
  $toLabel.Top = 438
  $toLabel.Width = 50
  $toLabel.Height = 22
  $toLabel.Text = "To:"
  $form.Controls.Add($toLabel)

  $toDatePicker = New-Object System.Windows.Forms.DateTimePicker
  $toDatePicker.Left = 330
  $toDatePicker.Top = 432
  $toDatePicker.Width = 150
  $toDatePicker.Format = [System.Windows.Forms.DateTimePickerFormat]::Custom
  $toDatePicker.CustomFormat = "yyyy-MM-dd"
  $toDatePicker.Value = (Get-Date).Date.AddDays(1)
  $form.Controls.Add($toDatePicker)

  $specificDatesLabel = New-Object System.Windows.Forms.Label
  $specificDatesLabel.Left = 20
  $specificDatesLabel.Top = 485
  $specificDatesLabel.Width = 500
  $specificDatesLabel.Height = 32
  $specificDatesLabel.Text = "Specific dates: click dates in the calendar to add/remove them, or paste dates manually."
  $form.Controls.Add($specificDatesLabel)

  $specificCalendar = New-Object System.Windows.Forms.MonthCalendar
  $specificCalendar.Left = 20
  $specificCalendar.Top = 520
  $specificCalendar.MaxSelectionCount = 1
  $specificCalendar.SelectionStart = (Get-Date).Date.AddDays(1)
  $specificCalendar.SelectionEnd = (Get-Date).Date.AddDays(1)
  $form.Controls.Add($specificCalendar)

  $specificDatesTextBox = New-Object System.Windows.Forms.TextBox
  $specificDatesTextBox.Left = 285
  $specificDatesTextBox.Top = 520
  $specificDatesTextBox.Width = 235
  $specificDatesTextBox.Height = 92
  $specificDatesTextBox.Multiline = $true
  $specificDatesTextBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $specificDatesTextBox.Text = (Get-Date).Date.AddDays(1).ToString("yyyy-MM-dd")
  $form.Controls.Add($specificDatesTextBox)

  $clearSpecificDatesButton = New-Object System.Windows.Forms.Button
  $clearSpecificDatesButton.Left = 285
  $clearSpecificDatesButton.Top = 625
  $clearSpecificDatesButton.Width = 170
  $clearSpecificDatesButton.Height = 28
  $clearSpecificDatesButton.Text = "Clear selected dates"
  $form.Controls.Add($clearSpecificDatesButton)

  $dateModeHint = New-Object System.Windows.Forms.Label
  $dateModeHint.Left = 20
  $dateModeHint.Top = 690
  $dateModeHint.Width = 500
  $dateModeHint.Height = 22
  $dateModeHint.Text = "Range mode creates every date from From to To, inclusive."
  $form.Controls.Add($dateModeHint)

  $speedLabel = New-Object System.Windows.Forms.Label
  $speedLabel.Left = 20
  $speedLabel.Top = 720
  $speedLabel.Width = 500
  $speedLabel.Height = 32
  $speedLabel.Text = "Speed mode. Use safe to return to the previous stable behavior."
  $form.Controls.Add($speedLabel)

  $speedCombo = New-Object System.Windows.Forms.ComboBox
  $speedCombo.Left = 20
  $speedCombo.Top = 755
  $speedCombo.Width = 250
  $speedCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$speedCombo.Items.Add("fast")
  [void]$speedCombo.Items.Add("safe")
  [void]$speedCombo.Items.Add("turbo")
  $speedCombo.SelectedIndex = 0
  $form.Controls.Add($speedCombo)

  function Format-IsoDate([datetime]$value) {
    return $value.Date.ToString("yyyy-MM-dd")
  }

  function Get-DateRangeIso {
    param(
      [Parameter(Mandatory = $true)]
      [datetime]$Start,
      [Parameter(Mandatory = $true)]
      [datetime]$End
    )

    $dates = @()
    $cursor = $Start.Date
    $last = $End.Date
    while ($cursor -le $last) {
      $dates += (Format-IsoDate -value $cursor)
      $cursor = $cursor.AddDays(1)
    }

    return $dates
  }

  function Set-SpecificDateText {
    param(
      [string[]]$Dates
    )

    $specificDatesTextBox.Text = (@($Dates) | Sort-Object -Unique) -join ", "
  }

  function Parse-SpecificStartDates {
    param(
      [Parameter(Mandatory = $true)]
      [string]$Text
    )

    $tokens = @(
      $Text -split "[,\s;|]+" |
        ForEach-Object { [string]$_ } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )

    $dates = New-Object System.Collections.Generic.List[string]
    $invalid = New-Object System.Collections.Generic.List[string]
    foreach ($token in $tokens) {
      if ($token -notmatch "^\d{4}-\d{2}-\d{2}$") {
        [void]$invalid.Add($token)
        continue
      }

      $parsedDate = [datetime]::MinValue
      $ok = [datetime]::TryParseExact(
        $token,
        "yyyy-MM-dd",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::None,
        [ref]$parsedDate
      )

      if (-not $ok) {
        [void]$invalid.Add($token)
        continue
      }

      [void]$dates.Add((Format-IsoDate -value $parsedDate))
    }

    return [PSCustomObject]@{
      dates = @($dates | Sort-Object -Unique)
      invalid = @($invalid)
    }
  }

  function Update-DateModeControls {
    $rangeMode = $rangeRadio.Checked
    $fromLabel.Enabled = $rangeMode
    $fromDatePicker.Enabled = $rangeMode
    $toLabel.Enabled = $rangeMode
    $toDatePicker.Enabled = $rangeMode
    $specificDatesLabel.Enabled = -not $rangeMode
    $specificCalendar.Enabled = -not $rangeMode
    $specificDatesTextBox.Enabled = -not $rangeMode
    $clearSpecificDatesButton.Enabled = -not $rangeMode

    if ($rangeMode) {
      $dateModeHint.Text = "Range mode creates every date from From to To, inclusive."
    } else {
      $dateModeHint.Text = "Specific mode: click a date to add it, click it again to remove it."
    }
  }

  $rangeRadio.Add_CheckedChanged({ Update-DateModeControls })
  $specificRadio.Add_CheckedChanged({ Update-DateModeControls })
  $specificCalendar.Add_MouseDown({
    param($sender, $eventArgs)

    if (-not $specificRadio.Checked) {
      $specificRadio.Checked = $true
    }

    $hit = $sender.HitTest($eventArgs.X, $eventArgs.Y)
    if ([string]$hit.HitArea -ne "Date") {
      return
    }

    $selectedIsoDate = Format-IsoDate -value $hit.Time
    $parsedSpecificDates = Parse-SpecificStartDates -Text $specificDatesTextBox.Text
    $dateSet = New-Object System.Collections.Generic.HashSet[string]
    foreach ($date in @($parsedSpecificDates.dates)) {
      [void]$dateSet.Add([string]$date)
    }

    if ($dateSet.Contains($selectedIsoDate)) {
      [void]$dateSet.Remove($selectedIsoDate)
    } else {
      [void]$dateSet.Add($selectedIsoDate)
    }

    Set-SpecificDateText -Dates @($dateSet)
  })
  $clearSpecificDatesButton.Add_Click({
    $specificRadio.Checked = $true
    $specificDatesTextBox.Clear()
  })
  Update-DateModeControls

  $runButton = New-Object System.Windows.Forms.Button
  $runButton.Left = 20
  $runButton.Top = 815
  $runButton.Width = 170
  $runButton.Height = 30
  $runButton.Text = "Run"
  $form.Controls.Add($runButton)

  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Left = 210
  $cancelButton.Top = 815
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

    if ($rangeRadio.Checked) {
      if ($fromDatePicker.Value.Date -gt $toDatePicker.Value.Date) {
        [void][System.Windows.Forms.MessageBox]::Show(
          "Start date range is invalid. 'From' must be before or equal to 'To'.",
          "Validation",
          [System.Windows.Forms.MessageBoxButtons]::OK,
          [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        return
      }

      $pickedStartDates = @(
        Get-DateRangeIso -Start $fromDatePicker.Value -End $toDatePicker.Value
      )
    } else {
      $parsedSpecificDates = Parse-SpecificStartDates -Text $specificDatesTextBox.Text
      if (@($parsedSpecificDates.invalid).Count -gt 0) {
        [void][System.Windows.Forms.MessageBox]::Show(
          "Invalid start date(s): $(@($parsedSpecificDates.invalid) -join ', '). Use YYYY-MM-DD format.",
          "Validation",
          [System.Windows.Forms.MessageBoxButtons]::OK,
          [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        return
      }

      $pickedStartDates = @($parsedSpecificDates.dates)
    }

    if ($pickedStartDates.Count -eq 0) {
      [void][System.Windows.Forms.MessageBox]::Show(
        "Choose at least one start date.",
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

  if ($selectedTokens -contains "2-20 (all)") {
    return @(2..20)
  }

  if ($selectedTokens -contains "2-10 (all)") {
    return @(2..10)
  }

  $unique = New-Object System.Collections.Generic.HashSet[int]
  foreach ($item in $selectedTokens) {
    $raw = [string]$item
    if ($raw -match "^\s*(\d+)\s*$") {
      $value = [int]$matches[1]
      if ($value -ge 2 -and $value -le 20) {
        [void]$unique.Add($value)
      }
    }
  }

  if ($unique.Count -eq 0) {
    return @(2..10)
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
