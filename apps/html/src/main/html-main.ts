import { withPinnedAssetOutput, withSelectedUserOutput } from '@vantage/electron-utils/user-output-publication'
import { configureRecoveryProfile, initializeStandaloneRecovery, requireRecoveryRuntime } from '../../../../packages/electron-utils/src/recovery-bootstrap'
import {PublicationReadRegistry,observePublicationTarget,absentPublicationTarget} from '../../../../packages/electron-utils/src/document-publication'
import {NativeCloseAdmission} from '../../../../packages/electron-utils/src/native-close-admission'
import {HtmlPresentationClose} from './html-presentation-close'
import {discardDraftJournal} from '../../../../packages/electron-utils/src/draft-journal'
import {beginCloseCleanup} from '../../../../packages/electron-utils/src/close-cleanup-runtime'
import type {CloseCleanupHandle,CloseCleanupAdmission} from '../../../../packages/electron-utils/src/close-cleanup'
import {HtmlPreviewSnapshots,type HtmlPreviewFrame} from './html-preview-snapshots'
import { HtmlCloseCoordinator,runHtmlNativeClose,htmlClosePermit,type HtmlClosePrepareOptions } from './html-close-lease'
import type { HtmlAssetCleanupReport,HtmlCloseReceipt,HtmlNativeCloseReceipt } from '../shared/html-close-lease'
import type { CloseLeaseTicket, CloseLeaseStamp } from '../../../../packages/electron-utils/src/close-lease'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  webContents,
} from 'electron'
import type { WebContents } from 'electron'
import {
  configuredDefaultSaveDir,
  contextMenuLabels,
  fetchRemoteImage,
  installContextMenu,
  installNavigationGuard,
  isHeadlessMode,
  safeExternalUrl,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  type HeadlessExportFormat,
  type HeadlessExportTarget,
  installRendererProtocol,
  rendererUrl,
  MAX_REMOTE_IMAGE_BYTES,
  readBodyCapped,
  printHtmlDocument,
  type PrintDialogOutcome,
} from '@vantage/electron-utils'
import { createI18n, getUiLang } from '@vantage/i18n'
import { generateImageTool, documentMediaRoots } from '@vantage/ai-search'
import { parseFileToText } from '@vantage/file-parse'
import { convertHtmlToDocx } from '../../../../packages/html2docx/src'
import { atomicWriteFile } from './atomic-write'
import { HtmlDraftController } from './html-draft-controller'
import { readHtmlReloadSource } from './html-reload-read'
import { HtmlDraftMaterializer } from './html-draft-isolated'
import type { HtmlDraftAssetGrant } from './html-draft-assets'
import {
  createDocumentDiskWatcher,
  type DocumentDiskWatcher,
} from '@vantage/electron-utils/disk-watch'
import { ElectronBrowserDriver } from '../../../../packages/html2docx/src/drivers/electron'
import {
  copyImageIntoOwnedAssets,
  extractHtmlAssetReferences,
  isInDocDir,
  pendingOwnedAssetsForDocument,
  prepareAssetsForSaveAs,
  reconcileOwnedAssets,
  renameOwnedAssetDocument,
  resolveSafeRelativeImagePath,
  resolveSourcePendingAfterSaveAs,
  rollbackPreparedSaveAsAssets,
  writeImageIntoOwnedAssets,
} from './asset-lifecycle'
import {
  ASSET_SNIFF_BYTES,
  PREVIEW_ASSET_EXTS,
  editableImageMime,
  extensionlessAssetMime,
} from './asset-mime'
import { buildPreviewDocument } from './preview-document'
import { inlineImagesForSingleFile, singleFileExportBaseName } from './single-file-html'
import { registerHtmlAiSearchIpc } from './ai-search-ipc'
import {
  assetBaseHref,
  previewUrlFor,
  registerPrivilegedSchemes,
  registerPreviewProtocol,
} from './preview-protocol'
import { ATTACHMENT_IMAGE_EXTS, HTML_CHANNELS } from '../shared/ipc'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  ExportDocxRequest,
  ExportHtmlRequest,
  ExportFormat,
  ExportPdfRequest,
  ExportResult,
  ImageData,
  PrintHtmlRequest,
  PrintResult,
  SaveHtmlRequest,
  SaveHtmlResult,
  SaveMode,
} from '../shared/ipc'

