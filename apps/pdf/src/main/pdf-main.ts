import { renameOwnedPdf } from './pdf-auto-rename'
import { publishNewUserOutput, publishSelectedUserOutputs } from '@vantage/electron-utils/user-output-publication'
import { configureRecoveryProfile, initializeStandaloneRecovery, requireRecoveryRuntime, recoveryRuntimeState, queueRecoveryWarning } from '../../../../packages/electron-utils/src/recovery-bootstrap'
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { BrowserWindow, WebContentsView, app, dialog, ipcMain, shell, webContents } from 'electron'
import type { WebContents, IpcMainInvokeEvent } from 'electron'
import {
  buildPrintableHtml,
  configuredDefaultSaveDir,
  contextMenuLabels,
  installContextMenu,
  installNavigationGuard,
  printHtmlToPdf,
  safeExternalUrl,
  showOpenDialogWithMemory,
  installRendererProtocol,
  registerRendererScheme,
  rendererUrl,
} from '@vantage/electron-utils'
import { createI18n, getUiLang } from '@vantage/i18n'
import { generateImageTool, documentMediaRoots } from '@vantage/ai-search'
import { PDF_CHANNELS } from '../shared/ipc'
import { printJobOptions } from '@vantage/electron-utils/print-job'
import { buildExportImagePaths, hasValidExportPageNumbers } from './export-images'
import type {
  ExportImagesRequest,
  ExportImagesResult,
  PdfAutoRenameResult,
  ExtractPagesRequest,
  ExtractPagesResult,
  InsertBlankPageRequest,
  InsertBlankPageResult,
  InsertPdfRequest,
  InsertPdfResult,
  MergePagesRequest,
  MergePagesResult,
  MergePdfRequest,
  MergePdfResult,
  PagePreviewRequest,
  ReplacePagesRequest,
  ReplacePagesResult,
  SetPageSizeRequest,
  SetPageSizeResult,
  SplitPagesRequest,
  SplitPagesResult,
  SplitPdfRequest,
  SplitPdfResult,
  SavePdfRequest,
  SavePdfResult,
  CropPagesRequest,
  CropPagesResult,
  CreateDocumentRequest,
  CreateDocumentResult,
  TextEditValidation,
  ValidateTextEditsRequest,
} from '../shared/ipc'
import type {
  CertificateErrorCode,
  CertificateInfo,
  InspectCertificateResult,
  ListSystemCertificatesResult,
  PdfSignatureInfo,
  SavedSignature,
  SignWithCertificateRequest,
  SignWithCertificateResult,
  SignaturePosition,
} from '../shared/ipc'
import { writePdfAtomically } from './atomic-write'
import { PdfDraftController, type PdfRestoreHandoff } from './pdf-draft-controller'
import { PdfCloseCoordinator, pdfCloseOptionsCurrent, type PdfCloseOptions } from './pdf-close'
import { preparePdfNativeCloseFlow } from './pdf-native-close'
import { NativeCloseAdmission } from '@vantage/electron-utils/native-close-admission'
import { PdfFileBindings, readPinnedPdf, assertPdfFileVersion, observePublishedPdf, publishPinnedPdf, type PdfLoadedFile } from './pdf-publication'
import { isCloseLeaseTicket } from '@vantage/electron-utils/close-lease'
import type { CloseLeaseStamp, CloseLeaseTicket } from '@vantage/electron-utils/close-lease'
import { PdfPrivateBases, readPdfWorkspaceFile, pdfRepresentation, pdfDigest } from './pdf-workspace'
import { writeDraftJournal, discardDraftJournal, listDraftJournal } from '@vantage/electron-utils/draft-journal'
import { stageCloseCleanup, beginCloseCleanup, retireCloseCleanupCustody, queryCloseCleanupCustody,  getCloseCleanupStatus, awaitCloseCleanup, recordCloseCleanupFailure, prepareCloseCleanupRestore } from '@vantage/electron-utils/close-cleanup-runtime'
import { atomicWriteFile, readAtomicFileVersion, type AtomicFileVersion } from '@vantage/electron-utils/atomic-write'
import type { PdfSourceRead, PdfWorkspaceSaveProof, PdfCloseIntent, PdfCloseReceipt } from '../shared/pdf-workspace'
import {
  cropPagesBytes,
  extractPagesBytes,
  insertBlankPageBytes,
  insertPdfBytes,
  mergePagesBytes,
  mergePdfBytes,
  readStaticFormFills,
  replacePagesBytes,
  applySaveRequest,
  verifyContentEdits,
  setPageSizeBytes,
  splitPagesBytes,
  splitPdfBytes,
} from './save-pdf'
import { readPdfText } from './read-text'
import {
  addSignature,
  isSignatureData,
  loadSignatures,
  removeSignature,
  saveSignatures,
} from './signature-store'
import { uniqueGeneratedPdfPath } from './generated-output'
import { validateRedactionRegions } from './redaction'
import { PdfOwnedFailureMarkers } from './pdf-owned-failures'
import { SignError, openCertificate, openExternalCertificate, signPdf } from './pdf-sign'
import type { ExternalSigner, SignPdfOptions } from './pdf-sign'
import { readPdfSignatures } from './pdf-signatures'
import { SystemStoreError, openSystemSigner, listSystemCertificates } from './system-certificates'
import type { SystemCertificateRef, SystemIdentity } from './system-certificates'

