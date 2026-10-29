param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
function Get-VerifiedEngineArchive([string]$Url,[string]$Name,[string]$Expected) {
  $taskPath=Join-Path $taskRoot $Name
  if(!(Test-Path -LiteralPath $taskPath)){Invoke-WebRequest -Uri $Url -OutFile $taskPath}
  $taskActual=(Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLower()
  if($taskActual -ne $Expected){throw "SHA256 mismatch for $Name; no executable will be started"}
  return $taskPath
}
$taskQpdfUrl='https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2-msvc64.zip'
$taskQpdfHash='db87077e683630c1217e0e8f9a20a9749d952ab676e881c3689187763a5de25d'
$taskQpdfArchive=Get-VerifiedEngineArchive $taskQpdfUrl 'qpdf-12.4.2-msvc64.zip' $taskQpdfHash
$taskQpdfDir=Join-Path $taskRoot 'qpdf-12.4.2'
if(!(Test-Path -LiteralPath (Join-Path $taskQpdfDir 'qpdf-12.4.2-msvc64\bin\qpdf.exe'))){Expand-Archive -LiteralPath $taskQpdfArchive -DestinationPath $taskQpdfDir}
$taskLoUrl='https://download.documentfoundation.org/libreoffice/stable/26.8.2/win/x86_64/LibreOffice_26.8.2_Win_x86-64.msi'
$taskLoHash='ff4b911403b67ee9e6249f820f9782c44bb32c94fdaa45b0da53a8e419e5307a'
$taskLoArchive=Get-VerifiedEngineArchive $taskLoUrl 'LibreOffice_26.8.2_Win_x86-64.msi' $taskLoHash
$taskExtractorUrl='https://github.com/activescott/lessmsi/releases/download/v2.12.9/lessmsi-v2.12.9.zip'
$taskExtractorHash='5b4e187e74b184ad3a63ccf06c3d17dae2b8c4b6c298a996dbd51a9f6db29d21'
$taskExtractorArchive=Get-VerifiedEngineArchive $taskExtractorUrl 'lessmsi-v2.12.9.zip' $taskExtractorHash
$taskExtractorDir=Join-Path $taskRoot 'lessmsi-2.12.9'
if(!(Test-Path -LiteralPath (Join-Path $taskExtractorDir 'lessmsi.exe'))){Expand-Archive -LiteralPath $taskExtractorArchive -DestinationPath $taskExtractorDir}
$taskLoDir=Join-Path $taskRoot 'libreoffice-26.8.2'
$taskComplete=Join-Path $taskLoDir '.vantage-extraction-complete'
if(!(Test-Path -LiteralPath $taskComplete)){
  # File-only cabinet extraction. No Windows Installer execution, registration or machine installation.
  & (Join-Path $taskExtractorDir 'lessmsi.exe') x $taskLoArchive ($taskLoDir+'\') *> (Join-Path $taskRoot 'libreoffice-file-extraction.log')
  if($LASTEXITCODE -ne 0){throw 'LibreOffice file extraction failed'}
  [IO.File]::WriteAllText($taskComplete,$taskLoHash)
}
$taskEnginePaths=@{libreoffice='libreoffice-26.8.2/SourceDir/LibreOffice/program/soffice.com';qpdf='qpdf-12.4.2/qpdf-12.4.2-msvc64/bin/qpdf.exe'}
$taskPins=@{}
foreach($taskId in $taskEnginePaths.Keys){$taskExe=Join-Path $taskRoot $taskEnginePaths[$taskId];$taskPins[$taskId]=@{path=$taskEnginePaths[$taskId];sha256=(Get-FileHash -LiteralPath $taskExe -Algorithm SHA256).Hash.ToLower()}}
$taskManifest=@{schemaVersion=1;createdAt=[DateTime]::UtcNow.ToString('o');engines=$taskPins;archives=@(@{component='qpdf';version='12.4.2';source=$taskQpdfUrl;sha256=$taskQpdfHash},@{component='LibreOffice';version='26.8.2';source=$taskLoUrl;sha256=$taskLoHash},@{component='lessmsi (extraction tool only)';version='2.12.9';source=$taskExtractorUrl;sha256=$taskExtractorHash})}
$taskManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $taskRoot 'engines.json') -Encoding utf8
foreach($taskLegal in @('LICENSE.txt','NOTICE.md')){Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/qpdf/qpdf/v12.4.2/'+$taskLegal) -OutFile (Join-Path $taskQpdfDir $taskLegal)}
@'
Vantage optional local compatibility engines

LibreOffice 26.8.2, unmodified extracted upstream distribution.
Source: https://download.documentfoundation.org/libreoffice/stable/26.8.2/
Terms and component attribution: libreoffice-26.8.2/SourceDir/LibreOffice/LICENSE.html,
license.txt, NOTICE and included component notices. Preserve that directory when redistributing.
Primary license: MPL-2.0; bundled libraries, fonts and dictionaries have their own terms.
Source code: https://download.documentfoundation.org/libreoffice/src/26.8.2/

qpdf 12.4.2, unmodified upstream Windows distribution.
Source and source code: https://github.com/qpdf/qpdf/releases/tag/v12.4.2
Apache-2.0. Copyright 2005-2021 Jay Berkenbilt; 2022-2026 Jay Berkenbilt and Manfred Holger.
Full license and notices: qpdf-12.4.2/LICENSE.txt and qpdf-12.4.2/NOTICE.md.

lessmsi 2.12.9 is a development-only extraction utility (MIT), not a runtime requirement.
Source and license: https://github.com/activescott/lessmsi/tree/v2.12.9
The downloaded archives and engines.json record exact versions and SHA256 values.
No trademark ownership or Office compatibility certification is implied.
'@ | Set-Content -LiteralPath (Join-Path $taskRoot 'THIRD-PARTY-NOTICES.txt') -Encoding utf8
Write-Output (Join-Path $taskRoot 'engines.json')