const tDlg = createI18n({
  zh: {
    dlgSaveTitle: '保存 HTML 文档',
    filterHtml: 'HTML 文档',
    dlgPickImage: '选择图片',
    filterImages: '图片',
    untitledFile: '未命名文档',
    closeUnsavedMsg: '此文档有未保存的更改。',
    closeUnsavedDetail: '关闭前是否保存？',
    btnSave: '保存',
    btnDontSave: '不保存',
    btnCancel: '取消',
    dlgAddAttachment: '添加附件',
    filterSupported: '支持的文件',
    filterAll: '所有文件',
    errUnsupportedExt: '暂不支持 .{ext} 类型',
    errNotFile: '不是文件',
    errTooLarge: '超过 {mb}MB 上限',
    errImageTooLarge: '图片超过 5MB 上限',
    errUnreadable: '无法读取',
    errFileTooLarge: '文件超过大小上限',
    errParseFailed: '文件解析失败',
    errImageNoText: '图片附件不提供文本,已作为图像随用户消息发送,直接看图即可',
    errNotImage: '不是支持的图片类型',
  },
  en: {
    dlgSaveTitle: 'Save HTML Document',
    filterHtml: 'HTML Documents',
    dlgPickImage: 'Choose an Image',
    filterImages: 'Images',
    untitledFile: 'Untitled',
    closeUnsavedMsg: 'This document has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
    dlgAddAttachment: 'Add Attachments',
    filterSupported: 'Supported Files',
    filterAll: 'All Files',
    errUnsupportedExt: '.{ext} files are not supported',
    errNotFile: 'not a file',
    errTooLarge: 'exceeds the {mb}MB limit',
    errImageTooLarge: 'image exceeds the 5MB limit',
    errUnreadable: 'cannot be read',
    errFileTooLarge: 'File exceeds the size limit',
    errParseFailed: 'Failed to parse file',
    errImageNoText: 'Image attachments have no text; the image is sent along with the user message',
    errNotImage: 'not a supported image type',
  },
  vi: {
    dlgSaveTitle: 'Lưu tài liệu HTML',
    filterHtml: 'Tài liệu HTML',
    dlgPickImage: 'Chọn một hình ảnh',
    filterImages: 'Hình ảnh',
    untitledFile: 'Không có tiêu đề',
    closeUnsavedMsg: 'Tài liệu này có những thay đổi chưa được lưu.',
    closeUnsavedDetail: 'Bạn có muốn lưu các thay đổi trước khi đóng không?',
    btnSave: 'Lưu',
    btnDontSave: 'Không lưu',
    btnCancel: 'Hủy',
    dlgAddAttachment: 'Thêm tệp đính kèm',
    filterSupported: 'Các tệp được hỗ trợ',
    filterAll: 'Tất cả các tệp',
    errUnsupportedExt: 'Tệp .{ext} không được hỗ trợ',
    errNotFile: 'không phải là tệp',
    errTooLarge: 'vượt quá giới hạn {mb}MB',
    errImageTooLarge: 'hình ảnh vượt quá giới hạn 5MB',
    errUnreadable: 'không thể đọc được',
    errFileTooLarge: 'Tệp vượt quá giới hạn kích thước',
    errParseFailed: 'Không thể phân tích tệp',
    errImageNoText:
      'Tệp đính kèm hình ảnh không có văn bản; hình ảnh được gửi cùng với tin nhắn của người dùng',
    errNotImage: 'loại hình ảnh không được hỗ trợ',
  },
  tr: {
    dlgSaveTitle: 'HTML belgesini kaydet',
    filterHtml: 'HTML belgeleri',
    dlgPickImage: 'Bir görsel seçin',
    filterImages: 'Görseller',
    untitledFile: 'Adsız',
    closeUnsavedMsg: 'Bu belge kaydedilmemiş değişiklikler içeriyor.',
    closeUnsavedDetail: 'Kapatmadan önce değişiklikleri kaydetmek istiyor musunuz?',
    btnSave: 'Kaydet',
    btnDontSave: 'Kaydetme',
    btnCancel: 'İptal',
    dlgAddAttachment: 'Ek dosya ekle',
    filterSupported: 'Desteklenen dosyalar',
    filterAll: 'Tüm dosyalar',
    errUnsupportedExt: '.{ext} dosyaları desteklenmiyor',
    errNotFile: 'bir dosya değil',
    errTooLarge: '{mb}MB sınırını aşıyor',
    errImageTooLarge: 'görsel 5MB sınırını aşıyor',
    errUnreadable: 'okunamıyor',
    errFileTooLarge: 'Dosya boyut sınırını aşıyor',
    errParseFailed: 'Dosya ayrıştırılamadı',
    errImageNoText:
      'Görsel ekleri metin sağlamaz; görsel kullanıcının mesajıyla birlikte gönderilir',
    errNotImage: 'desteklenmeyen görsel türü',
  },
  ja: {
    dlgSaveTitle: 'HTML ドキュメントを保存',
    filterHtml: 'HTML ドキュメント',
    dlgPickImage: '画像を選択',
    filterImages: '画像',
    untitledFile: '無題',
    closeUnsavedMsg: 'このドキュメントに未保存の変更があります。',
    closeUnsavedDetail: '閉じる前に保存しますか？',
    btnSave: '保存',
    btnDontSave: '保存しない',
    btnCancel: 'キャンセル',
    dlgAddAttachment: '添付ファイルの追加',
    filterSupported: 'サポートされているファイル',
    filterAll: 'すべてのファイル',
    errUnsupportedExt: '.{ext} 形式には対応していません',
    errNotFile: 'ファイルではありません',
    errTooLarge: '{mb}MB の上限を超えています',
    errImageTooLarge: '画像が 5MB の上限を超えています',
    errUnreadable: '読み取れません',
    errFileTooLarge: 'ファイルがサイズ上限を超えています',
    errParseFailed: 'ファイルの解析に失敗しました',
    errImageNoText:
      '画像の添付ファイルはテキストを提供しません。画像としてユーザーメッセージと一緒に送信されるため、そのまま画像をご確認ください',
    errNotImage: 'サポートされていない画像形式です',
  },
  ko: {
    dlgSaveTitle: 'HTML 문서 저장',
    filterHtml: 'HTML 문서',
    dlgPickImage: '이미지 선택',
    filterImages: '이미지',
    untitledFile: '제목 없음',
    closeUnsavedMsg: '이 문서에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
    dlgAddAttachment: '첨부 파일 추가',
    filterSupported: '지원되는 파일',
    filterAll: '모든 파일',
    errUnsupportedExt: '.{ext} 형식은 지원되지 않습니다',
    errNotFile: '파일이 아닙니다',
    errTooLarge: '{mb}MB 제한을 초과했습니다',
    errImageTooLarge: '이미지가 5MB 제한을 초과했습니다',
    errUnreadable: '읽을 수 없습니다',
    errFileTooLarge: '파일이 크기 제한을 초과했습니다',
    errParseFailed: '파일을 분석하지 못했습니다',
    errImageNoText:
      '이미지 첨부 파일은 텍스트를 제공하지 않으며, 이미지 형태로 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하면 됩니다',
    errNotImage: '지원되지 않는 이미지 형식입니다',
  },
  fr: {
    dlgSaveTitle: 'Enregistrer le document HTML',
    filterHtml: 'Documents HTML',
    dlgPickImage: 'Choisir une image',
    filterImages: 'Images',
    untitledFile: 'Sans titre',
    closeUnsavedMsg: 'Ce document contient des modifications non enregistrées.',
    closeUnsavedDetail: 'Voulez-vous les enregistrer avant de fermer ?',
    btnSave: 'Enregistrer',
    btnDontSave: 'Ne pas enregistrer',
    btnCancel: 'Annuler',
    dlgAddAttachment: 'Ajouter des pièces jointes',
    filterSupported: 'Fichiers pris en charge',
    filterAll: 'Tous les fichiers',
    errUnsupportedExt: 'les fichiers .{ext} ne sont pas pris en charge',
    errNotFile: "n'est pas un fichier",
    errTooLarge: 'dépasse la limite de {mb} Mo',
    errImageTooLarge: "l'image dépasse la limite de 5 Mo",
    errUnreadable: 'lecture impossible',
    errFileTooLarge: 'Le fichier dépasse la taille maximale',
    errParseFailed: "Échec de l'analyse du fichier",
    errImageNoText:
      "Les pièces jointes image ne fournissent pas de texte ; l'image est envoyée avec le message de l'utilisateur, consultez-la directement",
    errNotImage: "type d'image non pris en charge",
  },
  de: {
    dlgSaveTitle: 'HTML-Dokument speichern',
    filterHtml: 'HTML-Dokumente',
    dlgPickImage: 'Bild auswählen',
    filterImages: 'Bilder',
    untitledFile: 'Unbenannt',
    closeUnsavedMsg: 'Dieses Dokument enthält ungespeicherte Änderungen.',
    closeUnsavedDetail: 'Vor dem Schließen speichern?',
    btnSave: 'Speichern',
    btnDontSave: 'Nicht speichern',
    btnCancel: 'Abbrechen',
    dlgAddAttachment: 'Anlagen hinzufügen',
    filterSupported: 'Unterstützte Dateien',
    filterAll: 'Alle Dateien',
    errUnsupportedExt: '.{ext}-Dateien werden nicht unterstützt',
    errNotFile: 'keine Datei',
    errTooLarge: 'überschreitet das Limit von {mb} MB',
    errImageTooLarge: 'Bild überschreitet das Limit von 5 MB',
    errUnreadable: 'kann nicht gelesen werden',
    errFileTooLarge: 'Datei überschreitet die maximale Größe',
    errParseFailed: 'Datei konnte nicht analysiert werden',
    errImageNoText:
      'Bildanlagen liefern keinen Text; das Bild wird mit der Benutzernachricht gesendet und kann direkt betrachtet werden',
    errNotImage: 'kein unterstütztes Bildformat',
  },
  es: {
    dlgSaveTitle: 'Guardar documento HTML',
    filterHtml: 'Documentos HTML',
    dlgPickImage: 'Elegir imagen',
    filterImages: 'Imágenes',
    untitledFile: 'Sin título',
    closeUnsavedMsg: 'Este documento tiene cambios sin guardar.',
    closeUnsavedDetail: '¿Quieres guardarlos antes de cerrar?',
    btnSave: 'Guardar',
    btnDontSave: 'No guardar',
    btnCancel: 'Cancelar',
    dlgAddAttachment: 'Agregar datos adjuntos',
    filterSupported: 'Archivos compatibles',
    filterAll: 'Todos los archivos',
    errUnsupportedExt: 'los archivos .{ext} no son compatibles',
    errNotFile: 'no es un archivo',
    errTooLarge: 'supera el límite de {mb} MB',
    errImageTooLarge: 'la imagen supera el límite de 5 MB',
    errUnreadable: 'no se puede leer',
    errFileTooLarge: 'El archivo supera el tamaño máximo',
    errParseFailed: 'No se pudo analizar el archivo',
    errImageNoText:
      'Las imágenes adjuntas no proporcionan texto; la imagen se envía junto con el mensaje del usuario, puedes verla directamente',
    errNotImage: 'no es un tipo de imagen compatible',
  },
  th: {
    dlgSaveTitle: 'บันทึกเอกสาร HTML',
    filterHtml: 'เอกสาร HTML',
    dlgPickImage: 'เลือกรูปภาพ',
    filterImages: 'รูปภาพ',
    untitledFile: 'ไม่มีชื่อ',
    closeUnsavedMsg: 'เอกสารนี้มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก',
    closeUnsavedDetail: 'ต้องการบันทึกก่อนปิดหรือไม่?',
    btnSave: 'บันทึก',
    btnDontSave: 'ไม่บันทึก',
    btnCancel: 'ยกเลิก',
    dlgAddAttachment: 'เพิ่มสิ่งที่แนบ',
    filterSupported: 'ไฟล์ที่รองรับ',
    filterAll: 'ไฟล์ทั้งหมด',
    errUnsupportedExt: 'ไม่รองรับไฟล์ .{ext}',
    errNotFile: 'ไม่ใช่ไฟล์',
    errTooLarge: 'เกินขีดจำกัด {mb}MB',
    errImageTooLarge: 'รูปภาพเกินขีดจำกัด 5MB',
    errUnreadable: 'ไม่สามารถอ่านได้',
    errFileTooLarge: 'ไฟล์เกินขนาดสูงสุด',
    errParseFailed: 'แยกวิเคราะห์ไฟล์ไม่สำเร็จ',
    errImageNoText:
      'สิ่งที่แนบเป็นรูปภาพไม่มีข้อความ รูปจะถูกส่งไปพร้อมข้อความของผู้ใช้ ดูรูปได้โดยตรง',
    errNotImage: 'ไม่ใช่ชนิดรูปภาพที่รองรับ',
  },
  id: {
    dlgSaveTitle: 'Simpan dokumen HTML',
    filterHtml: 'Dokumen HTML',
    dlgPickImage: 'Pilih gambar',
    filterImages: 'Gambar',
    untitledFile: 'Tanpa judul',
    closeUnsavedMsg: 'Dokumen ini memiliki perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
    dlgAddAttachment: 'Tambahkan Lampiran',
    filterSupported: 'File yang Didukung',
    filterAll: 'Semua File',
    errUnsupportedExt: 'file .{ext} tidak didukung',
    errNotFile: 'bukan file',
    errTooLarge: 'melebihi batas {mb}MB',
    errImageTooLarge: 'gambar melebihi batas 5MB',
    errUnreadable: 'tidak dapat dibaca',
    errFileTooLarge: 'File melebihi batas ukuran',
    errParseFailed: 'Gagal mengurai file',
    errImageNoText:
      'Lampiran gambar tidak menyediakan teks; gambar dikirim bersama pesan pengguna dan dapat dilihat langsung',
    errNotImage: 'bukan jenis gambar yang didukung',
  },
  ru: {
    dlgSaveTitle: 'Сохранить документ HTML',
    filterHtml: 'Документы HTML',
    dlgPickImage: 'Выберите изображение',
    filterImages: 'Изображения',
    untitledFile: 'Без названия',
    closeUnsavedMsg: 'В этом документе есть несохранённые изменения.',
    closeUnsavedDetail: 'Сохранить их перед закрытием?',
    btnSave: 'Сохранить',
    btnDontSave: 'Не сохранять',
    btnCancel: 'Отмена',
    dlgAddAttachment: 'Добавить вложения',
    filterSupported: 'Поддерживаемые файлы',
    filterAll: 'Все файлы',
    errUnsupportedExt: 'файлы .{ext} не поддерживаются',
    errNotFile: 'не является файлом',
    errTooLarge: 'превышает лимит {mb} МБ',
    errImageTooLarge: 'изображение превышает лимит 5 МБ',
    errUnreadable: 'не удается прочитать',
    errFileTooLarge: 'Файл превышает максимальный размер',
    errParseFailed: 'Не удалось разобрать файл',
    errImageNoText:
      'Вложенные изображения не содержат текста; изображение отправляется вместе с сообщением пользователя, смотрите его напрямую',
    errNotImage: 'неподдерживаемый тип изображения',
  },
  ar: {
    dlgSaveTitle: 'حفظ مستند HTML',
    filterHtml: 'مستندات HTML',
    dlgPickImage: 'اختر صورة',
    filterImages: 'صور',
    untitledFile: 'بدون عنوان',
    closeUnsavedMsg: 'يحتوي هذا المستند على تغييرات غير محفوظة.',
    closeUnsavedDetail: 'هل تريد حفظها قبل الإغلاق؟',
    btnSave: 'حفظ',
    btnDontSave: 'عدم الحفظ',
    btnCancel: 'إلغاء',
    dlgAddAttachment: 'إضافة مرفقات',
    filterSupported: 'الملفات المدعومة',
    filterAll: 'كل الملفات',
    errUnsupportedExt: 'ملفات .{ext} غير مدعومة',
    errNotFile: 'ليس ملفًا',
    errTooLarge: 'يتجاوز الحد {mb}MB',
    errImageTooLarge: 'الصورة تتجاوز حد 5MB',
    errUnreadable: 'تعذرت القراءة',
    errFileTooLarge: 'الملف يتجاوز الحد الأقصى للحجم',
    errParseFailed: 'فشل تحليل الملف',
    errImageNoText:
      'مرفقات الصور لا توفر نصًا؛ تُرسل الصورة مع رسالة المستخدم ويمكن الاطلاع عليها مباشرة',
    errNotImage: 'ليس نوع صورة مدعومًا',
  },
  pt: {
    dlgSaveTitle: 'Salvar documento HTML',
    filterHtml: 'Documentos HTML',
    dlgPickImage: 'Escolher imagem',
    filterImages: 'Imagens',
    untitledFile: 'Sem título',
    closeUnsavedMsg: 'Este documento tem alterações não salvas.',
    closeUnsavedDetail: 'Deseja salvá-las antes de fechar?',
    btnSave: 'Salvar',
    btnDontSave: 'Não Salvar',
    btnCancel: 'Cancelar',
    dlgAddAttachment: 'Adicionar Anexos',
    filterSupported: 'Arquivos Compatíveis',
    filterAll: 'Todos os Arquivos',
    errUnsupportedExt: 'arquivos .{ext} não são suportados',
    errNotFile: 'não é um arquivo',
    errTooLarge: 'excede o limite de {mb}MB',
    errImageTooLarge: 'a imagem excede o limite de 5MB',
    errUnreadable: 'não é possível ler',
    errFileTooLarge: 'O arquivo excede o limite de tamanho',
    errParseFailed: 'Falha ao analisar o arquivo',
    errImageNoText:
      'Anexos de imagem não fornecem texto; a imagem é enviada junto com a mensagem do usuário, basta vê-la diretamente',
    errNotImage: 'não é um tipo de imagem suportado',
  },
  it: {
    dlgSaveTitle: 'Salva documento HTML',
    filterHtml: 'Documenti HTML',
    dlgPickImage: 'Scegli immagine',
    filterImages: 'Immagini',
    untitledFile: 'Senza titolo',
    closeUnsavedMsg: 'Questo documento contiene modifiche non salvate.',
    closeUnsavedDetail: 'Vuoi salvarle prima di chiudere?',
    btnSave: 'Salva',
    btnDontSave: 'Non salvare',
    btnCancel: 'Annulla',
    dlgAddAttachment: 'Aggiungi allegati',
    filterSupported: 'File supportati',
    filterAll: 'Tutti i file',
    errUnsupportedExt: 'i file .{ext} non sono supportati',
    errNotFile: 'non è un file',
    errTooLarge: 'supera il limite di {mb} MB',
    errImageTooLarge: "l'immagine supera il limite di 5 MB",
    errUnreadable: 'impossibile leggere',
    errFileTooLarge: 'Il file supera il limite di dimensione',
    errParseFailed: 'Impossibile analizzare il file',
    errImageNoText:
      "Gli allegati immagine non forniscono testo; l'immagine viene inviata insieme al messaggio dell'utente, basta guardarla direttamente",
    errNotImage: 'tipo di immagine non supportato',
  },
  pl: {
    dlgSaveTitle: 'Zapisz dokument HTML',
    filterHtml: 'Dokumenty HTML',
    dlgPickImage: 'Wybierz obraz',
    filterImages: 'Obrazy',
    untitledFile: 'Bez tytułu',
    closeUnsavedMsg: 'Ten dokument ma niezapisane zmiany.',
    closeUnsavedDetail: 'Czy zapisać je przed zamknięciem?',
    btnSave: 'Zapisz',
    btnDontSave: 'Nie zapisuj',
    btnCancel: 'Anuluj',
    dlgAddAttachment: 'Dodaj załączniki',
    filterSupported: 'Obsługiwane pliki',
    filterAll: 'Wszystkie pliki',
    errUnsupportedExt: 'pliki .{ext} nie są obsługiwane',
    errNotFile: 'to nie jest plik',
    errTooLarge: 'przekracza limit {mb} MB',
    errImageTooLarge: 'obraz przekracza limit 5 MB',
    errUnreadable: 'nie można odczytać',
    errFileTooLarge: 'Plik przekracza limit rozmiaru',
    errParseFailed: 'Nie udało się przeanalizować pliku',
    errImageNoText:
      'Załączniki graficzne nie zawierają tekstu; obraz jest wysyłany razem z wiadomością użytkownika, wystarczy na niego spojrzeć',
    errNotImage: 'nieobsługiwany typ obrazu',
  },
  cs: {
    dlgSaveTitle: 'Uložit dokument HTML',
    filterHtml: 'Dokumenty HTML',
    dlgPickImage: 'Vyberte obrázek',
    filterImages: 'Obrázky',
    untitledFile: 'Bez názvu',
    closeUnsavedMsg: 'Tento dokument obsahuje neuložené změny.',
    closeUnsavedDetail: 'Chcete je před zavřením uložit?',
    btnSave: 'Uložit',
    btnDontSave: 'Neukládat',
    btnCancel: 'Zrušit',
    dlgAddAttachment: 'Přidat přílohy',
    filterSupported: 'Podporované soubory',
    filterAll: 'Všechny soubory',
    errUnsupportedExt: 'soubory .{ext} nejsou podporovány',
    errNotFile: 'není soubor',
    errTooLarge: 'překračuje limit {mb} MB',
    errImageTooLarge: 'obrázek překračuje limit 5 MB',
    errUnreadable: 'nelze přečíst',
    errFileTooLarge: 'Soubor překračuje limit velikosti',
    errParseFailed: 'Soubor se nepodařilo zpracovat',
    errImageNoText:
      'Obrázkové přílohy neobsahují text; obrázek se odesílá spolu se zprávou uživatele',
    errNotImage: 'nepodporovaný typ obrázku',
  },
  nl: {
    dlgSaveTitle: 'HTML-document opslaan',
    filterHtml: 'HTML-documenten',
    dlgPickImage: 'Kies een afbeelding',
    filterImages: 'Afbeeldingen',
    untitledFile: 'Naamloos',
    closeUnsavedMsg: 'Dit document bevat niet-opgeslagen wijzigingen.',
    closeUnsavedDetail: 'Wilt u ze opslaan voordat u sluit?',
    btnSave: 'Opslaan',
    btnDontSave: 'Niet opslaan',
    btnCancel: 'Annuleren',
    dlgAddAttachment: 'Bijlagen toevoegen',
    filterSupported: 'Ondersteunde bestanden',
    filterAll: 'Alle bestanden',
    errUnsupportedExt: '.{ext}-bestanden worden niet ondersteund',
    errNotFile: 'geen bestand',
    errTooLarge: 'overschrijdt de limiet van {mb} MB',
    errImageTooLarge: 'afbeelding overschrijdt de limiet van 5 MB',
    errUnreadable: 'kan niet worden gelezen',
    errFileTooLarge: 'Bestand overschrijdt de maximale grootte',
    errParseFailed: 'Kan bestand niet parseren',
    errImageNoText:
      'Afbeeldingsbijlagen bevatten geen tekst; de afbeelding wordt samen met het gebruikersbericht verzonden en kan direct worden bekeken',
    errNotImage: 'geen ondersteund afbeeldingstype',
  },
  ms: {
    dlgSaveTitle: 'Simpan dokumen HTML',
    filterHtml: 'Dokumen HTML',
    dlgPickImage: 'Pilih imej',
    filterImages: 'Imej',
    untitledFile: 'Tanpa tajuk',
    closeUnsavedMsg: 'Dokumen ini mempunyai perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
    dlgAddAttachment: 'Tambah Lampiran',
    filterSupported: 'Fail yang Disokong',
    filterAll: 'Semua Fail',
    errUnsupportedExt: 'fail .{ext} tidak disokong',
    errNotFile: 'bukan fail',
    errTooLarge: 'melebihi had {mb}MB',
    errImageTooLarge: 'imej melebihi had 5MB',
    errUnreadable: 'tidak dapat dibaca',
    errFileTooLarge: 'Fail melebihi had saiz',
    errParseFailed: 'Gagal menghurai fail',
    errImageNoText:
      'Lampiran imej tidak menyediakan teks; imej dihantar bersama mesej pengguna dan boleh dilihat terus',
    errNotImage: 'bukan jenis imej yang disokong',
  },
  he: {
    dlgSaveTitle: 'שמירת מסמך HTML',
    filterHtml: 'מסמכי HTML',
    dlgPickImage: 'בחרו תמונה',
    filterImages: 'תמונות',
    untitledFile: 'ללא שם',
    closeUnsavedMsg: 'במסמך הזה יש שינויים שלא נשמרו.',
    closeUnsavedDetail: 'האם לשמור אותם לפני הסגירה?',
    btnSave: 'שמירה',
    btnDontSave: 'אל תשמור',
    btnCancel: 'ביטול',
    dlgAddAttachment: 'הוספת קבצים מצורפים',
    filterSupported: 'קבצים נתמכים',
    filterAll: 'כל הקבצים',
    errUnsupportedExt: 'קובצי .{ext} אינם נתמכים',
    errNotFile: 'אינו קובץ',
    errTooLarge: 'חורג מהמגבלה של {mb}MB',
    errImageTooLarge: 'התמונה חורגת מהמגבלה של 5MB',
    errUnreadable: 'לא ניתן לקרוא',
    errFileTooLarge: 'הקובץ חורג ממגבלת הגודל',
    errParseFailed: 'ניתוח הקובץ נכשל',
    errImageNoText:
      'קבצים מצורפים מסוג תמונה אינם מספקים טקסט; התמונה נשלחת יחד עם הודעת המשתמש וניתן לצפות בה ישירות',
    errNotImage: 'סוג תמונה שאינו נתמך',
  },
  hi: {
    dlgSaveTitle: 'HTML दस्तावेज़ सहेजें',
    filterHtml: 'HTML दस्तावेज़',
    dlgPickImage: 'छवि चुनें',
    filterImages: 'छवियाँ',
    untitledFile: 'शीर्षकहीन',
    closeUnsavedMsg: 'इस दस्तावेज़ में सहेजे नहीं गए परिवर्तन हैं।',
    closeUnsavedDetail: 'क्या बंद करने से पहले उन्हें सहेजना चाहते हैं?',
    btnSave: 'सहेजें',
    btnDontSave: 'न सहेजें',
    btnCancel: 'रद्द करें',
    dlgAddAttachment: 'अनुलग्नक जोड़ें',
    filterSupported: 'समर्थित फ़ाइलें',
    filterAll: 'सभी फ़ाइलें',
    errUnsupportedExt: '.{ext} फ़ाइलें समर्थित नहीं हैं',
    errNotFile: 'फ़ाइल नहीं है',
    errTooLarge: '{mb}MB की सीमा से अधिक है',
    errImageTooLarge: 'छवि 5MB की सीमा से अधिक है',
    errUnreadable: 'पढ़ा नहीं जा सकता',
    errFileTooLarge: 'फ़ाइल आकार सीमा से अधिक है',
    errParseFailed: 'फ़ाइल पार्स करने में विफल',
    errImageNoText:
      'छवि अनुलग्नक टेक्स्ट प्रदान नहीं करते; छवि उपयोगकर्ता संदेश के साथ भेजी जाती है, उसे सीधे देखें',
    errNotImage: 'समर्थित छवि प्रकार नहीं है',
  },
  'zh-TW': {
    dlgSaveTitle: '儲存 HTML 文件',
    filterHtml: 'HTML 文件',
    dlgPickImage: '選擇圖片',
    filterImages: '圖片',
    untitledFile: '未命名文件',
    closeUnsavedMsg: '此文件有未儲存的變更。',
    closeUnsavedDetail: '關閉前是否儲存？',
    btnSave: '儲存',
    btnDontSave: '不儲存',
    btnCancel: '取消',
    dlgAddAttachment: '新增附件',
    filterSupported: '支援的檔案',
    filterAll: '所有檔案',
    errUnsupportedExt: '暫不支援 .{ext} 類型',
    errNotFile: '不是檔案',
    errTooLarge: '超過 {mb}MB 上限',
    errImageTooLarge: '圖片超過 5MB 上限',
    errUnreadable: '無法讀取',
    errFileTooLarge: '檔案超過大小上限',
    errParseFailed: '檔案解析失敗',
    errImageNoText: '圖片附件不提供文字,已作為影像隨使用者訊息傳送,直接看圖即可',
    errNotImage: '不是支援的圖片類型',
  },
})
type DlgKey =
  | 'dlgSaveTitle'
  | 'filterHtml'
  | 'dlgPickImage'
  | 'filterImages'
  | 'untitledFile'
  | 'closeUnsavedMsg'
  | 'closeUnsavedDetail'
  | 'btnSave'
  | 'btnDontSave'
  | 'btnCancel'
  | 'dlgAddAttachment'
  | 'filterSupported'
  | 'filterAll'
  | 'errUnsupportedExt'
  | 'errNotFile'
  | 'errTooLarge'
  | 'errImageTooLarge'
  | 'errUnreadable'
  | 'errFileTooLarge'
  | 'errParseFailed'
  | 'errImageNoText'
  | 'errNotImage'