const tDlg = createI18n({
  zh: {
    dlgExportImages: '导出图片到文件夹',
    dlgExtract: '抽取页面为 PDF',
    dlgInsert: '选择要导入的 PDF',
    dlgSplit: '拆分 PDF 到文件夹',
    dlgMerge: '选择要合并的 PDF',
    dlgMergeSave: '合并 PDF 保存为',
    dlgMergePages: '合并页面保存为',
    dlgReplace: '选择用于替换的 PDF',
    dlgSplitPages: '拆分页面保存为',
    dlgRedactCopy: '保存涂黑副本为',
    dlgPickCertificate: '选择证书文件',
    dlgSignedCopy: '保存已签名副本为',
    filterCertificate: '证书文件 (.p12, .pfx)',
    filterPdf: 'PDF 文档',
    closeUnsavedMsg: '此 PDF 有未保存的更改。',
    closeUnsavedDetail: '关闭前是否保存？',
    btnSave: '保存',
    btnDontSave: '不保存',
    btnCancel: '取消',
  },
  en: {
    dlgExportImages: 'Export Images to Folder',
    dlgExtract: 'Extract Pages as PDF',
    dlgInsert: 'Choose a PDF to Import',
    dlgSplit: 'Split PDF into Folder',
    dlgMerge: 'Choose PDFs to Merge',
    dlgMergeSave: 'Save Merged PDF As',
    dlgMergePages: 'Save Merged Pages As',
    dlgReplace: 'Choose a Replacement PDF',
    dlgSplitPages: 'Save Split Pages As',
    dlgRedactCopy: 'Save Redacted Copy As',
    dlgPickCertificate: 'Choose a Certificate File',
    dlgSignedCopy: 'Save Signed Copy As',
    filterCertificate: 'Certificate Files (.p12, .pfx)',
    filterPdf: 'PDF Documents',
    closeUnsavedMsg: 'This PDF has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
  },
  vi: {
    dlgExportImages: 'Xuất hình ảnh vào thư mục',
    dlgExtract: 'Trích xuất các trang dưới dạng PDF',
    dlgInsert: 'Chọn một tệp PDF để nhập',
    dlgSplit: 'Tách PDF vào thư mục',
    dlgMerge: 'Chọn các tệp PDF để ghép',
    dlgMergeSave: 'Lưu tệp PDF đã ghép dưới dạng',
    dlgMergePages: 'Lưu các trang đã ghép dưới dạng',
    dlgReplace: 'Chọn một tệp PDF thay thế',
    dlgSplitPages: 'Lưu các trang đã tách dưới dạng',
    dlgRedactCopy: 'Lưu bản sao đã che thông tin dưới dạng',
    dlgPickCertificate: 'Chọn tệp chứng chỉ',
    dlgSignedCopy: 'Lưu bản sao đã ký dưới dạng',
    filterCertificate: 'Tệp chứng chỉ (.p12, .pfx)',
    filterPdf: 'Tài liệu PDF',
    closeUnsavedMsg: 'Tệp PDF này có những thay đổi chưa được lưu.',
    closeUnsavedDetail: 'Bạn có muốn lưu các thay đổi trước khi đóng không?',
    btnSave: 'Lưu',
    btnDontSave: 'Không lưu',
    btnCancel: 'Hủy',
  },
  tr: {
    dlgExportImages: 'Görselleri klasöre aktar',
    dlgExtract: 'Sayfaları PDF olarak ayıkla',
    dlgInsert: 'İçe aktarılacak bir PDF seçin',
    dlgSplit: "PDF'yi klasöre böl",
    dlgMerge: 'Birleştirilecek PDF dosyalarını seçin',
    dlgMergeSave: "Birleştirilmiş PDF'yi farklı kaydet",
    dlgMergePages: 'Birleştirilmiş sayfaları farklı kaydet',
    dlgReplace: 'Yerine konacak bir PDF seçin',
    dlgSplitPages: 'Bölünmüş sayfaları farklı kaydet',
    dlgRedactCopy: 'Karartılmış kopyayı farklı kaydet',
    dlgPickCertificate: 'Sertifika dosyası seçin',
    dlgSignedCopy: 'İmzalı kopyayı farklı kaydet',
    filterCertificate: 'Sertifika dosyaları (.p12, .pfx)',
    filterPdf: 'PDF belgeleri',
    closeUnsavedMsg: 'Bu PDF kaydedilmemiş değişiklikler içeriyor.',
    closeUnsavedDetail: 'Kapatmadan önce değişiklikleri kaydetmek istiyor musunuz?',
    btnSave: 'Kaydet',
    btnDontSave: 'Kaydetme',
    btnCancel: 'İptal',
  },
  ja: {
    dlgExportImages: '画像をフォルダに書き出す',
    dlgExtract: 'ページを PDF として抽出',
    dlgInsert: 'インポートする PDF を選択',
    dlgSplit: 'PDF をフォルダに分割',
    dlgMerge: '結合する PDF を選択',
    dlgMergeSave: '結合した PDF の保存先',
    dlgMergePages: '結合したページの保存先',
    dlgReplace: '差し替え用の PDF を選択',
    dlgSplitPages: '分割したページの保存先',
    dlgRedactCopy: '墨消し済みコピーの保存先',
    dlgPickCertificate: '証明書ファイルを選択',
    dlgSignedCopy: '署名済みコピーの保存先',
    filterCertificate: '証明書ファイル (.p12, .pfx)',
    filterPdf: 'PDF ドキュメント',
    closeUnsavedMsg: 'この PDF に未保存の変更があります。',
    closeUnsavedDetail: '閉じる前に保存しますか？',
    btnSave: '保存',
    btnDontSave: '保存しない',
    btnCancel: 'キャンセル',
  },
  ko: {
    dlgExportImages: '이미지를 폴더로 내보내기',
    dlgExtract: '페이지를 PDF로 추출',
    dlgInsert: '가져올 PDF 선택',
    dlgSplit: 'PDF를 폴더로 분할',
    dlgMerge: '병합할 PDF 선택',
    dlgMergeSave: '병합된 PDF 저장',
    dlgMergePages: '합쳐진 페이지 저장',
    dlgReplace: '교체할 PDF 선택',
    dlgSplitPages: '분할된 페이지 저장',
    dlgRedactCopy: '마스킹된 복사본 저장',
    dlgPickCertificate: '인증서 파일 선택',
    dlgSignedCopy: '서명된 사본 저장',
    filterCertificate: '인증서 파일 (.p12, .pfx)',
    filterPdf: 'PDF 문서',
    closeUnsavedMsg: '이 PDF에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
  },
  fr: {
    dlgExportImages: 'Exporter les images vers un dossier',
    dlgExtract: 'Extraire les pages en PDF',
    dlgInsert: 'Choisir un PDF à importer',
    dlgSplit: 'Diviser le PDF dans un dossier',
    dlgMerge: 'Choisir les PDF à fusionner',
    dlgMergeSave: 'Enregistrer le PDF fusionné sous',
    dlgMergePages: 'Enregistrer les pages fusionnées sous',
    dlgReplace: 'Choisir un PDF de remplacement',
    dlgSplitPages: 'Enregistrer les pages divisées sous',
    dlgRedactCopy: 'Enregistrer la copie caviardée sous',
    dlgPickCertificate: 'Choisir un fichier de certificat',
    dlgSignedCopy: 'Enregistrer la copie signée sous',
    filterCertificate: 'Fichiers de certificat (.p12, .pfx)',
    filterPdf: 'Documents PDF',
    closeUnsavedMsg: 'Ce PDF contient des modifications non enregistrées.',
    closeUnsavedDetail: 'Voulez-vous les enregistrer avant de fermer ?',
    btnSave: 'Enregistrer',
    btnDontSave: 'Ne pas enregistrer',
    btnCancel: 'Annuler',
  },
  de: {
    dlgExportImages: 'Bilder in Ordner exportieren',
    dlgExtract: 'Seiten als PDF extrahieren',
    dlgInsert: 'Zu importierendes PDF wählen',
    dlgSplit: 'PDF in Ordner aufteilen',
    dlgMerge: 'Zu vereinende PDFs wählen',
    dlgMergeSave: 'Zusammengeführtes PDF speichern unter',
    dlgMergePages: 'Zusammengefasste Seiten speichern unter',
    dlgReplace: 'Ersatz-PDF wählen',
    dlgSplitPages: 'Geteilte Seiten speichern unter',
    dlgRedactCopy: 'Geschwärzte Kopie speichern unter',
    dlgPickCertificate: 'Zertifikatdatei wählen',
    dlgSignedCopy: 'Signierte Kopie speichern unter',
    filterCertificate: 'Zertifikatdateien (.p12, .pfx)',
    filterPdf: 'PDF-Dokumente',
    closeUnsavedMsg: 'Dieses PDF enthält ungespeicherte Änderungen.',
    closeUnsavedDetail: 'Vor dem Schließen speichern?',
    btnSave: 'Speichern',
    btnDontSave: 'Nicht speichern',
    btnCancel: 'Abbrechen',
  },
  es: {
    dlgExportImages: 'Exportar imágenes a una carpeta',
    dlgExtract: 'Extraer páginas como PDF',
    dlgInsert: 'Elegir un PDF para importar',
    dlgSplit: 'Dividir PDF en una carpeta',
    dlgMerge: 'Elegir PDF para combinar',
    dlgMergeSave: 'Guardar PDF combinado como',
    dlgMergePages: 'Guardar páginas combinadas como',
    dlgReplace: 'Elegir un PDF de reemplazo',
    dlgSplitPages: 'Guardar páginas divididas como',
    dlgRedactCopy: 'Guardar copia censurada como',
    dlgPickCertificate: 'Elegir un archivo de certificado',
    dlgSignedCopy: 'Guardar copia firmada como',
    filterCertificate: 'Archivos de certificado (.p12, .pfx)',
    filterPdf: 'Documentos PDF',
    closeUnsavedMsg: 'Este PDF tiene cambios sin guardar.',
    closeUnsavedDetail: '¿Quieres guardarlos antes de cerrar?',
    btnSave: 'Guardar',
    btnDontSave: 'No guardar',
    btnCancel: 'Cancelar',
  },
  th: {
    dlgExportImages: 'ส่งออกรูปภาพไปยังโฟลเดอร์',
    dlgExtract: 'แยกหน้าเป็น PDF',
    dlgInsert: 'เลือก PDF ที่จะนำเข้า',
    dlgSplit: 'แยก PDF ไปยังโฟลเดอร์',
    dlgMerge: 'เลือก PDF ที่จะรวม',
    dlgMergeSave: 'บันทึก PDF ที่รวมแล้วเป็น',
    dlgMergePages: 'บันทึกหน้าที่รวมแล้วเป็น',
    dlgReplace: 'เลือก PDF สำหรับแทนที่',
    dlgSplitPages: 'บันทึกหน้าที่แยกแล้วเป็น',
    dlgRedactCopy: 'บันทึกสำเนาที่ปิดทับเป็น',
    dlgPickCertificate: 'เลือกไฟล์ใบรับรอง',
    dlgSignedCopy: 'บันทึกสำเนาที่ลงนามแล้วเป็น',
    filterCertificate: 'ไฟล์ใบรับรอง (.p12, .pfx)',
    filterPdf: 'เอกสาร PDF',
    closeUnsavedMsg: 'PDF นี้มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก',
    closeUnsavedDetail: 'ต้องการบันทึกก่อนปิดหรือไม่?',
    btnSave: 'บันทึก',
    btnDontSave: 'ไม่บันทึก',
    btnCancel: 'ยกเลิก',
  },
  id: {
    dlgExportImages: 'Ekspor gambar ke folder',
    dlgExtract: 'Ekstrak halaman sebagai PDF',
    dlgInsert: 'Pilih PDF untuk diimpor',
    dlgSplit: 'Pisahkan PDF ke folder',
    dlgMerge: 'Pilih PDF untuk digabung',
    dlgMergeSave: 'Simpan PDF gabungan sebagai',
    dlgMergePages: 'Simpan halaman gabungan sebagai',
    dlgReplace: 'Pilih PDF pengganti',
    dlgSplitPages: 'Simpan halaman terpisah sebagai',
    dlgRedactCopy: 'Simpan Salinan Teredaksi Sebagai',
    dlgPickCertificate: 'Pilih Berkas Sertifikat',
    dlgSignedCopy: 'Simpan Salinan Bertanda Tangan Sebagai',
    filterCertificate: 'Berkas Sertifikat (.p12, .pfx)',
    filterPdf: 'Dokumen PDF',
    closeUnsavedMsg: 'PDF ini memiliki perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
  },
  ru: {
    dlgExportImages: 'Экспорт изображений в папку',
    dlgExtract: 'Извлечь страницы в PDF',
    dlgInsert: 'Выберите PDF для импорта',
    dlgSplit: 'Разделить PDF в папку',
    dlgMerge: 'Выберите PDF для объединения',
    dlgMergeSave: 'Сохранить объединённый PDF как',
    dlgMergePages: 'Сохранить объединённые страницы как',
    dlgReplace: 'Выберите PDF для замены',
    dlgSplitPages: 'Сохранить разделённые страницы как',
    dlgRedactCopy: 'Сохранить затемнённую копию как',
    dlgPickCertificate: 'Выберите файл сертификата',
    dlgSignedCopy: 'Сохранить подписанную копию как',
    filterCertificate: 'Файлы сертификатов (.p12, .pfx)',
    filterPdf: 'Документы PDF',
    closeUnsavedMsg: 'В этом PDF есть несохранённые изменения.',
    closeUnsavedDetail: 'Сохранить их перед закрытием?',
    btnSave: 'Сохранить',
    btnDontSave: 'Не сохранять',
    btnCancel: 'Отмена',
  },
  ar: {
    dlgExportImages: 'تصدير الصور إلى مجلد',
    dlgExtract: 'استخراج الصفحات كملف PDF',
    dlgInsert: 'اختر PDF للاستيراد',
    dlgSplit: 'تقسيم PDF إلى مجلد',
    dlgMerge: 'اختر ملفات PDF للدمج',
    dlgMergeSave: 'حفظ PDF المدمج باسم',
    dlgMergePages: 'حفظ الصفحات المدمجة باسم',
    dlgReplace: 'اختر PDF بديلاً',
    dlgSplitPages: 'حفظ الصفحات المقسّمة باسم',
    dlgRedactCopy: 'حفظ النسخة المنقّحة باسم',
    dlgPickCertificate: 'اختيار ملف شهادة',
    dlgSignedCopy: 'حفظ النسخة الموقّعة باسم',
    filterCertificate: 'ملفات الشهادات (.p12, .pfx)',
    filterPdf: 'مستندات PDF',
    closeUnsavedMsg: 'يحتوي هذا الـ PDF على تغييرات غير محفوظة.',
    closeUnsavedDetail: 'هل تريد حفظها قبل الإغلاق؟',
    btnSave: 'حفظ',
    btnDontSave: 'عدم الحفظ',
    btnCancel: 'إلغاء',
  },
  pt: {
    dlgExportImages: 'Exportar imagens para pasta',
    dlgExtract: 'Extrair páginas como PDF',
    dlgInsert: 'Escolher um PDF para importar',
    dlgSplit: 'Dividir PDF em uma pasta',
    dlgMerge: 'Escolher PDFs para mesclar',
    dlgMergeSave: 'Salvar PDF mesclado como',
    dlgMergePages: 'Salvar páginas combinadas como',
    dlgReplace: 'Escolher um PDF de substituição',
    dlgSplitPages: 'Salvar páginas divididas como',
    dlgRedactCopy: 'Salvar cópia censurada como',
    dlgPickCertificate: 'Escolher um arquivo de certificado',
    dlgSignedCopy: 'Salvar cópia assinada como',
    filterCertificate: 'Arquivos de certificado (.p12, .pfx)',
    filterPdf: 'Documentos PDF',
    closeUnsavedMsg: 'Este PDF tem alterações não salvas.',
    closeUnsavedDetail: 'Deseja salvá-las antes de fechar?',
    btnSave: 'Salvar',
    btnDontSave: 'Não Salvar',
    btnCancel: 'Cancelar',
  },
  it: {
    dlgExportImages: 'Esporta immagini in una cartella',
    dlgExtract: 'Estrai pagine come PDF',
    dlgInsert: 'Scegli un PDF da importare',
    dlgSplit: 'Dividi il PDF in una cartella',
    dlgMerge: 'Scegli i PDF da unire',
    dlgMergeSave: 'Salva il PDF unito come',
    dlgMergePages: 'Salva le pagine combinate come',
    dlgReplace: 'Scegli un PDF sostitutivo',
    dlgSplitPages: 'Salva le pagine divise come',
    dlgRedactCopy: 'Salva copia oscurata con nome',
    dlgPickCertificate: 'Scegli un file di certificato',
    dlgSignedCopy: 'Salva copia firmata con nome',
    filterCertificate: 'File di certificato (.p12, .pfx)',
    filterPdf: 'Documenti PDF',
    closeUnsavedMsg: 'Questo PDF contiene modifiche non salvate.',
    closeUnsavedDetail: 'Vuoi salvarle prima di chiudere?',
    btnSave: 'Salva',
    btnDontSave: 'Non salvare',
    btnCancel: 'Annulla',
  },
  pl: {
    dlgExportImages: 'Eksportuj obrazy do folderu',
    dlgExtract: 'Wyodrębnij strony jako PDF',
    dlgInsert: 'Wybierz PDF do zaimportowania',
    dlgSplit: 'Podziel PDF do folderu',
    dlgMerge: 'Wybierz pliki PDF do scalenia',
    dlgMergeSave: 'Zapisz scalony PDF jako',
    dlgMergePages: 'Zapisz scalone strony jako',
    dlgReplace: 'Wybierz PDF zastępczy',
    dlgSplitPages: 'Zapisz podzielone strony jako',
    dlgRedactCopy: 'Zapisz zaczernioną kopię jako',
    dlgPickCertificate: 'Wybierz plik certyfikatu',
    dlgSignedCopy: 'Zapisz podpisaną kopię jako',
    filterCertificate: 'Pliki certyfikatów (.p12, .pfx)',
    filterPdf: 'Dokumenty PDF',
    closeUnsavedMsg: 'Ten PDF ma niezapisane zmiany.',
    closeUnsavedDetail: 'Czy zapisać je przed zamknięciem?',
    btnSave: 'Zapisz',
    btnDontSave: 'Nie zapisuj',
    btnCancel: 'Anuluj',
  },
  cs: {
    dlgExportImages: 'Exportovat obrázky do složky',
    dlgExtract: 'Extrahovat stránky jako PDF',
    dlgInsert: 'Vyberte PDF k importu',
    dlgSplit: 'Rozdělit PDF do složky',
    dlgMerge: 'Vyberte soubory PDF ke sloučení',
    dlgMergeSave: 'Uložit sloučený PDF jako',
    dlgMergePages: 'Uložit sloučené stránky jako',
    dlgReplace: 'Vyberte náhradní PDF',
    dlgSplitPages: 'Uložit rozdělené stránky jako',
    dlgRedactCopy: 'Uložit začerněnou kopii jako',
    dlgPickCertificate: 'Vyberte soubor certifikátu',
    dlgSignedCopy: 'Uložit podepsanou kopii jako',
    filterCertificate: 'Soubory certifikátů (.p12, .pfx)',
    filterPdf: 'Dokumenty PDF',
    closeUnsavedMsg: 'Tento PDF obsahuje neuložené změny.',
    closeUnsavedDetail: 'Chcete je před zavřením uložit?',
    btnSave: 'Uložit',
    btnDontSave: 'Neukládat',
    btnCancel: 'Zrušit',
  },
  nl: {
    dlgExportImages: 'Afbeeldingen naar map exporteren',
    dlgExtract: "Pagina's extraheren als PDF",
    dlgInsert: 'Kies een PDF om te importeren',
    dlgSplit: 'PDF splitsen naar map',
    dlgMerge: "Kies PDF's om samen te voegen",
    dlgMergeSave: 'Samengevoegde PDF opslaan als',
    dlgMergePages: "Gecombineerde pagina's opslaan als",
    dlgReplace: 'Kies een vervangende PDF',
    dlgSplitPages: "Gesplitste pagina's opslaan als",
    dlgRedactCopy: 'Zwartgemaakte kopie opslaan als',
    dlgPickCertificate: 'Certificaatbestand kiezen',
    dlgSignedCopy: 'Ondertekende kopie opslaan als',
    filterCertificate: 'Certificaatbestanden (.p12, .pfx)',
    filterPdf: 'PDF-documenten',
    closeUnsavedMsg: 'Deze PDF bevat niet-opgeslagen wijzigingen.',
    closeUnsavedDetail: 'Wilt u ze opslaan voordat u sluit?',
    btnSave: 'Opslaan',
    btnDontSave: 'Niet opslaan',
    btnCancel: 'Annuleren',
  },
  ms: {
    dlgExportImages: 'Eksport imej ke folder',
    dlgExtract: 'Ekstrak halaman sebagai PDF',
    dlgInsert: 'Pilih PDF untuk diimport',
    dlgSplit: 'Pisahkan PDF ke folder',
    dlgMerge: 'Pilih PDF untuk digabungkan',
    dlgMergeSave: 'Simpan PDF gabungan sebagai',
    dlgMergePages: 'Simpan halaman gabungan sebagai',
    dlgReplace: 'Pilih PDF pengganti',
    dlgSplitPages: 'Simpan halaman dipisah sebagai',
    dlgRedactCopy: 'Simpan Salinan Teredaksi Sebagai',
    dlgPickCertificate: 'Pilih Fail Sijil',
    dlgSignedCopy: 'Simpan Salinan Bertandatangan Sebagai',
    filterCertificate: 'Fail Sijil (.p12, .pfx)',
    filterPdf: 'Dokumen PDF',
    closeUnsavedMsg: 'PDF ini mempunyai perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
  },
  he: {
    dlgExportImages: 'ייצוא תמונות לתיקייה',
    dlgExtract: 'חילוץ עמודים כ-PDF',
    dlgInsert: 'בחרו PDF לייבוא',
    dlgSplit: 'פיצול PDF לתיקייה',
    dlgMerge: 'בחרו קובצי PDF למיזוג',
    dlgMergeSave: 'שמירת ה-PDF הממוזג בשם',
    dlgMergePages: 'שמירת העמודים המאוחדים בשם',
    dlgReplace: 'בחרו PDF חלופי',
    dlgSplitPages: 'שמירת העמודים המפוצלים בשם',
    dlgRedactCopy: 'שמירת עותק מושחר בשם',
    dlgPickCertificate: 'בחירת קובץ אישור',
    dlgSignedCopy: 'שמירת עותק חתום בשם',
    filterCertificate: 'קובצי אישורים (.p12, .pfx)',
    filterPdf: 'מסמכי PDF',
    closeUnsavedMsg: 'ב-PDF הזה יש שינויים שלא נשמרו.',
    closeUnsavedDetail: 'האם לשמור אותם לפני הסגירה?',
    btnSave: 'שמירה',
    btnDontSave: 'אל תשמור',
    btnCancel: 'ביטול',
  },
  hi: {
    dlgExportImages: 'चित्र फ़ोल्डर में निर्यात करें',
    dlgExtract: 'पृष्ठों को PDF के रूप में निकालें',
    dlgInsert: 'आयात करने के लिए PDF चुनें',
    dlgSplit: 'PDF को फ़ोल्डर में विभाजित करें',
    dlgMerge: 'मर्ज करने के लिए PDF चुनें',
    dlgMergeSave: 'मर्ज किया गया PDF इस रूप में सहेजें',
    dlgMergePages: 'संयोजित पृष्ठ इस रूप में सहेजें',
    dlgReplace: 'प्रतिस्थापन के लिए PDF चुनें',
    dlgSplitPages: 'विभाजित पृष्ठ इस रूप में सहेजें',
    dlgRedactCopy: 'काला किया गया प्रति इस रूप में सहेजें',
    dlgPickCertificate: 'प्रमाणपत्र फ़ाइल चुनें',
    dlgSignedCopy: 'हस्ताक्षरित प्रति इस रूप में सहेजें',
    filterCertificate: 'प्रमाणपत्र फ़ाइलें (.p12, .pfx)',
    filterPdf: 'PDF दस्तावेज़',
    closeUnsavedMsg: 'इस PDF में सहेजे नहीं गए परिवर्तन हैं।',
    closeUnsavedDetail: 'क्या बंद करने से पहले उन्हें सहेजना चाहते हैं?',
    btnSave: 'सहेजें',
    btnDontSave: 'न सहेजें',
    btnCancel: 'रद्द करें',
  },
  'zh-TW': {
    dlgExportImages: '匯出圖片到資料夾',
    dlgExtract: '擷取頁面為 PDF',
    dlgInsert: '選擇要匯入的 PDF',
    dlgSplit: '拆分 PDF 到資料夾',
    dlgMerge: '選擇要合併的 PDF',
    dlgMergeSave: '合併 PDF 儲存為',
    dlgMergePages: '合併頁面儲存為',
    dlgReplace: '選擇用於取代的 PDF',
    dlgSplitPages: '拆分頁面儲存為',
    dlgRedactCopy: '儲存塗黑副本為',
    dlgPickCertificate: '選擇憑證檔案',
    dlgSignedCopy: '儲存已簽署副本為',
    filterCertificate: '憑證檔案 (.p12, .pfx)',
    filterPdf: 'PDF 文件',
    closeUnsavedMsg: '此 PDF 有未儲存的變更。',
    closeUnsavedDetail: '關閉前是否儲存？',
    btnSave: '儲存',
    btnDontSave: '不儲存',
    btnCancel: '取消',
  },
})

