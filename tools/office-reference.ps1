param(
  [Parameter(Mandatory=$true)][string]$CorpusReport,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [int]$PerFormatLimit = 3
)
$ErrorActionPreference='Stop'
if($PerFormatLimit -lt 1 -or $PerFormatLimit -gt 100){throw 'PerFormatLimit must be 1-100'}
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskCorpus=Get-Content -LiteralPath $CorpusReport -Raw | ConvertFrom-Json
$taskCases=[Collections.Generic.List[object]]::new()
$taskRecord=[ordered]@{
  schemaVersion=1; createdAt=[DateTime]::UtcNow.ToString('o')
  scope='Read-only scratch copies in newly created Word and PowerPoint COM instances. Macros disabled; no user document enumeration, saving or process termination. PDF renders are references, not human layout or repair-prompt certification.'
  operatingSystem=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,TotalVisibleMemorySize)
  cpu=(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors)
  culture=(Get-Culture).Name; uiCulture=(Get-UICulture).Name
  display=(Get-CimInstance Win32_VideoController | Select-Object Name,CurrentHorizontalResolution,CurrentVerticalResolution)
  defaultPrinter=(Get-CimInstance Win32_Printer | Where-Object Default | Select-Object Name,DriverName)
  office=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' -ErrorAction SilentlyContinue | Select-Object VersionToReport,UpdateChannel,CDNBaseUrl,ClientCulture,Platform,ProductReleaseIds)
  licenseEntitlement='Not independently verified; installed application reference automation only.'
  fonts=@(Get-ChildItem -LiteralPath 'C:\Windows\Fonts' -File | ForEach-Object { $taskHash=Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256; [pscustomobject]@{name=$_.Name;sha256=$taskHash.Hash.ToLower()} })
  cases=$taskCases
}
function Save-ReferenceEvidence {
  $taskRecord | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $taskOutput 'office-reference-evidence.json') -Encoding utf8
}
function Copy-SafeFixture([string]$Path,[string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $taskArchive=[IO.Compression.ZipFile]::OpenRead($Path)
  try {
    foreach($taskPart in $taskArchive.Entries){
      if($taskPart.FullName.EndsWith('/')){continue}
      if($taskPart.FullName -match '(?i)vbaProject\.bin$|/activeX/|/embeddings/'){throw 'Active or embedded content fixture excluded from unattended reference rendering'}
      if($taskPart.FullName.EndsWith('.rels')){
        $taskReader=[IO.StreamReader]::new($taskPart.Open())
        try{$taskXml=$taskReader.ReadToEnd()}finally{$taskReader.Dispose()}
        if($taskXml -match 'TargetMode\s*=\s*["'']External["'']'){throw 'External relationship fixture excluded from unattended reference rendering'}
      }
    }
  } finally {$taskArchive.Dispose()}
  Copy-Item -LiteralPath $Path -Destination $Destination
}
Save-ReferenceEvidence
$taskWord=$null; $taskPpt=$null; $taskOldLinks=$null
try {
  foreach($taskKind in @('docx','pptx')){
    $taskSelected=@($taskCorpus.cases | Where-Object { $_.kind -eq $taskKind -and $_.noOp.status -eq 'passed' } | Select-Object -First $PerFormatLimit)
    if($taskKind -eq 'docx'){
      $taskWord=New-Object -ComObject Word.Application
      $taskWord.Visible=$false; $taskWord.DisplayAlerts=0; $taskWord.AutomationSecurity=3
      $taskOldLinks=$taskWord.Options.UpdateLinksAtOpen; $taskWord.Options.UpdateLinksAtOpen=$false
      $taskRecord.wordVersion=$taskWord.Version; $taskRecord.wordBuild=$taskWord.Build
    } else {
      $taskPpt=New-Object -ComObject PowerPoint.Application
      $taskPpt.AutomationSecurity=3; $taskPpt.DisplayAlerts=1
      $taskRecord.powerPointVersion=$taskPpt.Version
    }
    foreach($taskCase in $taskSelected){
      if(Test-Path -LiteralPath (Join-Path $taskOutput 'cancel.requested')){break}
      $taskCaseRecord=[ordered]@{id=$taskCase.id;kind=$taskKind;source=$taskCase.source;status='incomplete';variants=@();startedAt=[DateTime]::UtcNow.ToString('o')}
      $taskCases.Add([pscustomobject]$taskCaseRecord); $taskCaseObject=$taskCases[$taskCases.Count-1]
      Save-ReferenceEvidence
      try {
        $taskVariants=[Collections.Generic.List[object]]::new()
        foreach($taskVariant in @(@{name='reference';path=$taskCase.source},@{name='native-noop';path=$taskCase.noOp.output})){
          $taskDoc=$null
          $taskScratch=Join-Path $taskOutput ($taskCase.id+'.'+$taskVariant.name+'.'+$taskKind)
          $taskPdf=$taskScratch+'.pdf'
          if(Test-Path -LiteralPath $taskScratch){throw 'Use a fresh output folder; reference artifacts are never overwritten'}
          $taskSourceBefore=(Get-FileHash -LiteralPath $taskVariant.path -Algorithm SHA256).Hash
          Copy-SafeFixture $taskVariant.path $taskScratch
          try {
            if($taskKind -eq 'docx'){
              $taskDoc=$taskWord.Documents.Open($taskScratch,$false,$true,$false)
              $taskText=$taskDoc.Content.Text
              $taskPages=$taskDoc.ComputeStatistics(2)
              $taskDoc.ExportAsFixedFormat($taskPdf,17)
            } else {
              $taskDoc=$taskPpt.Presentations.Open($taskScratch,-1,0,0)
              $taskPages=$taskDoc.Slides.Count; $taskText=''
              foreach($taskSlide in $taskDoc.Slides){foreach($taskShape in $taskSlide.Shapes){if($taskShape.HasTextFrame -eq -1 -and $taskShape.TextFrame.HasText -eq -1){$taskText+=$taskShape.TextFrame.TextRange.Text}}}
              $taskDoc.SaveAs($taskPdf,32)
            }
            if(!(Test-Path -LiteralPath $taskPdf)){throw 'Reference PDF was not written'}
            $taskTextHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskText))).ToLower()
            $taskSourceAfter=(Get-FileHash -LiteralPath $taskVariant.path -Algorithm SHA256).Hash
            $taskVariants.Add([pscustomobject]@{name=$taskVariant.name;pdf=$taskPdf;pages=$taskPages;textSha256=$taskTextHash;sourceSha256=$taskSourceBefore.ToLower();sourceUnchanged=($taskSourceBefore -eq $taskSourceAfter);pdfSha256=(Get-FileHash -LiteralPath $taskPdf -Algorithm SHA256).Hash.ToLower()})
          } finally {
            if($null -ne $taskDoc){
              if($taskKind -eq 'docx'){$taskDoc.Close(0)}else{$taskDoc.Saved=-1;$taskDoc.Close()}
              [Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskDoc) | Out-Null
            }
          }
        }
        $taskCaseObject.variants=@($taskVariants)
        if($taskVariants[0].pages -ne $taskVariants[1].pages){throw 'Page count differs after native no-op save'}
        if($taskVariants[0].textSha256 -ne $taskVariants[1].textSha256){throw 'Office-extracted text differs after native no-op save'}
        if(@($taskVariants | Where-Object {!$_.sourceUnchanged}).Count){throw 'A source file changed during reference rendering'}
        $taskCaseObject.status='rendered'
      } catch {
        $taskCaseObject.status='failed'
        $taskCaseObject | Add-Member -NotePropertyName error -NotePropertyValue $_.Exception.Message -Force
        if($_.Exception.Message -match 'RPC server is unavailable|0x800706BA'){
          $taskCaseObject.status='oracle-unavailable'
          Save-ReferenceEvidence
          Write-Output ($taskCase.id+': oracle-unavailable; stopping this format')
          break
        }
      }
      Save-ReferenceEvidence
      Write-Output ($taskCase.id+': '+$taskCaseObject.status)
    }
  }
} finally {
  if($null -ne $taskWord){
    try{if($null -ne $taskOldLinks){$taskWord.Options.UpdateLinksAtOpen=$taskOldLinks};$taskWord.Quit(0)}catch{Write-Warning ('Word reference cleanup: '+$_.Exception.Message)}
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskWord) | Out-Null
  }
  if($null -ne $taskPpt){try{$taskPpt.Quit()}catch{Write-Warning ('PowerPoint reference cleanup: '+$_.Exception.Message)};[Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskPpt) | Out-Null}
  Save-ReferenceEvidence
  [GC]::Collect();[GC]::WaitForPendingFinalizers()
}