const tm = (key: DlgKey, vars?: Record<string, string | number>) => tDlg(getUiLang(), key, vars)

// ---- chat attachments: local files parsed for the agent (same contract as the docs panel) ----

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'go',
  'rs',
  'rb',
  'sh',
  'sql',
  'css',
])
/** office/pdf formats get text extracted via @vantage/file-parse; images skip extraction and go multimodal */
const ATTACHMENT_EXTS = new Set([
  ...TEXT_EXTS,
  'doc',
  'docx',
  'pdf',
  'pptx',
  'ppt',
  'xlsx',
  'xlsm',
  'xls',
  ...ATTACHMENT_IMAGE_EXTS,
])
const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** extracted text cache keyed by path; invalidated by mtime+size */
const attachmentTextCache = new Map<string, { stamp: string; text: string }>()

function statAttachment(filePath: string): { meta?: AttachmentMeta; error?: string } {
  const name = basename(filePath)
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (!ATTACHMENT_EXTS.has(ext)) return { error: `${name}: ${tm('errUnsupportedExt', { ext })}` }
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return { error: `${name}: ${tm('errNotFile')}` }
    if (stat.size > ATTACHMENT_MAX_BYTES) {
      return {
        error: `${name}: ${tm('errTooLarge', { mb: Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024) })}`,
      }
    }
    if (ATTACHMENT_IMAGE_EXTS.has(ext) && stat.size > ATTACHMENT_IMAGE_MAX_BYTES) {
      return { error: `${name}: ${tm('errImageTooLarge')}` }
    }
    return { meta: { path: filePath, name, ext, sizeBytes: stat.size } }
  } catch {
    return { error: `${name}: ${tm('errUnreadable')}` }
  }
}

function collectAttachments(paths: string[]): AttachmentAddResult {
  const accepted: AttachmentMeta[] = []
  const rejected: string[] = []
  for (const p of paths) {
    const { meta, error } = statAttachment(p)
    if (meta) accepted.push(meta)
    else if (error) rejected.push(error)
  }
  return { accepted, rejected }
}

let pastedImageSeq = 0
let pastedDirPruned = false

/** drop pasted-image temp files older than 7 days (once per app run) */
function prunePastedImages(dir: string): void {
  if (pastedDirPruned) return
  pastedDirPruned = true
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {
        // another tab may have removed it already
      }
    }
  } catch {
    // directory may not exist yet
  }
}

/** clipboard-pasted image bytes → temp file (shared with the docs panel), null for non-images or empty data */
function savePastedImage(data: unknown, ext: unknown): string | null {
  const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : ''
  if (!ATTACHMENT_IMAGE_EXTS.has(cleanExt)) return null
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null
  if (!bytes || bytes.byteLength === 0) return null
  const dir = join(app.getPath('temp'), 'vantage-pasted')
  mkdirSync(dir, { recursive: true })
  prunePastedImages(dir)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const filePath = join(dir, `pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`)
  writeFileSync(filePath, bytes)
  return filePath
}

async function extractAttachmentText(filePath: string): Promise<string> {
  const stat = statSync(filePath)
  const stamp = `${stat.mtimeMs}:${stat.size}`
  const cached = attachmentTextCache.get(filePath)
  if (cached && cached.stamp === stamp) return cached.text
  if (stat.size > ATTACHMENT_MAX_BYTES) throw new Error(tm('errFileTooLarge'))
  const parsed = await parseFileToText(filePath)
  if (!parsed.ok || parsed.kind !== 'text' || parsed.text == null) {
    throw new Error(parsed.error ?? tm('errParseFailed'))
  }
  attachmentTextCache.set(filePath, { stamp, text: parsed.text })
  if (attachmentTextCache.size > 8) {
    const oldest = attachmentTextCache.keys().next().value
    if (oldest) attachmentTextCache.delete(oldest)
  }
  return parsed.text
}

interface RuntimePaths {
  preloadPath: string
  rendererUrl?: string
  rendererFile?: string
  /** Shell router used to open exported PDFs in a new Vantage tab. */
  openGeneratedPath?: (path: string) => boolean
}

let runtime: RuntimePaths = { preloadPath: '' }

export function configureHtmlRuntime(paths: RuntimePaths): void {
  runtime = paths
}

export { registerPrivilegedSchemes }

/** After a successful Html → PDF export: open the file in a PDF tab (shell)
 * or reveal it in the folder (standalone). Tab-opening failure must not
 * report the export itself as failed — the file is already persisted. */
function openExportedPdf(path: string): void {
  // Headless export must stay silent: no tab, no Finder window.
  if (isHeadlessMode()) return
  try {
    if (runtime.openGeneratedPath?.(path)) return
  } catch (err) {
    console.warn('[html] Failed to open exported PDF:', err)
  }
  shell.showItemInFolder(path)
}

/** Open path per view, queued at tab creation; the renderer consumes it after mount.
 * Kept until the view is destroyed so a reload (View > Reload) consumes it again. */
const openPathByWc = new Map<number, string>()
/** File paths granted to each view — readFile/save only allow these */
const allowedByWc = new Map<number, Set<string>>()
/** Current save target per view; absent = untitled document */
const savePathByWc = new Map<number, string>()
const diskWatcherByWc = new Map<number, DocumentDiskWatcher>()
const publicationReads=new PublicationReadRegistry<number>()
/** Unsaved-changes flags mirrored from the renderer; drives the save prompt before closing a tab/window */
const dirtyByWc = new Set<number>()
/** Latest buffer text pushed by each renderer; served by html-preview:// to the preview iframe */
const previewTextByWc = new Map<number, string>()
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
/** Resolvers for menu-triggered saves, resolved when the renderer's save invoke completes */
const previewSnapshots=new HtmlPreviewSnapshots({urlFor:previewUrlFor})
function currentTopSender(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent):boolean{return !event.sender.isDestroyed()&&event.senderFrame===event.sender.mainFrame}
function htmlExportSourceProof(event:Electron.IpcMainInvokeEvent){
 const session=closeCoordinator.session(event.sender.id),source=closeCoordinator.source(event.sender.id),path=savePathByWc.get(event.sender.id)
 return{sourcePaths:path?[path]:[],assertCurrent:()=>{if(!currentTopSender(event)||closeCoordinator.session(event.sender.id)!==session||closeCoordinator.source(event.sender.id)!==source||savePathByWc.get(event.sender.id)!==path)throw new Error('The loaded HTML source changed before export publication')}}
}

function actualPreviewFrame(owner:number,name:string):HtmlPreviewFrame|null{
 const contents=webContents.fromId(owner);if(!contents||contents.isDestroyed())return null
 try{const matches=contents.mainFrame.frames.filter(frame=>!frame.detached&&frame.name===name);if(matches.length>1)throw new Error('The preview frame name is ambiguous.');if(!matches.length)return null;const frame=matches[0]!;return {name:frame.name,url:frame.url,processId:frame.processId,routingId:frame.routingId,frameTreeNodeId:frame.frameTreeNodeId,frameToken:frame.frameToken}}catch{return null}
}
function pinActualPreviewFrames(owner:number):void{try{const contents=webContents.fromId(owner);previewSnapshots.pinFrameUrls(owner,contents&&!contents.isDestroyed()?contents.mainFrame.frames.filter(frame=>!frame.detached).map(frame=>frame.url):[])}catch{previewSnapshots.pinFrameUrls(owner,[])}}
const htmlCleanup=new Map<number,Promise<void>>()
interface HtmlCloseCustody {owner:number;ticket:CloseLeaseTicket;receipt:HtmlCloseReceipt;handle?:CloseCleanupHandle;admission?:CloseCleanupAdmission;cancelProducer:()=>void;canceled:boolean;removed:boolean}
const htmlCustodyByTicket=new Map<string,HtmlCloseCustody>()
const htmlCustodyByReceipt=new WeakMap<HtmlCloseReceipt,HtmlCloseCustody>()
function updateHtmlCustody(record:HtmlCloseCustody):void{if(!record.handle)return;const status=record.handle.status();record.receipt.journalCleanup=status;if(record.receipt.cleanup)record.receipt.cleanup.journal=status.phase==='complete'?'complete':status.phase==='retained'?'retained':status.phase==='canceled'?'canceled':status.phase==='running'||status.phase==='committing'?'running':'staged'}
function cancelHtmlCustody(record:HtmlCloseCustody,reason:string):void{if(record.removed)return;record.canceled=true;record.admission?.cancel(reason);record.handle?.cancel(reason);record.cancelProducer();updateHtmlCustody(record);htmlCustodyByTicket.delete(record.ticket.id)}
function releaseHtmlCustody(owner:number,ticket:CloseLeaseTicket,reason:string):void{const record=htmlCustodyByTicket.get(ticket.id);if(!record||record.owner!==owner||record.ticket.sequence!==ticket.sequence||record.ticket.source!==ticket.source)return;if(!record.removed)cancelHtmlCustody(record,reason);else htmlCustodyByTicket.delete(ticket.id)}
const htmlDeferredRelease=new Map<number,Array<{ticket:CloseLeaseTicket;reason:string}>>()
const presentationCloses=new HtmlPresentationClose({alive:owner=>webContents.fromId(owner)?.isDestroyed()===false,sourceOwner:owner=>presentOwnerByWc.get(owner)})
const nativeCloseAdmission=new NativeCloseAdmission<number>()
const closeCoordinator=new HtmlCloseCoordinator({
  alive:owner=>allowedByWc.has(owner)&&!!webContents.fromId(owner)&&!webContents.fromId(owner)!.isDestroyed(),
  pathAllowed:(owner,path)=>allowedByWc.get(owner)?.has(path)===true,
  send:(owner,mode,request)=>webContents.fromId(owner)!.send(HTML_CHANNELS.saveRequest,mode,request.requestId,request.targetPath,request),
  validate:(owner,ticket,stamp,result)=>{try{const proof=result.previewProof?previewSnapshots.getProof(owner,result.previewProof):null;return !!proof&&previewSnapshots.ready(owner,ticket.id,result.previewProof,stamp,actualPreviewFrame(owner,proof.name))}catch{return false}},
  release:(owner,ticket,reason)=>{releaseHtmlCustody(owner,ticket,reason);previewSnapshots.release(owner,ticket.id);if(htmlCleanup.has(owner)){htmlDeferredRelease.set(owner,[...(htmlDeferredRelease.get(owner)??[]),{ticket,reason}]);return}const contents=webContents.fromId(owner);if(contents&&!contents.isDestroyed())contents.send(HTML_CHANNELS.closeLeaseRelease,ticket,reason)},
})
function assertNoHtmlCleanup(owner:number):void{if(htmlCleanup.has(owner))throw new Error('Approved HTML discard cleanup is still finishing; a new writer was not delivered.')}
function registerHtmlMutationHandle<Args extends unknown[],Result>(channel:string,handler:(event:Electron.IpcMainInvokeEvent,...args:Args)=>Result|Promise<Result>):void{
  ipcMain.handle(channel,async(event,...args:Args)=>{if(!currentTopSender(event))throw new Error('The source sender frame is obsolete.');assertNoHtmlCleanup(event.sender.id);const candidate=args[0] as {closeSource?:CloseLeaseStamp}|CloseLeaseStamp|undefined;const source=candidate&&typeof candidate==='object'&&'source'in candidate?candidate as CloseLeaseStamp:(candidate&&typeof candidate==='object'?candidate as {closeSource?:CloseLeaseStamp}:undefined)?.closeSource;const work=closeCoordinator.beginMutation(event.sender.id,undefined,source);try{return await handler(event,...args)}finally{closeCoordinator.finishMutation(work)}})
}
/** Resolvers for MCP reads of the live document source, resolved by the renderer's reply */
const readTextWaiters = new Map<number, (result: { text: string } | { error: string }) => void>()
/** one read per tab at a time: concurrent callers share this promise */
const readTextInFlight = new Map<number, Promise<string>>()