/** A redaction copy must never be the same file through a symlink, `.`/`..`,
 * or an existing hard link. For a new destination, canonicalize its parent
 * directory so a symlinked directory cannot disguise the source path. */
function isSameRedactionCopyPath(source: string, target: string): boolean {
  const canonical = (path: string) => {
    const absolute = resolve(path)
    try {
      return realpathSync.native(absolute)
    } catch {
      return join(realpathSync.native(dirname(absolute)), basename(absolute))
    }
  }
  if (canonical(source) === canonical(target)) return true
  try {
    const a = statSync(source)
    const b = statSync(target)
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}
type DlgKey =
  | 'dlgExportImages'
  | 'dlgExtract'
  | 'dlgInsert'
  | 'dlgSplit'
  | 'dlgMerge'
  | 'dlgMergeSave'
  | 'dlgMergePages'
  | 'dlgReplace'
  | 'dlgSplitPages'
  | 'dlgRedactCopy'
  | 'dlgPickCertificate'
  | 'dlgSignedCopy'
  | 'filterCertificate'
  | 'filterPdf'
  | 'closeUnsavedMsg'
  | 'closeUnsavedDetail'
  | 'btnSave'
  | 'btnDontSave'
  | 'btnCancel'
const tm = (key: DlgKey) => tDlg(getUiLang(), key)

interface RuntimePaths {
  preloadPath: string
  rendererUrl?: string
  rendererFile?: string
  /** Shell router used to open generated PDFs in a new Vantage tab. */
  openGeneratedPath?: (path: string) => boolean
  /** Host-owned cross-app document creator (the shell routes DOCX into Docs). */
  createDocument?: (request: CreateDocumentRequest) => Promise<CreateDocumentResult>
}

let runtime: RuntimePaths = { preloadPath: '' }

export function configurePdfRuntime(paths: RuntimePaths): void {
  runtime = paths
}

const MAX_CREATE_DOCUMENT_TITLE_CHARS = 200
const MAX_CREATE_DOCUMENT_CONTENT_CHARS = 2_000_000

function parseCreateDocumentRequest(request: unknown): CreateDocumentRequest | null {
  if (!request || typeof request !== 'object') return null
  const { type, title, content } = request as Record<string, unknown>
  if (type !== 'docx' && type !== 'pdf' && type !== 'md') return null
  if (
    typeof title !== 'string' ||
    title.trim() === '' ||
    title.length > MAX_CREATE_DOCUMENT_TITLE_CHARS
  )
    return null
  if (
    typeof content !== 'string' ||
    content.trim() === '' ||
    content.length > MAX_CREATE_DOCUMENT_CONTENT_CHARS
  )
    return null
  return { type, title: title.trim(), content }
}

function sanitizeGeneratedDocumentTitle(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- generated file names must reject controls
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80)
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'Untitled'
}

function uniqueGeneratedTextPath(dir: string, title: string, ext: 'md' | 'html'): string {
  const stem = sanitizeGeneratedDocumentTitle(title)
  let candidate = join(dir, `${stem}.${ext}`)
  for (let i = 2; existsSync(candidate); i += 1) candidate = join(dir, `${stem}-${i}.${ext}`)
  return candidate
}

async function createStandaloneDocument(
  request: CreateDocumentRequest,
): Promise<CreateDocumentResult> {
  if (request.type === 'docx') {
    return {
      ok: false,
      error: 'Creating DOCX files requires the Vantage shell or Docs app.',
    }
  }
  const title = sanitizeGeneratedDocumentTitle(request.title)
  try {
    if (request.type === 'pdf') {
      const bytes = await printHtmlToPdf(
        buildPrintableHtml(title, request.content),
        () =>
          new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } }),
      )
      const path = uniqueGeneratedPdfPath(configuredDefaultSaveDir(app), `${title}.pdf`)
      await publishNewUserOutput(path, bytes,()=>openGeneratedPdf(path))
      return { ok: true, path }
    }
    // md / html: the source is the file; standalone has no sibling editor to open it in
    const path = uniqueGeneratedTextPath(configuredDefaultSaveDir(app), title, request.type)
    await publishNewUserOutput(path, Buffer.from(request.content, 'utf8'),()=>shell.showItemInFolder(path))
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function openGeneratedPdf(path: string): void {
  try {
    if (runtime.openGeneratedPath?.(path)) return
  } catch (err) {
    // The file is already safely persisted; a tab-opening failure must not
    // report the merge itself as failed.
    console.warn('[pdf] Failed to open generated PDF:', err)
  }
  // Standalone PDF mode has no shell tab router. If routing is unavailable or
  // rejects the path, reveal the persisted output so success is never silent.
  shell.showItemInFolder(path)
}

/** Open path per view, queued at tab creation; the renderer consumes it after mount
 * (avoids did-finish-load races). Kept until the view is destroyed: a reload
 * (View > Reload) remounts the renderer and consumes again — a one-shot entry
 * would strand the tab on "No file to open". */
const openPathByWc = new Map<number, string>()
const pdfCloseSessionByWc = new Map<number, string>()
const pdfWritersByWc = new Map<number, number>()
const pdfWriteBasesByWc = new Map<number, { path: string; readId: string; session: string; version: AtomicFileVersion; binding: PdfLoadedFile }>()
const pdfFiles = new PdfFileBindings()
const nativePdfWrites = new NativeCloseAdmission<string>()
function pdfPublicationDomain(owner: number): string { return pdfFiles.domain(owner, pdfCloseSessionByWc.get(owner) ?? '', draftController?.source(owner)?.helperPath ?? openPathByWc.get(owner) ?? `blank-view-${owner}`) }
async function rememberPdfRead(owner: number, session: string, read: PdfSourceRead, ticket?: CloseLeaseTicket, expectedVersion?: AtomicFileVersion): Promise<void> {
  const version = await readAtomicFileVersion(read.helperPath)
  if (!version || version.sha256 !== read.baseSha256) throw new Error('The parsed PDF source changed before its read receipt was established.')
  if (expectedVersion) await assertPdfFileVersion(read.helperPath, expectedVersion)
  if (session !== pdfCloseSessionByWc.get(owner) || !allowedByWc.has(owner) || (ticket && !pdfCloses().claim(owner, ticket))) throw new Error('The PDF source changed before its read receipt could be handed back.')
  pdfFiles.remember(owner, { path: read.helperPath, version, sha256: read.baseSha256, readId: read.readId, session, ...(ticket ? { closeTicket: ticket } : {}) })
}
/** File paths granted to each view — readFile only allows these */
const allowedByWc = new Map<number, Set<string>>()
/** Unsaved-changes flags mirrored from the renderer; drives the save prompt before closing a tab/window */
const dirtyByWc = new Set<number>()
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
const saveAsWaiters = new Map<number, (ok: boolean) => void>()
/** Save As destination granted per view (main-process dialog pick); the save handler refuses any other non-source target */
const saveAsTargetByWc = new Map<number, string>()
const saveAsTargetVersions = new Map<number, { path: string; session: string; version: AtomicFileVersion | null }>()
const saveAsPreparing = new Set<number>()
/** Only a copy produced by this view may receive subsequent in-place redactions. */
const redactionPathByWc = new Map<number, string>()
const redactionFlows = new Set<number>()
const workspaceCopies = new Set<number>()
const workspaceCopyPickers = new Set<number>()
const pdfCleanupRetries = new Map<number, Promise<void>>()
let draftController: PdfDraftController | undefined
let privateBases: PdfPrivateBases | undefined
let closeCoordinator: PdfCloseCoordinator | undefined
function pdfCloses(): PdfCloseCoordinator {
  const send = (owner: number, channel: string, value: unknown) => { const view = webContents.fromId(owner); if (view && !view.isDestroyed()) view.send(channel, value) }
  return closeCoordinator ??= new PdfCloseCoordinator({
    alive: owner => { const view = webContents.fromId(owner); return !!view && !view.isDestroyed() && allowedByWc.has(owner) },
    source: owner => pdfCloseSessionByWc.get(owner) ?? '',
    canReady: owner => !(pdfWritersByWc.get(owner) ?? 0) && !draftController?.hasForkWriter(owner) && !workspaceCopies.has(owner) && !workspaceCopyPickers.has(owner) && !saveAsWaiters.has(owner) && !saveAsPreparing.has(owner),
    unpublished: owner => draftController?.hasUnpublishedBase(owner) ?? false,
    draftToken: owner => draftController?.source(owner)?.token || null,
    stage: (owner, floor, cleanupId) => {
      const staged = pdfDrafts().stageClose(owner, floor)
      let earlierFailure = false
      const preparation = beginCloseCleanup({ id: cleanupId, module: 'pdf', ownerKey: String(owner), source: staged.source,
        generation: staged.generation, token: staged.token, documentPath: staged.documentPath,
        ready: Promise.all([staged.drained, privateBases!.drainOwnership(staged.helperPath)]).then(() => {}),
        custody: { recoveryRoot: join(app.getPath('userData'), 'recovery'), draftId: staged.token, attest: () => {
          const binding = staged.journalBinding()
          return binding ? { expectedDocumentPath: binding.documentPath, expectedSha256: binding.sha256 } : { expectedDocumentPath: staged.documentPath }
        } },
        run: async signal => {
          signal.throwIfAborted()
          await pdfDrafts().discardCaptured(staged.token)
          signal.throwIfAborted()
          // Prior canceled closes for this exact trusted UUID can retain custody.
          await retireCloseCleanupCustody({ module: 'pdf', tokens: [staged.token], excludeIds: [cleanupId] }, 'This captured PDF producer was closed successfully.')
          if (earlierFailure || pdfDrafts().hasEarlierCleanup(owner) || privateBases!.hasRetainedFor(owner)) throw new Error('This PDF closed successfully, but earlier owned recovery/checkpoint cleanup remains incomplete. Review its separate retained recovery statuses; no all-drafts-clean claim was made.')
        } })
      return { ...preparation, ready: preparation.ready.then(handle => { earlierFailure = pdfDrafts().hasEarlierCleanup(owner) || privateBases!.hasRetainedFor(owner); return handle }) }
    },
    resume: (owner, floor) => pdfDrafts().resumeClose(owner, floor),
    prepare: (owner, request) => send(owner, PDF_CHANNELS.closePrepare, request),
    release: (owner, response) => send(owner, PDF_CHANNELS.closeRelease, response),
    query: (owner, id) => send(owner, PDF_CHANNELS.closeStateRequest, id),
  })
}
let pdfFailureMarkers: PdfOwnedFailureMarkers | undefined
function failureMarkers(): PdfOwnedFailureMarkers { return pdfFailureMarkers ??= new PdfOwnedFailureMarkers(join(app.getPath('userData'), 'pdf-owned-cleanup-failures')) }
function recordPdfOwnedFailure(value: { id: string; ownerKey: string; source: string; generation: number; token: string; documentPath: string | null; error: string }): void {
  const { error, ...lineage } = value
  let markerFailure: unknown
  try { failureMarkers().record(value) } catch (failure) { markerFailure = failure }
  try {
    const related = queryCloseCleanupCustody({ module: 'pdf' }).find(status => (status.id === lineage.id || status.id.startsWith(lineage.id + ':')) && status.phase === 'retained' && status.source === lineage.source && status.generation === lineage.generation && status.token === lineage.token)
    if (!related) {
      const id = getCloseCleanupStatus(lineage.id) ? `${lineage.id}:${randomUUID()}` : lineage.id
      recordCloseCleanupFailure({ ...lineage, id, module: 'pdf' }, error)
    }
  } catch {
    // A durable metadata marker admits this failure on the next startup even if
    // the shared status quota is full. If BOTH stores failed, say so explicitly.
    queueRecoveryWarning('pdf-owned-cleanup-status', markerFailure ? 'Both PDF cleanup status stores failed; this warning could not be recorded durably. Known recovery files need review. No complete cleanup was certified.' : 'PDF cleanup is incomplete. An independent failure marker was kept for Recovery review; originals, workspaces and history are unchanged.')
  }
}
async function resolvePdfOwnedFailure(id: string): Promise<void> {
  const ids = queryCloseCleanupCustody({ module: 'pdf' }).filter(status => status.id === id || status.id.startsWith(id + ':')).map(status => status.id)
  if (ids.length) await retireCloseCleanupCustody({ module: 'pdf', ids }, 'Checked owned PDF maintenance completed.')
  failureMarkers().clearResolved(id)
}
function pdfDrafts(): PdfDraftController {
  privateBases ??= new PdfPrivateBases(join(app.getPath('userData'), 'pdf-workspace-bases'), {
    inUse: path => draftController?.usesPrivateBase(path) ?? false,
    retained: record => recordPdfOwnedFailure({ ...record.lineage, id: `pdf-private:${record.id}`, error: record.error ?? 'An owned private PDF checkpoint remains for review.' }),
    resolved: id => resolvePdfOwnedFailure(`pdf-private:${id}`),
  })
  return draftController ??= new PdfDraftController({
    recoveryAvailable: () => recoveryRuntimeState().available,
    alive: (owner) => { const view = webContents.fromId(owner); return !!view && !view.isDestroyed() && allowedByWc.has(owner) },
    bases: privateBases,
    write: (id, documentPath, bytes) => writeDraftJournal(join(app.getPath('userData'), 'recovery'), { id, module: 'pdf', documentPath, extension: '.vpdfdraft', bytes }),
    discard: (id, expectedSha256) => discardDraftJournal(join(app.getPath('userData'), 'recovery'), id, expectedSha256 ? { expectedSha256 } : undefined),
    retireCustody: async lineage => {
      const inherited = new Set(lineage.inheritedEntries.map(([token]) => token))
      if (queryCloseCleanupCustody({ module: 'pdf', tokens: [...inherited] }).some(status => status.custody && status.phase !== 'purged')) throw new Error('An independently retained original-view recovery copy remains. Its snapshot may be newer and was not erased by this recovered workspace.')
      await retireCloseCleanupCustody({ module: 'pdf', tokens: lineage.tokens }, 'A verified sanitized PDF retired its earlier automatic recovery lineage.')
    },
    failure: recordPdfOwnedFailure,
    resolvedFailure: resolvePdfOwnedFailure,
    notify: (owner, value) => { const view = webContents.fromId(owner); if (view && !view.isDestroyed()) view.send(PDF_CHANNELS.draftRetired, value) },
  })
}
/** Root startup calls after registering the shared app-owned cleanup runtime.
 * This bounded metadata inspection never deletes a previous process's files. */
