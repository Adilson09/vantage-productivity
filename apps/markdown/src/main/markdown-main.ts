import {
  withPinnedAssetOutput,
  publishSelectedUserOutput,
} from '@vantage/electron-utils/user-output-publication'
import {
  configureRecoveryProfile,
  initializeStandaloneRecovery,
  requireRecoveryRuntime,
} from '../../../../packages/electron-utils/src/recovery-bootstrap'
import {
  PublicationReadRegistry,
  observePublicationTarget,
  absentPublicationTarget,
} from '../../../../packages/electron-utils/src/document-publication'
import { NativeCloseAdmission } from '../../../../packages/electron-utils/src/native-close-admission'
import { beginCloseCleanup } from '../../../../packages/electron-utils/src/close-cleanup-runtime'
import type {
  CloseCleanupHandle,
  CloseCleanupAdmission,
} from '../../../../packages/electron-utils/src/close-cleanup'
import {
  MarkdownCloseCoordinator,
  runMarkdownNativeClose,
  markdownClosePermit,
  type MarkdownClosePrepareOptions,
} from './markdown-close-lease'
import type {
  MarkdownAssetCleanupReport,
  MarkdownCloseReceipt,
  MarkdownNativeCloseReceipt,
} from '../shared/markdown-close-lease'
import type {
  CloseLeaseTicket,
  CloseLeaseStamp,
} from '../../../../packages/electron-utils/src/close-lease'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import {
  discardDraftJournal,
  writeDraftJournal,
} from '../../../../packages/electron-utils/src/draft-journal'
import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} from 'electron'
import type { WebContents } from 'electron'
import {
  MAX_REMOTE_IMAGE_BYTES,
  configuredDefaultSaveDir,
  fetchRemoteImage,
  readBodyCapped,
  saveImageFromUrl,
  contextMenuLabels,
  installContextMenu,
  installNavigationGuard,
  isHeadlessMode,
  safeExternalUrl,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  installRendererProtocol,
  registerRendererScheme,
  rendererUrl,
} from '@vantage/electron-utils'
import { createI18n, getUiLang } from '@vantage/i18n'
import { generateImageTool, documentMediaRoots } from '@vantage/ai-search'
import { ImageExportSessions } from './image-export'
import { printMarkdownPdf } from './print-pdf'
import { atomicWriteFile } from './atomic-write'
import {
  createDocumentDiskWatcher,
  type DocumentDiskWatcher,
} from '@vantage/electron-utils/disk-watch'
import {
  copyImageIntoOwnedAssets,
  extractMarkdownImageSources,
  isInDocDir,
  pendingOwnedAssetsForDocument,
  prepareAssetsForSaveAs,
  reconcileOwnedAssets,
  renameOwnedAssetDocument,
  resolveSafeRelativeImagePath,
  resolveSafeVaultImagePath,
  resolveSourcePendingAfterSaveAs,
  rollbackPreparedSaveAsAssets,
  writeImageIntoOwnedAssets,
} from './asset-lifecycle'
import { createMarkdownConversionSession, writeMarkdownConversion } from './conversion-lifecycle'
import { normalizeMarkdownTheme, type MarkdownTheme } from '../shared/markdown-theme'
import { MARKDOWN_CHANNELS, MAX_PASTED_IMAGE_BYTES } from '../shared/ipc'
import type {
  ImageHostConfig,
  WikiBacklink,
  WikiCreateNoteRequest,
  WikiCreateNoteResult,
  WikiGraph,
  WikiLinkResolveRequest,
  WikiLinkResolved,
  WikiNoteEntry,
} from '../shared/ipc'
import { nodeFs, resolveWikiLinks } from './wiki-resolve'
import { listWikiNotes } from './wiki-notes'
import { createWikiNote } from './wiki-create'
import { nodeVaultFs, warmWikiIndex, wikiBacklinks, wikiGraph, wikiTags } from './wiki-index'
import { rememberWikiFragment, takeWikiFragment } from './wiki-fragment'
import { isImageHostUsable, normalizeImageHostConfig, uploadImageToHost } from './image-host'
import {
  EXPORT_IMAGE_EXTS,
  EXPORT_IMAGE_MIME_BY_EXT,
  remoteExportImageMime,
} from '../shared/export-image-mime'
import type {
  ExportDocxRequest,
  ExportFormat,
  ExportPdfRequest,
  ImageExportPreparation,
  ExportResult,
  ImageData,
  SaveMarkdownRequest,
  SaveMarkdownResult,
  SaveMode,
  MarkdownSaveCompletion,
} from '../shared/ipc'