const htmlDraftMaterializer = new HtmlDraftMaterializer(join(__dirname, 'html-draft-worker.js'))
const htmlDraftGrants = new Map<number, HtmlDraftAssetGrant>()
const htmlDraftActivationIntent = new Map<number, number>()
async function htmlAssetGrant(documentPath: string | null): Promise<HtmlDraftAssetGrant> {
  const directory = documentPath ? dirname(documentPath) : null
  return {
    documentPath,
    directory,
    realDirectory: directory ? await realpath(directory) : null,
    files: [],
  }
}
const htmlDraftController = new HtmlDraftController({
  recoveryRoot: () => join(app.getPath('userData'), 'recovery'),
  isLive: (owner) =>
    allowedByWc.has(owner) &&
    !presentOwnerByWc.has(owner) &&
    !!webContents.fromId(owner) &&
    !webContents.fromId(owner)!.isDestroyed(),
  canWritePath: (owner, path) => allowedByWc.get(owner)?.has(path) === true,
  prepare: (owner, documentPath, bytes) => {
    const grant = htmlDraftGrants.get(owner)
    if (!grant || grant.documentPath !== documentPath)
      throw new Error(
        'The active HTML asset grant changed; the previous recovery copy is retained.',
      )
    return htmlDraftMaterializer.prepare(bytes, grant)
  },
})

/** Recovery-panel and close-prompt discard invalidate the live producer before storage awaits. */
export async function discardActiveHtmlDraft(id: string): Promise<boolean> {
  for (const owner of allowedByWc.keys()) {
    if (htmlDraftController.tokenFor(owner) !== id) continue
    await discardHtmlDraft(owner)
    return true
  }
  return false
}
async function discardHtmlDraft(owner: number): Promise<void> {
  const token = htmlDraftController.tokenFor(owner)
  closeCoordinator.cancel(owner)
  await htmlDraftController.discardCurrent(owner)
  htmlDraftGrants.delete(owner)
  htmlDraftActivationIntent.set(owner, (htmlDraftActivationIntent.get(owner) ?? 0) + 1)
  const wc = webContents.fromId(owner)
  if (token && wc && !wc.isDestroyed()) wc.send(HTML_CHANNELS.draftDiscarded, token)
}

/** Fired after a save lands on a NEW path (untitled first save / Save As) — the shell syncs tab title, recents, projects */
let fileSavedHook: ((wc: WebContents, path: string) => void) | null = null

export function setHtmlFileSavedHook(hook: (wc: WebContents, path: string) => void): void {
  fileSavedHook = hook
}

/** An untitled document got a provisional name from the user's first AI request — the shell titles its tab */
let provisionalTitleHook: ((wc: WebContents, title: string) => void) | null = null

export function setHtmlProvisionalTitleHook(hook: (wc: WebContents, title: string) => void): void {
  provisionalTitleHook = hook
}

/** After a Word export the shell opens the new .docx in a docs tab; standalone reveals it */
let docxExportedHook: ((path: string) => void) | null = null
/** Before the .docx is written: the shell closes a docs tab already showing that path
 * (its unsaved-changes prompt applies); false = the user kept it, so the export is dropped */
let docxExportPrepareHook: ((path: string) => Promise<boolean>) | null = null

export function setHtmlDocxExportedHook(hook: (path: string) => void): void {
  docxExportedHook = hook
}

export function setHtmlDocxExportPrepareHook(hook: (path: string) => Promise<boolean>): void {
  docxExportPrepareHook = hook
}

function openExportedDocx(path: string): void {
  if (isHeadlessMode()) return
  try {
    if (docxExportedHook) {
      docxExportedHook(path)
      return
    }
  } catch (err) {
    console.warn('[html] Failed to open exported Word file:', err)
  }
  shell.showItemInFolder(path)
}

function exportFileName(suggested: unknown): string {
  return (
    String(suggested || tm('untitledFile'))
      .replace(/[/\\:*?"<>|]/g, '_')
      .slice(0, 80)
      .trim() || tm('untitledFile')
  )
}

export interface HtmlPresentHooks {
  /** cover the tab strip with the presenting tab's view (shell tab mode) */
  setBleed?: (wc: WebContents, on: boolean) => void
  /** window hosting a view when BrowserWindow.fromWebContents cannot tell (shell WebContentsView) */
  hostWindow?: (wc: WebContents) => BrowserWindow | null
  /** open a chrome-free tab presenting the owner view's preview; false → a window is opened instead */
  openTab?: (owner: WebContents, title: string) => boolean
  /** close the tab hosting a present view; false → not a tab of this shell */
  closeTab?: (wc: WebContents) => boolean
}
let presentHooks: HtmlPresentHooks = {}
export function setHtmlPresentHooks(hooks: HtmlPresentHooks): void {
  presentHooks = hooks
}
/** present views → the editing view whose preview they show */
const presentOwnerByWc = new Map<number, number>()
/** standalone Present windows; unreferenced BrowserWindows may be garbage-collected */
const presentWindows = new Set<BrowserWindow>()

/** The owner view is gone, so is its preview: close every present view showing it */
function closePresentViewsOf(ownerWcId: number): void {
  for (const [id, owner] of presentOwnerByWc) {
    if (owner !== ownerWcId) continue
    presentationCloses.destroy(id);presentOwnerByWc.delete(id)
    const wc = webContents.fromId(id)
    if (!wc || wc.isDestroyed()) continue
    if (presentHooks.closeTab?.(wc)) continue
    const win = BrowserWindow.fromWebContents(wc)
    if (win && !win.isDestroyed()) win.close()
    else wc.close()
  }
}

/** A4 at 96dpi; html2docx re-measures at the authored width itself when the page asks for more. */
const HTML2DOCX_VIEWPORT = { width: 794, height: 1123, deviceScaleFactor: 2 }
// A renderer that never yields must not strand the export: watchdog destroys
// the hidden conversion window.
const HTML_EXPORT_TIMEOUT_MS = 180_000

/** Print the document in a hidden script-free window (sheets-style). Relative assets
 * resolve through html-asset:// against the document's folder, exactly as in the preview. */
async function renderPrintPdf(
  html: string,
  docPath: string | undefined,
  workDir: string,
): Promise<Buffer> {
  const base = docPath ? assetBaseHref(dirname(docPath)) : null
  const htmlPath = join(workDir, 'print.html')
  await writeFile(htmlPath, buildPreviewDocument(html, base), 'utf8')
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false },
  })
  try {
    await printWin.loadFile(htmlPath)
    return await printWin.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    })
  } finally {
    printWin.destroy()
  }
}

/** Shell menu export entry: ask the renderer to serialize and run the export flow */
export function sendHtmlExportRequest(contents: WebContents, format: ExportFormat): void {
  if (contents.isDestroyed() || presentOwnerByWc.has(contents.id)) return
  contents.send(HTML_CHANNELS.exportRequest, format)
}

/** Shell menu Print: ask the renderer to build the print HTML and open the system dialog */
export function sendHtmlPrintRequest(contents: WebContents): void {
  if (contents.isDestroyed() || presentOwnerByWc.has(contents.id)) return
  contents.send(HTML_CHANNELS.printRequest)
}

// Scripting stays on here, unlike the PDF export window: Chromium rejects
// executeJavaScript under `javascript: false`, and the fonts/images readiness
// probe needs it. Print and Export-PDF therefore differ for <script>-built content.
function printHtml(html: string, docPath: string | undefined): Promise<PrintDialogOutcome> {
  const base = docPath ? assetBaseHref(dirname(docPath)) : null
  return printHtmlDocument({
    html: buildPreviewDocument(html, base),
    window: new BrowserWindow({ show: false, webPreferences: { sandbox: true } }),
    fileName: 'print.html',
    dirPrefix: 'vantage-html-print-',
  })
}

export function htmlIsDirty(webContentsId: number): boolean {
  return dirtyByWc.has(webContentsId)
}

export function htmlFilePath(webContentsId: number): string | undefined {
  return savePathByWc.get(webContentsId)
}

/** The file was renamed on disk — re-grant the new path and tell the renderer */
export async function htmlFileRenamed(contents: WebContents, oldPath: string, newPath: string): Promise<void> {
  const wcId = contents.id
  if(savePathByWc.get(wcId)!==oldPath)return
  closeCoordinator.cancel(wcId,undefined,'source renamed')
  allowedByWc.get(wcId)?.delete(oldPath)
  const publicationSession=closeCoordinator.session(wcId)
  await publicationReads.rebind(wcId,publicationSession,oldPath,newPath,()=>!contents.isDestroyed()&&closeCoordinator.session(wcId)===publicationSession&&savePathByWc.get(wcId)===oldPath)

  if (savePathByWc.get(wcId) === oldPath) savePathByWc.set(wcId, newPath)
  if (openPathByWc.get(wcId) === oldPath) openPathByWc.set(wcId, newPath)
  const allowed = allowedByWc.get(wcId)
  if (allowed) allowed.add(newPath)
  htmlDraftController.rename(wcId, oldPath, newPath)
  const grant = htmlDraftGrants.get(wcId)
  if (grant?.documentPath === oldPath && resolve(dirname(oldPath)) === resolve(dirname(newPath)))
    htmlDraftGrants.set(wcId, { ...grant, documentPath: newPath })
  else if (grant?.documentPath === oldPath) htmlDraftGrants.delete(wcId)
  if (savePathByWc.get(wcId) === newPath) await diskWatcherByWc.get(wcId)?.watch(newPath)
  await renameOwnedAssetDocument(oldPath, newPath).catch((error) => {
    console.warn('[html] asset manifest rename sync failed:', error)
  })
  if (!contents.isDestroyed()) contents.send(HTML_CHANNELS.fileRenamed, newPath)
}

/**
 * Close guard: true means proceed with closing. Clean → true; dirty →
 * Save / Don't Save / Cancel. On Save, ask the renderer to serialize + write
 * and await the result; a canceled untitled-save dialog keeps the tab open.
 */