export async function inspectRetainedPdfPrivateBases(): Promise<void> {
  pdfDrafts()
  for (const failure of failureMarkers().inspect()) recordPdfOwnedFailure(failure)
  for (const record of await privateBases!.inspectRetained()) recordPdfOwnedFailure({ ...record.lineage, id: `pdf-private:${record.id}`, error: record.error ?? 'An owned private PDF checkpoint remains for review.' })
}
/** Root passes only a selected persisted status ID, never a renderer file path. */
export async function retryRetainedPdfPrivateBase(id: string): Promise<void> {
  const match = typeof id === 'string' ? /^pdf-private:([0-9a-f-]{36})(?::[0-9a-f-]{36})?$/.exec(id) : null
  if (!match) throw new Error('Choose a retained private PDF checkpoint status.')
  const status = getCloseCleanupStatus(id)
  if (!status || status.module !== 'pdf' || status.custody || status.phase !== 'retained') throw new Error('That private PDF cleanup status is not available for checked retry.')
  pdfDrafts(); await privateBases!.inspectRetained()
  await privateBases!.retryRetained(match[1]!)
  await resolvePdfOwnedFailure(id)
}
export async function discardActivePdfDraft(id: string): Promise<boolean> {
  const owner = draftController?.ownerOfEntry(id)
  if (owner !== undefined) closeCoordinator?.cancel(owner, undefined, 'explicit draft discard')
  return draftController ? draftController.discardEntry(id) : false
}
export function pdfIsWorkspace(owner: number): boolean { return draftController?.source(owner)?.mode === 'workspace' }
/** Called by trusted Root after exclusive restore and before its host-owned open. */
export async function registerPdfRecoveryRestore(path: string, token: string, sha256: string, handoff?: PdfRestoreHandoff): Promise<void> {
  const bytes = await readPdfWorkspaceFile(path)
  if (pdfDigest(bytes) !== sha256) throw new Error('The restored PDF workspace changed before opening. The saved copy was retained.')
  pdfDrafts().grantRestoredOrigin(path, token, sha256, handoff)
}
/** Trusted Root only. Raw source custody is registered before reading and retained
 * through the final synchronous main activation after the renderer parsed it. */
export async function preparePdfJournalRecovery(id: string, destination: string): Promise<{ cleanupId: string; destination: string; cancel(reason?: string): void }> {
  if (!/\.vpdfdraft$/i.test(destination)) throw new Error('Recover the complete PDF workspace to a separate .vpdfdraft file.')
  const recoveryRoot = join(app.getPath('userData'), 'recovery')
  const entry = (await listDraftJournal(recoveryRoot)).find(item => item.id === id && item.module === 'pdf' && item.extension === '.vpdfdraft')
  if (!entry) throw new Error('That complete PDF recovery entry is no longer available.')
  const nonce = randomUUID(), captured = { token: entry.id, path: entry.documentPath, sha256: entry.sha256 }
  const custody = await stageCloseCleanup({ id: nonce, module: 'pdf', ownerKey: 'root-recovery', source: `root-pdf-recovery:${nonce}`, generation: 0, token: captured.token, documentPath: captured.path,
    custody: { recoveryRoot, draftId: captured.token, attest: () => ({ expectedDocumentPath: captured.path, expectedSha256: captured.sha256 }) },
    run: async () => { throw new Error('A Root restoration reservation cannot authorize source journal deletion.') },
  })
  custody.cancel('Root is preserving the source journal while restoring a separate user-owned workspace.')
  const prepared = await prepareCloseCleanupRestore(nonce, destination)
  const actualDestination = prepared.destination
  try {
    await registerPdfRecoveryRestore(actualDestination, captured.token, prepared.sha256, {
      commitHandoff: action => prepared.commitHandoff(action), cancel: reason => prepared.cancel(reason),
      completed: () => { void retireCloseCleanupCustody({ module: 'pdf', ids: [nonce] }, 'The separate recovered workspace was handed to its parsed PDF editor; temporary restoration custody is no longer needed.').catch(error => recordPdfOwnedFailure({ id: `pdf-restore:${nonce}`, ownerKey: 'root-recovery', source: `root-pdf-recovery:${nonce}`, generation: 0, token: captured.token, documentPath: captured.path, error: String(error) })) },
    })
  } catch (error) { prepared.cancel(String(error)); throw error }
  return { cleanupId: nonce, destination: actualDestination, cancel: reason => { pdfDrafts().cancelRestoredOrigin(actualDestination, reason ?? 'The Root host refused the restored workspace.'); prepared.cancel(reason) } }
}
async function writePdfOwnedSource(owner: number, path: string, bytes: Uint8Array): Promise<void> {
  const immutableBytes = Buffer.from(bytes)
  pdfDrafts().assertWritableSource(owner, path)
  const captured = await assertPdfWriteBase(owner, path)
  await atomicWriteFile(path, immutableBytes, { expectedVersion: captured.version })
  const published = await observePublishedPdf(path, immutableBytes)
  pdfFiles.ownPublication(owner, captured.binding, published, immutableBytes)
}
async function assertPdfWriteBase(owner: number, path: string) {
  const captured = pdfWriteBasesByWc.get(owner)
  const current = pdfDrafts().source(owner)
  if (!captured || captured.path !== path || captured.session !== pdfCloseSessionByWc.get(owner) || !allowedByWc.get(owner)?.has(path) || (current && (current.helperPath !== path || current.readId !== captured.readId))) throw new Error('The PDF source changed during this file operation.')
  await assertPdfFileVersion(path, captured.version)
  return captured
}
function registerPdfWrite<Arguments extends unknown[], Result>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Arguments) => Result | Promise<Result>): void {
  ipcMain.handle(channel, async (event, ...args: Arguments) => {
    const request = args[0] as { closeTicket?: CloseLeaseTicket; automaticSave?: unknown } | null
    const automatic = channel === PDF_CHANNELS.save && request?.automaticSave === true
    if (channel === PDF_CHANNELS.save && request?.automaticSave !== undefined && typeof request.automaticSave !== 'boolean') throw new Error('Invalid automatic PDF save flag.')
    const ownedClose = channel === PDF_CHANNELS.save && request?.closeTicket !== undefined
    if (ownedClose && (automatic || !pdfCloses().claim(event.sender.id, request!.closeTicket))) throw new Error('The PDF close/save authorization expired.')
    if (pdfWritersByWc.get(event.sender.id)) throw new Error('Another PDF writer is still finishing. Retry after it completes.')
    if (draftController?.hasForkWriter(event.sender.id)) throw new Error('The complete PDF recovery workspace is still being recorded.')
    // Admit BEFORE canceling close permission. Blur-triggered automatic writes
    // defer without invalidating the native prompt or entering any serializer.
    const releaseWrite = nativePdfWrites.write(pdfPublicationDomain(event.sender.id), automatic, ownedClose ? event.sender.id : undefined)
    if (!releaseWrite) return { ok: false, deferred: true, error: 'Background PDF saving is deferred while a close decision is unresolved.' } as Result
    const capturedSession = pdfCloseSessionByWc.get(event.sender.id)
    pdfWritersByWc.set(event.sender.id, (pdfWritersByWc.get(event.sender.id) ?? 0) + 1)
    try {
      if (!ownedClose) closeCoordinator?.cancel(event.sender.id, undefined, 'PDF mutation requested')
      if (channel !== PDF_CHANNELS.save) {
        const path = (args[0] as { path?: unknown } | null)?.path
        if (typeof path !== 'string' || !allowedByWc.get(event.sender.id)?.has(path)) throw new Error('The PDF source is not granted to this view.')
        pdfDrafts().assertWritableSource(event.sender.id, path)
        const binding = pdfFiles.loaded(event.sender.id, capturedSession ?? '', path)
        await assertPdfFileVersion(path, binding.version)
        if (!capturedSession || capturedSession !== pdfCloseSessionByWc.get(event.sender.id)) throw new Error('The PDF renderer changed before its file operation could start.')
        pdfWriteBasesByWc.set(event.sender.id, { path, readId: binding.readId, session: capturedSession, version: binding.version, binding })
      }
      return await handler(event, ...args)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return (channel === PDF_CHANNELS.signWithCertificate ? { ok: false, error: 'sign-failed', message } : { ok: false, error: message }) as Result
    }
    finally {
      pdfWriteBasesByWc.delete(event.sender.id)
      const remaining = (pdfWritersByWc.get(event.sender.id) ?? 1) - 1
      if (remaining) pdfWritersByWc.set(event.sender.id, remaining); else pdfWritersByWc.delete(event.sender.id)
      releaseWrite() // actual handler/serializer/publication settlement, never caller timeout
    }
  })
}
export async function preparePdfClose(contents: WebContents, filePath?: string, intent: PdfCloseIntent = 'save', approvedStamp?: CloseLeaseStamp, options: PdfCloseOptions = {}): Promise<PdfCloseReceipt> {
  if (!pdfCloseOptionsCurrent(options)) throw new Error('The PDF close group changed before Save or Discard was dispatched.')
  if (contents.isDestroyed() || !allowedByWc.has(contents.id)) throw new Error('The PDF editor is no longer open.')
  const source = draftController?.source(contents.id)
  if (filePath && filePath !== source?.path && filePath !== source?.helperPath && filePath !== openPathByWc.get(contents.id)) throw new Error('The PDF source changed before closing.')
  return pdfCloses().prepare(contents.id, intent, approvedStamp, options)
}
export async function preparePdfNativeClose(contents: WebContents, parent?: BrowserWindow | null, options: PdfCloseOptions = {}): Promise<PdfCloseReceipt | null> {
  if (contents.isDestroyed()) return null
  return preparePdfNativeCloseFlow({
    alive: () => !contents.isDestroyed() && allowedByWc.has(contents.id),
    source: () => pdfCloseSessionByWc.get(contents.id) ?? '',
    hold: () => nativePdfWrites.hold(contents.id, pdfPublicationDomain(contents.id)),
    query: queryOptions => pdfCloses().query(contents.id, queryOptions),
    prompt: async () => {
      const dialogOptions = { type: 'warning' as const, message: tm('closeUnsavedMsg'), detail: tm('closeUnsavedDetail'), buttons: [tm('btnSave'), tm('btnDontSave'), tm('btnCancel')], defaultId: 0, cancelId: 2, noLink: true }
      const result = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, dialogOptions) : await dialog.showMessageBox(dialogOptions)
      return result.response
    },
    prepare: (intent, stamp, closeOptions) => preparePdfClose(contents, undefined, intent, stamp, closeOptions),
    cancel: (receipt, reason) => pdfCloses().cancel(contents.id, receipt.ticket, reason),
  }, options)
}
export function isPdfClosePrepared(contents: WebContents, receipt: PdfCloseReceipt): boolean { return !contents.isDestroyed() && pdfCloses().isPrepared(contents.id, receipt) }
export function sealPdfClose(contents: WebContents, receipt: PdfCloseReceipt): PdfCloseReceipt | null { return contents.isDestroyed() ? null : pdfCloses().seal(contents.id, receipt) }
export function completePdfClose(contents: WebContents, receipt: PdfCloseReceipt, removeSync: () => boolean): boolean { return pdfCloses().complete(contents.id, receipt, removeSync) }
export async function cancelPdfClose(contents: WebContents, receipt: PdfCloseReceipt, reason = 'PDF host canceled closing'): Promise<void> { pdfCloses().cancel(contents.id, receipt.ticket, reason) }
/** Main-owned status remains queryable after the PDF renderer is destroyed. */
export function pdfCloseCleanupStatus(receipt: PdfCloseReceipt) { return receipt.cleanupId ? getCloseCleanupStatus(receipt.cleanupId) : undefined }
export async function awaitPdfCloseCleanup(receipt: PdfCloseReceipt) { return receipt.cleanupId ? awaitCloseCleanup(receipt.cleanupId) : undefined }
/** A derived copy (redacted or certificate-signed) becomes this tab's document */
let pdfRedactionSavedHook: ((wc: WebContents, path: string) => void) | null = null

export function setPdfRedactionSavedHook(hook: (wc: WebContents, path: string) => void): void {
  pdfRedactionSavedHook = hook
}

/** Certificate files the user picked in this view, by opaque id; the renderer never learns the path */
type CertEntry =
  | { kind: 'file'; path: string }
  | { kind: 'system'; ref: SystemCertificateRef; identity?: SystemIdentity }
const certEntriesByWc = new Map<number, Map<string, CertEntry>>()

const certEntryOf = (wcId: number, id: unknown): CertEntry | undefined =>
  typeof id === 'string' ? certEntriesByWc.get(wcId)?.get(id) : undefined

function rememberCert(wcId: number, entry: CertEntry): string {
  const id = randomUUID()
  const entries = certEntriesByWc.get(wcId) ?? new Map<string, CertEntry>()
  entries.set(id, entry)
  certEntriesByWc.set(wcId, entries)
  return id
}

/** A system identity is exported once per use and its key material dropped as soon as it is done */
function releaseCertEntry(entry: CertEntry | undefined): void {
  if (entry?.kind === 'system') delete entry.identity
}

/** What signs: PKCS#12 bytes with their password, or an OS store that signs in place */
type CertMaterial =
  { kind: 'p12'; p12: Uint8Array; password: string } | { kind: 'in-place'; signer: ExternalSigner }

async function certMaterial(
  entry: CertEntry,
  password: string,
  storePassword?: string,
): Promise<CertMaterial> {
  if (entry.kind === 'file')
    return { kind: 'p12', p12: await readCertificateFile(entry.path), password }
  entry.identity ??= await openSystemSigner(entry.ref, storePassword)
  return entry.identity
}

/** Decrypt a PKCS#12 once, or read the chain an OS store reports; the key itself is never read for the latter */
function openMaterial(material: CertMaterial):
  | { ok: false; error: CertificateErrorCode }
  | {
      ok: true
      info: CertificateInfo[]
      sign: Pick<SignPdfOptions, 'loaded' | 'p12' | 'password' | 'external'>
    } {
  if (material.kind === 'in-place') {
    const opened = openExternalCertificate(material.signer)
    return opened.ok
      ? {
          ok: true,
          info: opened.info,
          sign: { external: { signer: material.signer, loaded: opened.loaded } },
        }
      : opened
  }
  const opened = openCertificate(material.p12, material.password)
  return opened.ok
    ? {
        ok: true,
        info: opened.info,
        sign: { loaded: opened.loaded, p12: material.p12, password: material.password },
      }
    : opened
}

const MAX_CERTIFICATE_FILE_BYTES = 4 * 1024 * 1024
const SIGNATURE_POSITIONS = new Set([
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'center',
])

async function readCertificateFile(path: string): Promise<Uint8Array> {
  if ((await stat(path)).size > MAX_CERTIFICATE_FILE_BYTES)
    throw new Error('certificate file too large')
  return new Uint8Array(await readFile(path))
}