const tDlg = createI18n({
  zh: {
    dlgSaveTitle: '保存 Markdown 文档',
    filterMarkdown: '文本文件 (Markdown, TXT, JSON)',
    dlgPickImage: '选择图片',
    dlgSaveImage: '保存图片',
    filterImages: '图片',
    untitledFile: '未命名文档',
    closeUnsavedMsg: '此文档有未保存的更改。',
    closeUnsavedDetail: '关闭前是否保存？',
    btnSave: '保存',
    btnDontSave: '不保存',
    btnCancel: '取消',
  },
  en: {
    dlgSaveTitle: 'Save Markdown Document',
    filterMarkdown: 'Text Files (Markdown, TXT, JSON)',
    dlgPickImage: 'Choose an Image',
    dlgSaveImage: 'Save Image',
    filterImages: 'Images',
    untitledFile: 'Untitled',
    closeUnsavedMsg: 'This document has unsaved changes.',
    closeUnsavedDetail: 'Do you want to save them before closing?',
    btnSave: 'Save',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
  },
  vi: {
    dlgSaveTitle: 'Lưu tài liệu Markdown',
    filterMarkdown: 'Tệp văn bản (Markdown, TXT, JSON)',
    dlgPickImage: 'Chọn một hình ảnh',
    dlgSaveImage: 'Lưu hình ảnh',
    filterImages: 'Hình ảnh',
    untitledFile: 'Không có tiêu đề',
    closeUnsavedMsg: 'Tài liệu này có những thay đổi chưa được lưu.',
    closeUnsavedDetail: 'Bạn có muốn lưu các thay đổi trước khi đóng không?',
    btnSave: 'Lưu',
    btnDontSave: 'Không lưu',
    btnCancel: 'Hủy',
  },
  tr: {
    dlgSaveTitle: 'Markdown belgesini kaydet',
    filterMarkdown: 'Metin dosyaları (Markdown, TXT, JSON)',
    dlgPickImage: 'Bir görsel seçin',
    dlgSaveImage: 'Görseli kaydet',
    filterImages: 'Görseller',
    untitledFile: 'Adsız',
    closeUnsavedMsg: 'Bu belge kaydedilmemiş değişiklikler içeriyor.',
    closeUnsavedDetail: 'Kapatmadan önce değişiklikleri kaydetmek istiyor musunuz?',
    btnSave: 'Kaydet',
    btnDontSave: 'Kaydetme',
    btnCancel: 'İptal',
  },
  ja: {
    dlgSaveTitle: 'Markdown ドキュメントを保存',
    filterMarkdown: 'テキストファイル (Markdown, TXT, JSON)',
    dlgPickImage: '画像を選択',
    dlgSaveImage: '画像を保存',
    filterImages: '画像',
    untitledFile: '無題',
    closeUnsavedMsg: 'このドキュメントに未保存の変更があります。',
    closeUnsavedDetail: '閉じる前に保存しますか？',
    btnSave: '保存',
    btnDontSave: '保存しない',
    btnCancel: 'キャンセル',
  },
  ko: {
    dlgSaveTitle: 'Markdown 문서 저장',
    filterMarkdown: '텍스트 파일 (Markdown, TXT, JSON)',
    dlgPickImage: '이미지 선택',
    dlgSaveImage: '이미지 저장',
    filterImages: '이미지',
    untitledFile: '제목 없음',
    closeUnsavedMsg: '이 문서에 저장하지 않은 변경 사항이 있습니다.',
    closeUnsavedDetail: '닫기 전에 저장하시겠습니까?',
    btnSave: '저장',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
  },
  fr: {
    dlgSaveTitle: 'Enregistrer le document Markdown',
    filterMarkdown: 'Fichiers texte (Markdown, TXT, JSON)',
    dlgPickImage: 'Choisir une image',
    dlgSaveImage: "Enregistrer l'image",
    filterImages: 'Images',
    untitledFile: 'Sans titre',
    closeUnsavedMsg: 'Ce document contient des modifications non enregistrées.',
    closeUnsavedDetail: 'Voulez-vous les enregistrer avant de fermer ?',
    btnSave: 'Enregistrer',
    btnDontSave: 'Ne pas enregistrer',
    btnCancel: 'Annuler',
  },
  de: {
    dlgSaveTitle: 'Markdown-Dokument speichern',
    filterMarkdown: 'Textdateien (Markdown, TXT, JSON)',
    dlgPickImage: 'Bild auswählen',
    dlgSaveImage: 'Bild speichern',
    filterImages: 'Bilder',
    untitledFile: 'Unbenannt',
    closeUnsavedMsg: 'Dieses Dokument enthält ungespeicherte Änderungen.',
    closeUnsavedDetail: 'Vor dem Schließen speichern?',
    btnSave: 'Speichern',
    btnDontSave: 'Nicht speichern',
    btnCancel: 'Abbrechen',
  },
  es: {
    dlgSaveTitle: 'Guardar documento Markdown',
    filterMarkdown: 'Archivos de texto (Markdown, TXT, JSON)',
    dlgPickImage: 'Elegir imagen',
    dlgSaveImage: 'Guardar imagen',
    filterImages: 'Imágenes',
    untitledFile: 'Sin título',
    closeUnsavedMsg: 'Este documento tiene cambios sin guardar.',
    closeUnsavedDetail: '¿Quieres guardarlos antes de cerrar?',
    btnSave: 'Guardar',
    btnDontSave: 'No guardar',
    btnCancel: 'Cancelar',
  },
  th: {
    dlgSaveTitle: 'บันทึกเอกสาร Markdown',
    filterMarkdown: 'ไฟล์ข้อความ (Markdown, TXT, JSON)',
    dlgPickImage: 'เลือกรูปภาพ',
    dlgSaveImage: 'บันทึกรูปภาพ',
    filterImages: 'รูปภาพ',
    untitledFile: 'ไม่มีชื่อ',
    closeUnsavedMsg: 'เอกสารนี้มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก',
    closeUnsavedDetail: 'ต้องการบันทึกก่อนปิดหรือไม่?',
    btnSave: 'บันทึก',
    btnDontSave: 'ไม่บันทึก',
    btnCancel: 'ยกเลิก',
  },
  id: {
    dlgSaveTitle: 'Simpan dokumen Markdown',
    filterMarkdown: 'File teks (Markdown, TXT, JSON)',
    dlgPickImage: 'Pilih gambar',
    dlgSaveImage: 'Simpan Gambar',
    filterImages: 'Gambar',
    untitledFile: 'Tanpa judul',
    closeUnsavedMsg: 'Dokumen ini memiliki perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
  },
  ru: {
    dlgSaveTitle: 'Сохранить документ Markdown',
    filterMarkdown: 'Текстовые файлы (Markdown, TXT, JSON)',
    dlgPickImage: 'Выберите изображение',
    dlgSaveImage: 'Сохранить изображение',
    filterImages: 'Изображения',
    untitledFile: 'Без названия',
    closeUnsavedMsg: 'В этом документе есть несохранённые изменения.',
    closeUnsavedDetail: 'Сохранить их перед закрытием?',
    btnSave: 'Сохранить',
    btnDontSave: 'Не сохранять',
    btnCancel: 'Отмена',
  },
  ar: {
    dlgSaveTitle: 'حفظ مستند Markdown',
    filterMarkdown: 'ملفات نصية (Markdown, TXT, JSON)',
    dlgPickImage: 'اختر صورة',
    dlgSaveImage: 'حفظ الصورة',
    filterImages: 'صور',
    untitledFile: 'بدون عنوان',
    closeUnsavedMsg: 'يحتوي هذا المستند على تغييرات غير محفوظة.',
    closeUnsavedDetail: 'هل تريد حفظها قبل الإغلاق؟',
    btnSave: 'حفظ',
    btnDontSave: 'عدم الحفظ',
    btnCancel: 'إلغاء',
  },
  pt: {
    dlgSaveTitle: 'Salvar documento Markdown',
    filterMarkdown: 'Arquivos de texto (Markdown, TXT, JSON)',
    dlgPickImage: 'Escolher imagem',
    dlgSaveImage: 'Salvar imagem',
    filterImages: 'Imagens',
    untitledFile: 'Sem título',
    closeUnsavedMsg: 'Este documento tem alterações não salvas.',
    closeUnsavedDetail: 'Deseja salvá-las antes de fechar?',
    btnSave: 'Salvar',
    btnDontSave: 'Não Salvar',
    btnCancel: 'Cancelar',
  },
  it: {
    dlgSaveTitle: 'Salva documento Markdown',
    filterMarkdown: 'File di testo (Markdown, TXT, JSON)',
    dlgPickImage: 'Scegli immagine',
    dlgSaveImage: 'Salva immagine',
    filterImages: 'Immagini',
    untitledFile: 'Senza titolo',
    closeUnsavedMsg: 'Questo documento contiene modifiche non salvate.',
    closeUnsavedDetail: 'Vuoi salvarle prima di chiudere?',
    btnSave: 'Salva',
    btnDontSave: 'Non salvare',
    btnCancel: 'Annulla',
  },
  pl: {
    dlgSaveTitle: 'Zapisz dokument Markdown',
    filterMarkdown: 'Pliki tekstowe (Markdown, TXT, JSON)',
    dlgPickImage: 'Wybierz obraz',
    dlgSaveImage: 'Zapisz obraz',
    filterImages: 'Obrazy',
    untitledFile: 'Bez tytułu',
    closeUnsavedMsg: 'Ten dokument ma niezapisane zmiany.',
    closeUnsavedDetail: 'Czy zapisać je przed zamknięciem?',
    btnSave: 'Zapisz',
    btnDontSave: 'Nie zapisuj',
    btnCancel: 'Anuluj',
  },
  cs: {
    dlgSaveTitle: 'Uložit dokument Markdown',
    filterMarkdown: 'Textové soubory (Markdown, TXT, JSON)',
    dlgPickImage: 'Vyberte obrázek',
    dlgSaveImage: 'Uložit obrázek',
    filterImages: 'Obrázky',
    untitledFile: 'Bez názvu',
    closeUnsavedMsg: 'Tento dokument má neuložené změny.',
    closeUnsavedDetail: 'Chcete je před zavřením uložit?',
    btnSave: 'Uložit',
    btnDontSave: 'Neukládat',
    btnCancel: 'Zrušit',
  },
  nl: {
    dlgSaveTitle: 'Markdown-document opslaan',
    filterMarkdown: 'Tekstbestanden (Markdown, TXT, JSON)',
    dlgPickImage: 'Kies een afbeelding',
    dlgSaveImage: 'Afbeelding opslaan',
    filterImages: 'Afbeeldingen',
    untitledFile: 'Naamloos',
    closeUnsavedMsg: 'Dit document bevat niet-opgeslagen wijzigingen.',
    closeUnsavedDetail: 'Wilt u ze opslaan voordat u sluit?',
    btnSave: 'Opslaan',
    btnDontSave: 'Niet opslaan',
    btnCancel: 'Annuleren',
  },
  ms: {
    dlgSaveTitle: 'Simpan dokumen Markdown',
    filterMarkdown: 'Fail teks (Markdown, TXT, JSON)',
    dlgPickImage: 'Pilih imej',
    dlgSaveImage: 'Simpan Imej',
    filterImages: 'Imej',
    untitledFile: 'Tanpa tajuk',
    closeUnsavedMsg: 'Dokumen ini mempunyai perubahan yang belum disimpan.',
    closeUnsavedDetail: 'Simpan sebelum menutup?',
    btnSave: 'Simpan',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
  },
  he: {
    dlgSaveTitle: 'שמירת מסמך Markdown',
    filterMarkdown: 'קובצי טקסט (Markdown, TXT, JSON)',
    dlgPickImage: 'בחרו תמונה',
    dlgSaveImage: 'שמור תמונה',
    filterImages: 'תמונות',
    untitledFile: 'ללא שם',
    closeUnsavedMsg: 'במסמך הזה יש שינויים שלא נשמרו.',
    closeUnsavedDetail: 'האם לשמור אותם לפני הסגירה?',
    btnSave: 'שמירה',
    btnDontSave: 'אל תשמור',
    btnCancel: 'ביטול',
  },
  hi: {
    dlgSaveTitle: 'Markdown दस्तावेज़ सहेजें',
    filterMarkdown: 'पाठ फ़ाइलें (Markdown, TXT, JSON)',
    dlgPickImage: 'छवि चुनें',
    dlgSaveImage: 'छवि सहेजें',
    filterImages: 'छवियाँ',
    untitledFile: 'शीर्षकहीन',
    closeUnsavedMsg: 'इस दस्तावेज़ में सहेजे नहीं गए परिवर्तन हैं।',
    closeUnsavedDetail: 'क्या बंद करने से पहले उन्हें सहेजना चाहते हैं?',
    btnSave: 'सहेजें',
    btnDontSave: 'न सहेजें',
    btnCancel: 'रद्द करें',
  },
  'zh-TW': {
    dlgSaveTitle: '儲存 Markdown 文件',
    filterMarkdown: '文字檔 (Markdown, TXT, JSON)',
    dlgPickImage: '選擇圖片',
    dlgSaveImage: '儲存圖片',
    filterImages: '圖片',
    untitledFile: '未命名文件',
    closeUnsavedMsg: '此文件有未儲存的變更。',
    closeUnsavedDetail: '關閉前是否儲存？',
    btnSave: '儲存',
    btnDontSave: '不儲存',
    btnCancel: '取消',
  },
})
type DlgKey =
  | 'dlgSaveTitle'
  | 'filterMarkdown'
  | 'dlgPickImage'
  | 'dlgSaveImage'
  | 'filterImages'
  | 'untitledFile'
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
  /** Shell router used to open exported PDFs in a new Vantage tab. */
  openGeneratedPath?: (path: string) => boolean
}

let runtime: RuntimePaths = { preloadPath: '' }

export function configureMarkdownRuntime(paths: RuntimePaths): void {
  runtime = paths
}

/** After a successful Markdown → PDF export: open the file in a PDF tab (shell)
 * or reveal it in the folder (standalone). Tab-opening failure must not
 * report the export itself as failed — the file is already persisted. */