/** Removal must consume a held receipt; a Boolean can never authorize a later removal. */
export async function requestHtmlClose(_contents:WebContents,_parent?:BrowserWindow|null):Promise<boolean>{return false}
export async function prepareHtmlNativeClose(contents:WebContents,parent?:BrowserWindow|null,options:HtmlClosePrepareOptions={}):Promise<HtmlNativeCloseReceipt|null>{
 return runHtmlNativeClose({holdAutomaticSaves:()=>nativeCloseAdmission.hold(contents.id,contents.id),alive:()=>!contents.isDestroyed(),readOnly:()=>presentOwnerByWc.has(contents.id),state:()=>closeCoordinator.state(contents.id),retainedAssets:async()=>{const path=savePathByWc.get(contents.id);return path?pendingOwnedAssetsForDocument(path):[]},prompt:async retainedCount=>{
  const detail=tm('closeUnsavedDetail')+(retainedCount?' Unpublished image files will stay on disk when you discard, because another copy may use them.':'')
  const promptOptions={type:'warning' as const,message:tm('closeUnsavedMsg'),detail,buttons:[tm('btnSave'),tm('btnDontSave'),tm('btnCancel')],defaultId:0,cancelId:2,noLink:true}
  const {response}=parent&&!parent.isDestroyed()?await dialog.showMessageBox(parent,promptOptions):await dialog.showMessageBox(promptOptions)
  return response
 },prepare:(intent,approved,permit)=>prepareHtmlClose(contents,undefined,intent,approved,permit),cancel:receipt=>cancelHtmlClose(contents,receipt,'The native close group ended after preparation.')},options)
}
export async function prepareHtmlClose(contents:WebContents,filePath?:string,intent:'save'|'discard'|'clean'='save',approved?:CloseLeaseStamp,options:HtmlClosePrepareOptions={}):Promise<HtmlNativeCloseReceipt>{
  const permit=Object.freeze({deferSeal:options.deferSeal===true,signal:options.signal,isCurrent:options.isCurrent})
  if(!htmlClosePermit(permit))throw new Error('The close operation ended before Save or custody was requested.')
  if(filePath!==undefined&&(!isAbsolute(filePath)||filePath.includes('\0')))throw new Error('HTML close Save requires an absolute destination.')
  if(presentOwnerByWc.has(contents.id)&&!contents.isDestroyed())return presentationCloses.prepare(contents.id,permit)
  assertNoHtmlCleanup(contents.id)
  if(intent==='discard'&&!approved)approved=closeCoordinator.state(contents.id)?.stamp
  const sourceAtTarget=closeCoordinator.source(contents.id),targetVersion=intent==='save'&&filePath!==undefined&&savePathByWc.get(contents.id)!==filePath?await observePublicationTarget(filePath):undefined
  if(contents.isDestroyed()||closeCoordinator.source(contents.id)!==sourceAtTarget||!htmlClosePermit(permit))throw new Error('The source or close operation changed while its destination was being checked.')
  const result=await closeCoordinator.request(contents.id,'save',filePath,true,intent,approved,{...permit,deferSeal:true},targetVersion)
  if(!htmlClosePermit(permit)){if(result.closeLease)closeCoordinator.cancel(contents.id,result.closeLease.ticket,'The group ended after renderer preparation.');throw new Error('This close attempt was canceled before recovery was prepared.')}
  if(result.phase!=='prepared'||!result.current||!result.closeLease)throw new Error(result.error??'The current HTML editor could not be held for close.')
  if(intent==='discard'){
    const owner=contents.id,draft=result.draft,documentPath=savePathByWc.get(owner)??null,recoveryRoot=join(app.getPath('userData'),'recovery')
    if(!draft||!htmlDraftController.isActivation(owner,draft.token)){closeCoordinator.cancel(owner,result.closeLease.ticket,'discard source changed');throw new Error('The approved discard source changed.')}
    // Retire the producer and all allocated old snapshots before any await,
    // but retain its last complete durable bytes until actual owner removal.
    let producer:ReturnType<HtmlDraftController['stageClose']>
    try{producer=htmlDraftController.stageClose(owner,draft)}catch(error){closeCoordinator.cancel(owner,result.closeLease.ticket,'discard journal source changed');throw error}
    const record:HtmlCloseCustody={owner,ticket:result.closeLease.ticket,receipt:result,cancelProducer:producer.cancel,canceled:false,removed:false}
    htmlCustodyByTicket.set(record.ticket.id,record);htmlCustodyByReceipt.set(result,record)
    let actualSettlement:Promise<void>=Promise.resolve()
    const cleanup=(async()=>{
      if(!htmlClosePermit(permit))throw new Error('The close group ended before custody admission.')
      // Register lineage now; privacy retirement can see an unfinished drain.
      const admission=beginCloseCleanup({ready:producer.drain,id:'html:'+result.requestId,module:'html',ownerKey:record.ticket.source,source:result.closeLease!.stamp.source,generation:record.ticket.sequence,token:producer.token,documentPath:producer.documentPath,custody:{recoveryRoot,draftId:producer.token,attest:producer.attest},run:async signal=>{if(signal.aborted)throw new Error('Captured journal cleanup was canceled.');if(!record.handle?.status().custody)return;const binding=producer.attest();if(!binding)throw new Error('Captured HTML journal binding is unknown; its recovery bytes were retained.');await discardDraftJournal(recoveryRoot,producer.token,{expectedSha256:binding.expectedSha256})}});record.admission=admission;actualSettlement=admission.actualSettled;record.handle=await admission.ready;await admission.actualSettled
      if(!htmlClosePermit(permit))throw new Error('This close attempt was canceled.')
      if(record.canceled)record.handle.cancel('Close permission ended while recovery custody was being prepared.')
      const retained=documentPath?await pendingOwnedAssetsForDocument(documentPath):[]
      if(!htmlClosePermit(permit))throw new Error('This close attempt was canceled.')
      result.cleanup={journal:'staged',assets:retained.length?'retained':'none',...(retained.length?{retainedAssets:retained.length}:{})};updateHtmlCustody(record)
      if(retained.length){const warning='Staged image files were retained because this view cannot prove exclusive ownership; another copy may use them.';result.warnings=[warning];console.warn('[html] discard asset retention:',warning)}
      if(record.canceled)throw new Error('Close permission expired while the protected recovery copy was being prepared; the document remains open.')
    })()
    // A ready timeout may reject promptly; the actual provider/finalizers keep their slot and renderer lock.
    const actual=cleanup.finally(()=>actualSettlement).finally(()=>{if(htmlCleanup.get(owner)!==actual)return;htmlCleanup.delete(owner);for(const release of htmlDeferredRelease.get(owner)??[]){if(!contents.isDestroyed())contents.send(HTML_CHANNELS.closeLeaseRelease,release.ticket,release.reason)}htmlDeferredRelease.delete(owner)})
    void actual.catch(()=>{})
    htmlCleanup.set(owner,actual)
    try{await cleanup;await actual}catch(error){cancelHtmlCustody(record,'recovery staging did not finish');closeCoordinator.cancel(owner,result.closeLease.ticket,'recovery staging failed');throw error}
  }
  if(!htmlClosePermit(permit)||!isHtmlClosePrepared(contents,result)){if(result.closeLease)closeCoordinator.cancel(contents.id,result.closeLease.ticket,'The close operation expired before its final seal.');throw new Error('The document changed before it could close.')}
  if(permit.deferSeal)return result as HtmlNativeCloseReceipt
  const ready=sealHtmlClose(contents,result)
  if(!ready)throw new Error('The document changed before it could close.')
  return ready
}
export function isHtmlClosePrepared(contents:WebContents,receipt:HtmlCloseReceipt):boolean{
  if(receipt.readOnlyPresentation!==undefined)return presentationCloses.isPrepared(contents.id,receipt)
  if(contents.isDestroyed()||htmlCleanup.has(contents.id))return false
  const staged=htmlCustodyByReceipt.get(receipt)
  return(!staged||!staged.canceled&&!!staged.handle)&&closeCoordinator.isPrepared(contents.id,receipt)
}
export function sealHtmlClose(contents:WebContents,receipt:HtmlCloseReceipt):HtmlNativeCloseReceipt|null{
  if(receipt.readOnlyPresentation!==undefined)return presentationCloses.seal(contents.id,receipt)
  if(!isHtmlClosePrepared(contents,receipt))return null
  const ready=closeCoordinator.seal(contents.id,receipt);if(!ready)return null
  const staged=htmlCustodyByReceipt.get(receipt);if(staged){staged.receipt=ready;htmlCustodyByReceipt.set(ready,staged);htmlCustodyByReceipt.delete(receipt)}
  return ready
}
export function completeHtmlClose(contents:WebContents,receipt:HtmlCloseReceipt,remove:()=>boolean):boolean{
  if(receipt.readOnlyPresentation!==undefined)return presentationCloses.complete(contents.id,receipt,remove)
  if(htmlCleanup.has(contents.id))return false
  const staged=htmlCustodyByReceipt.get(receipt)
  if(staged&&(staged.canceled||!staged.handle))return false
  try{return closeCoordinator.complete(contents.id,receipt,()=>staged?staged.handle!.commitRemoval(()=>{const removed=remove();if(removed)staged.removed=true;return removed}):remove())}
  finally{if(staged)updateHtmlCustody(staged)}
}
export async function cancelHtmlClose(contents:WebContents,receipt:HtmlCloseReceipt,reason='close cancelled'):Promise<void>{
  if(receipt.readOnlyPresentation!==undefined){presentationCloses.cancel(contents.id,receipt);return}
  if(!receipt.closeLease)return
  closeCoordinator.cancel(contents.id,receipt.closeLease.ticket,reason);await htmlCleanup.get(contents.id)
  const staged=htmlCustodyByReceipt.get(receipt);if(staged&&!staged.removed)cancelHtmlCustody(staged,reason)
}

/**
 * Drop assets staged next to the document but never written into it — the MCP
 * "discard unsaved changes" path, same cleanup the interactive close prompt
 * runs when the user picks "Don't Save".
 */
export async function htmlDiscardPendingAssets(contents: WebContents): Promise<void> {
  void contents
  throw new Error('Discard requires a captured intent and a held renderer close lease.')
}

/** Menu Save / Save As: ask the renderer to serialize and save; clean views resolve true immediately on plain save */
export function requestHtmlSave(contents:WebContents,mode:SaveMode):Promise<boolean>{if(contents.isDestroyed())return Promise.resolve(false);if(presentOwnerByWc.has(contents.id))return Promise.resolve(true);return closeCoordinator.request(contents.id,mode).then(result=>result.published||result.current&&result.clean,()=>false)}

/**
 * Read the live document source for an MCP `open_documents` read. The buffer the
 * renderer pushes for the preview is instrumented for the iframe, so it cannot
 * be reused here: this asks for the saved serialization instead, unsaved edits
 * included.
 */
export function htmlReadText(contents: WebContents): Promise<string> {
  if (contents.isDestroyed()) return Promise.reject(new Error('the document is no longer open'))
  const wcId = contents.id
  const inFlight = readTextInFlight.get(wcId)
  if (inFlight) return inFlight
  const request = new Promise<string>((resolve, reject) => {
    // The renderer registers its listener while mounting, which can land after
    // the tab appears; a request sent before that is dropped silently. Re-send
    // on an interval until the renderer answers, the way the shell's own
    // control channel polls for a not-yet-ready editor.
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(retry)
      clearTimeout(timer)
      readTextWaiters.delete(wcId)
      readTextInFlight.delete(wcId)
      finish()
    }
    const retry = setInterval(() => {
      if (contents.isDestroyed()) {
        settle(() => reject(new Error('the document is no longer open')))
        return
      }
      contents.send(HTML_CHANNELS.readTextRequest)
    }, 250)
    const timer = setTimeout(
      () => settle(() => reject(new Error('timed out reading the document'))),
      30_000,
    )
    readTextWaiters.set(wcId, (result) => {
      settle(() => {
        if ('text' in result) resolve(result.text)
        else reject(new Error(result.error))
      })
    })
    contents.send(HTML_CHANNELS.readTextRequest)
  })
  readTextInFlight.set(wcId, request)
  return request
}

/** Save the live document to the destination owned by this request, then await current clean source. */
export async function htmlSaveToPath(contents:WebContents,filePath:string):Promise<HtmlAssetCleanupReport|void>{
  if(!isAbsolute(filePath)||filePath.includes('\0'))throw new Error('HTML Save requires an absolute destination.')
  const sourceAtRequest=closeCoordinator.source(contents.id),targetVersion=savePathByWc.get(contents.id)===filePath?undefined:await observePublicationTarget(filePath)
  if(contents.isDestroyed()||closeCoordinator.source(contents.id)!==sourceAtRequest)throw new Error('The source changed while the explicit destination was being checked.')
  const result=await closeCoordinator.request(contents.id,'save',filePath,false,'save',undefined,{},targetVersion)
  if(!result.published&&!(result.current&&result.clean))throw new Error(result.error??'The HTML file was not published.')
  if(result.assetCleanup||result.warnings?.length)return {assetCleanup:result.assetCleanup,warnings:result.warnings}
}

async function confirmPublicationChoice(e:Electron.IpcMainInvokeEvent,target:string,mustExist=false){
  const selected=await observePublicationTarget(target)
  if(mustExist&&!selected.version)throw new Error('The original document was moved or deleted. Save As a separate copy; current edits are retained.')
  if(!selected.version)return selected
  const parent=BrowserWindow.fromWebContents(e.sender)??undefined,choice={type:'warning' as const,message:'Replace the selected file?',detail:target+'\nThe exact version now on disk will be replaced. A later change will stop this save.',buttons:['Replace','Cancel'],defaultId:1,cancelId:1,noLink:true}
  const answer=parent&&!parent.isDestroyed()?await dialog.showMessageBox(parent,choice):await dialog.showMessageBox(choice)
  return answer.response===0?selected:null
}