/** Renderer input is untrusted: clamp and type-check everything that reaches the signer */
function parseSignOptions(request: SignWithCertificateRequest): {
  reason?: string
  location?: string
  contactInfo?: string
  certifyLevel?: 1 | 2 | 3
  visible?: {
    pageIndex: number
    position: SignaturePosition
    width: number
    height: number
    png: Uint8Array
  }
} | null {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : undefined
  const level = request.certifyLevel
  if (level !== undefined && level !== 1 && level !== 2 && level !== 3) return null
  const out: NonNullable<ReturnType<typeof parseSignOptions>> = {
    reason: text(request.reason),
    location: text(request.location),
    contactInfo: text(request.contactInfo),
    certifyLevel: level,
  }
  const v = request.visible
  if (v !== undefined) {
    if (
      !v ||
      !Number.isInteger(v.pageIndex) ||
      v.pageIndex < 0 ||
      !SIGNATURE_POSITIONS.has(v.position) ||
      !Number.isFinite(v.width) ||
      !Number.isFinite(v.height) ||
      v.width < 40 ||
      v.height < 20 ||
      v.width > 800 ||
      v.height > 800 ||
      typeof v.png !== 'string' ||
      v.png.length > 8 * 1024 * 1024
    ) {
      return null
    }
    out.visible = {
      pageIndex: v.pageIndex,
      position: v.position,
      width: v.width,
      height: v.height,
      png: new Uint8Array(Buffer.from(v.png, 'base64')),
    }
  }
  return out
}

export function pdfIsDirty(webContentsId: number): boolean {
  return dirtyByWc.has(webContentsId)
}

/** Drop the mirrored dirty flag (webContents.reload does not destroy the view). */
export function clearPdfDirty(webContentsId: number): void {
  dirtyByWc.delete(webContentsId)
}

// ── Content-derived auto-naming (pdf's analog of sheets' autoRenameWorkbook) ──

/** Paths of shell-created blank PDFs still carrying their untitled name; only these may auto-rename */
const untitledPdfPaths = new Set<string>()
/** Shell hook fired after an auto-rename so the tab title / recents / project mapping follow the file */
let pdfRenamedHook: ((wc: WebContents, oldPath: string, newPath: string) => void | Promise<void>) | null = null

/** Called by the shell right after "New PDF" writes the blank file to disk */
export function markPdfUntitledPath(path: string): void {
  untitledPdfPaths.add(path)
}

/**
 * The shell renamed or moved the file this view shows (home Folders / Files
 * pane): re-key every per-view record and tell the renderer, so the next save
 * writes to the new location instead of recreating the old one.
 */
export function pdfFileRenamed(contents: WebContents, oldPath: string, newPath: string): void {
  const wcId = contents.id
  draftController?.renamed(wcId, oldPath, newPath)
  let movedVersion: AtomicFileVersion | null = null
  try { const value = statSync(newPath); movedVersion = { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, ino: value.ino, dev: value.dev } } catch { /* old loaded authority is invalidated below */ }
  pdfFiles.renamed(wcId, oldPath, newPath, movedVersion)
  if (openPathByWc.get(wcId) === oldPath) openPathByWc.set(wcId, newPath)
  if (redactionPathByWc.get(wcId) === oldPath) redactionPathByWc.set(wcId, newPath)
  const allowed = allowedByWc.get(wcId)
  if (allowed?.delete(oldPath)) allowed.add(newPath)
  // A renamed picker destination needs a new explicit grant/fingerprint.
  if (saveAsTargetByWc.get(wcId) === oldPath) { saveAsTargetByWc.delete(wcId); saveAsTargetVersions.delete(wcId) }
  if (untitledPdfPaths.delete(oldPath)) untitledPdfPaths.add(newPath)
  if (!contents.isDestroyed()) contents.send(PDF_CHANNELS.fileRenamed, newPath)
}

export function setPdfRenamedHook(
  hook: (wc: WebContents, oldPath: string, newPath: string) => void | Promise<void>,
): void {
  pdfRenamedHook = hook
}

/** Sanitize a proposed base name into a safe filename: strip illegal path chars, collapse whitespace, cap length; null if nothing survives. (Mirrors docs' deriveAutoFileName.) */
function sanitizeAutoRenameBase(raw: string): string | null {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned) return null
  // Windows device names stay reserved with an extension (CON.pdf is still
  // CON): suffix them so the no-clobber move works there instead of failing.
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? cleaned + '_' : cleaned
  return safe.length > 40 ? safe.slice(0, 40).trim() : safe
}

export type NoClobberMoveResult = 'moved' | 'occupied' | 'failed'

export interface NoClobberFileOps {
  link(source: string, target: string): void
  copyExclusive(source: string, target: string): void
  unlink(path: string): void
  identity(path: string): string
  readSource(path: string): Buffer
  matchesSource(path: string, bytes: Buffer): boolean
  restoreSource(path: string, bytes: Buffer): void
}

const defaultNoClobberFileOps: NoClobberFileOps = {
  link: linkSync,
  copyExclusive: (source, target) => copyFileSync(source, target, constants.COPYFILE_EXCL),
  unlink: unlinkSync,
  identity: (path) => {
    const stats = statSync(path, { bigint: true })
    return `${stats.dev}:${stats.ino}`
  },
  readSource: (path) => readFileSync(path),
  matchesSource: (path, bytes) => readFileSync(path).equals(bytes),
  restoreSource: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx', flush: true }),
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

const LINK_COPY_FALLBACK_CODES = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])

/**
 * Same-directory no-clobber move. A hard link reserves the exact destination
 * atomically and without copying PDF bytes; filesystems without hard-link
 * support fall back to an exclusive copy. Removing the old directory entry
 * completes the move. If that final unlink fails, the reserved destination is
 * removed only while it is still the exact entry we created.
 */
export function movePdfFileNoClobber(
  source: string,
  target: string,
  overrides: Partial<NoClobberFileOps> = {},
): NoClobberMoveResult {
  const ops = { ...defaultNoClobberFileOps, ...overrides }
  let sourceBytes: Buffer
  try {
    sourceBytes = ops.readSource(source)
  } catch {
    return 'failed'
  }
  try {
    ops.link(source, target)
  } catch (linkError) {
    const code = fileErrorCode(linkError)
    if (code === 'EEXIST') return 'occupied'
    if (!code || !LINK_COPY_FALLBACK_CODES.has(code)) return 'failed'
    try {
      ops.copyExclusive(source, target)
    } catch (copyError) {
      return fileErrorCode(copyError) === 'EEXIST' ? 'occupied' : 'failed'
    }
  }

  let createdIdentity: string
  try {
    createdIdentity = ops.identity(target)
  } catch {
    // The source is still intact. Do not remove a target that no longer
    // proves to be the entry this operation created.
    return 'failed'
  }

  try {
    ops.unlink(source)
  } catch {
    try {
      if (ops.identity(target) === createdIdentity && ops.matchesSource(target, sourceBytes)) {
        ops.unlink(target)
      }
    } catch {
      // Preserve an entry that no longer proves to be ours.
    }
    return 'failed'
  }

  try {
    if (ops.identity(target) === createdIdentity && ops.matchesSource(target, sourceBytes)) {
      return 'moved'
    }
  } catch {
    // Restore below from the in-memory source snapshot.
  }

  // A concurrent actor replaced or removed target between reservation and
  // source unlink. Recreate the original source path before reporting failure.
  try {
    ops.restoreSource(source, sourceBytes)
  } catch {
    // Best effort: an actor with write access to the directory may also have
    // raced the source path. Never claim success or grant the suspect target.
  }
  return 'failed'
}

/** @deprecated A Boolean cannot authorize a later tab/window removal. Every host
 * must use preparePdfNativeClose + completePdfClose(actual synchronous remove). */
export async function requestPdfClose(
  _contents: WebContents,
  _parent?: BrowserWindow | null,
): Promise<boolean> {
  throw new Error('This PDF host requires correlated Close preparation and synchronous actual-removal completion. The document was kept open.')
}

function requestRendererSave(contents: WebContents, flushAll: boolean): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      closeSaveWaiters.delete(contents.id)
      resolve(false)
    }, 120_000)
    closeSaveWaiters.set(contents.id, (ok) => {
      clearTimeout(timer)
      resolve(ok)
    })
    contents.send(PDF_CHANNELS.closeSaveRequest, { flushAll })
  })
}

/** Ask the renderer to write pending edits to disk; clean views resolve true immediately.
 *  flushAll (export flows): the file must then hold everything on screen, so the form field
 *  whose card is open is written too; menu Save leaves it to Done */
export function flushPdfSave(contents: WebContents, flushAll = false): Promise<boolean> {
  if (contents.isDestroyed() || !dirtyByWc.has(contents.id)) return Promise.resolve(true)
  return requestRendererSave(contents, flushAll)
}

/** Menu Print: ask the renderer to run its print flow (save, rasterize, system dialog) */
export function sendPdfPrintRequest(contents: WebContents): void {
  if (!contents.isDestroyed()) contents.send(PDF_CHANNELS.printRequest)
}

/**
 * Marks the whole Save As flow (dialog included) for the renderer, which pauses
 * autosave meanwhile: opening the save dialog blurs the window, and a
 * blur-triggered autosave would write the pending edits into the original file.
 */
export function setPdfSaveAsInFlight(contents: WebContents, inFlight: boolean): void {
  if (!contents.isDestroyed()) contents.send(PDF_CHANNELS.saveAsFlow, inFlight)
}

/**
 * Menu Save As: grant targetPath to the view, then ask the renderer to apply its
 * pending edits onto the source bytes and write the result to targetPath only.
 * The original file is never written (non-destructive Save As).
 */
export async function requestPdfSaveAs(contents: WebContents, targetPath: string): Promise<boolean> {
  if (contents.isDestroyed() || saveAsWaiters.has(contents.id) || saveAsPreparing.has(contents.id)) return false
  const wcId = contents.id, session = pdfCloseSessionByWc.get(wcId)
  if (!session) return false
  saveAsPreparing.add(wcId)
  try {
    // Pin at the MAIN picker grant, before renderer work/serialization can await.
    const version = await readAtomicFileVersion(targetPath)
    if (contents.isDestroyed() || pdfCloseSessionByWc.get(wcId) !== session) return false
    saveAsTargetByWc.set(wcId, targetPath)
    const grant = { path: targetPath, session, version }
    saveAsTargetVersions.set(wcId, grant)
    return await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        if (saveAsTargetVersions.get(wcId) === grant) { saveAsTargetByWc.delete(wcId); saveAsTargetVersions.delete(wcId) }
        resolve(ok)
      }
      const timer = setTimeout(() => { saveAsWaiters.delete(wcId); done(false) }, 120_000)
      saveAsWaiters.set(wcId, (ok) => { clearTimeout(timer); done(ok) })
      try { contents.send(PDF_CHANNELS.saveAsRequest, targetPath) } catch { saveAsWaiters.delete(wcId); clearTimeout(timer); done(false) }
    })
  } finally { saveAsPreparing.delete(wcId) }
}

/** Saved signatures live in userData, shared by all documents and windows */
const signaturesPath = () => join(app.getPath('userData'), 'pdf-signatures.json')

/** Serialize signature file read-modify-writes: several pdf views share one file */
let signatureQueue: Promise<unknown> = Promise.resolve()
function withSignatures(
  op: (list: SavedSignature[]) => Promise<SavedSignature[]>,
): Promise<SavedSignature[]> {
  const next = signatureQueue
    .catch(() => undefined)
    .then(async () => op(await loadSignatures(signaturesPath())))
  signatureQueue = next
  return next
}

let ipcRegistered = false

/** Filesystem seam for readMergeInputs; defaults to node:fs/promises */
export interface MergeInputIo {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string): Promise<Uint8Array>
}

/**
 * Total size budget across the open document plus every merge-dialog pick.
 * The merge used to hold every picked file in memory at once (Promise.all
 * over readFile) on the main process — a singleton, where an OOM takes the
 * whole app down, not one tab; 30 × 200 MB scans were enough to get there.
 * 1 GiB comfortably covers realistic merge jobs while keeping the peak
 * read footprint bounded.
 */
export const MAX_MERGE_TOTAL_BYTES = 1_073_741_824

/**
 * Stat + sum every merge input before anything is read — refusing an
 * oversized merge must not require reading it first — then read the picked
 * files one at a time (so at most one extra copy is live) and finally the
 * base document, in the same order the merge appends them. Throws a readable
 * error when the total crosses MAX_MERGE_TOTAL_BYTES.
 */
export async function readMergeInputs(
  basePath: string,
  pickedPaths: readonly string[],
  io: MergeInputIo = { stat: (p) => stat(p), readFile: (p) => readFile(p) },
): Promise<{ base: Uint8Array; others: Uint8Array[] }> {
  // Same MB rounding the electron-utils remote-image cap error uses.
  const asMb = (bytes: number): number => Math.round(bytes / (1024 * 1024))
  let totalBytes = 0
  for (const input of [basePath, ...pickedPaths]) {
    totalBytes += (await io.stat(input)).size
    if (totalBytes > MAX_MERGE_TOTAL_BYTES) {
      throw new Error(
        `pdf: merge too large — the selected files total ${asMb(totalBytes)} MB, ` +
          `over the ${asMb(MAX_MERGE_TOTAL_BYTES)} MB merge limit`,
      )
    }
  }
  const others: Uint8Array[] = []
  for (const pickedPath of pickedPaths) {
    others.push(new Uint8Array(await io.readFile(pickedPath)))
  }
  return { base: new Uint8Array(await io.readFile(basePath)), others }
}

function registerPdfIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.handle(PDF_CHANNELS.closeClaim, (event, ticket) => pdfCloses().claim(event.sender.id, ticket))
  ipcMain.handle(PDF_CHANNELS.closeCancel, (event, ticket: CloseLeaseTicket, reason: unknown) => { if (ticket && typeof ticket.id === 'string') pdfCloses().cancel(event.sender.id, ticket, typeof reason === 'string' ? reason.slice(0, 512) : 'PDF renderer canceled') })
  ipcMain.on(PDF_CHANNELS.closePrepared, (event, response) => { void pdfCloses().prepared(event.sender.id, response) })
  ipcMain.on(PDF_CHANNELS.closeStateResponse, (event, id, state) => pdfCloses().queried(event.sender.id, id, state))

  ipcMain.handle(PDF_CHANNELS.consumePending, (e) => openPathByWc.get(e.sender.id) ?? null)

  ipcMain.handle(PDF_CHANNELS.getUsername, () => {
    try {
      return userInfo().username
    } catch {
      return ''
    }
  })

  ipcMain.handle(PDF_CHANNELS.printers, async (e) => {
    const printers = await e.sender.getPrintersAsync()
    return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name }))
  })

  ipcMain.handle(PDF_CHANNELS.print, (e, job: unknown) => {
    const opts = printJobOptions(job)
    // the renderer's print stylesheet already lays one rasterized page per sheet
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      e.sender.print({ margins: { marginType: 'none' }, ...opts }, (success, failureReason) => {
        resolve({
          ok: success,
          ...(failureReason && !/cancel/i.test(failureReason) ? { error: failureReason } : {}),
        })
      })
    })
  })

  ipcMain.handle(PDF_CHANNELS.readFile, async (e, path: unknown, closeTicket: unknown) => {
    const owner = e.sender.id, session = pdfCloseSessionByWc.get(owner)
    if (typeof path !== 'string' || !allowedByWc.get(owner)?.has(path) || !session) throw new Error('pdf: path not granted to this view')
    if (closeTicket !== undefined && (!isCloseLeaseTicket(closeTicket) || !pdfCloses().claim(owner, closeTicket))) throw new Error('The PDF close/save reload authorization expired.')
    const pinned = await readPinnedPdf(path)
    if (e.sender.isDestroyed() || pdfCloseSessionByWc.get(owner) !== session || !allowedByWc.get(owner)?.has(path)) throw new Error('The PDF source changed while reading.')
    pdfFiles.remember(owner, { path, session, readId: '', version: pinned.version, sha256: pinned.sha256, ...(isCloseLeaseTicket(closeTicket) ? { closeTicket } : {}) })
    const buf = pinned.bytes
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })
  ipcMain.handle(PDF_CHANNELS.readSource, async (e, path: unknown, closeTicket: unknown): Promise<PdfSourceRead> => {
    const owner = e.sender.id, session = pdfCloseSessionByWc.get(owner)
    if (typeof path !== 'string' || !allowedByWc.get(owner)?.has(path) || !session) throw new Error('pdf: source not granted to this view')
    if (closeTicket !== undefined) {
      if (!isCloseLeaseTicket(closeTicket) || !pdfCloses().claim(owner, closeTicket)) throw new Error('The PDF close/save reload authorization expired.')
    } else {
      closeCoordinator?.cancel(owner, undefined, 'PDF source read requested')
      nativePdfWrites.write(pdfPublicationDomain(owner), false)?.()
    }
    const version = await readAtomicFileVersion(path)
    if (!version) throw new Error('The PDF source is unavailable.')
    const result = await pdfDrafts().read(owner, path)
    if (e.sender.isDestroyed() || !allowedByWc.get(owner)?.has(path) || pdfCloseSessionByWc.get(owner) !== session) throw new Error('pdf: source owner changed during reading')
    await rememberPdfRead(owner, session, result, isCloseLeaseTicket(closeTicket) ? closeTicket : undefined, result.mode === 'native' ? version : undefined)
    allowedByWc.get(owner)!.add(result.helperPath)
    return result
  })
  ipcMain.handle(PDF_CHANNELS.activateDraft, (e, readId: unknown, unjournaledPath: unknown) => {
    const owner = e.sender.id, session = pdfCloseSessionByWc.get(owner)
    if (typeof readId !== 'string' || readId.length > 128 || !session) throw new Error('Invalid PDF read receipt.')
    if (!readId && (typeof unjournaledPath !== 'string' || !allowedByWc.get(owner)?.has(unjournaledPath))) throw new Error('The unjournaled PDF source is not granted to this view.')
    const candidate = pdfFiles.candidate(owner, session, readId, typeof unjournaledPath === 'string' ? unjournaledPath : undefined)
    if (candidate.closeTicket && !pdfCloses().claim(owner, candidate.closeTicket)) throw new Error('The PDF owned-save activation permission expired.')
    const result = readId ? pdfDrafts().activate(owner, readId) : pdfDrafts().acceptUnjournaled(owner, candidate.path)
    // Rotate only after successful parse/activation. An exact MAIN-correlated
    // close Save may adopt its own checkpoint without becoming another source.
    const sameRead = pdfFiles.isActive(owner, candidate)
    const nextSession = candidate.closeTicket || sameRead ? session : randomUUID()
    if (!candidate.closeTicket && !sameRead) { closeCoordinator?.cancel(owner, undefined, 'A parsed PDF source was activated'); nativePdfWrites.write(pdfPublicationDomain(owner), false)?.() }
    pdfCloseSessionByWc.set(owner, nextSession)
    pdfFiles.activate(owner, candidate, nextSession)
    return result
  })
  ipcMain.handle(PDF_CHANNELS.writeDraft, (e, request) => pdfDrafts().snapshot(e.sender.id, request))
  ipcMain.handle(PDF_CHANNELS.discardDraft, (e, token: unknown) => {
    if (typeof token !== 'string' || token.length > 128) throw new Error('Invalid PDF draft receipt.')
    return pdfDrafts().discard(e.sender.id, token)
  })
  ipcMain.handle(PDF_CHANNELS.acknowledgeCopy, (e, request) => pdfDrafts().acknowledgeCopy(e.sender.id, request))
  ipcMain.handle(PDF_CHANNELS.forkAfterSave, async (event, request) => {
    const result = await pdfDrafts().forkAfterSave(event.sender.id, request)
    if (event.sender.isDestroyed() || !allowedByWc.has(event.sender.id)) throw new Error('The PDF view closed before its recovery workspace could be handed back.')
    const session = pdfCloseSessionByWc.get(event.sender.id)
    if (!session) throw new Error('The PDF source changed during recovery fallback.')
    await rememberPdfRead(event.sender.id, session, result.read)
    allowedByWc.get(event.sender.id)!.add(result.read.helperPath)
    return result
  })
  ipcMain.handle(PDF_CHANNELS.retryDraftCleanup, async event => {
    const owner = event.sender.id
    if (!allowedByWc.has(owner)) throw new Error('This PDF cleanup owner is no longer open.')
    let work = pdfCleanupRetries.get(owner)
    if (!work) {
      work = pdfDrafts().retryCleanup(owner).then(() => privateBases!.retryPublicationCleanup(owner))
      pdfCleanupRetries.set(owner, work)
      void work.then(() => { if (pdfCleanupRetries.get(owner) === work) pdfCleanupRetries.delete(owner) }, () => { if (pdfCleanupRetries.get(owner) === work) pdfCleanupRetries.delete(owner) })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Earlier automatic PDF cleanup is still finishing. Its known files remain tracked; no complete-cleanup claim was made.')), 5000) })]) }
    finally { if (timer) clearTimeout(timer) }
  })
  ipcMain.handle(PDF_CHANNELS.requestWorkspaceCopy, async (e, path: unknown) => {
    const source = pdfDrafts().source(e.sender.id)
    if (!source || source.mode !== 'workspace' || path !== source.helperPath || workspaceCopies.has(e.sender.id) || workspaceCopyPickers.has(e.sender.id)) return false
    workspaceCopyPickers.add(e.sender.id)
    try {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const options = { title: 'Save a new PDF copy', defaultPath: basename(source.path).replace(/\.vpdfdraft$/i, '') + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] }
    const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath || !/\.pdf$/i.test(picked.filePath)) return false
    if (e.sender.isDestroyed() || pdfDrafts().source(e.sender.id)?.token !== source.token) return false
    return await requestPdfSaveAs(e.sender, picked.filePath)
    } finally { workspaceCopyPickers.delete(e.sender.id) }
  })

  ipcMain.handle(
    PDF_CHANNELS.createDocument,
    async (e, request: unknown): Promise<CreateDocumentResult> => {
      if (!allowedByWc.has(e.sender.id)) {
        return { ok: false, error: 'pdf: sender is not a registered PDF view' }
      }
      const parsed = parseCreateDocumentRequest(request)
      if (!parsed) return { ok: false, error: 'pdf: invalid create-document request' }
      const create = runtime.createDocument
      if (!create) return { ok: false, error: 'pdf: document creation is unavailable in this host' }
      try {
        return await create(parsed)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  registerPdfWrite(PDF_CHANNELS.save, async (e, request: SavePdfRequest): Promise<SavePdfResult> => {
    const requestSession = pdfCloseSessionByWc.get(e.sender.id)
    const path = request?.path
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      return { ok: false, error: 'pdf: path not granted to this view' }
    }
    const loaded = pdfFiles.loaded(e.sender.id, requestSession ?? '', path)
    // Save As targets must have been granted by requestPdfSaveAs (main-process dialog pick)
    const target = typeof request.targetPath === 'string' ? request.targetPath : path
    if (target !== path && saveAsTargetByWc.get(e.sender.id) !== target) {
      return { ok: false, error: 'pdf: target path not granted to this view' }
    }
    const targetGrant = saveAsTargetVersions.get(e.sender.id)
    if (target !== path && (!targetGrant || targetGrant.path !== target || targetGrant.session !== requestSession)) return { ok: false, error: 'The PDF Save As destination grant expired.' }
    const pinnedTarget = { path: target, version: target === path ? loaded.version : targetGrant!.version }
    const assertCurrentSave = () => {
      if (!requestSession || requestSession !== pdfCloseSessionByWc.get(e.sender.id)) throw new Error('The PDF renderer changed before output publication.')
      if (request.closeTicket && !pdfCloses().claim(e.sender.id, request.closeTicket)) throw new Error('The PDF close Save permission expired before publication.')
      if (target !== path && saveAsTargetVersions.get(e.sender.id) !== targetGrant) throw new Error('The PDF Save As grant expired before publication.')
    }
    const workspace = pdfDrafts().source(e.sender.id)?.mode === 'workspace' || !!privateBases?.owns(path) || /\.vpdfdraft$/i.test(path)
    if (workspace && (target === path || !/\.pdf$/i.test(target))) return { ok: false, error: 'Save this recovery workspace to a new .pdf copy. The workspace and original remain unchanged.' }
    if (workspace && !request.workspaceProof) return { ok: false, error: 'The complete PDF workspace state must accompany Save.' }
    if (workspaceCopies.has(e.sender.id)) return { ok: false, error: 'A PDF workspace copy is already being saved.' }
    if (request.redactions !== undefined) {
      if (!redactionFlows.has(e.sender.id)) return { ok: false, error: 'Permanent redaction requires a fresh Apply action and a separately selected copy.' }
      let regions
      try {
        regions = validateRedactionRegions(request.redactions)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (isSameRedactionCopyPath(path, target)) {
        return { ok: false, error: 'pdf: permanent redaction requires Save As copy' }
      }
      // A redaction is intentionally its own irreversible transaction. Persist normal
      // changes first; otherwise a later annotation/form write could add recoverable
      // data after native removal.
      if (
        request.markups.length ||
        request.annotDeletes?.length ||
        request.drawings.length ||
        request.noteEdits?.length ||
        request.formValues.length ||
        request.stamps.length ||
        request.textEdits?.length ||
        request.textInserts?.length ||
        request.imageEdits?.length ||
        request.rotations?.length ||
        request.deletedPages?.length ||
        request.pageOrder?.length ||
        request.metadata
      ) {
        return { ok: false, error: 'pdf: save other pending edits before applying redactions' }
      }
      request = { ...request, redactions: regions }
    }
    let outputPublished = false
    try {
      const capture = request.workspaceProof ? pdfDrafts().captureCopy(e.sender.id, request.workspaceProof) : null
      if (capture && pdfDrafts().source(e.sender.id)?.helperPath !== path) throw new Error('The PDF save belongs to an obsolete source path.')
      if (capture && request.redactions?.length && pdfRepresentation(capture.state, request, capture.pageCount, capture.renderedStampConfig).skipped.length) throw new Error('Finish or save all pending PDF content before applying redactions.')
      if (workspace) workspaceCopies.add(e.sender.id)
      let skippedTextEdits, skippedTextInserts, skippedImageEdits
      let written: Buffer | undefined
      let inputSha256: string | undefined
      let cleanupWarning: string | undefined
      if (capture?.savedPublication) {
        const published = await readAtomicFileVersion(capture.savedPublication.path)
        if (!published || published.sha256 !== capture.savedPublication.sha256) cleanupWarning = 'The earlier saved PDF changed outside this view. Only the separately chosen exclusive new copy is being published; the external replacement is left unchanged.'
      }
      if (!capture) await assertPdfFileVersion(path, loaded.version)
      const sourceBytes = capture ? capture.bytes : await readPdfWorkspaceFile(path, loaded.version.size)
      inputSha256 = pdfDigest(sourceBytes)
      const published = await publishPinnedPdf({
        source: loaded, target: pinnedTarget, input: sourceBytes,
        serialize: bytes => applySaveRequest(bytes, request),
        output: applied => applied.bytes,
        verify: applied => verifyContentEdits(applied.bytes, request, applied),
        current: () => { assertCurrentSave(); if (capture) pdfDrafts().checkCopy(e.sender.id, capture) },
        publish: async (bytes, expectedVersion) => {
          assertCurrentSave()
          if (workspace || request.redactions?.length) {
            const publication = await privateBases!.publishNew(bytes, target, e.sender.id)
            cleanupWarning = [cleanupWarning, publication.cleanupWarning].filter(Boolean).join(' ') || undefined
          } else await atomicWriteFile(target, bytes, { expectedVersion })
          outputPublished = true
        },
      })
      written = published.bytes
      ;({ skippedTextEdits, skippedTextInserts, skippedImageEdits } = published.result)
      if (target === path) {
        const outputVersion = await observePublishedPdf(target, written)
        pdfFiles.ownPublication(e.sender.id, loaded, outputVersion, written)
      }
      if (!request.redactions?.length && target === path && written && inputSha256) pdfDrafts().bindNativeWrite(e.sender.id, path, inputSha256, written)
      if (request.redactions?.length && !capture) cleanupWarning = [cleanupWarning, 'The sanitized PDF was saved. Complete recovery was unavailable for this source, so earlier automatic recovery cleanup was not certified. Earlier user-owned files and backups remain.'].filter(Boolean).join(' ')
      if (request.redactions !== undefined && (!capture || pdfDrafts().source(e.sender.id)?.token === capture.activeToken)) {
        // Revoke old-source read/write grants immediately after verified publication,
        // before recovery classification or cleanup can await storage.
        allowedByWc.set(e.sender.id, new Set([target]))
        openPathByWc.set(e.sender.id, target)
        redactionPathByWc.set(e.sender.id, target)
        try { pdfRedactionSavedHook?.(e.sender, target) }
        catch { cleanupWarning = [cleanupWarning, 'The sanitized PDF was saved, but its workspace tab could not be renamed automatically.'].filter(Boolean).join(' ') }
      }
      let copyReceipt
      if (capture && written) {
        const represented = pdfRepresentation(capture.state, request, capture.pageCount, capture.renderedStampConfig)
        const failures = [...represented.skipped, ...skippedTextEdits.map(value => `text:${value.reason}`), ...skippedTextInserts.map(value => `insert:${value.reason}`), ...skippedImageEdits.map(value => `image:${value.reason}`)]
        copyReceipt = await pdfDrafts().publication(e.sender.id, capture, { bytes: written, outputPath: target, representedIds: represented.representedIds, pageMap: represented.pageMap, skipped: failures, redacted: !!request.redactions?.length })
        if (cleanupWarning) copyReceipt.cleanupWarning = [copyReceipt.cleanupWarning, cleanupWarning].filter(Boolean).join(' ')
        if (copyReceipt.checkpoint) {
          await rememberPdfRead(e.sender.id, requestSession!, copyReceipt.checkpoint, request.closeTicket)
          allowedByWc.get(e.sender.id)?.add(copyReceipt.checkpoint.helperPath)
        }
        if (workspace && !request.redactions?.length) openGeneratedPdf(target)
      }
      return {
        ok: true,
        ...(copyReceipt ? { copyReceipt } : {}),
        ...(cleanupWarning && !copyReceipt ? { warning: cleanupWarning } : {}),
        ...(skippedTextEdits.length > 0 ? { skippedTextEdits } : {}),
        ...(skippedTextInserts.length > 0 ? { skippedTextInserts } : {}),
        ...(skippedImageEdits.length > 0 ? { skippedImageEdits } : {}),
      }
    } catch (err) {
      if (outputPublished) return { ok: true, warning: `The PDF output was saved, but its recovery checkpoint could not be completed. ${err instanceof Error ? err.message : String(err)}` }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      workspaceCopies.delete(e.sender.id)
    }
  })

  ipcMain.handle(PDF_CHANNELS.requestRedactionCopy, async (e, path: unknown): Promise<boolean> => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) return false
    if (redactionFlows.has(e.sender.id) || saveAsWaiters.has(e.sender.id)) return false
    const session = pdfCloseSessionByWc.get(e.sender.id), source = pdfDrafts().source(e.sender.id)
    if (!session || (source && source.helperPath !== path)) return false
    redactionFlows.add(e.sender.id)
    const base = basename(path).replace(/\.pdf$/i, '')
    setPdfSaveAsInFlight(e.sender, true)
    try {
      const parent = BrowserWindow.fromWebContents(e.sender)
      const options = {
        title: tm('dlgRedactCopy'),
        defaultPath: join(dirname(path), `${base}-redacted.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }
      const picked = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath || isSameRedactionCopyPath(path, picked.filePath))
        return false
      const current = pdfDrafts().source(e.sender.id)
      if (e.sender.isDestroyed() || pdfCloseSessionByWc.get(e.sender.id) !== session || current?.readId !== source?.readId || (current && current.helperPath !== path)) return false
      return await requestPdfSaveAs(e.sender, picked.filePath)
    } finally {
      redactionFlows.delete(e.sender.id)
      setPdfSaveAsInFlight(e.sender, false)
    }
  })

  ipcMain.handle(PDF_CHANNELS.isUntitled, (e, path: unknown): boolean => {
    return (
      typeof path === 'string' &&
      !!allowedByWc.get(e.sender.id)?.has(path) &&
      untitledPdfPaths.has(path)
    )
  })

  ipcMain.handle(
    PDF_CHANNELS.autoRename,
    async (e, path: unknown, baseName: unknown): Promise<PdfAutoRenameResult> => {
      if(typeof path!=='string'||!allowedByWc.get(e.sender.id)?.has(path)||!untitledPdfPaths.has(path)||typeof baseName!=='string')return {renamed:false}
      const base=sanitizeAutoRenameBase(baseName)
      if(!base)return {renamed:false}
      try{
        const session=pdfCloseSessionByWc.get(e.sender.id)
        const source=pdfFiles.loaded(e.sender.id,session??'',path)
        const target=await renameOwnedPdf({source,baseName:base,
          current:()=>{if(e.sender.isDestroyed()||pdfCloseSessionByWc.get(e.sender.id)!==session||!pdfFiles.isActive(e.sender.id,source)||!allowedByWc.get(e.sender.id)?.has(path)||!untitledPdfPaths.has(path))throw new Error('The PDF source changed before automatic rename')},
          cancelClose:()=>closeCoordinator?.cancel(e.sender.id,undefined,'PDF automatic rename'),
          move:movePdfFileNoClobber,
          adopt:async newPath=>{
            pdfFileRenamed(e.sender,path,newPath)
            allowedByWc.set(e.sender.id,new Set([newPath]))
            untitledPdfPaths.delete(newPath)
            try{await pdfRenamedHook?.(e.sender,path,newPath)}catch(err){console.warn('[pdf] auto-rename hook failed:',err)}
          },
        })
        return target?{renamed:true,path:target,name:basename(target)}:{renamed:false}
      }catch(err){console.warn('[pdf] auto-rename refused:',err);return {renamed:false}}
    },
  )

  ipcMain.handle(PDF_CHANNELS.listPageImages, async (e, path: unknown) => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      throw new Error('pdf: path not granted to this view')
    }
    // Lazy import like the text-edit paths: pdfium wasm only loads when the feature is used
    const { listPageImages } = await import('./image-edit')
    return listPageImages(new Uint8Array(await readFile(path)))
  })

  ipcMain.handle(PDF_CHANNELS.listStaticFormFills, async (e, path: unknown) => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      throw new Error('pdf: path not granted to this view')
    }
    return readStaticFormFills(new Uint8Array(await readFile(path)))
  })

  ipcMain.handle(PDF_CHANNELS.ocrPage, async (_e, png: unknown) => {
    // bad payload = failed page ([]), never "no engine" (null) — null stops the caller's pass
    if (typeof png !== 'string' || png.length === 0 || png.length > 64 * 1024 * 1024) return []
    const { ocrPagePng } = await import('./ocr')
    return ocrPagePng(png)
  })

  ipcMain.handle(
    PDF_CHANNELS.pageImagePng,
    async (
      e,
      request: {
        path: string
        pageIndex: number
        rect: [number, number, number, number]
        scale?: number
      },
    ) => {
      const { path, pageIndex, rect, scale } = request ?? {}
      if (
        typeof path !== 'string' ||
        !allowedByWc.get(e.sender.id)?.has(path) ||
        typeof pageIndex !== 'number' ||
        !Array.isArray(rect)
      ) {
        throw new Error('pdf: path not granted to this view')
      }
      const { renderImagePng } = await import('./image-edit')
      return renderImagePng(
        new Uint8Array(await readFile(path)),
        pageIndex,
        rect,
        typeof scale === 'number' && Number.isFinite(scale) ? scale : 1,
      )
    },
  )

  ipcMain.handle(PDF_CHANNELS.pagePreviewPng, async (e, request: PagePreviewRequest) => {
    const { path, pageIndex, excludeRects, excludeAnnots, excludeText, clip, pxWidth, rotate } =
      request ?? {}
    if (
      typeof path !== 'string' ||
      !allowedByWc.get(e.sender.id)?.has(path) ||
      typeof pageIndex !== 'number' ||
      !Array.isArray(excludeRects) ||
      (excludeAnnots !== undefined && !Array.isArray(excludeAnnots)) ||
      (excludeText !== undefined && !Array.isArray(excludeText)) ||
      typeof clip !== 'object' ||
      typeof pxWidth !== 'number' ||
      typeof rotate !== 'number'
    ) {
      throw new Error('pdf: path not granted to this view')
    }
    const { renderPagePreviewPng } = await import('./image-edit')
    return renderPagePreviewPng(new Uint8Array(await readFile(path)), {
      pageIndex,
      excludeRects,
      excludeAnnots,
      excludeText,
      clip,
      pxWidth,
      rotate,
    })
  })

  ipcMain.handle(
    PDF_CHANNELS.validateTextEdits,
    async (e, request: ValidateTextEditsRequest): Promise<TextEditValidation[]> => {
      const { path, edits } = request ?? {}
      if (
        typeof path !== 'string' ||
        !allowedByWc.get(e.sender.id)?.has(path) ||
        !Array.isArray(edits)
      ) {
        throw new Error('pdf: path not granted to this view')
      }
      // Same lazy import as the save path: the pdfium wasm only loads when text editing is used
      const { validateTextEdits } = await import('./text-edit')
      return validateTextEdits(new Uint8Array(await readFile(path)), edits)
    },
  )

  ipcMain.handle(PDF_CHANNELS.listEditFonts, async (): Promise<string[]> => {
    const { listEditFonts } = await import('./text-edit')
    return listEditFonts()
  })

  ipcMain.handle(
    PDF_CHANNELS.canDrawText,
    async (_e, text: unknown, font: unknown, bold: unknown, italic: unknown): Promise<boolean> => {
      if (typeof text !== 'string') return false
      const { canDrawText } = await import('./text-edit')
      return canDrawText(
        text,
        typeof font === 'string' ? font : undefined,
        bold === true,
        italic === true,
      )
    },
  )

  ipcMain.handle(
    PDF_CHANNELS.extractPages,
    async (e, request: ExtractPagesRequest): Promise<ExtractPagesResult> => {
      const { path, pages, suggestedName } = request ?? {}
      if (
        typeof path !== 'string' ||
        !allowedByWc.get(e.sender.id)?.has(path) ||
        !Array.isArray(pages)
      ) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      try {
        const bytes = await extractPagesBytes(new Uint8Array(await readFile(path)), pages)
        const targetPath = uniqueGeneratedPdfPath(
          configuredDefaultSaveDir(app),
          String(suggestedName || 'pages.pdf'),
        )
        // Vantage Productivity: derived document outputs use protected publication too.
        await writePdfAtomically(targetPath, bytes)
        openGeneratedPdf(targetPath)
        return { ok: true, savedPath: targetPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  registerPdfWrite(
    PDF_CHANNELS.insertPdf,
    async (e, request: InsertPdfRequest): Promise<InsertPdfResult> => {
      const { path, afterPageIndex } = request ?? {}
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const picked = await showOpenDialogWithMemory(dialog, win, {
        title: tm('dlgInsert'),
        filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
        properties: ['openFile'],
      })
      const other = picked.filePaths[0]
      if (picked.canceled || !other) return { ok: true, canceled: true }
      try {
        const { merged, count } = await insertPdfBytes(
          new Uint8Array(await readFile(path)),
          new Uint8Array(await readFile(other)),
          typeof afterPageIndex === 'number' ? afterPageIndex : -1,
        )
        await writePdfOwnedSource(e.sender.id, path, merged)
        return { ok: true, insertedCount: count }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  ) // Compare: pick a second document and extract its per-page text main-side —
  // the bytes and the path stay here, the renderer gets text only
  ipcMain.handle(PDF_CHANNELS.compareReadPdf, async (e) => {
    if (!allowedByWc.has(e.sender.id)) {
      return { ok: false as const, reason: 'pdf: sender is not a registered PDF view' }
    }
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
    const picked = await showOpenDialogWithMemory(dialog, win ?? undefined, {
      filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
      properties: ['openFile'],
    })
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return { ok: false as const, canceled: true }
    try {
      const text = await readPdfText(new Uint8Array(await readFile(file)))
      return {
        ok: true as const,
        name: basename(file),
        pageCount: text.pageCount,
        pages: text.pages.map((page) => page.text),
      }
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  // Compare: the open document's own text through the same pdfium engine as the
  // picked side — pdf.js and pdfium break lines differently, and a diff across
  // engines reports added and removed lines on files that are identical.
  ipcMain.handle(PDF_CHANNELS.compareReadOpen, async (e, path: unknown) => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      return { ok: false as const, reason: 'pdf: path not granted to this view' }
    }
    try {
      const text = await readPdfText(new Uint8Array(await readFile(path)))
      return {
        ok: true as const,
        name: basename(path),
        pageCount: text.pageCount,
        pages: text.pages.map((page) => page.text),
      }
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  registerPdfWrite(
    PDF_CHANNELS.insertBlankPage,
    async (e, request: InsertBlankPageRequest): Promise<InsertBlankPageResult> => {
      const { path, afterPageIndex } = request ?? {}
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      try {
        const bytes = await insertBlankPageBytes(
          new Uint8Array(await readFile(path)),
          typeof afterPageIndex === 'number' ? afterPageIndex : -1,
        )
        await writePdfOwnedSource(e.sender.id, path, bytes)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    PDF_CHANNELS.splitPdf,
    async (e, request: SplitPdfRequest): Promise<SplitPdfResult> => {
      const { path, chunkSize, baseName } = request ?? {}
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const picked = await showOpenDialogWithMemory(dialog, win, {
        title: tm('dlgSplit'),
        properties: ['openDirectory', 'createDirectory'],
      })
      const dir = picked.filePaths[0]
      if (picked.canceled || !dir) return { ok: true, canceled: true }
      try {
        const parts = await splitPdfBytes(
          new Uint8Array(await readFile(path)),
          typeof chunkSize === 'number' ? chunkSize : 1,
        )
        const safeBase = String(baseName || 'split').replace(/[/\\:*?"<>|]/g, '_')
        for (const [i, bytes] of parts.entries()) {
          await writePdfAtomically(join(dir, `${safeBase}-${i + 1}.pdf`), bytes)
        }
        // Many output files — don't open tabs; reveal them so success is never silent
        shell.showItemInFolder(join(dir, `${safeBase}-1.pdf`))
        return { ok: true, savedDir: dir, count: parts.length }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    PDF_CHANNELS.mergePdf,
    async (e, request: MergePdfRequest): Promise<MergePdfResult> => {
      const { path, suggestedName } = request ?? {}
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const picked = await showOpenDialogWithMemory(dialog, win, {
        title: tm('dlgMerge'),
        filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections'],
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: true, canceled: true }
      try {
        const { base, others } = await readMergeInputs(path, picked.filePaths)
        const { merged, appended } = await mergePdfBytes(base, others)
        const targetPath = uniqueGeneratedPdfPath(
          configuredDefaultSaveDir(app),
          String(suggestedName || 'merged.pdf'),
        )
        await writePdfAtomically(targetPath, merged)
        openGeneratedPdf(targetPath)
        return { ok: true, savedPath: targetPath, appendedCount: appended }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    PDF_CHANNELS.mergePages,
    async (e, request: MergePagesRequest): Promise<MergePagesResult> => {
      const { path, perSheet, direction, separator, suggestedName } = request ?? {}
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      if (!Number.isInteger(perSheet) || perSheet < 2 || perSheet > 16) {
        return { ok: false, error: 'pdf: pages-per-sheet must be 2-16' }
      }
      try {
        const bytes = await mergePagesBytes(new Uint8Array(await readFile(path)), {
          perSheet,
          direction: direction === 'horizontal' ? 'horizontal' : 'vertical',
          separator: separator === true,
        })
        const targetPath = uniqueGeneratedPdfPath(
          configuredDefaultSaveDir(app),
          String(suggestedName || 'merged-pages.pdf'),
        )
        await writePdfAtomically(targetPath, bytes)
        openGeneratedPdf(targetPath)
        return { ok: true, savedPath: targetPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  registerPdfWrite(
    PDF_CHANNELS.replacePages,
    async (e, request: ReplacePagesRequest): Promise<ReplacePagesResult> => {
      const { path, pages } = request ?? {}
      if (
        typeof path !== 'string' ||
        !allowedByWc.get(e.sender.id)?.has(path) ||
        !Array.isArray(pages) ||
        pages.length === 0
      ) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const picked = await showOpenDialogWithMemory(dialog, win, {
        title: tm('dlgReplace'),
        filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
        properties: ['openFile'],
      })
      const other = picked.filePaths[0]
      if (picked.canceled || !other) return { ok: true, canceled: true }
      try {
        const { merged, removed, inserted } = await replacePagesBytes(
          new Uint8Array(await readFile(path)),
          new Uint8Array(await readFile(other)),
          pages,
        )
        await writePdfOwnedSource(e.sender.id, path, merged)
        return { ok: true, removed, inserted }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  registerPdfWrite(
    PDF_CHANNELS.setPageSize,
    async (e, request: SetPageSizeRequest): Promise<SetPageSizeResult> => {
      const { path, width, height } = request ?? {}
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) {
        return { ok: false, error: 'pdf: invalid page size' }
      }
      try {
        const bytes = await setPageSizeBytes(new Uint8Array(await readFile(path)), width, height)
        await writePdfOwnedSource(e.sender.id, path, bytes)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    PDF_CHANNELS.splitPages,
    async (e, request: SplitPagesRequest): Promise<SplitPagesResult> => {
      const { path, perPage, suggestedName } = request ?? {}
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      if (perPage !== 2 && perPage !== 4 && perPage !== 9) {
        return { ok: false, error: 'pdf: unsupported split grid' }
      }
      try {
        const bytes = await splitPagesBytes(new Uint8Array(await readFile(path)), perPage)
        const targetPath = uniqueGeneratedPdfPath(
          configuredDefaultSaveDir(app),
          String(suggestedName || 'split-pages.pdf'),
        )
        await writePdfAtomically(targetPath, bytes)
        openGeneratedPdf(targetPath)
        return { ok: true, savedPath: targetPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  registerPdfWrite(
    PDF_CHANNELS.cropPages,
    async (e, request: CropPagesRequest): Promise<CropPagesResult> => {
      const { path, pages, rect } = request ?? {}
      if (
        typeof path !== 'string' ||
        !allowedByWc.get(e.sender.id)?.has(path) ||
        !Array.isArray(pages) ||
        pages.length === 0 ||
        !rect
      ) {
        return { ok: false, error: 'pdf: path not granted to this view' }
      }
      try {
        const bytes = await cropPagesBytes(new Uint8Array(await readFile(path)), pages, rect)
        await writePdfOwnedSource(e.sender.id, path, bytes)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    PDF_CHANNELS.exportImages,
    async (e, request: ExportImagesRequest): Promise<ExportImagesResult> => {
      const { images, pageNumbers, baseName } = request ?? {}
      if (!Array.isArray(images) || images.length === 0)
        return { ok: false, error: 'pdf: no images' }
      if (!hasValidExportPageNumbers(pageNumbers, images.length))
        return { ok: false, error: 'pdf: invalid page numbers' }
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      const picked = await showOpenDialogWithMemory(dialog, win, {
        title: tm('dlgExportImages'),
        properties: ['openDirectory', 'createDirectory'],
      })
      const dir = picked.filePaths[0]
      if (picked.canceled || !dir) return { ok: true, canceled: true }
      try {
        const outputPaths = buildExportImagePaths(dir, baseName, pageNumbers)
        await publishSelectedUserOutputs(outputPaths.map((path,index)=>({path,prepare:async()=>Buffer.from(images[index]!, 'base64')})))
        // Reveal the exported images so success is never silent
        shell.showItemInFolder(outputPaths[0]!)
        return { ok: true, savedDir: dir, count: images.length }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // pdf-owned (unlike ai:image-search / ai:fetch-image, which the shell registers app-wide):
  // slides' ai:generate-image is only registered once a slides view exists, so pdf needs its own
  ipcMain.handle(PDF_CHANNELS.generateImage, (e, op: { prompt?: unknown; aspectRatio?: unknown }) =>
    generateImageTool(
      join(app.getPath('userData'), 'ai-settings.json'),
      {
        prompt: String(op?.prompt ?? ''),
        aspectRatio: op?.aspectRatio ? String(op.aspectRatio) : undefined,
      },
      {
        // pdf keeps its media (exported/edited images) beside the open file
        mediaRoots: documentMediaRoots(
          openPathByWc.get(e.sender.id),
          join(app.getPath('temp'), 'vantage-pasted'),
        ),
      },
    ),
  )

  // ── Certificate (digital) signatures ──

  ipcMain.handle(
    PDF_CHANNELS.listDigitalSignatures,
    async (e, path: unknown): Promise<PdfSignatureInfo[]> => {
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) return []
      try {
        return await readPdfSignatures(new Uint8Array(await readFile(path)))
      } catch {
        return []
      }
    },
  )

  ipcMain.handle(PDF_CHANNELS.pickCertificate, async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender)
    const options = {
      title: tm('dlgPickCertificate'),
      properties: ['openFile' as const],
      filters: [{ name: tm('filterCertificate'), extensions: ['p12', 'pfx'] }],
    }
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    // The renderer only ever sees an opaque id; the path stays in the main process
    const certId = rememberCert(e.sender.id, { kind: 'file', path: file })
    return { certId, fileName: basename(file) }
  })

  ipcMain.handle(
    PDF_CHANNELS.listSystemCertificates,
    async (e, storePassword: unknown): Promise<ListSystemCertificatesResult> => {
      const listing = await listSystemCertificates(
        typeof storePassword === 'string' && storePassword ? storePassword : undefined,
      )
      // A fresh listing replaces the previous one; ids from the old listing stop working
      const entries = certEntriesByWc.get(e.sender.id)
      if (entries) {
        for (const [id, entry] of entries) if (entry.kind === 'system') entries.delete(id)
      }
      return {
        issues: listing.issues,
        certs: listing.certs.map((cert) => ({
          certId: rememberCert(e.sender.id, { kind: 'system', ref: cert.ref }),
          label: cert.label,
          commonName: cert.commonName,
          issuerCommonName: cert.issuerCommonName,
          validTo: cert.validTo,
          expired: cert.expired,
        })),
      }
    },
  )

  ipcMain.on(PDF_CHANNELS.releaseCertificate, (e, certId: unknown) => {
    releaseCertEntry(certEntryOf(e.sender.id, certId))
  })

  ipcMain.handle(
    PDF_CHANNELS.inspectCertificate,
    async (
      e,
      certId: unknown,
      password: unknown,
      storePassword: unknown,
    ): Promise<InspectCertificateResult> => {
      const entry = certEntryOf(e.sender.id, certId)
      if (!entry || typeof password !== 'string') return { ok: false, error: 'cert-invalid' }
      try {
        const material = await certMaterial(
          entry,
          password,
          typeof storePassword === 'string' && storePassword ? storePassword : undefined,
        )
        const opened = openMaterial(material)
        return opened.ok
          ? { ok: true, signer: opened.info[0]!, chain: opened.info }
          : { ok: false, error: opened.error }
      } catch (err) {
        return { ok: false, error: err instanceof SystemStoreError ? err.code : 'cert-invalid' }
      }
    },
  )

  registerPdfWrite(
    PDF_CHANNELS.signWithCertificate,
    async (e, request: SignWithCertificateRequest): Promise<SignWithCertificateResult> => {
      const path = request?.path
      if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
        return { ok: false, error: 'sign-failed', message: 'pdf: path not granted to this view' }
      }
      const certEntry = certEntryOf(e.sender.id, request.certId)
      if (!certEntry || typeof request.password !== 'string') {
        return { ok: false, error: 'cert-invalid' }
      }
      const options = parseSignOptions(request)
      if (!options) return { ok: false, error: 'sign-failed', message: 'pdf: invalid sign request' }
      if (redactionFlows.has(e.sender.id) || saveAsWaiters.has(e.sender.id)) {
        return { ok: false, error: 'sign-failed', message: 'pdf: another save is in progress' }
      }
      // The signature covers the file on disk; edits still in the renderer would silently be left out
      if (dirtyByWc.has(e.sender.id)) {
        return {
          ok: false,
          error: 'sign-failed',
          message: 'pdf: save pending edits before signing',
        }
      }
      redactionFlows.add(e.sender.id)
      setPdfSaveAsInFlight(e.sender, true)
      try {
        const material = await certMaterial(
          certEntry,
          request.password,
          typeof request.storePassword === 'string' && request.storePassword
            ? request.storePassword
            : undefined,
        )
        // Fail on a wrong password before asking where to save
        const opened = openMaterial(material)
        if (!opened.ok) return { ok: false, error: opened.error }

        const parent = BrowserWindow.fromWebContents(e.sender)
        const base = basename(path).replace(/\.pdf$/i, '')
        const dialogOptions = {
          title: tm('dlgSignedCopy'),
          defaultPath: join(dirname(path), `${base}-signed.pdf`),
          filters: [{ name: tm('filterPdf'), extensions: ['pdf'] }],
        }
        const picked = parent
          ? await dialog.showSaveDialog(parent, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions)
        if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }
        const target = picked.filePath
        // Never overwrite the source: the original stays exactly as the user left it
        if (isSameRedactionCopyPath(path, target)) return { ok: false, cancelled: true }

        const signed = await signPdf(new Uint8Array(await readFile(path)), {
          ...opened.sign,
          ...options,
        })
        await assertPdfWriteBase(e.sender.id, path)
        await writePdfAtomically(target, signed)
        allowedByWc.set(e.sender.id, new Set([target]))
        openPathByWc.set(e.sender.id, target)
        try {
          pdfRedactionSavedHook?.(e.sender, target)
        } catch (err) {
          console.warn('[pdf] signed-copy hook failed:', err)
        }
        return { ok: true, path: target }
      } catch (err) {
        if (err instanceof SignError || err instanceof SystemStoreError) {
          return { ok: false, error: err.code }
        }
        return {
          ok: false,
          error: 'sign-failed',
          message: err instanceof Error ? err.message : String(err),
        }
      } finally {
        releaseCertEntry(certEntry)
        redactionFlows.delete(e.sender.id)
        setPdfSaveAsInFlight(e.sender, false)
      }
    },
  )

  ipcMain.handle(PDF_CHANNELS.listSignatures, () => withSignatures(async (list) => list))

  ipcMain.handle(PDF_CHANNELS.addSignature, (_e, data: unknown) =>
    withSignatures(async (list) => {
      if (!isSignatureData(data)) return list
      const next = addSignature(list, data)
      await saveSignatures(signaturesPath(), next)
      return next
    }),
  )

  ipcMain.handle(PDF_CHANNELS.removeSignature, (_e, id: unknown) =>
    withSignatures(async (list) => {
      if (typeof id !== 'string') return list
      const next = removeSignature(list, id)
      if (next.length !== list.length) await saveSignatures(signaturesPath(), next)
      return next
    }),
  )

  ipcMain.on(PDF_CHANNELS.dirtyChanged, (e, dirty: unknown) => {
    if (dirty === true) dirtyByWc.add(e.sender.id)
    else dirtyByWc.delete(e.sender.id)
  })

  ipcMain.on(PDF_CHANNELS.closeSaveResult, (e, ok: unknown) => {
    const waiter = closeSaveWaiters.get(e.sender.id)
    closeSaveWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  ipcMain.on(PDF_CHANNELS.saveAsResult, (e, ok: unknown) => {
    const waiter = saveAsWaiters.get(e.sender.id)
    saveAsWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  // Language channel shared with other modules; removeHandler tolerates duplicate registration
  ipcMain.removeHandler(PDF_CHANNELS.getLanguage)
  ipcMain.handle(PDF_CHANNELS.getLanguage, () => getUiLang())
}

function grantAndTrack(wc: WebContents, openPath?: string | null): void {
  const wcId = wc.id
  pdfCloseSessionByWc.set(wcId, randomUUID())
  const allowedPaths = new Set<string>()
  allowedByWc.set(wcId, allowedPaths)
  if (openPath && existsSync(openPath)) {
    openPathByWc.set(wcId, openPath)
    allowedPaths.add(openPath)
  }
  // External links inside the PDF (Link annots with target=_blank) go to the system browser
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url, { allowedProtocols: ['http:', 'https:', 'mailto:'] })
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  wc.once('destroyed', () => {
    closeCoordinator?.destroy(wcId)
    nativePdfWrites.destroy(wcId)
    pdfFiles.retire(wcId)
    pdfCloseSessionByWc.delete(wcId)
    draftController?.retire(wcId)
    openPathByWc.delete(wcId)
    redactionPathByWc.delete(wcId)
    redactionFlows.delete(wcId)
    allowedByWc.delete(wcId)
    dirtyByWc.delete(wcId)
    certEntriesByWc.delete(wcId)
    saveAsTargetByWc.delete(wcId)
    saveAsTargetVersions.delete(wcId)
    saveAsPreparing.delete(wcId)
    closeSaveWaiters.get(wcId)?.(false)
    closeSaveWaiters.delete(wcId)
    saveAsWaiters.get(wcId)?.(false)
    saveAsWaiters.delete(wcId)
  })
  // reload() remounts the renderer without destroying webContents, so the
  // destroyed handler never runs. A remount discards in-memory edits; the
  // close guard must not still think the tab is dirty.
  wc.on('did-start-loading', () => {
    pdfCloseSessionByWc.set(wcId, randomUUID())
    closeCoordinator?.cancel(wcId, undefined, 'PDF renderer reloaded')
    nativePdfWrites.destroy(wcId); pdfFiles.retire(wcId)
    draftController?.retire(wcId)
    dirtyByWc.delete(wcId)
  })
  wc.on('render-process-gone', () => {
    pdfCloseSessionByWc.set(wcId, randomUUID())
    closeCoordinator?.cancel(wcId, undefined, 'PDF renderer crashed')
    nativePdfWrites.destroy(wcId); pdfFiles.retire(wcId)
    draftController?.retire(wcId)
    dirtyByWc.delete(wcId)
  })
}

export function createPdfView(openPath?: string | null): WebContentsView {
  registerPdfIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  grantAndTrack(view.webContents, openPath)
  void view.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'pdf'))
  return view
}

/** Standalone window mode: `npm run dev -w @vantage/pdf`, pdf path passed via argv */
export function startPdfStandalone(): void {
  registerRendererScheme()
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  const standaloneRecoveryProfile = configureRecoveryProfile({ app, mode: 'gui', guiProfile: process.env.VANTAGE_USER_DATA || app.getPath('userData') })
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  initializeStandaloneRecovery({ app, ...standaloneRecoveryProfile, lockAcquired: true,
    warning: message => { void dialog.showMessageBox({ type: 'warning', message }).catch(() => {}) },
    terminal: cleanup => { app.once('will-quit', cleanup) },
  })
  configurePdfRuntime({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
    createDocument: createStandaloneDocument,
  })
  void app.whenReady().then(() => {
  // RECOVERY_BOOTSTRAP: runtime belongs to GUI startup, not handler registration.
    if (recoveryRuntimeState().available) void inspectRetainedPdfPrivateBases().catch(() => { void dialog.showMessageBox({ type: 'warning', message: 'Private PDF recovery storage needs review. Retained files were kept.' }).catch(() => {}) })
    installRendererProtocol({ pdf: join(__dirname, '../renderer') })
    registerPdfIpc()
    const win = new BrowserWindow({
      width: 1200,
      height: 850,
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    const argPath = process.argv.slice(1).find((a) => /\.(pdf|vpdfdraft)$/i.test(a) && existsSync(a))
    grantAndTrack(win.webContents, argPath)
    let preparingClose = false
    win.on('close', (event) => {
      event.preventDefault()
      if (preparingClose) return
      preparingClose = true
      const contents = win.webContents
      void (async () => {
        let receipt: PdfCloseReceipt | null = null
        try {
          receipt = await preparePdfNativeClose(contents, win)
          if (receipt) completePdfClose(contents, receipt, () => { if (win.isDestroyed() || win.webContents !== contents) return false; win.destroy(); return win.isDestroyed() })
        } catch (error) { if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'error', message: 'The PDF remains open', detail: error instanceof Error ? error.message : String(error) }) }
        finally { if (receipt) await cancelPdfClose(contents, receipt); preparingClose = false }
      })()
    })
    void win.loadURL(rendererUrl(runtime.rendererUrl, 'pdf'))
  })
  app.on('window-all-closed', () => app.quit())
}