function openExportedPdf(path: string): void {
  // Headless export must stay silent: no tab, no Finder window.
  if (isHeadlessMode()) return
  try {
    if (runtime.openGeneratedPath?.(path)) return
  } catch (err) {
    console.warn('[markdown] Failed to open exported PDF:', err)
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
const publicationReads = new PublicationReadRegistry<number>()
/** Unsaved-changes flags mirrored from the renderer; drives the save prompt before closing a tab/window */
const dirtyByWc = new Set<number>()
const draftByWc = new Map<number, string>()
const discardedDraftFloor = new Map<number, CloseLeaseStamp>()
interface MarkdownJournalBinding {
  receiptSequence: number
  expectedDocumentPath: string | null
  expectedSha256: string
}
interface MarkdownDraftEpoch {
  id: string
  retired: 'discard' | 'preserve' | null
  writes: Set<Promise<MarkdownJournalBinding | null>>
  receiptSequence: number
  lastWriteBinding: MarkdownJournalBinding | null
}
const draftEpochByWc = new Map<number, MarkdownDraftEpoch>()
function rotateMarkdownDraft(
  owner: number,
  disposition: 'discard' | 'preserve' = 'preserve',
): void {
  const previous = draftEpochByWc.get(owner)
  if (previous && previous.retired === null) previous.retired = disposition
  const id = randomUUID()
  draftEpochByWc.set(owner, {
    id,
    retired: null,
    writes: new Set(),
    receiptSequence: 0,
    lastWriteBinding: null,
  })
  draftByWc.set(owner, id)
}
/** Baseline plus accepted writer results are sealed independently of any later cancel/resume. */
function capturedMarkdownJournal(epoch: MarkdownDraftEpoch | undefined) {
  let sealed = epoch?.lastWriteBinding ?? null,
    drained = false
  const accepted = [...(epoch?.writes ?? [])]
  const ready = Promise.allSettled(accepted).then((results) => {
    for (const result of results)
      if (
        result.status === 'fulfilled' &&
        result.value &&
        (!sealed || result.value.receiptSequence > sealed.receiptSequence)
      )
        sealed = result.value
    drained = true
  })
  const attest = () => {
    if (!drained)
      throw new Error(
        'The captured Markdown journal writer drain is unfinished; its prior copy is retained.',
      )
    return sealed
      ? { expectedDocumentPath: sealed.expectedDocumentPath, expectedSha256: sealed.expectedSha256 }
      : null
  }
  return { ready, attest }
}
const draftRoot = () =>
  process.env.VANTAGE_RECOVERY_ROOT || join(app.getPath('userData'), 'recovery')
const closeSaveWaiters = new Map<number, (ok: boolean) => void>()
/** Actual writers and close permission outlive caller promise timeouts. */
function currentTopSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame
}
function beginMarkdownMutation(
  event: Electron.IpcMainInvokeEvent,
  requestId?: unknown,
  stamp?: CloseLeaseStamp,
) {
  if (!currentTopSender(event)) throw new Error('The source sender frame is obsolete.')
  return closeCoordinator.beginMutation(event.sender.id, requestId, stamp)
}
const markdownContents = new Map<number, WebContents>()
const markdownCleanup = new Map<number, Promise<void>>()
interface MarkdownCloseCustody {
  owner: number
  ticket: CloseLeaseTicket
  receipt: MarkdownCloseReceipt
  handle?: CloseCleanupHandle
  admission?: CloseCleanupAdmission
  cancelProducer: () => void
  canceled: boolean
  removed: boolean
}
const markdownCustodyByTicket = new Map<string, MarkdownCloseCustody>()
const markdownCustodyByReceipt = new WeakMap<MarkdownCloseReceipt, MarkdownCloseCustody>()
function updateMarkdownCustody(record: MarkdownCloseCustody): void {
  if (!record.handle) return
  const status = record.handle.status()
  record.receipt.journalCleanup = status
  if (record.receipt.cleanup)
    record.receipt.cleanup.journal =
      status.phase === 'complete'
        ? 'complete'
        : status.phase === 'retained'
          ? 'retained'
          : status.phase === 'canceled'
            ? 'canceled'
            : status.phase === 'running' || status.phase === 'committing'
              ? 'running'
              : 'staged'
}
function cancelMarkdownCustody(record: MarkdownCloseCustody, reason: string): void {
  if (record.removed) return
  record.canceled = true
  record.admission?.cancel(reason)
  record.handle?.cancel(reason)
  record.cancelProducer()
  updateMarkdownCustody(record)
  markdownCustodyByTicket.delete(record.ticket.id)
}
function releaseMarkdownCustody(owner: number, ticket: CloseLeaseTicket, reason: string): void {
  const record = markdownCustodyByTicket.get(ticket.id)
  if (
    !record ||
    record.owner !== owner ||
    record.ticket.sequence !== ticket.sequence ||
    record.ticket.source !== ticket.source
  )
    return
  if (!record.removed) cancelMarkdownCustody(record, reason)
  else markdownCustodyByTicket.delete(ticket.id)
}
const deferredReleases = new Map<number, Array<{ ticket: CloseLeaseTicket; reason: string }>>()
const nativeCloseAdmission = new NativeCloseAdmission<number>()
const closeCoordinator = new MarkdownCloseCoordinator({
  alive: (owner) => !!markdownContents.get(owner) && !markdownContents.get(owner)!.isDestroyed(),
  pathAllowed: (owner, path) => allowedByWc.get(owner)?.has(path) === true,
  send: (owner, mode, request) =>
    markdownContents.get(owner)!.send(MARKDOWN_CHANNELS.saveRequest, mode, request),
  release: (owner, ticket, reason) => {
    releaseMarkdownCustody(owner, ticket, reason)
    if (markdownCleanup.has(owner)) {
      deferredReleases.set(owner, [...(deferredReleases.get(owner) ?? []), { ticket, reason }])
      return
    }
    const contents = markdownContents.get(owner)
    if (contents && !contents.isDestroyed())
      contents.send(MARKDOWN_CHANNELS.closeLeaseRelease, ticket, reason)
  },
})
async function waitForMarkdownCleanup(owner: number): Promise<void> {
  await markdownCleanup.get(owner)
}
function assertNoMarkdownCleanup(owner: number): void {
  if (markdownCleanup.has(owner))
    throw new Error('Approved discard cleanup is still finishing; no new writer was delivered.')
}
/** Resolvers for MCP reads of the live document text, resolved by the renderer's reply */
const readTextWaiters = new Map<number, (result: { text: string } | { error: string }) => void>()
/** one read per tab at a time: concurrent callers share this promise */
const readTextInFlight = new Map<number, Promise<string>>()
const vaultFs = nodeFs()

/** Fired after a save lands on a NEW path (untitled first save / Save As) — the shell syncs tab title, recents, projects */
let fileSavedHook: ((wc: WebContents, path: string) => void) | null = null

export function setMarkdownFileSavedHook(hook: (wc: WebContents, path: string) => void): void {
  fileSavedHook = hook
}

/** Fired after a "convert & open in Docs" export — the shell routes the new .docx to a docs tab */
let docxExportedHook: ((path: string) => void) | null = null
/** One marked cache session per app process. Old crash leftovers are removed after seven days. */
let conversionSessionPromise: Promise<string> | null = null

export function setMarkdownDocxExportedHook(hook: (path: string) => void): void {
  docxExportedHook = hook
}

function markdownConversionSession(): Promise<string> {
  conversionSessionPromise ??= createMarkdownConversionSession(
    join(app.getPath('userData'), 'markdown-conversions'),
  )
  return conversionSessionPromise
}

/** Shell menu export entry: ask the renderer to serialize and run the export flow */
export function sendMarkdownExportRequest(contents: WebContents, format: ExportFormat): void {
  if (!contents.isDestroyed()) contents.send(MARKDOWN_CHANNELS.exportRequest, format)
}

/** Shell menu Print: ask the renderer to build the print HTML and open the system dialog */
export function sendMarkdownPrintRequest(contents: WebContents): void {
  if (!contents.isDestroyed()) contents.send(MARKDOWN_CHANNELS.printRequest)
}

export function markdownIsDirty(webContentsId: number): boolean {
  return dirtyByWc.has(webContentsId)
}

export function markdownFilePath(webContentsId: number): string | undefined {
  return savePathByWc.get(webContentsId)
}

/** The file was renamed on disk — re-grant the new path and tell the renderer */
export async function markdownFileRenamed(
  contents: WebContents,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const wcId = contents.id
  if (savePathByWc.get(wcId) !== oldPath) return
  closeCoordinator.cancel(wcId, undefined, 'source renamed')
  allowedByWc.get(wcId)?.delete(oldPath)
  const publicationSession = closeCoordinator.session(wcId)
  await publicationReads.rebind(
    wcId,
    publicationSession,
    oldPath,
    newPath,
    () =>
      !contents.isDestroyed() &&
      closeCoordinator.session(wcId) === publicationSession &&
      savePathByWc.get(wcId) === oldPath,
  )

  if (savePathByWc.get(wcId) === oldPath) savePathByWc.set(wcId, newPath)
  if (openPathByWc.get(wcId) === oldPath) openPathByWc.set(wcId, newPath)
  const allowed = allowedByWc.get(wcId)
  if (allowed) allowed.add(newPath)
  if (savePathByWc.get(wcId) === newPath) await diskWatcherByWc.get(wcId)?.watch(newPath)
  await renameOwnedAssetDocument(oldPath, newPath).catch((error) => {
    console.warn('[markdown] asset manifest rename sync failed:', error)
  })
  if (!contents.isDestroyed()) contents.send(MARKDOWN_CHANNELS.fileRenamed, newPath)
}

/** Legacy Boolean approval is intentionally unavailable: removal must consume a live lease. */
export async function requestMarkdownClose(
  _contents: WebContents,
  _parent?: BrowserWindow | null,
): Promise<boolean> {
  return false
}

/**
 * Drop assets staged next to the document but never written into it — the MCP
 * "discard unsaved changes" path, same cleanup the interactive close prompt
 * runs when the user picks "Don't Save".
 */
export async function markdownDiscardPendingAssets(contents: WebContents): Promise<void> {
  void contents
  throw new Error('Discard requires a captured intent and a held renderer close lease.')
}

/** Ordinary Save reports real publication independently of final close permission. */
export function requestMarkdownSave(contents: WebContents, mode: SaveMode): Promise<boolean> {
  if (contents.isDestroyed() || closeCoordinator.pending(contents.id)) return Promise.resolve(false)
  return closeCoordinator.request(contents.id, mode).then(
    (result) => result.published || (result.current && result.clean),
    () => false,
  )
}
/**
 * Read the live document text for an MCP `open_documents` read. Unlike reading
 * the file from disk this includes unsaved edits, which is the whole point of
 * reading an *open* document.
 *
 * Concurrent reads of the same tab share one request: the waiter slot below
 * holds a single resolver, so a second in-flight read would overwrite the first
 * and strand it until its 30s timeout (the same trap the docs close-state query
 * guards against).
 */
export function markdownReadText(contents: WebContents): Promise<string> {
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
      contents.send(MARKDOWN_CHANNELS.readTextRequest)
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
    contents.send(MARKDOWN_CHANNELS.readTextRequest)
  })
  readTextInFlight.set(wcId, request)
  return request
}

