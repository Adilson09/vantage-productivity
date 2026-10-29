param(
  [Parameter(Mandatory=$true)][string]$Fixtures,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
$suiteFixtures = Get-Content -LiteralPath $Fixtures -Raw | ConvertFrom-Json
$suiteExcel = $null
$suiteBook = $null
$suiteSheet = $null
$suiteRange = $null
$suiteStarted = Get-Date
$suiteReport = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  status = 'unavailable'
  reference = 'New owned Excel COM instance, fresh scratch workbook, macros disabled; no user files opened.'
  caseCount = $suiteFixtures.cases.Count
  passed = 0
  failures = @()
}
try {
  $suiteExcel = New-Object -ComObject Excel.Application
  $suiteExcel.Visible = $false
  $suiteExcel.DisplayAlerts = $false
  $suiteExcel.AutomationSecurity = 3
  $suiteExcel.AskToUpdateLinks = $false
  $suiteReport.excelVersion = [string]$suiteExcel.Version
  $suiteReport.excelBuild = [string]$suiteExcel.Build
  $suiteReport.excelOperatingSystem = [string]$suiteExcel.OperatingSystem
  $suiteBook = $suiteExcel.Workbooks.Add()
  $suiteSheet = $suiteBook.Worksheets.Item(1)
  $suiteSheet.Name = 'Data'
  $suiteGrid = New-Object 'object[,]' $suiteFixtures.cases.Count,3
  for ($suiteIndex = 0; $suiteIndex -lt $suiteFixtures.cases.Count; $suiteIndex++) {
    $suiteCase = $suiteFixtures.cases[$suiteIndex]
    $suiteGrid[$suiteIndex,0] = [double]$suiteCase.a
    $suiteGrid[$suiteIndex,1] = [double]$suiteCase.b
    $suiteGrid[$suiteIndex,2] = [string]$suiteCase.formula
  }
  $suiteRange = $suiteSheet.Range('A1', ('C' + $suiteFixtures.cases.Count))
  $suiteRange.Formula = $suiteGrid
  foreach ($suiteCase in $suiteFixtures.cases) {
    if ($null -ne $suiteCase.formatted) {
      $suiteFormatCell = $suiteSheet.Cells.Item([int]$suiteCase.row,3)
      try { $suiteFormatCell.NumberFormat = '0.00' } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteFormatCell) }
    }
  }
  $suiteExcel.CalculateFullRebuild()
  $suiteFailures = [Collections.Generic.List[object]]::new()
  $suiteActualRange = $suiteSheet.Range('C1', ('C' + $suiteFixtures.cases.Count))
  try { $suiteValues = $suiteActualRange.Value2 } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteActualRange) }
  foreach ($suiteCase in $suiteFixtures.cases) {
    $suiteActual = $suiteValues[[int]$suiteCase.row,1]
    $suiteReason = $null
    if ($suiteCase.error -eq $true) {
      $suiteCell = $suiteSheet.Cells.Item([int]$suiteCase.row,3)
      try { $suiteText = [string]$suiteCell.Text } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteCell) }
      if ($suiteText -ne [string]$suiteCase.native.formatted) { $suiteReason = "Error differs: Excel=$suiteText native=$($suiteCase.native.formatted)" }
    } elseif ($null -ne $suiteCase.native.number) {
      $suiteReference = [double]$suiteActual
      $suiteTolerance = [Math]::Max(1e-9,[Math]::Abs($suiteReference)*1e-9)
      if ([Math]::Abs([double]$suiteCase.native.number - $suiteReference) -gt $suiteTolerance) { $suiteReason = "Numeric result differs: Excel=$suiteReference native=$($suiteCase.native.number)" }
      if ($null -ne $suiteCase.formatted) {
        $suiteCell = $suiteSheet.Cells.Item([int]$suiteCase.row,3)
        try { $suiteText = [string]$suiteCell.Text } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteCell) }
        if ($suiteText -cne [string]$suiteCase.native.formatted) { $suiteReason = "Displayed financial rounding differs: Excel=$suiteText native=$($suiteCase.native.formatted)" }
      }
    } else {
      if ($suiteActual -is [bool]) { $suiteText = if ($suiteActual) { 'TRUE' } else { 'FALSE' } } else { $suiteText = [string]$suiteActual }
      if ($suiteText -cne [string]$suiteCase.native.formatted) { $suiteReason = "Typed text/boolean differs: Excel=$suiteText native=$($suiteCase.native.formatted)" }
    }
    if ($null -ne $suiteReason) { $suiteFailures.Add([ordered]@{row=$suiteCase.row;category=$suiteCase.category;formula=$suiteCase.formula;reason=$suiteReason}) }
  }
  # Verify that the comparison uses a live model, rather than saved caches.
  $suiteDependency = $suiteSheet.Cells.Item(1,1)
  try { $suiteDependency.Value2 = [double]999 } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteDependency) }
  $suiteExcel.CalculateFullRebuild()
  $suiteResultCell = $suiteSheet.Cells.Item(1,3)
  try { $suiteRefreshed = [double]$suiteResultCell.Value2 } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteResultCell) }
  $suiteReport.liveDependencyRefresh = ($suiteRefreshed -eq (999 + [double]$suiteFixtures.cases[0].b))
  $suiteReport.status = if ($suiteFailures.Count -eq 0 -and $suiteReport.liveDependencyRefresh) { 'passed' } else { 'failed' }
  $suiteReport.passed = $suiteFixtures.cases.Count - $suiteFailures.Count
  $suiteReport.failures = $suiteFailures.ToArray()
  $suiteReport.limitations = @('Twelve deterministic function categories; not all Excel functions or advanced models.', 'No volatile functions or external connections.', 'Machine locale and installed Excel version apply to this reference.')
} catch {
  $suiteReport.error = $_.Exception.Message
} finally {
  if ($null -ne $suiteRange) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteRange) }
  if ($null -ne $suiteSheet) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteSheet) }
  if ($null -ne $suiteBook) {
    try { $suiteBook.Close($false) } catch { }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteBook)
  }
  if ($null -ne $suiteExcel) {
    try { $suiteExcel.Quit() } catch { }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($suiteExcel)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
$suiteReport.elapsedMs = [int]((Get-Date) - $suiteStarted).TotalMilliseconds
$suiteReport | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Output -Encoding utf8
Write-Output ($suiteReport | ConvertTo-Json -Depth 4 -Compress)
if ($suiteReport.status -eq 'failed') { exit 1 }
if ($suiteReport.status -eq 'unavailable') { exit 2 }