function fileNameBase(name: string | undefined): string {
  return (name ?? '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .slice(0, 80)
    .trim()
}

async function resolveSaveTarget(
  e: Electron.IpcMainInvokeEvent,
  mode: SaveMode,
  suggestedName?: string,
  defaultName?: string,
): Promise<string | null | 'canceled'> {
  const current = savePathByWc.get(e.sender.id)
  if (mode === 'save' && current) return current
  // AI auto-naming: silent first save of an untitled document
  if (mode === 'save' && !current && suggestedName) {
    const base = fileNameBase(suggestedName)
    if (base) {
      const dir = configuredDefaultSaveDir(app)
      let target = join(dir, `${base}.html`)
      for (let n = 1; existsSync(target); n++) target = join(dir, `${base}-${n}.html`)
      return target
    }
  }
  const win =
    BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
  // A name proposed by the model (or the page's own title) prefills the dialog
  // rather than replacing it: the reader still chooses the location, and
  // cancelling still cancels. Without one, the dialog opens on the file's own
  // name, or on the untitled default for a page that has never been saved.
  const proposed = fileNameBase(defaultName)
  const defaultPath = proposed
    ? // keep the open file's extension: an .html proposal must not offer to
      // rewrite an opened .htm file, or a Save As on an .html one
      join(
        current ? dirname(current) : configuredDefaultSaveDir(app),
        `${proposed}${current ? extname(current) : '.html'}`,
      )
    : current
      ? join(dirname(current), basename(current))
      : join(configuredDefaultSaveDir(app), `${tm('untitledFile')}.html`)
  const picked = await showSaveDialogWithMemory(dialog, win, {
    title: tm('dlgSaveTitle'),
    defaultPath,
    filters: [{ name: tm('filterHtml'), extensions: ['html', 'htm'] }],
  })
  if (picked.canceled || !picked.filePath) return 'canceled'
  return picked.filePath
}

/**
 * Serves authored image paths to the editor DOM. A plain file:// <img> URL is
 * blocked whenever the renderer page is served over http (dev server), so the
 * renderer resolves images to html-asset:// instead. Only files inside an open
 * document's directory are served: by extension, or for extensionless
 * "Save page as, complete" assets by signature / requesting slot.
 */
function registerImageProtocol(): void {
  protocol.handle('html-asset', async (request) => {
    let target: string
    try {
      target = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (/^\/[a-zA-Z]:\//.test(target)) target = target.slice(1)
    target = resolve(target)
    const knownExt = PREVIEW_ASSET_EXTS.has(extname(target).toLowerCase())
    if (!existsSync(target)) return new Response(null, { status: 404 })
    let inDocDir = false
    for (const doc of new Set([...openPathByWc.values(), ...savePathByWc.values()])) {
      const dir = resolve(dirname(doc))
      if (!isInDocDir(target, dir)) continue
      if (await resolveSafeRelativeImagePath(doc, relative(dir, target))) {
        inDocDir = true
        break
      }
    }
    if (!inDocDir) return new Response(null, { status: 403 })
    let mime: string | null = null
    if (!knownExt) {
      mime = extensionlessAssetMime(target, await readHead(target), request.headers.get('accept'))
      if (!mime) return new Response(null, { status: 404 })
    }
    const res = await net.fetch(pathToFileURL(target).toString())
    if (!mime || !res.ok) return res
    return new Response(res.body, { status: 200, headers: { 'Content-Type': mime } })
  })
}

async function readHead(target: string): Promise<Uint8Array> {
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(ASSET_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, ASSET_SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

let ipcRegistered = false

function registerHtmlIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  registerImageProtocol()
  registerPreviewProtocol((wcId,url) => {
    const snapshotId=url.searchParams.get('snapshot')
    if(snapshotId){if(previewSnapshots.idFromUrl(wcId,url.href)!==snapshotId)return null;const snapshot=previewSnapshots.read(wcId,snapshotId);return snapshot?{text:snapshot.instrumented,baseHref:snapshot.baseHref}:null}
    const text = previewTextByWc.get(wcId)
    if (text === undefined) return null
    const doc = savePathByWc.get(wcId)
    return { text, baseHref: doc ? assetBaseHref(dirname(doc)) : null }
  })

  ipcMain.handle(HTML_CHANNELS.consumePending, (e) => openPathByWc.get(e.sender.id) ?? null)

  // ---- headless export mode (--headless-export) ----

  ipcMain.handle(HTML_CHANNELS.consumeHeadlessExport, (e): HeadlessExportTarget | null => {
    const target = headlessExportTargets.get(e.sender.id) ?? null
    headlessExportTargets.delete(e.sender.id)
    return target
  })

  ipcMain.on(HTML_CHANNELS.headlessExportDone, (e, result: unknown) => {
    const settle = headlessExportWaiters.get(e.sender.id)
    if (!settle) return
    headlessExportWaiters.delete(e.sender.id)
    const state = result as { ok?: unknown; error?: unknown } | null
    settle({
      ok: state?.ok === true,
      ...(typeof state?.error === 'string' ? { error: state.error } : {}),
    })
  })

  ipcMain.on(HTML_CHANNELS.previewUpdate, (e, text: unknown) => {
    if (!currentTopSender(e))return
    if (typeof text === 'string') previewTextByWc.set(e.sender.id, text)
  })

  ipcMain.handle(HTML_CHANNELS.previewPublish,(event,request:{source:string;instrumented:string;stamp:CloseLeaseStamp})=>{
    if(!currentTopSender(event)||presentOwnerByWc.has(event.sender.id))throw new Error('The preview publisher is not the active editor frame.')
    const state=closeCoordinator.state(event.sender.id);if(state&&request?.stamp?.source!==state.stamp.source)throw new Error('The preview belongs to a replaced document.')
    const grant=htmlDraftGrants.get(event.sender.id);if(!grant)throw new Error('The preview asset grant is not ready.')
    pinActualPreviewFrames(event.sender.id)
    const documentPath=savePathByWc.get(event.sender.id)
    return previewSnapshots.publish(event.sender.id,request.source,request.instrumented,documentPath?assetBaseHref(dirname(documentPath)):null,grant)
  })
  ipcMain.handle(HTML_CHANNELS.previewRetire,(event,id:unknown)=>{if(currentTopSender(event)&&typeof id==='string')previewSnapshots.retire(event.sender.id,id)})

  ipcMain.handle(HTML_CHANNELS.previewInfo, (e) => ({
    url: previewUrlFor(presentOwnerByWc.get(e.sender.id) ?? e.sender.id),
  }))

  // Same shape as the slides show: the renderer asks for the screen in one call so the
  // macOS snap skips the Space animation; HTML fullscreen is left to the renderer elsewhere.
  let presentFsRelease: ReturnType<typeof setTimeout> | null = null
  ipcMain.handle(HTML_CHANNELS.presentFullScreen, (e, on: unknown) => {
    const wc = e.sender
    const win = BrowserWindow.fromWebContents(wc) ?? presentHooks.hostWindow?.(wc) ?? null
    if (!win || win.isDestroyed()) return
    if (presentFsRelease) {
      clearTimeout(presentFsRelease)
      presentFsRelease = null
    }
    if (on === true) {
      presentHooks.setBleed?.(wc, true)
      if (process.platform === 'darwin' && !win.isFullScreen()) {
        win.setFullScreenable(false)
        if (!win.isSimpleFullScreen()) win.setSimpleFullScreen(true)
      }
      // the snap can hand the first responder to the shell chrome; Esc must keep landing in the tab
      wc.focus()
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.focus()
      }, 50)
      return
    }
    presentFsRelease = setTimeout(() => {
      presentFsRelease = null
      if (!wc.isDestroyed()) presentHooks.setBleed?.(wc, false)
      if (win.isDestroyed()) return
      if (process.platform === 'darwin') {
        if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false)
        win.setFullScreenable(true)
      }
    }, 150)
  })

  ipcMain.handle(HTML_CHANNELS.presentNewTab, (e, title: unknown) => {
    const label = typeof title === 'string' ? title : ''
    if (presentHooks.openTab?.(e.sender, label)) return true
    const parent = BrowserWindow.fromWebContents(e.sender) ?? presentHooks.hostWindow?.(e.sender)
    const bounds =
      parent && !parent.isDestroyed() ? parent.getContentBounds() : { width: 1200, height: 850 }
    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    presentWindows.add(win)
    win.once('closed', () => presentWindows.delete(win))
    bindPresentView(win.webContents, e.sender.id, label)
    return true
  })

  ipcMain.on(HTML_CHANNELS.ackFileChangedOnDisk, (e) => {
    void diskWatcherByWc.get(e.sender.id)?.acknowledge()
  })

  ipcMain.handle(HTML_CHANNELS.draftReloadRead, async (e, value: unknown) => {
    const request = value as { token?: unknown; documentPath?: unknown; revision?: unknown } | null
    const valid = () =>
      currentTopSender(e)&&!!request &&
      typeof request.token === 'string' &&
      typeof request.documentPath === 'string' &&
      Number.isSafeInteger(request.revision) &&
      htmlDraftController.isActivation(e.sender.id, request.token) &&
      htmlDraftController.pathFor(e.sender.id) === request.documentPath &&
      htmlDraftController.revisionFor(e.sender.id) === request.revision &&
      allowedByWc.get(e.sender.id)?.has(request.documentPath) === true
    if (!valid())
      throw new Error(
        'HTML Reload belongs to an obsolete source; the current document is retained.',
      )
    const raw = await readHtmlReloadSource(request!.documentPath as string)
    if (!valid())
      throw new Error('The document changed while Reload was reading; current edits are retained.')
    return raw
  })
  ipcMain.handle(HTML_CHANNELS.draftReloadApplied, (e, request: unknown) => {
    if(!currentTopSender(e))throw new Error('The reload sender frame is obsolete.')
    const priorOperation = htmlDraftController.sourceOperationFor(e.sender.id)
    const pending = htmlDraftController.applyReload(e.sender.id, request)
    if (htmlDraftController.sourceOperationFor(e.sender.id) !== priorOperation)
      closeCoordinator.cancel(e.sender.id)
    return pending
  })
  ipcMain.handle(HTML_CHANNELS.draftActivate, async (e, path: unknown, revision: unknown) => {
    requireRecoveryRuntime('HTML automatic recovery activation')
    if(!currentTopSender(e))throw new Error('The activation sender frame is obsolete.')
    const sessionAtRequest=closeCoordinator.session(e.sender.id)
    if (path !== null && (typeof path !== 'string' || openPathByWc.get(e.sender.id) !== path))
      throw new Error('HTML activation must follow a successful document load.')
    const owner = e.sender.id,
      intent = (htmlDraftActivationIntent.get(owner) ?? 0) + 1
    htmlDraftActivationIntent.set(owner, intent)
    const grant = await htmlAssetGrant(path as string | null)
    if (
      !currentTopSender(e)||closeCoordinator.session(owner)!==sessionAtRequest||htmlDraftActivationIntent.get(owner) !== intent ||
      (path !== null && openPathByWc.get(owner) !== path)
    )
      throw new Error('HTML activation was superseded.')
    closeCoordinator.cancel(owner)
    const token = htmlDraftController.activate(owner, path, revision as number)
    htmlDraftGrants.set(owner, grant)
    return token
  })
  ipcMain.on(HTML_CHANNELS.draftChanged, (e, change: unknown) => {
    if(!currentTopSender(e))return
    try {
      if (htmlDraftController.changed(e.sender.id, change)) {
        if ((change as { dirty: boolean }).dirty) dirtyByWc.add(e.sender.id)
        else dirtyByWc.delete(e.sender.id)
      }
    } catch (error) {
      console.warn('[html] rejected stale draft change:', error)
    }
  })
  ipcMain.handle(HTML_CHANNELS.draftWrite,(e,request:unknown)=>{if(!currentTopSender(e))throw new Error('The draft sender frame is obsolete.');requireRecoveryRuntime('HTML automatic recovery capture');return htmlDraftController.snapshot(e.sender.id,request)})
  ipcMain.handle(HTML_CHANNELS.draftSaved,(e,request:unknown)=>{if(!currentTopSender(e))throw new Error('The save acknowledgment sender is obsolete.');return htmlDraftController.acknowledgeSaved(e.sender.id,request)})

  ipcMain.handle(HTML_CHANNELS.readPublication,async(e,path:unknown,reload?:{token?:unknown;documentPath?:unknown;revision?:unknown})=>{
    const session=closeCoordinator.session(e.sender.id)
    const valid=()=>currentTopSender(e)&&closeCoordinator.session(e.sender.id)===session&&typeof path==='string'&&allowedByWc.get(e.sender.id)?.has(path)===true&&(!reload||(typeof reload.token==='string'&&reload.documentPath===path&&Number.isSafeInteger(reload.revision)&&htmlDraftController.isActivation(e.sender.id,reload.token)&&htmlDraftController.pathFor(e.sender.id)===path&&htmlDraftController.revisionFor(e.sender.id)===reload.revision))
    if(!valid())throw new Error('The publication read is not granted to the current document.')
    const result=await publicationReads.read(e.sender.id,session,path as string,async()=>reload?Buffer.from(await readHtmlReloadSource(path as string),'utf8'):await readFile(path as string),valid)
    return{text:Buffer.from(result.bytes).toString('utf8'),publicationId:result.publicationId}
  })
  ipcMain.on(HTML_CHANNELS.publicationLoaded,(e,request:unknown)=>{
    if(!currentTopSender(e))return
    const candidate=request as {publicationId?:unknown;path?:unknown;stamp?:CloseLeaseStamp}|null,state=closeCoordinator.state(e.sender.id)
    if(!candidate||typeof candidate.path!=='string'||!allowedByWc.get(e.sender.id)?.has(candidate.path)||savePathByWc.get(e.sender.id)!==candidate.path||!state||candidate.stamp?.source!==state.stamp.source||candidate.stamp?.revision!==state.stamp.revision||!publicationReads.adopt(e.sender.id,closeCoordinator.session(e.sender.id),state.stamp.source,candidate.path,candidate.publicationId))console.warn('[html] refused obsolete publication-load acknowledgment')
  })

  ipcMain.handle(HTML_CHANNELS.readFile, async (e, path: unknown) => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      throw new Error('html: path not granted to this view')
    }
    return await readFile(path, 'utf8')
  })

  ipcMain.handle(
    HTML_CHANNELS.save,
    async (e, request: SaveHtmlRequest): Promise<SaveHtmlResult> => {
      const releaseAutomatic=nativeCloseAdmission.write(e.sender.id,request?.automatic===true,closeCoordinator.ownsCloseWrite(e.sender.id,request?.requestId)?e.sender.id:undefined)
      if(!releaseAutomatic)return{ok:true,canceled:true}
      try{
      const retained=new Set<string>(),retention={retainUnproven:true,onRetained:(names:readonly string[])=>{for(const name of names)retained.add(name)}}
      if(!currentTopSender(e))return {ok:false,error:'The save sender frame is obsolete.'}
      const requestId = request?.requestId
      const done=(result:SaveHtmlResult):SaveHtmlResult=>retained.size?{...result,assetCleanup:{assets:'retained'},warnings:['Some image files were kept because another open copy or a saved version may still need them.']}:result
      if (typeof request?.text !== 'string') {
        return done({ ok: false, error: 'html: bad save request' })
      }
      if (
        request.imageSources !== undefined &&
        (!Array.isArray(request.imageSources) ||
          request.imageSources.some((source) => typeof source !== 'string'))
      ) {
        return done({ ok: false, error: 'html: bad image references' })
      }
      const draft = request.draft
      if (
        !draft ||
        !htmlDraftController.isActivation(e.sender.id, draft.token) ||
        !Number.isSafeInteger(draft.revision) ||
        draft.revision < 0 ||
        !Number.isSafeInteger(draft.throughSequence) ||
        draft.throughSequence < 0
      )
        return done({ ok: false, error: 'html: save belongs to an inactive document' })
      if (!htmlDraftController.acceptsSourceRevision(e.sender.id, draft.token, draft.revision))
        return done({ ok: false, error: 'html: Save belongs to a retired source revision' })
      assertNoHtmlCleanup(e.sender.id)
      const closeSourceAtRequest=closeCoordinator.source(e.sender.id)
      const sourceOperationAtRequest = htmlDraftController.sourceOperationFor(e.sender.id)
      if (requestId !== undefined && !closeCoordinator.matches(e.sender.id, requestId))
        return done({ ok: false, error: 'html: obsolete Save request' })
      const isCurrentSave = () =>
        currentTopSender(e)&&closeCoordinator.source(e.sender.id)===closeSourceAtRequest&&htmlDraftController.isActivation(e.sender.id, draft.token) &&
        htmlDraftController.sourceOperationFor(e.sender.id) === sourceOperationAtRequest &&
        (requestId === undefined || closeCoordinator.matches(e.sender.id, requestId))
      const work=closeCoordinator.beginMutation(e.sender.id,requestId,request.closeSource)
      let publishedPath:string|undefined
      const mode: SaveMode = request.mode === 'saveAs' ? 'saveAs' : 'save'
      const pathAtRequest = htmlDraftController.pathFor(e.sender.id) ?? undefined
      try {
        const publicationEntry=publicationReads.select(e.sender.id,closeCoordinator.session(e.sender.id),request.closeSource?.source??'',request.publicationId,pathAtRequest??null,mode==='saveAs'),loadedPublication=publicationEntry.publication.snapshot()
        const overwriteVersion=request.overwrite===true&&mode==='save'&&pathAtRequest?await confirmPublicationChoice(e,pathAtRequest,true):undefined
        if(request.overwrite===true&&mode==='save'&&pathAtRequest&&!overwriteVersion)return done({ok:true,canceled:true})
        const pendingAtRequest=pathAtRequest?await pendingOwnedAssetsForDocument(pathAtRequest):[]
        if(!isCurrentSave())return done({ok:false,error:'The close group ended before choosing a Save target.'})
        const suggestedName =
          typeof request.suggestedName === 'string' ? request.suggestedName : undefined
        const defaultName =
          typeof request.defaultName === 'string' ? request.defaultName : undefined
        const target =
          closeCoordinator.target(e.sender.id, requestId) ??
          (await resolveSaveTarget(e, mode, suggestedName, defaultName))
        if (target === 'canceled') return done({ ok: true, canceled: true })
        if (!target) return done({ ok: false, error: 'html: no save target' })
        if (!isCurrentSave())
          return done({ ok: false, error: 'html: document changed while choosing a save target' })
        const capturedTarget=closeCoordinator.publicationTarget(e.sender.id,request.requestId)
        const selectedTarget=capturedTarget??overwriteVersion??(mode==='saveAs'?await confirmPublicationChoice(e,target):pathAtRequest===target?undefined:absentPublicationTarget(target))
        if(mode==='saveAs'&&!selectedTarget)return done({ok:true,canceled:true})
        const publicationTicket=publicationEntry.publication.pin(target,selectedTarget??undefined,loadedPublication)
        const savedAssetGrant = await htmlAssetGrant(target)
        if (!isCurrentSave()) return done({ ok: false, error: 'html: save activation changed' })
        const assetSession=closeCoordinator.session(e.sender.id)
        const assetRetention={...retention,assertCurrent:()=>{if(!currentTopSender(e)||e.sender.isDestroyed()||closeCoordinator.session(e.sender.id)!==assetSession||!isCurrentSave()||(htmlDraftController.pathFor(e.sender.id)??undefined)!==pathAtRequest)throw new Error('The loaded source changed before asset publication.')}}
        let adoptedNewPath=false
        const assetResult=await withPinnedAssetOutput<SaveHtmlResult>({targetPath:target,expectedVersion:publicationTicket.expectedVersion,sourceDocumentPath:pathAtRequest,assertCurrent:assetRetention.assertCurrent},async()=>{
        const currentPath = pathAtRequest
        const isNewPath = currentPath !== target
        const imageSources = [...(request.imageSources ?? [])]
        const knownImageSources = new Set(imageSources)
        for (const source of extractHtmlAssetReferences(request.text)) {
          if (knownImageSources.has(source)) continue
          knownImageSources.add(source)
          imageSources.push(source)
        }
        const prepared =
          currentPath && resolve(dirname(currentPath)) !== resolve(dirname(target))
            ? await prepareAssetsForSaveAs(currentPath, target, request.text, imageSources,assetRetention)
            : null
        const textToWrite = prepared?.text ?? request.text
        const savedImageSources = prepared?.imageSources ?? imageSources
        const watcher = diskWatcherByWc.get(e.sender.id)
        if (watcher && !isNewPath && request.overwrite !== true && !(await watcher.isCurrent())) {
          if (prepared) await rollbackPreparedSaveAsAssets(prepared,retention).catch(() => {})
          return done({ ok: false, error: 'html: file changed on disk', conflict: true })
        }
        if (!isCurrentSave()) {
          if (prepared) await rollbackPreparedSaveAsAssets(prepared,retention).catch(() => {})
          return done({ ok: false, error: 'html: document changed before save' })
        }
        watcher?.beginOwnWrite()
        try {
          await publicationEntry.publication.publishBytes(publicationTicket,()=>Buffer.from(textToWrite,'utf8'),()=>isCurrentSave())
          publishedPath=target
        } catch (error) {
          if (prepared) await rollbackPreparedSaveAsAssets(prepared,retention).catch(() => {})
          throw error
        } finally {
          await watcher?.endOwnWrite(target)
        }
        if (!isCurrentSave())
          return done({
            ok: false,
            error: 'html: save completed for an earlier document activation',
          })
        savePathByWc.set(e.sender.id, target)
        // keep the reload path in sync — a stale openPathByWc would make a
        // reloaded renderer load the OLD file and then save it over the new one
        openPathByWc.set(e.sender.id, target)
        const allowed = allowedByWc.get(e.sender.id) ?? new Set<string>()
        allowed.add(target)
        allowedByWc.set(e.sender.id, allowed)
        htmlDraftGrants.set(e.sender.id, savedAssetGrant)
        await htmlDraftController.acknowledgeSaved(e.sender.id, {
          token: draft.token,
          revision: draft.revision,
          throughSequence: draft.throughSequence,
          documentPath: target,
          clean: false,
        })
        // Renderer acknowledges clean only if its captured revision is still current.
        const pendingNames = prepared
          ? prepared.created.map((record) => record.name)
          : currentPath && resolve(currentPath) === resolve(target)
            ? pendingAtRequest
            : []
        const reconciled = await reconcileOwnedAssets(target, savedImageSources, { pendingNames,...retention })
        if (reconciled.errors.length > 0) {
          console.warn('[html] asset reconciliation incomplete:', reconciled.errors)
        }
        if (mode === 'saveAs' && currentPath && resolve(currentPath) !== resolve(target)) {
          const sourceResolved = await resolveSourcePendingAfterSaveAs(
            currentPath,
            pendingAtRequest,retention,
          )
          if (sourceResolved.errors.length > 0) {
            console.warn('[html] source asset reconciliation incomplete:', sourceResolved.errors)
          }
        }
        if (!isCurrentSave())
          return done({
            ok: false,
            error: 'html: An earlier source was written; the current document was kept.',
          })
        if(isNewPath)adoptedNewPath=true
        return done({
          ok: true,
          path: target,
          publicationId:publicationEntry.id,
          ...(prepared?.rewrites.length ? { imageRewrites: prepared.rewrites } : {}),
        })
        })
        // Relocation hooks run after actual publication/adoption/asset settlement,
        // never from inside the publisher that a physical move must drain.
        if(adoptedNewPath&&closeCoordinator.session(e.sender.id)===assetSession&&savePathByWc.get(e.sender.id)===target)fileSavedHook?.(e.sender,target)
        return assetResult
      } catch (err) {
        return done({ ok: false, error: err instanceof Error ? err.message : String(err) })
      } finally{closeCoordinator.finishMutation(work,publishedPath,retained.size>0)}
      }finally{releaseAutomatic()}
    },
  )

  ipcMain.handle(HTML_CHANNELS.filesPick, async (e): Promise<AttachmentAddResult | null> => {
    const win =
      BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
    const picked = await showOpenDialogWithMemory(dialog, win, {
      title: tm('dlgAddAttachment'),
      filters: [
        { name: tm('filterSupported'), extensions: [...ATTACHMENT_EXTS] },
        { name: tm('filterAll'), extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return collectAttachments(picked.filePaths)
  })

  ipcMain.handle(HTML_CHANNELS.filesAdd, (_e, paths: unknown) =>
    collectAttachments(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []),
  )

  ipcMain.handle(
    HTML_CHANNELS.filesAddPastedImage,
    (_e, data: unknown, ext: unknown): AttachmentAddResult => {
      const filePath = savePastedImage(data, ext)
      return filePath
        ? collectAttachments([filePath])
        : { accepted: [], rejected: [tm('errNotImage')] }
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.filesRead,
    async (
      _e,
      filePath: string,
      offset: number,
      maxChars: number,
    ): Promise<AttachmentReadResult> => {
      const name = basename(filePath)
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (!ATTACHMENT_EXTS.has(ext)) return { ok: false, error: tm('errUnsupportedExt', { ext }) }
      if (ATTACHMENT_IMAGE_EXTS.has(ext)) return { ok: false, error: tm('errImageNoText') }
      try {
        const text = await extractAttachmentText(filePath)
        const start = Math.max(0, Math.floor(offset) || 0)
        const size = Math.min(Math.max(1, Math.floor(maxChars) || 1), 48_000)
        return {
          ok: true,
          name,
          totalChars: text.length,
          offset: start,
          text: text.slice(start, start + size),
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(HTML_CHANNELS.filesReadImage, (_e, filePath: string): AttachmentImageResult => {
    const name = basename(filePath)
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = ATTACHMENT_IMAGE_MIME[ext]
    if (!mime) return { ok: false, error: `${name}: ${tm('errNotImage')}` }
    try {
      const stat = statSync(filePath)
      if (stat.size > ATTACHMENT_IMAGE_MAX_BYTES) {
        return { ok: false, error: `${name}: ${tm('errImageTooLarge')}` }
      }
      return { ok: true, base64: readFileSync(filePath).toString('base64'), mime }
    } catch {
      return { ok: false, error: `${name}: ${tm('errUnreadable')}` }
    }
  })

  registerHtmlMutationHandle(HTML_CHANNELS.pickImage, async (e): Promise<string | null> => {
    const docPath = savePathByWc.get(e.sender.id),sourceAtRequest=closeCoordinator.source(e.sender.id),assetSession=closeCoordinator.session(e.sender.id)
    if (!docPath) return null
    const win =
      BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
    const picked = await showOpenDialogWithMemory(dialog, win, {
      title: tm('dlgPickImage'),
      // only formats readImage/DOCX export can round-trip (docx-engine NewImage mimes)
      filters: [{ name: tm('filterImages'), extensions: ['png', 'jpg', 'jpeg', 'gif'] }],
      properties: ['openFile'],
    })
    const source = picked.filePaths[0]
    if (picked.canceled || !source||!currentTopSender(e)||closeCoordinator.source(e.sender.id)!==sourceAtRequest) return null
    return copyImageIntoOwnedAssets(docPath, source,{retainUnproven:true,assertCurrent:()=>{if(!currentTopSender(e)||e.sender.isDestroyed()||closeCoordinator.session(e.sender.id)!==assetSession||closeCoordinator.source(e.sender.id)!==sourceAtRequest||savePathByWc.get(e.sender.id)!==docPath)throw new Error('The loaded source changed before image publication.')}})
  })

  registerHtmlMutationHandle(
    HTML_CHANNELS.saveImage,
    async (e, data: { base64?: unknown; ext?: unknown }): Promise<string | null> => {
      const docPath = savePathByWc.get(e.sender.id),assetSession=closeCoordinator.session(e.sender.id),sourceAtRequest=closeCoordinator.source(e.sender.id)
      const ext = String(data?.ext ?? '').toLowerCase()
      if (!docPath || typeof data?.base64 !== 'string' || !data.base64) return null
      // keep in sync with readImage's MIME map — every authored asset must stay DOCX-exportable
      if (!['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return null
      return writeImageIntoOwnedAssets(docPath, `image.${ext}`, Buffer.from(data.base64, 'base64'),{retainUnproven:true,assertCurrent:()=>{if(!currentTopSender(e)||e.sender.isDestroyed()||closeCoordinator.session(e.sender.id)!==assetSession||closeCoordinator.source(e.sender.id)!==sourceAtRequest||savePathByWc.get(e.sender.id)!==docPath)throw new Error('The loaded source changed before image publication.')}})
    },
  )

  // html-owned (like docs:ai-generate-image): the shared ai:* handlers are
  // shell-registered, but image generation is gated per app
  registerHtmlMutationHandle(
    HTML_CHANNELS.aiGenerateImage,
    (e, op: { prompt?: unknown; aspectRatio?: unknown }) =>
      generateImageTool(
        join(app.getPath('userData'), 'ai-settings.json'),
        {
          prompt: String(op?.prompt ?? ''),
          aspectRatio: op?.aspectRatio ? String(op.aspectRatio) : undefined,
        },
        {
          mediaRoots: documentMediaRoots(
            htmlFilePath(e.sender.id),
            join(app.getPath('temp'), 'vantage-pasted'),
          ),
        },
      ),
  )

  const MIME_BY_EXT: Record<string, ImageData['mime']> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
  }

  ipcMain.handle(HTML_CHANNELS.readImage, async (e, src: unknown): Promise<ImageData | null> => {
    const docPath = savePathByWc.get(e.sender.id)
    if (!docPath || typeof src !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null
    const target = await resolveSafeRelativeImagePath(docPath, src)
    if (!target || !existsSync(target)) return null
    try {
      // "save page as, complete" assets have no extension: type them from the signature
      const mime =
        MIME_BY_EXT[extname(target).toLowerCase()] ?? editableImageMime(await readHead(target))
      if (!mime) return null
      return { base64: (await readFile(target)).toString('base64'), mime }
    } catch {
      return null
    }
  })

  // remote pictures (AI-generated or hot-linked) are downloaded here: the frame's fetch is
  // CORS-bound, and fetchRemoteImage refuses private/link-local targets
  ipcMain.handle(HTML_CHANNELS.fetchImage, async (_e, url: unknown): Promise<ImageData | null> => {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return null
    try {
      const resp = await fetchRemoteImage(url)
      if (!resp?.ok) return null
      const ct = resp.headers.get('content-type') ?? ''
      const mime = ct.includes('png')
        ? 'image/png'
        : ct.includes('gif')
          ? 'image/gif'
          : 'image/jpeg'
      const bytes = await readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)
      return { base64: Buffer.from(bytes).toString('base64'), mime }
    } catch {
      return null
    }
  })

  ipcMain.handle(
    HTML_CHANNELS.exportDocx,
    async (e, request: ExportDocxRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad export request' }
      }
      const sourceProof=htmlExportSourceProof(e)
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      // Headless export has no dialog to authorize a path; the CLI already chose one.
      const picked =
        isHeadlessMode() && typeof request.outPath === 'string' && request.outPath
          ? { canceled: false, filePath: request.outPath }
          : await showSaveDialogWithMemory(
              dialog,
              win,
              {
                defaultPath: `${exportFileName(request.suggestedName)}.docx`,
                filters: [{ name: 'Word', extensions: ['docx'] }],
              },
              configuredDefaultSaveDir(app),
            )
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      const outputPath=picked.filePath
      return withSelectedUserOutput<ExportResult>(outputPath,async selectedVersion=>{
      if (docxExportPrepareHook && !(await docxExportPrepareHook(outputPath))) {
        return { ok: true, canceled: true }
      }
      const workDir = await mkdtemp(join(tmpdir(), 'vantage-html-docx-'))
      let driver: ElectronBrowserDriver | null = null
      try {
        // Same document the preview shows (scripts on, relative assets via html-asset://):
        // html2docx extracts from the rendered DOM, not from a print.
        const docPath = savePathByWc.get(e.sender.id)
        const base = docPath ? assetBaseHref(dirname(docPath)) : null
        const htmlPath = join(workDir, 'export.html')
        await writeFile(htmlPath, buildPreviewDocument(request.html, base), 'utf8')
        driver = await ElectronBrowserDriver.create(HTML2DOCX_VIEWPORT)
        // AI-generated markup with a script that never yields keeps
        // executeJavaScript pending forever, which would strand the hidden
        // window and this handler; race a watchdog and destroy the window on
        // timeout (same shape as the slides export guard).
        const conversion = convertHtmlToDocx({ url: pathToFileURL(htmlPath).href }, driver).then(
          ({ docx }) => docx,
        )
        let watchdog: ReturnType<typeof setTimeout> | undefined
        const docx = await Promise.race([
          conversion,
          new Promise<Uint8Array>((_, reject) => {
            watchdog = setTimeout(() => {
              if (driver && !driver.isWindowDestroyed()) driver.destroyNow()
              driver = null
              reject(new Error('html export timed out'))
            }, HTML_EXPORT_TIMEOUT_MS)
          }),
        ]).finally(() => clearTimeout(watchdog))
        // Vantage Productivity: protected publication also covers document exports.
        sourceProof.assertCurrent()
        await atomicWriteFile(outputPath, Buffer.from(docx),{expectedVersion:selectedVersion})
        openExportedDocx(outputPath)
        return { ok: true, path: outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        await driver?.close()
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
      },sourceProof)
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.exportPdf,
    async (e, request: ExportPdfRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad export request' }
      }
      const sourceProof=htmlExportSourceProof(e)
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      // Headless export has no dialog to authorize a path; the CLI already chose one.
      const picked =
        isHeadlessMode() && typeof request.outPath === 'string' && request.outPath
          ? { canceled: false, filePath: request.outPath }
          : await showSaveDialogWithMemory(
              dialog,
              win,
              {
                defaultPath: `${exportFileName(request.suggestedName)}.pdf`,
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
              },
              configuredDefaultSaveDir(app),
            )
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      const outputPath=picked.filePath
      return withSelectedUserOutput<ExportResult>(outputPath,async selectedVersion=>{
      const workDir = await mkdtemp(join(tmpdir(), 'vantage-html-pdf-'))
      try {
        const docPath = savePathByWc.get(e.sender.id)
        const bytes=await renderPrintPdf(request.html, docPath, workDir)
        sourceProof.assertCurrent()
        await atomicWriteFile(outputPath,bytes,{expectedVersion:selectedVersion})
        openExportedPdf(outputPath)
        return { ok: true, path: outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {})
      }
      },sourceProof)
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.printHtml,
    async (e, request: PrintHtmlRequest): Promise<PrintResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad print request' }
      }
      // printHtml already reports why it failed and separates a dialog the
      // user closed from a real failure, so the outcome maps straight onto
      // PrintResult: the renderer can stay silent on cancel and must surface
      // a failure instead of swallowing it.
      return printHtml(request.html, savePathByWc.get(e.sender.id))
    },
  )

  ipcMain.handle(
    HTML_CHANNELS.exportHtml,
    async (e, request: ExportHtmlRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string') {
        return { ok: false, error: 'html: bad export request' }
      }
      const sourceProof=htmlExportSourceProof(e)
      const win =
        BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
      // Headless export has no dialog to authorize a path; the CLI already chose one.
      const picked =
        isHeadlessMode() && typeof request.outPath === 'string' && request.outPath
          ? { canceled: false, filePath: request.outPath }
          : await showSaveDialogWithMemory(
              dialog,
              win,
              {
                defaultPath: `${singleFileExportBaseName(exportFileName(request.suggestedName))}.html`,
                filters: [{ name: 'HTML', extensions: ['html'] }],
              },
              configuredDefaultSaveDir(app),
            )
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      const docPath = savePathByWc.get(e.sender.id) ?? null
      // inlining the document into itself would silently rewrite the working file
      if (docPath && resolve(picked.filePath) === resolve(docPath)) {
        return { ok: false, error: 'single-file export cannot overwrite the open document' }
      }
      const outputPath=picked.filePath
      return withSelectedUserOutput<ExportResult>(outputPath,async selectedVersion=>{
      try {
        const { html, skipped } = await inlineImagesForSingleFile(request.html, docPath)
        sourceProof.assertCurrent()
        await atomicWriteFile(outputPath, Buffer.from(html, 'utf8'),{expectedVersion:selectedVersion})
        if (!isHeadlessMode()) shell.showItemInFolder(outputPath)
        return skipped.length
          ? { ok: true, path: outputPath, skipped }
          : { ok: true, path: outputPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      },sourceProof)
    },
  )

  ipcMain.on(HTML_CHANNELS.provisionalTitle, (e, title: unknown) => {
    if (typeof title !== 'string' || savePathByWc.has(e.sender.id)) return
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (clean) provisionalTitleHook?.(e.sender, clean)
  })

  ipcMain.on(HTML_CHANNELS.dirtyChanged, (e, dirty: unknown) => {
    if (dirty === true) dirtyByWc.add(e.sender.id)
    else dirtyByWc.delete(e.sender.id)
  })

  ipcMain.on(HTML_CHANNELS.closeSaveResult, (e, ok: unknown) => {
    const waiter = closeSaveWaiters.get(e.sender.id)
    closeSaveWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  ipcMain.on(HTML_CHANNELS.readTextResult, (e, result: unknown) => {
    const waiter = readTextWaiters.get(e.sender.id)
    readTextWaiters.delete(e.sender.id)
    if (!waiter) return
    if (result && typeof result === 'object' && 'text' in result) {
      waiter({ text: String((result as { text: unknown }).text) })
    } else {
      waiter({ error: 'the document could not be read' })
    }
  })

  // safety net for menu saves the renderer declined without invoking save()
  // (busy / still loading) — the save handler itself resolves the normal path
  ipcMain.on(HTML_CHANNELS.saveRequestAck,(event,requestId:unknown,result:unknown)=>{if(!currentTopSender(event))return;if(result&&typeof result==='object'&&(result as HtmlCloseReceipt).requestId===requestId)closeCoordinator.receive(event.sender.id,result)})
  ipcMain.handle(HTML_CHANNELS.closeSourceCheck,async(event,request:{requestId:string;token:string;revision:number;text:string;stamp:CloseLeaseStamp;sourceOnly:boolean;frameName:string})=>{
    if(!currentTopSender(event))return {ok:false,error:'The source sender frame is obsolete.'}
    assertNoHtmlCleanup(event.sender.id)
    if(typeof request?.text!=='string'||Buffer.byteLength(request.text,'utf8')>16*1024*1024||typeof request.sourceOnly!=='boolean'||!htmlDraftController.isActivation(event.sender.id,request.token)||request.revision!==htmlDraftController.revisionFor(event.sender.id))return {ok:false,error:'The HTML source changed before close validation.'}
    const owner=event.sender.id,work=closeCoordinator.beginMutation(owner,request.requestId,request.stamp),operation=htmlDraftController.sourceOperationFor(owner)
    let proofId:string|undefined
    try{
      const frame=actualPreviewFrame(owner,request.frameName),intent=closeCoordinator.intent(owner,request.requestId)
      if((request.sourceOnly||intent==='discard')&&frame)throw new Error('The owned preview has not finished retiring. Retry after source-only mode or explicit discard finishes.')
      if(!request.sourceOnly&&intent!=='discard'&&!frame)throw new Error('The actual loaded preview frame is unavailable.')
      const proof=previewSnapshots.begin(owner,request.requestId,request.stamp,request.frameName,frame);proofId=proof.id
      if(frame){
        const loaded=previewSnapshots.snapshotFor(proof);if(!loaded)throw new Error('The actual loaded source snapshot was retired.')
        // Validate the actual served document BEFORE the renderer may issue a frame nonce.
        const loadedResult=await htmlDraftMaterializer.prepare(Buffer.from(loaded.source,'utf8'),loaded.grant,{purpose:'close-proof'})
        if(loadedResult.unsealedExecutableReferences!==false)throw new Error('The loaded snapshot refers to unsealed executable files or active documents. Current file bytes cannot prove what previously executed.')
        const grant=htmlDraftGrants.get(owner);if(!grant)throw new Error('The current source asset grant is unavailable.')
        const currentResult=await htmlDraftMaterializer.prepare(Buffer.from(request.text,'utf8'),grant,{purpose:'close-proof'})
        if(currentResult.unsealedExecutableReferences!==false)throw new Error('The source still has unsealed executable references. Use source-only editing or explicitly discard.')
      }
      if(!closeCoordinator.current(work)||!htmlDraftController.isActivation(owner,request.token)||operation!==htmlDraftController.sourceOperationFor(owner)||request.revision!==htmlDraftController.revisionFor(owner)||!previewSnapshots.validated(owner,proof.id,actualPreviewFrame(owner,request.frameName)))throw new Error('The source or main-owned frame navigation generation changed during verification.')
      if(!frame&&!previewSnapshots.attest(owner,request.requestId,proof.id,null))throw new Error('The retired-frame proof changed.')
      return {ok:true,proof:proof.id}
    }catch(error){if(proofId&&previewSnapshots.getProof(owner,proofId))previewSnapshots.release(owner,request.requestId);return {ok:false,error:'Close could not verify the actual loaded preview: '+String(error)+'. Ordinary Save remains available. Apply or discard visual edits, then choose source-only editing, or explicitly discard this document.'}}
    finally{closeCoordinator.finishMutation(work)}
  })
  ipcMain.handle(HTML_CHANNELS.closeFrameRetired,(event,request:{requestId:string;frameName:string})=>{if(!currentTopSender(event)||!closeCoordinator.matches(event.sender.id,request?.requestId)||typeof request?.frameName!=='string'||!/^html-preview-[0-9a-f-]{36}$/.test(request.frameName))return false;try{return actualPreviewFrame(event.sender.id,request.frameName)===null}catch{return false}})
  ipcMain.handle(HTML_CHANNELS.closeFrameAttested,(event,request:{requestId:string;proof:string})=>{
    if(!currentTopSender(event)||!closeCoordinator.matches(event.sender.id,request?.requestId)||typeof request.proof!=='string')return false
    const proof=previewSnapshots.getProof(event.sender.id,request.proof)
    return !!proof&&previewSnapshots.attest(event.sender.id,request.requestId,request.proof,actualPreviewFrame(event.sender.id,proof.name))
  })
  ipcMain.on(HTML_CHANNELS.closeSourceState,(event,state)=>{if(currentTopSender(event))closeCoordinator.observe(event.sender.id,state)})
  ipcMain.handle(HTML_CHANNELS.closeLeaseClaim,(event,ticket)=>currentTopSender(event)&&closeCoordinator.claim(event.sender.id,ticket))
  ipcMain.handle(HTML_CHANNELS.closeLeaseCancel,async(event,ticket,reason)=>{if(!currentTopSender(event))return;closeCoordinator.cancel(event.sender.id,ticket,typeof reason==='string'?reason:'cancelled');await htmlCleanup.get(event.sender.id)})
  // Language channel shared with other modules; removeHandler tolerates duplicate registration
  ipcMain.removeHandler(HTML_CHANNELS.getLanguage)
  ipcMain.handle(HTML_CHANNELS.getLanguage, () => getUiLang())
}

function grantAndTrack(wc: WebContents, openPath?: string | null): void {
  const wcId = wc.id
  closeCoordinator.open(wcId)
  wc.on('render-process-gone',()=>closeCoordinator.rendererGone(wcId))
  wc.on('did-start-navigation',(details)=>{
    // Any start invalidates a proof, including away/back to the identical token URL.
    previewSnapshots.navigate(wcId);closeCoordinator.cancel(wcId,undefined,'preview navigation started')
    if(details.isMainFrame){closeCoordinator.rendererGone(wcId);htmlDraftController.retire(wcId);previewSnapshots.destroy(wcId)}
  })
  wc.on('did-frame-navigate',()=>{previewSnapshots.navigate(wcId);closeCoordinator.cancel(wcId,undefined,'preview navigation committed');pinActualPreviewFrames(wcId)})
  wc.on('did-navigate-in-page',()=>{previewSnapshots.navigate(wcId);closeCoordinator.cancel(wcId,undefined,'preview in-page navigation');pinActualPreviewFrames(wcId)})
  allowedByWc.set(wcId, new Set())
  const watcher = createDocumentDiskWatcher((path) => {
    if (!wc.isDestroyed()) wc.send(HTML_CHANNELS.fileChangedOnDisk, path)
  })
  diskWatcherByWc.set(wcId, watcher)
  if (openPath && existsSync(openPath)) {
    openPathByWc.set(wcId, openPath)
    savePathByWc.set(wcId, openPath)
    allowedByWc.set(wcId, new Set([openPath]))
    void watcher.watch(openPath)
  }
  installExternalLinkOpener(wc)
  wc.once('destroyed', () => {
    htmlDraftController.retire(wcId)
    htmlDraftGrants.delete(wcId)
    htmlDraftActivationIntent.delete(wcId)
    closePresentViewsOf(wcId)
    diskWatcherByWc.get(wcId)?.dispose()
    diskWatcherByWc.delete(wcId)
    publicationReads.forget(wcId)
    openPathByWc.delete(wcId)
    allowedByWc.delete(wcId)
    savePathByWc.delete(wcId)
    dirtyByWc.delete(wcId)
    previewTextByWc.delete(wcId)
    previewSnapshots.destroy(wcId)
    closeSaveWaiters.get(wcId)?.(false)
    closeSaveWaiters.delete(wcId)
    closeCoordinator.destroy(wcId)
  })
}

function installExternalLinkOpener(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url, { allowedProtocols: ['http:', 'https:', 'mailto:'] })
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
}

/** A present view renders only the owner's preview (renderer route `?present=<owner wc id>`) */
function bindPresentView(wc: WebContents, ownerWcId: number, title: string): void {
  const wcId = wc.id
  presentOwnerByWc.set(wcId, ownerWcId)
  installExternalLinkOpener(wc)
  wc.once('destroyed',()=>{presentationCloses.destroy(wcId);presentOwnerByWc.delete(wcId)})
  const query = { present: String(ownerWcId), title }
  void wc.loadURL(rendererUrl(runtime.rendererUrl, 'html', query))
}

export function createHtmlPresentView(owner: WebContents, title: string): WebContentsView {
  registerHtmlIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  bindPresentView(view.webContents, owner.id, title)
  return view
}

/** hidden export windows: webContents id -> what the renderer must write */
const headlessExportTargets = new Map<number, HeadlessExportTarget>()
/** settled by the renderer's headless-export-done message (or by it dying) */
const headlessExportWaiters = new Map<number, (result: HeadlessHtmlReport) => void>()

interface HeadlessHtmlReport {
  ok: boolean
  error?: string
}

/**
 * Render `input` to `outPath` (PDF or Word) with no visible window: a hidden
 * html renderer opens the file through the normal pending-open queue and runs
 * the File menu's own export, which already renders in a second hidden window.
 */
export async function exportHtmlHeadless(
  input: string,
  outPath: string,
  format: HeadlessExportFormat = 'pdf',
  timeoutMs = 180_000,
): Promise<void> {
  registerHtmlIpc()
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 850,
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  const wcId = win.webContents.id
  grantAndTrack(win.webContents, input)
  headlessExportTargets.set(wcId, { outPath, format })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const report = await new Promise<HeadlessHtmlReport>((resolve) => {
      headlessExportWaiters.set(wcId, resolve)
      win.webContents.on('render-process-gone', (_event, details) =>
        resolve({ ok: false, error: `html renderer stopped (${details.reason})` }),
      )
      timer = setTimeout(
        () => resolve({ ok: false, error: `html export timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
      void win.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'html'))
    })
    if (!report.ok) throw new Error(report.error ?? 'html export failed')
  } finally {
    if (timer) clearTimeout(timer)
    headlessExportWaiters.delete(wcId)
    headlessExportTargets.delete(wcId)
    if (!win.isDestroyed()) win.destroy()
  }
}

export function createHtmlView(openPath?: string | null): WebContentsView {
  registerHtmlIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  grantAndTrack(view.webContents, openPath)
  void view.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'html'))
  return view
}

/** Standalone window mode: `npm run dev -w @vantage/html`, md path passed via argv */
export function startHtmlStandalone(): void {
  registerPrivilegedSchemes()
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  const standaloneRecoveryProfile = configureRecoveryProfile({ app, mode: 'gui', guiProfile: process.env.VANTAGE_USER_DATA || app.getPath('userData') })
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  initializeStandaloneRecovery({ app, ...standaloneRecoveryProfile, lockAcquired: true,
    warning: message => { void dialog.showMessageBox({ type: 'warning', message }).catch(() => {}) },
    terminal: cleanup => { app.once('will-quit', cleanup) },
  })
  configureHtmlRuntime({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
  })
  void app.whenReady().then(() => {
  // RECOVERY_BOOTSTRAP: runtime belongs to GUI startup, not handler registration.
    installRendererProtocol({ html: join(__dirname, '../renderer') })
    registerHtmlIpc()
    // shell mode leaves the shared ai:* search channels to docs-main registerAiIpc
    registerHtmlAiSearchIpc()
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
    const argPath = process.argv.slice(1).find((a) => /\.html?$/i.test(a) && existsSync(a))
    grantAndTrack(win.webContents, argPath)
    let closePreparing=false
    win.on('close',event=>{event.preventDefault();if(closePreparing)return;closePreparing=true;void(async()=>{let receipt:HtmlCloseReceipt|null=null;try{receipt=await prepareHtmlNativeClose(win.webContents,win);if(receipt)completeHtmlClose(win.webContents,receipt,()=>{if(win.isDestroyed())return false;win.destroy();return true})}catch(error){console.error('[html] close refused:',error)}finally{closePreparing=false;if(receipt)await cancelHtmlClose(win.webContents,receipt,'standalone HTML close finished')}})()})
    void win.loadURL(rendererUrl(runtime.rendererUrl, 'html'))
  })
  app.on('window-all-closed', () => app.quit())
}