/** The target belongs to this request until an actual publication adopts it. */
export async function markdownSaveToPath(
  contents: WebContents,
  filePath: string,
): Promise<MarkdownAssetCleanupReport | void> {
  if (!isAbsolute(filePath) || filePath.includes('\0'))
    throw new Error('Markdown Save requires an absolute destination.')
  const sourceAtRequest = closeCoordinator.source(contents.id),
    targetVersion =
      savePathByWc.get(contents.id) === filePath
        ? undefined
        : await observePublicationTarget(filePath)
  if (contents.isDestroyed() || closeCoordinator.source(contents.id) !== sourceAtRequest)
    throw new Error('The source changed while the explicit destination was being checked.')
  const result = await closeCoordinator.request(
    contents.id,
    'save',
    filePath,
    false,
    'save',
    undefined,
    {},
    targetVersion,
  )
  if (!result.published && !(result.current && result.clean))
    throw new Error(result.error ?? 'The file was not published.')
  if (result.assetCleanup || result.warnings?.length)
    return { assetCleanup: result.assetCleanup, warnings: result.warnings }
}
export async function prepareMarkdownClose(
  contents: WebContents,
  filePath?: string,
  intent: 'save' | 'discard' | 'clean' = 'save',
  approved?: CloseLeaseStamp,
  options: MarkdownClosePrepareOptions = {},
): Promise<MarkdownNativeCloseReceipt> {
  const permit = Object.freeze({
    deferSeal: options.deferSeal === true,
    signal: options.signal,
    isCurrent: options.isCurrent,
  })
  if (!markdownClosePermit(permit))
    throw new Error('The close operation ended before Save or custody was requested.')
  if (filePath !== undefined && (!isAbsolute(filePath) || filePath.includes('\0')))
    throw new Error('Markdown close Save requires an absolute destination.')
  assertNoMarkdownCleanup(contents.id)
  if (intent === 'discard' && !approved) approved = closeCoordinator.state(contents.id)?.stamp
  const sourceAtTarget = closeCoordinator.source(contents.id),
    targetVersion =
      intent === 'save' && filePath !== undefined && savePathByWc.get(contents.id) !== filePath
        ? await observePublicationTarget(filePath)
        : undefined
  if (
    contents.isDestroyed() ||
    closeCoordinator.source(contents.id) !== sourceAtTarget ||
    !markdownClosePermit(permit)
  )
    throw new Error(
      'The source or close operation changed while its destination was being checked.',
    )
  const result = await closeCoordinator.request(
    contents.id,
    'save',
    filePath,
    true,
    intent,
    approved,
    { ...permit, deferSeal: true },
    targetVersion,
  )
  if (!markdownClosePermit(permit)) {
    if (result.closeLease)
      closeCoordinator.cancel(
        contents.id,
        result.closeLease.ticket,
        'The group ended after renderer preparation.',
      )
    throw new Error('This close attempt was canceled before recovery was prepared.')
  }
  if (result.phase !== 'prepared' || !result.closeLease || !result.current)
    throw new Error(result.error ?? 'The current editor could not be held for close.')
  if (intent === 'discard') {
    const owner = contents.id,
      oldEpoch = draftEpochByWc.get(owner),
      oldDraft = oldEpoch?.id ?? randomUUID(),
      documentPath = savePathByWc.get(owner) ?? null,
      recoveryRoot = draftRoot()
    // Retire and drain the captured producer; KEEP its journal until actual removal.
    discardedDraftFloor.set(owner, { ...result.closeLease.stamp })
    rotateMarkdownDraft(owner, 'preserve')
    const replacementEpoch = draftEpochByWc.get(owner),
      approvedSource = result.closeLease.stamp.source
    const cancelProducer = () => {
      if (
        oldEpoch &&
        replacementEpoch &&
        draftEpochByWc.get(owner) === replacementEpoch &&
        !contents.isDestroyed() &&
        closeCoordinator.state(owner)?.stamp.source === approvedSource
      ) {
        replacementEpoch.retired = 'preserve'
        oldEpoch.retired = null
        draftEpochByWc.set(owner, oldEpoch)
        draftByWc.set(owner, oldEpoch.id)
      }
    }
    const journal = capturedMarkdownJournal(oldEpoch)
    const record: MarkdownCloseCustody = {
      owner,
      ticket: result.closeLease.ticket,
      receipt: result,
      cancelProducer,
      canceled: false,
      removed: false,
    }
    markdownCustodyByTicket.set(record.ticket.id, record)
    markdownCustodyByReceipt.set(result, record)
    let actualSettlement: Promise<void> = Promise.resolve()
    const cleanup = (async () => {
      if (!markdownClosePermit(permit))
        throw new Error('The close group ended before custody admission.')
      // Register lineage now; the shared service tracks the prior writer drain.
      const admission = beginCloseCleanup({
        ready: journal.ready,
        id: 'markdown:' + result.requestId,
        module: 'markdown',
        ownerKey: record.ticket.source,
        source: result.closeLease!.stamp.source,
        generation: record.ticket.sequence,
        token: oldDraft,
        documentPath,
        custody: { recoveryRoot, draftId: oldDraft, attest: journal.attest },
        run: async (signal) => {
          if (signal.aborted) throw new Error('Captured journal cleanup was canceled.')
          if (!record.handle?.status().custody) return
          const binding = journal.attest()
          if (!binding)
            throw new Error(
              'Captured Markdown journal binding is unknown; its recovery bytes were retained.',
            )
          await discardDraftJournal(recoveryRoot, oldDraft, {
            expectedSha256: binding.expectedSha256,
          })
        },
      })
      record.admission = admission
      actualSettlement = admission.actualSettled
      record.handle = await admission.ready
      await admission.actualSettled
      if (!markdownClosePermit(permit)) throw new Error('This close attempt was canceled.')
      if (record.canceled)
        record.handle.cancel('Close permission ended while recovery custody was being prepared.')
      const retained = documentPath ? await pendingOwnedAssetsForDocument(documentPath) : []
      if (!markdownClosePermit(permit)) throw new Error('This close attempt was canceled.')
      result.cleanup = {
        journal: 'staged',
        assets: retained.length ? 'retained' : 'none',
        ...(retained.length ? { retainedAssets: retained.length } : {}),
      }
      updateMarkdownCustody(record)
      if (retained.length) {
        const warning =
          'Staged image files were retained because this view cannot prove exclusive ownership; another copy may use them.'
        result.warnings = [warning]
        console.warn('[markdown] discard asset retention:', warning)
      }
      if (record.canceled)
        throw new Error(
          'Close permission expired while the protected recovery copy was being prepared; the document remains open.',
        )
    })()
    // A ready timeout may reject promptly; the actual provider/finalizers keep their slot and renderer lock.
    const actual = cleanup
      .finally(() => actualSettlement)
      .finally(() => {
        if (markdownCleanup.get(owner) !== actual) return
        markdownCleanup.delete(owner)
        for (const release of deferredReleases.get(owner) ?? []) {
          if (!contents.isDestroyed())
            contents.send(MARKDOWN_CHANNELS.closeLeaseRelease, release.ticket, release.reason)
        }
        deferredReleases.delete(owner)
      })
    void actual.catch(() => {})
    markdownCleanup.set(owner, actual)
    try {
      await cleanup
      await actual
    } catch (error) {
      cancelMarkdownCustody(record, 'recovery staging did not finish')
      closeCoordinator.cancel(owner, result.closeLease.ticket, 'recovery staging failed')
      throw error
    }
  }
  if (!markdownClosePermit(permit) || !isMarkdownClosePrepared(contents, result)) {
    if (result.closeLease)
      closeCoordinator.cancel(
        contents.id,
        result.closeLease.ticket,
        'The close operation expired before its final seal.',
      )
    throw new Error('The document changed before it could close.')
  }
  if (permit.deferSeal) return result as MarkdownNativeCloseReceipt
  const ready = sealMarkdownClose(contents, result)
  if (!ready) throw new Error('The document changed before it could close.')
  return ready
}
export function isMarkdownClosePrepared(
  contents: WebContents,
  receipt: MarkdownCloseReceipt,
): boolean {
  if (contents.isDestroyed() || markdownCleanup.has(contents.id)) return false
  const staged = markdownCustodyByReceipt.get(receipt)
  return (
    (!staged || (!staged.canceled && !!staged.handle)) &&
    closeCoordinator.isPrepared(contents.id, receipt)
  )
}
export function sealMarkdownClose(
  contents: WebContents,
  receipt: MarkdownCloseReceipt,
): MarkdownNativeCloseReceipt | null {
  if (!isMarkdownClosePrepared(contents, receipt)) return null
  const ready = closeCoordinator.seal(contents.id, receipt)
  if (!ready) return null
  const staged = markdownCustodyByReceipt.get(receipt)
  if (staged) {
    staged.receipt = ready
    markdownCustodyByReceipt.set(ready, staged)
    markdownCustodyByReceipt.delete(receipt)
  }
  return ready
}
export function completeMarkdownClose(
  contents: WebContents,
  receipt: MarkdownCloseReceipt,
  remove: () => boolean,
): boolean {
  if (markdownCleanup.has(contents.id)) return false
  const staged = markdownCustodyByReceipt.get(receipt)
  if (staged && (staged.canceled || !staged.handle)) return false
  try {
    return closeCoordinator.complete(contents.id, receipt, () =>
      staged
        ? staged.handle!.commitRemoval(() => {
            const removed = remove()
            if (removed) staged.removed = true
            return removed
          })
        : remove(),
    )
  } finally {
    if (staged) updateMarkdownCustody(staged)
  }
}
export async function cancelMarkdownClose(
  contents: WebContents,
  receipt: MarkdownCloseReceipt,
  reason = 'close cancelled',
): Promise<void> {
  if (!receipt.closeLease) return
  closeCoordinator.cancel(contents.id, receipt.closeLease.ticket, reason)
  await waitForMarkdownCleanup(contents.id)
  const staged = markdownCustodyByReceipt.get(receipt)
  if (staged && !staged.removed) cancelMarkdownCustody(staged, reason)
}
/** Prompt approval is bound to the exact authored revision the user was shown. */
export async function prepareMarkdownNativeClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
  options: MarkdownClosePrepareOptions = {},
): Promise<MarkdownNativeCloseReceipt | null> {
  return runMarkdownNativeClose(
    {
      holdAutomaticSaves: () => nativeCloseAdmission.hold(contents.id, contents.id),
      alive: () => !contents.isDestroyed(),
      state: () => closeCoordinator.state(contents.id),
      retainedAssets: async () => {
        const path = savePathByWc.get(contents.id)
        return path ? pendingOwnedAssetsForDocument(path) : []
      },
      prompt: async (retainedCount) => {
        const detail =
          tm('closeUnsavedDetail') +
          (retainedCount
            ? ' Unpublished image files will stay on disk when you discard, because another copy may use them.'
            : '')
        const promptOptions = {
          type: 'warning' as const,
          message: tm('closeUnsavedMsg'),
          detail,
          buttons: [tm('btnSave'), tm('btnDontSave'), tm('btnCancel')],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        }
        const { response } =
          parent && !parent.isDestroyed()
            ? await dialog.showMessageBox(parent, promptOptions)
            : await dialog.showMessageBox(promptOptions)
        return response
      },
      prepare: (intent, approved, permit) =>
        prepareMarkdownClose(contents, undefined, intent, approved, permit),
      cancel: (receipt) =>
        cancelMarkdownClose(contents, receipt, 'The native close group ended after preparation.'),
    },
    options,
  )
}
async function confirmPublicationChoice(
  e: Electron.IpcMainInvokeEvent,
  target: string,
  mustExist = false,
) {
  const selected = await observePublicationTarget(target)
  if (mustExist && !selected.version)
    throw new Error(
      'The original document was moved or deleted. Save As a separate copy; current edits are retained.',
    )
  if (!selected.version) return selected
  const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined,
    choice = {
      type: 'warning' as const,
      message: 'Replace the selected file?',
      detail:
        target +
        '\nThe exact version now on disk will be replaced. A later change will stop this save.',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }
  const answer =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, choice)
      : await dialog.showMessageBox(choice)
  return answer.response === 0 ? selected : null
}

/**
 * A file-name stem from an untrusted source (a model's answer, or a heading).
 *
 * The answer is a bare string from outside the app, so it goes through the same
 * filter whichever name it is destined for: a stem carrying a separator, a
 * control character, or a trailing dot would otherwise become a path the save
 * refuses, or worse, writes somewhere else. Empty when nothing usable is left.
 */
function fileNameStem(raw: string | undefined): string {
  return (raw ?? '')
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
    const base = fileNameStem(suggestedName)
    if (base) {
      const dir = configuredDefaultSaveDir(app)
      let target = join(dir, `${base}.md`)
      for (let n = 1; existsSync(target); n++) target = join(dir, `${base}-${n}.md`)
      return target
    }
  }
  const win =
    BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
  // A name proposed by the model (or the document's first heading) prefills the
  // dialog rather than replacing it: the reader still chooses the location, and
  // cancelling still cancels. Without one, the dialog opens on the file's own
  // name, or on the untitled default for a document that has never been saved.
  const proposed = fileNameStem(defaultName)
  const defaultPath = proposed
    ? // keep the open file's extension: a .md proposal must not offer to
      // rewrite an opened .markdown (or .txt) file as a different format
      join(
        current ? dirname(current) : configuredDefaultSaveDir(app),
        `${proposed}${current ? extname(current) : '.md'}`,
      )
    : current
      ? join(dirname(current), basename(current))
      : join(configuredDefaultSaveDir(app), `${tm('untitledFile')}.md`)
  const picked = await showSaveDialogWithMemory(dialog, win, {
    title: tm('dlgSaveTitle'),
    defaultPath,
    filters: [{ name: tm('filterMarkdown'), extensions: ['md', 'markdown', 'txt', 'json'] }],
  })
  if (picked.canceled || !picked.filePath) return 'canceled'
  return picked.filePath
}

const DISPLAY_IMAGE_EXTS = new Set(Object.keys(EXPORT_IMAGE_MIME_BY_EXT))

/**
 * `![x](https://…)` for the DOCX export: downloaded here so the renderer's
 * origin restrictions do not apply; the SSRF guard keeps the model-writable
 * URL off private hosts.
 */
async function readRemoteImage(url: string): Promise<ImageData | null> {
  try {
    const resp = await fetchRemoteImage(url)
    if (!resp?.ok) return null
    const bytes = await readBodyCapped(resp, MAX_REMOTE_IMAGE_BYTES)
    const mime = remoteExportImageMime(bytes, resp.headers.get('content-type'), url)
    if (!mime) return null
    return { base64: Buffer.from(bytes).toString('base64'), mime }
  } catch {
    return null
  }
}

/**
 * Serves authored image paths to the editor DOM. A plain file:// <img> URL is
 * blocked whenever the renderer page is served over http (dev server), so the
 * renderer resolves images to md-asset:// instead. Only image files inside an
 * open document's directory are served.
 */
function registerImageProtocol(): void {
  protocol.handle('md-asset', async (request) => {
    let target: string
    try {
      target = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response(null, { status: 400 })
    }
    if (/^\/[a-zA-Z]:\//.test(target)) target = target.slice(1)
    target = resolve(target)
    if (!DISPLAY_IMAGE_EXTS.has(extname(target).toLowerCase()) || !existsSync(target)) {
      return new Response(null, { status: 404 })
    }
    let served: string | null = null
    for (const doc of new Set([...openPathByWc.values(), ...savePathByWc.values()])) {
      const dir = resolve(dirname(doc))
      // isInDocDir handles filesystem-root docs ("/", "C:\") whose dir
      // already ends in a separator — dir + sep would 403 every sibling.
      if (!isInDocDir(target, dir)) continue
      const safe = await resolveSafeRelativeImagePath(doc, relative(dir, target))
      if (safe) {
        served = safe
        break
      }
    }
    if (!served) {
      // a cross-folder embed resolves through the vault root the wiki resolver
      // walks, so the picture next to the note (vault attachments/ from a
      // nested note, the Obsidian layout) renders too: the same root decides,
      // realpath-resolved so a symlink escape is refused
      served = await resolveSafeVaultImagePath(configuredDefaultSaveDir(app), target)
    }
    if (!served) return new Response(null, { status: 403 })
    return net.fetch(pathToFileURL(served).toString())
  })
}

const imageExports = new ImageExportSessions()

let ipcRegistered = false

function registerMarkdownIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

  registerImageProtocol()

  ipcMain.handle(MARKDOWN_CHANNELS.consumePending, (e) => {
    const pending = openPathByWc.get(e.sender.id) ?? null
    // the vault root is known from here on: start the index so the backlinks
    // panel and the graph usually find it already built
    if (pending) warmWikiIndex(configuredDefaultSaveDir(app))
    return pending
  })

  // ---- headless export mode (--headless-export) ----

  ipcMain.handle(MARKDOWN_CHANNELS.consumeHeadlessExport, (e): string | null => {
    const target = headlessExportTargets.get(e.sender.id) ?? null
    headlessExportTargets.delete(e.sender.id)
    return target
  })

  ipcMain.on(MARKDOWN_CHANNELS.headlessExportDone, (e, result: unknown) => {
    const settle = headlessExportWaiters.get(e.sender.id)
    if (!settle) return
    headlessExportWaiters.delete(e.sender.id)
    const state = result as { ok?: unknown; error?: unknown } | null
    settle({
      ok: state?.ok === true,
      ...(typeof state?.error === 'string' ? { error: state.error } : {}),
    })
  })

  ipcMain.on(MARKDOWN_CHANNELS.ackFileChangedOnDisk, (e) => {
    void diskWatcherByWc.get(e.sender.id)?.acknowledge()
  })

  ipcMain.handle(MARKDOWN_CHANNELS.readPublication, async (e, path: unknown) => {
    const session = closeCoordinator.session(e.sender.id)
    const valid = () =>
      currentTopSender(e) &&
      closeCoordinator.session(e.sender.id) === session &&
      typeof path === 'string' &&
      allowedByWc.get(e.sender.id)?.has(path) === true
    if (!valid()) throw new Error('The publication read is not granted to the current document.')
    const result = await publicationReads.read(
      e.sender.id,
      session,
      path as string,
      async () => readFile(path as string),
      valid,
    )
    return { text: Buffer.from(result.bytes).toString('utf8'), publicationId: result.publicationId }
  })
  ipcMain.on(MARKDOWN_CHANNELS.publicationLoaded, (e, request: unknown) => {
    if (!currentTopSender(e)) return
    const candidate = request as {
        publicationId?: unknown
        path?: unknown
        stamp?: CloseLeaseStamp
      } | null,
      state = closeCoordinator.state(e.sender.id)
    if (
      !candidate ||
      typeof candidate.path !== 'string' ||
      !allowedByWc.get(e.sender.id)?.has(candidate.path) ||
      savePathByWc.get(e.sender.id) !== candidate.path ||
      !state ||
      candidate.stamp?.source !== state.stamp.source ||
      candidate.stamp?.revision !== state.stamp.revision ||
      !publicationReads.adopt(
        e.sender.id,
        closeCoordinator.session(e.sender.id),
        state.stamp.source,
        candidate.path,
        candidate.publicationId,
      )
    )
      console.warn('[markdown] refused obsolete publication-load acknowledgment')
  })

  ipcMain.handle(MARKDOWN_CHANNELS.readFile, async (e, path: unknown) => {
    if (typeof path !== 'string' || !allowedByWc.get(e.sender.id)?.has(path)) {
      throw new Error('markdown: path not granted to this view')
    }
    return await readFile(path, 'utf8')
  })

  ipcMain.handle(
    MARKDOWN_CHANNELS.resolveWikiLinks,
    async (_e, request: WikiLinkResolveRequest): Promise<Record<string, WikiLinkResolved>> => {
      const fromPath = typeof request?.fromPath === 'string' ? request.fromPath : ''
      const targets = Array.isArray(request?.targets)
        ? request.targets.filter((t): t is string => typeof t === 'string')
        : []
      const resolved = await resolveWikiLinks(
        targets,
        { fromPath, root: configuredDefaultSaveDir(app) },
        vaultFs,
      )
      // a Map is structured-cloneable but arrives as an empty object; ship the
      // shape the renderer asked for
      return Object.fromEntries(resolved)
    },
  )

  ipcMain.handle(MARKDOWN_CHANNELS.rememberWikiFragment, (_e, path: unknown, fragment: unknown) => {
    if (typeof path !== 'string' || typeof fragment !== 'string') return
    rememberWikiFragment(path, fragment)
  })

  ipcMain.handle(MARKDOWN_CHANNELS.takeWikiFragment, (_e, path: unknown): string =>
    typeof path === 'string' ? takeWikiFragment(path) : '',
  )

  ipcMain.handle(MARKDOWN_CHANNELS.listWikiNotes, async (): Promise<WikiNoteEntry[]> =>
    listWikiNotes(configuredDefaultSaveDir(app), nodeFs()),
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.createWikiNote,
    async (e, request: WikiCreateNoteRequest): Promise<WikiCreateNoteResult> => {
      const target = typeof request?.target === 'string' ? request.target : ''
      if (!target) return { ok: false }
      // where a bare name lands follows the document this view holds: the
      // saved path wins (Save As moved it), the opened path is the fallback
      const fromPath = savePathByWc.get(e.sender.id) ?? openPathByWc.get(e.sender.id) ?? ''
      if (!currentTopSender(e)) throw new Error('The source sender frame is obsolete.')
      assertNoMarkdownCleanup(e.sender.id)
      const work = beginMarkdownMutation(e, undefined, request.closeSource)
      try {
        const made = await createWikiNote(target, {
          root: configuredDefaultSaveDir(app),
          fromDir: fromPath ? dirname(fromPath) : '',
        }).catch(() => null)
        return made ? { ok: true, ...made } : { ok: false }
      } finally {
        closeCoordinator.finishMutation(work)
      }
    },
  )

  ipcMain.handle(MARKDOWN_CHANNELS.wikiBacklinks, (_e, path: unknown): Promise<WikiBacklink[]> =>
    typeof path === 'string'
      ? wikiBacklinks(configuredDefaultSaveDir(app), path, nodeVaultFs())
      : Promise.resolve([]),
  )

  ipcMain.handle(MARKDOWN_CHANNELS.wikiGraph, (): Promise<WikiGraph> =>
    wikiGraph(configuredDefaultSaveDir(app), nodeVaultFs()),
  )

  ipcMain.handle(MARKDOWN_CHANNELS.wikiTags, (): Promise<{ tag: string; files: string[] }[]> =>
    wikiTags(configuredDefaultSaveDir(app), nodeVaultFs()),
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.save,
    async (e, request: SaveMarkdownRequest): Promise<SaveMarkdownResult> => {
      const releaseAutomatic = nativeCloseAdmission.write(
        e.sender.id,
        request?.automatic === true,
        closeCoordinator.ownsCloseWrite(e.sender.id, request?.requestId) ? e.sender.id : undefined,
      )
      if (!releaseAutomatic) return { ok: true, canceled: true }
      try {
        const retained = new Set<string>(),
          retention = {
            retainUnproven: true,
            onRetained: (names: readonly string[]) => {
              for (const name of names) retained.add(name)
            },
          }
        const perform = async (): Promise<SaveMarkdownResult> => {
          if (typeof request?.text !== 'string') {
            return { ok: false, error: 'markdown: bad save request' }
          }
          if (
            request.imageSources !== undefined &&
            (!Array.isArray(request.imageSources) ||
              request.imageSources.some((source) => typeof source !== 'string'))
          ) {
            return { ok: false, error: 'markdown: bad image references' }
          }
          assertNoMarkdownCleanup(e.sender.id)
          const work = beginMarkdownMutation(e, request.requestId, request.closeSource)
          let publishedPath: string | undefined
          const mode: SaveMode = request.mode === 'saveAs' ? 'saveAs' : 'save'
          const pathAtRequest = savePathByWc.get(e.sender.id)
          try {
            const publicationEntry = publicationReads.select(
                e.sender.id,
                closeCoordinator.session(e.sender.id),
                request.closeSource?.source ?? '',
                request.publicationId,
                pathAtRequest ?? null,
                mode === 'saveAs',
              ),
              loadedPublication = publicationEntry.publication.snapshot()
            const overwriteVersion =
              request.overwrite === true && mode === 'save' && pathAtRequest
                ? await confirmPublicationChoice(e, pathAtRequest, true)
                : undefined
            if (request.overwrite === true && mode === 'save' && pathAtRequest && !overwriteVersion)
              return { ok: true, canceled: true }

            const pendingAtRequest = pathAtRequest
              ? await pendingOwnedAssetsForDocument(pathAtRequest)
              : []
            if (!closeCoordinator.current(work))
              return { ok: false, error: 'The close group ended before choosing a Save target.' }
            const suggestedName =
              typeof request.suggestedName === 'string' ? request.suggestedName : undefined
            const defaultName =
              typeof request.defaultName === 'string' ? request.defaultName : undefined
            const forcedTarget = closeCoordinator.target(e.sender.id, request.requestId)
            const target =
              forcedTarget ?? (await resolveSaveTarget(e, mode, suggestedName, defaultName))
            if (!closeCoordinator.current(work))
              return { ok: false, error: 'The document changed before the write was delivered.' }
            if (target === 'canceled') return { ok: true, canceled: true }
            if (!target) return { ok: false, error: 'markdown: no save target' }
            const capturedTarget = closeCoordinator.publicationTarget(
              e.sender.id,
              request.requestId,
            )
            const selectedTarget =
              capturedTarget ??
              overwriteVersion ??
              (mode === 'saveAs'
                ? await confirmPublicationChoice(e, target)
                : pathAtRequest === target
                  ? undefined
                  : absentPublicationTarget(target))
            if (mode === 'saveAs' && !selectedTarget) return { ok: true, canceled: true }
            const publicationTicket = publicationEntry.publication.pin(
              target,
              selectedTarget ?? undefined,
              loadedPublication,
            )
            const assetSession = closeCoordinator.session(e.sender.id)
            const assetRetention = {
              ...retention,
              assertCurrent: () => {
                if (
                  !currentTopSender(e) ||
                  e.sender.isDestroyed() ||
                  closeCoordinator.session(e.sender.id) !== assetSession ||
                  !closeCoordinator.current(work) ||
                  savePathByWc.get(e.sender.id) !== pathAtRequest
                )
                  throw new Error('The loaded source changed before asset publication.')
              },
            }
            let adoptedNewPath = false
            const assetResult = await withPinnedAssetOutput<SaveMarkdownResult>(
              {
                targetPath: target,
                expectedVersion: publicationTicket.expectedVersion,
                sourceDocumentPath: pathAtRequest,
                assertCurrent: assetRetention.assertCurrent,
              },
              async () => {
                const currentPath = pathAtRequest
                const isNewPath = currentPath !== target
                const imageSources = [...(request.imageSources ?? [])]
                const knownImageSources = new Set(imageSources)
                for (const source of extractMarkdownImageSources(request.text)) {
                  if (knownImageSources.has(source)) continue
                  knownImageSources.add(source)
                  imageSources.push(source)
                }
                const prepared =
                  currentPath && resolve(dirname(currentPath)) !== resolve(dirname(target))
                    ? await prepareAssetsForSaveAs(
                        currentPath,
                        target,
                        request.text,
                        imageSources,
                        assetRetention,
                      )
                    : null
                const textToWrite = prepared?.text ?? request.text
                const savedImageSources = prepared?.imageSources ?? imageSources
                const watcher = diskWatcherByWc.get(e.sender.id)
                if (
                  watcher &&
                  !isNewPath &&
                  request.overwrite !== true &&
                  !(await watcher.isCurrent())
                ) {
                  if (prepared)
                    await rollbackPreparedSaveAsAssets(prepared, retention).catch(() => {})
                  return { ok: false, error: 'markdown: file changed on disk', conflict: true }
                }
                watcher?.beginOwnWrite()
                try {
                  if (!closeCoordinator.current(work))
                    throw new Error('The document changed before publication.')
                  await publicationEntry.publication.publishBytes(
                    publicationTicket,
                    () => Buffer.from(textToWrite, 'utf8'),
                    () => closeCoordinator.current(work),
                  )
                  publishedPath = target
                } catch (error) {
                  if (prepared)
                    await rollbackPreparedSaveAsAssets(prepared, retention).catch(() => {})
                  throw error
                } finally {
                  await watcher?.endOwnWrite(target)
                }
                if (!closeCoordinator.current(work))
                  return {
                    ok: true,
                    path: target,
                    ...(prepared?.rewrites.length
                      ? { imageRewrites: prepared.rewrites, writtenText: textToWrite }
                      : {}),
                  }
                savePathByWc.set(e.sender.id, target)
                // keep the reload path in sync — a stale openPathByWc would make a
                // reloaded renderer load the OLD file and then save it over the new one
                openPathByWc.set(e.sender.id, target)
                const allowed = allowedByWc.get(e.sender.id) ?? new Set<string>()
                allowed.add(target)
                allowedByWc.set(e.sender.id, allowed)
                if (isNewPath) adoptedNewPath = true
                const pendingNames = prepared
                  ? prepared.created.map((record) => record.name)
                  : currentPath && resolve(currentPath) === resolve(target)
                    ? pendingAtRequest
                    : []
                const reconciled = await reconcileOwnedAssets(target, savedImageSources, {
                  pendingNames,
                  ...retention,
                })
                if (reconciled.errors.length > 0) {
                  console.warn('[markdown] asset reconciliation incomplete:', reconciled.errors)
                }
                if (mode === 'saveAs' && currentPath && resolve(currentPath) !== resolve(target)) {
                  const sourceResolved = await resolveSourcePendingAfterSaveAs(
                    currentPath,
                    pendingAtRequest,
                    retention,
                  )
                  if (sourceResolved.errors.length > 0) {
                    console.warn(
                      '[markdown] source asset reconciliation incomplete:',
                      sourceResolved.errors,
                    )
                  }
                }
                return {
                  ok: true,
                  path: target,
                  publicationId: publicationEntry.id,
                  ...(prepared?.rewrites.length
                    ? { imageRewrites: prepared.rewrites, writtenText: textToWrite }
                    : {}),
                }
              },
            )
            // Relocation hooks run after actual publication/adoption/asset settlement,
            // never from inside the publisher that a physical move must drain.
            if (
              adoptedNewPath &&
              closeCoordinator.session(e.sender.id) === assetSession &&
              savePathByWc.get(e.sender.id) === target
            )
              fileSavedHook?.(e.sender, target)
            return assetResult
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          } finally {
            closeCoordinator.finishMutation(work, publishedPath, retained.size > 0)
          }
        }
        const result = await perform()
        if (retained.size) {
          console.warn('[markdown] asset retention:', retained.size)
          return {
            ...result,
            assetCleanup: { assets: 'retained' },
            warnings: [
              'Some image files were kept because another open copy or a saved version may still need them.',
            ],
          }
        }
        return result
      } finally {
        releaseAutomatic()
      }
    },
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.pickImage,
    async (e, source?: CloseLeaseStamp): Promise<string | null> => {
      if (!currentTopSender(e)) throw new Error('The source sender frame is obsolete.')
      assertNoMarkdownCleanup(e.sender.id)
      const work = beginMarkdownMutation(e, undefined, source)
      try {
        const docPath = savePathByWc.get(e.sender.id),
          assetSession = closeCoordinator.session(e.sender.id)
        if (!docPath) return null
        const win =
          BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
        const picked = await showOpenDialogWithMemory(dialog, win, {
          title: tm('dlgPickImage'),
          filters: [{ name: tm('filterImages'), extensions: EXPORT_IMAGE_EXTS }],
          properties: ['openFile'],
        })
        if (picked.canceled || !picked.filePaths[0] || !closeCoordinator.current(work)) return null
        return await copyImageIntoOwnedAssets(docPath, picked.filePaths[0], {
          retainUnproven: true,
          assertCurrent: () => {
            if (
              !currentTopSender(e) ||
              e.sender.isDestroyed() ||
              !closeCoordinator.current(work) ||
              closeCoordinator.session(e.sender.id) !== assetSession ||
              savePathByWc.get(e.sender.id) !== docPath
            )
              throw new Error('The loaded source changed before image publication.')
          },
        })
      } finally {
        closeCoordinator.finishMutation(work)
      }
    },
  )
  ipcMain.handle(
    MARKDOWN_CHANNELS.saveImage,
    async (
      e,
      data: { base64?: unknown; ext?: unknown; closeSource?: CloseLeaseStamp },
    ): Promise<string | null> => {
      assertNoMarkdownCleanup(e.sender.id)
      const work = beginMarkdownMutation(e, undefined, data?.closeSource)
      try {
        const docPath = savePathByWc.get(e.sender.id),
          assetSession = closeCoordinator.session(e.sender.id),
          ext = String(data?.ext ?? '').toLowerCase()
        if (
          !docPath ||
          typeof data?.base64 !== 'string' ||
          !data.base64 ||
          !EXPORT_IMAGE_EXTS.includes(ext) ||
          data.base64.length > Math.ceil(MAX_PASTED_IMAGE_BYTES / 3) * 4
        )
          return null
        return await writeImageIntoOwnedAssets(
          docPath,
          'image.' + ext,
          Buffer.from(data.base64, 'base64'),
          {
            retainUnproven: true,
            assertCurrent: () => {
              if (
                !currentTopSender(e) ||
                e.sender.isDestroyed() ||
                !closeCoordinator.current(work) ||
                closeCoordinator.session(e.sender.id) !== assetSession ||
                savePathByWc.get(e.sender.id) !== docPath
              )
                throw new Error('The loaded source changed before image publication.')
            },
          },
        )
      } finally {
        closeCoordinator.finishMutation(work)
      }
    },
  )
  ipcMain.handle(
    MARKDOWN_CHANNELS.aiGenerateImage,
    async (e, op: { prompt?: unknown; aspectRatio?: unknown; closeSource?: CloseLeaseStamp }) => {
      assertNoMarkdownCleanup(e.sender.id)
      const work = beginMarkdownMutation(e, undefined, op?.closeSource)
      try {
        return await generateImageTool(
          join(app.getPath('userData'), 'ai-settings.json'),
          {
            prompt: String(op?.prompt ?? ''),
            aspectRatio: op?.aspectRatio ? String(op.aspectRatio) : undefined,
          },
          { mediaRoots: documentMediaRoots(markdownFilePath(e.sender.id), undefined) },
        )
      } finally {
        closeCoordinator.finishMutation(work)
      }
    },
  )

  // ---- image host (vantage#388): bring-your-own storage for pasted images,
  // with the local assets/ copy kept as the renderer's fallback ----
  const imageHostConfigPath = (): string => join(app.getPath('userData'), 'markdown-settings.json')

  const readImageHostConfig = async (): Promise<ImageHostConfig | null> => {
    try {
      const raw = JSON.parse(await readFile(imageHostConfigPath(), 'utf8'))
      return normalizeImageHostConfig(raw?.imageHost ?? null)
    } catch {
      return null
    }
  }

  ipcMain.handle(MARKDOWN_CHANNELS.getImageHost, async (): Promise<ImageHostConfig | null> => {
    return readImageHostConfig()
  })

  ipcMain.handle(
    MARKDOWN_CHANNELS.setImageHost,
    async (_e, config: unknown): Promise<ImageHostConfig | null> => {
      // null clears the host: pastes return to the local-assets behaviour
      const normalized = normalizeImageHostConfig(config)
      // an incomplete form is rejected without touching the stored host
      if (normalized === null && config !== null) return null
      let file: Record<string, unknown>
      try {
        file = JSON.parse(await readFile(imageHostConfigPath(), 'utf8'))
      } catch {
        file = {}
      }
      file.imageHost = normalized
      await atomicWriteFile(imageHostConfigPath(), Buffer.from(JSON.stringify(file, null, 2)))
      return normalized
    },
  )

  // ---- document paper theme (rendered via data-markdown-theme) ----
  ipcMain.handle(MARKDOWN_CHANNELS.getMarkdownTheme, async (): Promise<MarkdownTheme> => {
    try {
      const raw = JSON.parse(await readFile(imageHostConfigPath(), 'utf8'))
      return normalizeMarkdownTheme(raw?.markdownTheme)
    } catch {
      return 'default'
    }
  })

  ipcMain.handle(
    MARKDOWN_CHANNELS.setMarkdownTheme,
    async (_e, theme: unknown): Promise<MarkdownTheme> => {
      const normalized = normalizeMarkdownTheme(theme)
      let file: Record<string, unknown>
      try {
        file = JSON.parse(await readFile(imageHostConfigPath(), 'utf8'))
      } catch {
        file = {}
      }
      file.markdownTheme = normalized
      await atomicWriteFile(imageHostConfigPath(), Buffer.from(JSON.stringify(file, null, 2)))
      return normalized
    },
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.uploadImage,
    async (
      e,
      data: { base64?: unknown; ext?: unknown; name?: unknown; closeSource?: CloseLeaseStamp },
    ): Promise<{ ok: boolean; url?: string; error?: string }> => {
      assertNoMarkdownCleanup(e.sender.id)
      const work = beginMarkdownMutation(e, undefined, data?.closeSource)
      try {
        const ext = String(data?.ext ?? '').toLowerCase()
        if (
          !EXPORT_IMAGE_EXTS.includes(ext) ||
          typeof data?.base64 !== 'string' ||
          !data.base64 ||
          data.base64.length > Math.ceil(MAX_PASTED_IMAGE_BYTES / 3) * 4
        )
          return { ok: false, error: 'Unsupported or oversized image data' }
        const config = await readImageHostConfig()
        if (!isImageHostUsable(config) || !closeCoordinator.current(work))
          return { ok: false, error: 'Image host or source is unavailable' }
        return await uploadImageToHost(config, { bytes: Buffer.from(data.base64, 'base64'), ext })
      } finally {
        closeCoordinator.finishMutation(work)
      }
    },
  )

  ipcMain.handle(MARKDOWN_CHANNELS.saveImageAs, async (e, src: unknown) => {
    if (typeof src !== 'string') return { ok: false }
    const win = BrowserWindow.fromWebContents(e.sender)
    return saveImageFromUrl(win, src, {
      title: tm('dlgSaveImage'),
      fallbackDir: configuredDefaultSaveDir(app),
    })
  })

  ipcMain.handle(
    MARKDOWN_CHANNELS.readImage,
    async (e, src: unknown): Promise<ImageData | null> => {
      if (typeof src !== 'string') return null
      if (/^https?:/i.test(src)) return readRemoteImage(src)
      const docPath = savePathByWc.get(e.sender.id)
      if (!docPath || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null
      const target = await resolveSafeRelativeImagePath(docPath, src)
      if (!target) return null
      const mime = EXPORT_IMAGE_MIME_BY_EXT[extname(target).toLowerCase()]
      if (!mime || !existsSync(target)) return null
      try {
        return { base64: (await readFile(target)).toString('base64'), mime }
      } catch {
        return null
      }
    },
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.exportDocx,
    async (e, request: ExportDocxRequest): Promise<ExportResult> => {
      if (typeof request?.base64 !== 'string' || !request.base64) {
        return { ok: false, error: 'markdown: bad export request' }
      }
      const safeName =
        String(request.suggestedName || tm('untitledFile'))
          .replace(/[/\\:*?"<>|]/g, '_')
          .slice(0, 80)
          .trim() || tm('untitledFile')
      try {
        const bytes = Buffer.from(request.base64, 'base64')
        if (request.mode === 'openInDocs') {
          // Each conversion gets an app-owned cache file. A marked session is
          // retained for the life of open Docs tabs; crash leftovers expire
          // after the explicit TTL enforced when the next session starts.
          const target = await writeMarkdownConversion(
            await markdownConversionSession(),
            safeName,
            bytes,
          )
          docxExportedHook?.(target)
          return { ok: true, path: target }
        }
        const win =
          BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
        const picked = await showSaveDialogWithMemory(
          dialog,
          win,
          {
            defaultPath: `${safeName}.docx`,
            filters: [{ name: 'Word', extensions: ['docx'] }],
          },
          configuredDefaultSaveDir(app),
        )
        if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
        // Vantage Productivity: protected publication also covers document exports.
        await publishSelectedUserOutput(picked.filePath, async () => bytes)
        return { ok: true, path: picked.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.exportPdf,
    async (e, request: ExportPdfRequest): Promise<ExportResult> => {
      if (typeof request?.html !== 'string' || !request.html) {
        return { ok: false, error: 'markdown: bad export request' }
      }
      const safeName =
        String(request.suggestedName || tm('untitledFile'))
          .replace(/[/\\:*?"<>|]/g, '_')
          .slice(0, 80)
          .trim() || tm('untitledFile')
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
                defaultPath: `${safeName}.pdf`,
                filters: [{ name: 'PDF', extensions: ['pdf'] }],
              },
              configuredDefaultSaveDir(app),
            )
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true }
      try {
        await publishSelectedUserOutput(picked.filePath, () => printMarkdownPdf(request.html), {
          afterPublished: () => openExportedPdf(picked.filePath!),
        })
        return { ok: true, path: picked.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.prepareImageExport,
    async (e, request: ExportPdfRequest): Promise<ImageExportPreparation> => {
      if (typeof request?.html !== 'string' || !request.html)
        return { ok: false, error: 'Empty document' }
      let id: string | undefined
      const exportSession = closeCoordinator.session(e.sender.id)
      const exportSource = savePathByWc.get(e.sender.id)
      const sourceProof = {
        sourcePaths: exportSource ? [exportSource] : [],
        assertCurrent: () => {
          if (
            e.sender.isDestroyed() ||
            !currentTopSender(e) ||
            closeCoordinator.session(e.sender.id) !== exportSession ||
            savePathByWc.get(e.sender.id) !== exportSource
          )
            throw new Error('The source changed before image export admission')
        },
      }
      try {
        const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
        const picked = await showOpenDialogWithMemory(
          dialog,
          win,
          {
            properties: ['openDirectory', 'createDirectory'],
          },
          configuredDefaultSaveDir(app),
        )
        if (picked.canceled || !picked.filePaths[0]) return { ok: true, canceled: true }
        id = await imageExports.start(
          e.sender.id,
          picked.filePaths[0],
          String(request.suggestedName || tm('untitledFile')),
          sourceProof,
        )
        const pdf = await printMarkdownPdf(request.html)
        if (e.sender.isDestroyed()) throw new Error('Document closed during export')
        return { ok: true, id, pdfBase64: pdf.toString('base64') }
      } catch (err) {
        if (id) await imageExports.finish(e.sender.id, id, false).catch(() => {})
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
  ipcMain.handle(
    MARKDOWN_CHANNELS.writeExportImage,
    async (e, id: string, page: number, base64: string) => {
      try {
        await imageExports.write(e.sender.id, id, page, base64)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
  ipcMain.handle(
    MARKDOWN_CHANNELS.finishImageExport,
    async (e, id: string, success: boolean): Promise<ExportResult> => {
      try {
        const dir = await imageExports.finish(e.sender.id, id, success === true)
        if (!dir) return { ok: true, canceled: true }
        shell.showItemInFolder(join(dir, 'page-01.png'))
        return { ok: true, path: dir }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    MARKDOWN_CHANNELS.writeDraft,
    async (event, request: { text?: unknown; stamp?: CloseLeaseStamp }) => {
      requireRecoveryRuntime('Markdown automatic recovery capture')
      const text = request?.text
      try {
        if (!currentTopSender(event)) throw new Error('The draft sender frame is obsolete.')
        const epoch = draftEpochByWc.get(event.sender.id),
          id = epoch?.id
        if (!epoch || !id || event.sender.isDestroyed())
          throw new Error('Draft recording is unavailable for this view')
        const state = closeCoordinator.state(event.sender.id),
          stamp = request?.stamp,
          floor = discardedDraftFloor.get(event.sender.id)
        if (
          !stamp ||
          stamp.source !== state?.stamp.source ||
          !Number.isSafeInteger(Number(stamp.revision)) ||
          (floor?.source === stamp.source && Number(stamp.revision) <= Number(floor.revision))
        )
          throw new Error('The draft snapshot was captured before discard or source replacement.')
        if (typeof text !== 'string' || text.length > 16 * 1024 * 1024)
          throw new Error('Draft exceeds its 16 MiB limit')
        if (!dirtyByWc.has(event.sender.id)) return { ok: true }
        const documentPath = savePathByWc.get(event.sender.id) ?? null
        const extension =
          documentPath && ['.txt', '.json'].includes(extname(documentPath).toLowerCase())
            ? extname(documentPath).toLowerCase()
            : '.md'
        if (epoch.retired !== null)
          throw new Error('The captured draft producer was retired before delivery.')
        const bytes = Buffer.from(text, 'utf8'),
          expectedSha256 = createHash('sha256').update(bytes).digest('hex')
        const writing = writeDraftJournal(draftRoot(), {
          id,
          module: 'markdown',
          documentPath,
          extension,
          bytes,
        }).then((entry) => {
          if (!entry) return null
          const samePath =
            entry.documentPath === null || documentPath === null
              ? entry.documentPath === documentPath
              : process.platform === 'win32'
                ? resolve(entry.documentPath).toLowerCase() === resolve(documentPath).toLowerCase()
                : resolve(entry.documentPath) === resolve(documentPath)
          if (
            entry.id !== id ||
            entry.module !== 'markdown' ||
            !samePath ||
            entry.extension !== extension ||
            entry.bytes !== bytes.length ||
            entry.sha256 !== expectedSha256
          )
            throw new Error(
              'The Markdown journal writer returned an unverified receipt; the previous custody binding is retained.',
            )
          const receiptSequence = epoch.receiptSequence + 1
          if (!Number.isSafeInteger(receiptSequence))
            throw new Error(
              'The Markdown journal receipt sequence is exhausted; its previous copy is retained.',
            )
          epoch.receiptSequence = receiptSequence
          const binding = Object.freeze({
            receiptSequence,
            expectedDocumentPath: entry.documentPath,
            expectedSha256: entry.sha256,
          })
          epoch.lastWriteBinding = binding
          return binding
        })
        epoch.writes.add(writing)
        try {
          await writing
        } finally {
          epoch.writes.delete(writing)
        }
        if (epoch.retired === 'discard') await discardDraftJournal(draftRoot(), id)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.on(MARKDOWN_CHANNELS.dirtyChanged, (event, dirty: unknown, stamp: CloseLeaseStamp) => {
    if (!currentTopSender(event)) return
    const state = closeCoordinator.state(event.sender.id)
    if (!stamp || stamp.source !== state?.stamp.source || stamp.revision !== state.stamp.revision)
      return
    if (dirty === true) dirtyByWc.add(event.sender.id)
    else if (dirty === false) {
      dirtyByWc.delete(event.sender.id)
      const old = draftByWc.get(event.sender.id)
      discardedDraftFloor.set(event.sender.id, { ...stamp })
      rotateMarkdownDraft(event.sender.id, 'discard')
      if (old)
        void discardDraftJournal(draftRoot(), old).catch((error) =>
          console.warn('[markdown] saved draft cleanup:', error),
        )
    }
  })

  ipcMain.on(MARKDOWN_CHANNELS.closeSaveResult, (e, ok: unknown) => {
    const waiter = closeSaveWaiters.get(e.sender.id)
    closeSaveWaiters.delete(e.sender.id)
    waiter?.(ok === true)
  })

  ipcMain.on(MARKDOWN_CHANNELS.readTextResult, (e, result: unknown) => {
    const waiter = readTextWaiters.get(e.sender.id)
    readTextWaiters.delete(e.sender.id)
    if (!waiter) return
    if (result && typeof result === 'object' && 'text' in result) {
      waiter({ text: String((result as { text: unknown }).text) })
    } else {
      waiter({ error: 'the document could not be read' })
    }
  })

  // Only the matching final renderer receipt may settle an outer request.
  // The physical save handler returns independently, so no invoke/ack cycle forms.
  ipcMain.on(MARKDOWN_CHANNELS.saveRequestAck, (e, value: unknown) => {
    if (!currentTopSender(e)) return
    const result = value as MarkdownSaveCompletion | null
    if (
      !result ||
      typeof result.requestId !== 'string' ||
      typeof result.published !== 'boolean' ||
      typeof result.current !== 'boolean' ||
      typeof result.clean !== 'boolean'
    )
      return
    closeCoordinator.receive(e.sender.id, result)
  })

  ipcMain.on(MARKDOWN_CHANNELS.closeSourceState, (event, value) => {
    if (currentTopSender(event)) closeCoordinator.observe(event.sender.id, value)
  })
  ipcMain.handle(
    MARKDOWN_CHANNELS.closeLeaseClaim,
    (event, ticket) => currentTopSender(event) && closeCoordinator.claim(event.sender.id, ticket),
  )
  ipcMain.handle(MARKDOWN_CHANNELS.closeLeaseCancel, async (event, ticket, reason) => {
    if (!currentTopSender(event)) return
    closeCoordinator.cancel(
      event.sender.id,
      ticket,
      typeof reason === 'string' ? reason : 'cancelled',
    )
    await waitForMarkdownCleanup(event.sender.id)
  })

  // Language channel shared with other modules; removeHandler tolerates duplicate registration
  ipcMain.removeHandler(MARKDOWN_CHANNELS.getLanguage)
  ipcMain.handle(MARKDOWN_CHANNELS.getLanguage, () => getUiLang())
}

function grantAndTrack(wc: WebContents, openPath?: string | null): void {
  const wcId = wc.id
  markdownContents.set(wcId, wc)
  closeCoordinator.open(wcId)
  wc.on('render-process-gone', () => closeCoordinator.rendererGone(wcId))
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame) {
      rotateMarkdownDraft(wcId, 'preserve')
      dirtyByWc.delete(wcId)
      closeCoordinator.rendererGone(wcId)
    }
  })
  rotateMarkdownDraft(wcId)
  const watcher = createDocumentDiskWatcher((path) => {
    if (!wc.isDestroyed()) wc.send(MARKDOWN_CHANNELS.fileChangedOnDisk, path)
  })
  diskWatcherByWc.set(wcId, watcher)
  if (openPath && existsSync(openPath)) {
    openPathByWc.set(wcId, openPath)
    savePathByWc.set(wcId, openPath)
    allowedByWc.set(wcId, new Set([openPath]))
    void watcher.watch(openPath)
  }
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeExternalUrl(url, { allowedProtocols: ['http:', 'https:', 'mailto:'] })
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  wc.once('destroyed', () => {
    // Teardown alone is never authority to delete a durable journal. A clean
    // Save has its own exact acknowledgment; approved close owns separate custody.
    const epoch = draftEpochByWc.get(wcId)
    if (epoch && epoch.retired === null) epoch.retired = 'preserve'
    draftEpochByWc.delete(wcId)
    discardedDraftFloor.delete(wcId)
    draftByWc.delete(wcId)
    void imageExports
      .dispose(wcId)
      .catch((err) => console.warn('[markdown] image export cleanup:', err))
    diskWatcherByWc.get(wcId)?.dispose()
    diskWatcherByWc.delete(wcId)
    publicationReads.forget(wcId)
    openPathByWc.delete(wcId)
    allowedByWc.delete(wcId)
    savePathByWc.delete(wcId)
    dirtyByWc.delete(wcId)
    closeSaveWaiters.get(wcId)?.(false)
    closeSaveWaiters.delete(wcId)
    closeCoordinator.destroy(wcId)
    markdownContents.delete(wcId)
  })
}

/** hidden export windows: webContents id -> the PDF path the renderer must write */
const headlessExportTargets = new Map<number, string>()
/** settled by the renderer's headless-export-done message (or by it dying) */
const headlessExportWaiters = new Map<number, (result: HeadlessMarkdownReport) => void>()

interface HeadlessMarkdownReport {
  ok: boolean
  error?: string
}

/**
 * Render `input` to `outPath` with no visible window: a hidden markdown
 * renderer opens the file through the normal pending-open queue and runs the
 * File menu's own PDF export, which already prints in a second hidden window.
 */
export async function exportMarkdownPdfHeadless(
  input: string,
  outPath: string,
  timeoutMs = 180_000,
): Promise<void> {
  registerMarkdownIpc()
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
  headlessExportTargets.set(wcId, outPath)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const report = await new Promise<HeadlessMarkdownReport>((resolve) => {
      headlessExportWaiters.set(wcId, resolve)
      win.webContents.on('render-process-gone', (_event, details) =>
        resolve({ ok: false, error: `markdown renderer stopped (${details.reason})` }),
      )
      timer = setTimeout(
        () => resolve({ ok: false, error: `markdown export timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
      void win.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'markdown'))
    })
    if (!report.ok) throw new Error(report.error ?? 'markdown export failed')
  } finally {
    if (timer) clearTimeout(timer)
    headlessExportWaiters.delete(wcId)
    headlessExportTargets.delete(wcId)
    if (!win.isDestroyed()) win.destroy()
  }
}

export function createMarkdownView(openPath?: string | null): WebContentsView {
  registerMarkdownIpc()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  grantAndTrack(view.webContents, openPath)
  void view.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'markdown'))
  return view
}

/** Standalone window mode: `npm run dev -w @vantage/markdown`, md path passed via argv */
export function startMarkdownStandalone(): void {
  registerRendererScheme()
  installNavigationGuard(app)
  installContextMenu(app, () => contextMenuLabels(getUiLang()))
  const standaloneRecoveryProfile = configureRecoveryProfile({
    app,
    mode: 'gui',
    guiProfile: process.env.VANTAGE_USER_DATA || app.getPath('userData'),
  })
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  initializeStandaloneRecovery({
    app,
    ...standaloneRecoveryProfile,
    lockAcquired: true,
    warning: (message) => {
      void dialog.showMessageBox({ type: 'warning', message }).catch(() => {})
    },
    terminal: (cleanup) => {
      app.once('will-quit', cleanup)
    },
  })
  configureMarkdownRuntime({
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: join(__dirname, '../renderer/index.html'),
  })
  void app.whenReady().then(() => {
    // RECOVERY_BOOTSTRAP: runtime belongs to GUI startup, not handler registration.
    installRendererProtocol({ markdown: join(__dirname, '../renderer') })
    registerMarkdownIpc()
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
    const argPath = process.argv.slice(1).find((a) => /\.(md|markdown)$/i.test(a) && existsSync(a))
    grantAndTrack(win.webContents, argPath)
    let closePreparing = false
    win.on('close', (event) => {
      event.preventDefault()
      if (closePreparing) return
      closePreparing = true
      void (async () => {
        let receipt: MarkdownCloseReceipt | null = null
        try {
          receipt = await prepareMarkdownNativeClose(win.webContents, win)
          if (receipt)
            completeMarkdownClose(win.webContents, receipt, () => {
              if (win.isDestroyed()) return false
              win.destroy()
              return true
            })
        } catch (error) {
          console.error('[markdown] close refused:', error)
        } finally {
          closePreparing = false
          if (receipt)
            await cancelMarkdownClose(win.webContents, receipt, 'standalone close finished')
        }
      })()
    })
    void win.loadURL(rendererUrl(runtime.rendererUrl, 'markdown'))
  })
  app.on('window-all-closed', () => app.quit())
}
