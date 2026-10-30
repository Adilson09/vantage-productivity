import { configureRecoveryProfile, initializeStandaloneRecovery, recoveryRuntimeState } from '../../../../packages/electron-utils/src/recovery-bootstrap'
import { initializeStandaloneSheetsCloseRuntime, type StandaloneSheetsCloseRuntime } from './standalone-close-runtime'
import { settleHeadlessSheetsCleanup } from './headless-sheets-cleanup'
import { HeadlessSheetsOwnerWork } from './headless-sheets-owner-work'
import { runInteractiveSheetsPrint } from './interactive-sheets-print'
import { captureSelectedSheetsOutput, captureFreshSheetsOutput, publishCapturedSheetsOutput } from './sheets-selected-output'
import { publishNewUserOutput } from '@vantage/electron-utils/user-output-publication'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import { assertWorkbookTargetUnchanged } from './workbook-source-expectation'
import { atomicCopyFile, withAtomicSaveQueue } from '@vantage/electron-utils/atomic-write'
import { reserveFileMutation, withAttestedFilePublication, withFilePublication, type FilePublicationScope } from '@vantage/electron-utils/file-publication-exclusion'
import { WorkbookPublicationLifecycle, type WorkbookPublicationDecision } from './workbook-publication-lifecycle'
import { SheetsRenameRefreshTransport } from './sheets-rename-refresh'
import { moveWorkbookExclusively } from './workbook-exclusive-move'
import { WorkbookDocumentRecovery, canonicalDocumentPayload } from './workbook-document-recovery'
import { createSettledDocumentNativeClient } from './settled-document-native-client'
import type { CapturedNativeCloseAuthority } from './workbook-document-recovery'
import { SheetsCloseCoordinator, type SheetsCleanupAdmission, type SheetsClosePrepareOptions, type SheetsClosePromptHandle } from './sheets-close-coordinator'
import { SheetsCloseTransport, isSheetsCloseSource } from './sheets-close-transport'
import { SheetsPromptWriteGate, parseWorkbookWriteContext, type SheetsWorkbookWriteAdmission } from './sheets-prompt-write-gate'
import { captureReaderDisplay, rebindRecoveredReader, recoveredReaderFile, recoveredReaderSource, sessionAfterPasswordPublication, type ReaderDisplay } from './reader-recovery'
import { SheetsSourceLineages, type SheetsSourceOpen, type SheetsSourceAdoption } from './sheets-source-lineage'
import { isCloseLeaseStamp, isCloseLeaseTicket, type CloseLeaseStamp, type CloseLeaseTicket } from '../../../../packages/electron-utils/src/close-lease'
import { sameSheetsCloseSource, type SheetsCloseReceipt, type SheetsCloseSource, type SheetsCloseState } from '../shared/sheets-close'
import type { WorkbookCloseCheckpointBinding, WorkbookPublicationAdoption, WorkbookWriteContext, WorkbookRenamedMetadata } from '../shared/desktop-api'
import { allocateSessionSnapshotDirectory } from './session-snapshot-directory'
import {
  documentPayloadFromSave,
  validateDocumentPayload,
} from '../shared/document-checkpoint'
import { writeDocumentSavePipeline } from './document-save-pipeline'
import { writeWorkbookDocumentPackage, type DocumentWriteSession } from './workbook-document-writer'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rmdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { refreshCsvDigest } from './csv-digest'
import { createServer } from 'node:http'
import { basename, dirname, isAbsolute, join } from 'node:path'

import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  net,
  screen,
  session as electronSession,
  shell,
  systemPreferences,
  webContents,
  WebContentsView,
} from 'electron'
import type {
  IpcMainInvokeEvent,
  MenuItemConstructorOptions,
  OpenDialogOptions,
  SaveDialogOptions,
  WebContents,
} from 'electron'
import { z } from 'zod'
import {
  abortOnDestroyed,
  decryptOoxml,
  encryptOoxml,
  isCfbFile,
  isEncryptedOoxml,
  appMenuLabels,
  appMenuTemplate,
  buildPrintableHtml,
  configuredDefaultSaveDir,
  contextMenuLabels,
  fetchRemoteImage,
  installContextMenu,
  installNavigationGuard,
  isHeadlessMode,
  printHtmlToPdf,
  safeExternalUrl,
  showOpenDialogWithMemory,
  showSaveDialogWithMemory,
  helpMenuTemplate,
  viewMenuTemplate,
  windowMenuTemplate,
  settingsMenuItem,
  installRendererProtocol,
  registerRendererScheme,
  rendererUrl,
  writeJsonAtomic,
  recoveryCopyDiskNewer,
  configuredAuthorName,
} from '@vantage/electron-utils'
import { createMainProcessProxyDispatcher } from '@vantage/electron-utils/main-proxy'
import { createI18n, getUiLang, type Lang, normalizeLang, setUiLang } from '@vantage/i18n'
import { ProjectStore } from '@vantage/project-store'

import {
  AiCreditsError,
  AiTimeoutError,
  isAiNetworkError,
  isAiOverloadedError,
  isAiRegionBlockedError,
  chatForProvider,
  defaultAiSettings,
  activeProvider,
  maxOutputTokensOf,
  resolveAiSettings,
  setAiUserAgent,
  setRescueFetch,
  resolveProfileCredential,
  streamForProvider,
  type AiProviderId,
  type AiSettings,
  type AiStreamChunk,
  type GenSparkAccountStatus,
  type LegacyAiSettings,
} from '@vantage/ai-provider'
import { shutdownCodexAppServers } from '@vantage/ai-provider/codex-app-server'
import {
  csvToXlsxBufferForOpen,
  decodeCsvBuffer,
  sheetCsvToXlsxBuffer,
} from '@vantage/xlsx-gateway/gateway/csv-import'
import {
  ensureVantageLogin,
  noteGskCallFailure,
  setVantageLoginOpener,
  gskApiKey,
  gskLoginInfo,
  hasGskAuth,
  setGskProxyUrl,
  webSearchTool,
  imageSearchTool,
  generateImageTool,
  localMediaRoots,
} from '@vantage/ai-search'
import { parseFileToText } from '@vantage/file-parse'
import {
  readArchiveEntryText,
  saveWorkbookViaSidecar,
} from '@vantage/xlsx-gateway/gateway/xlsx-package-io'
import { parsePivotDefinition } from '@vantage/xlsx-gateway/gateway/xlsx-pivot'
import { readWorkbookRedactionPart } from './workbook-redactions'
import type {
  AttachmentAddResult,
  AttachmentImageResult,
  AttachmentMeta,
  AttachmentReadResult,
  WorkbookFile,
} from '../shared/desktop-api'
import {
  ATTACHMENT_IMAGE_EXTS,
  aiChatRequestSchema,
  aiSettingsInputSchema,
  aiStreamRequestSchema,
  workbookFileSchema,
  workbookFormulaCellsRequestSchema,
  workbookRowOutlineResultSchema,
  workbookFormulaCellsResultSchema,
  workbookFindCellsRequestSchema,
  workbookFindCellsResultSchema,
  workbookRecalcRequestSchema,
  workbookRecalcResultSchema,
  workbookMediaRequestSchema,
  workbookMediaResultSchema,
  workbookPivotRequestSchema,
  workbookRedactionsRequestSchema,
  workbookRedactionsResultSchema,
  localImageRequestSchema,
  localImageResultSchema,
  screenCaptureRequestSchema,
  screenCaptureResultSchema,
  screenSourcesResultSchema,
  workbookPivotDefinitionSchema,
  workbookCreateDocumentRequestSchema,
  workbookExportCsvRequestSchema,
  workbookExportPdfRequestSchema,
  printerInfoSchema,
  workbookRangeRequestSchema,
  workbookRangeResultSchema,
  workbookSaveEditsAbortSchema,
  workbookSaveEditsBeginSchema,
  saveEditsChunkArraySchema,
  workbookSaveEditsChunkSchema,
  workbookSaveRequestSchema,
  type WorkbookCreateDocumentResult,
  type WorkbookSaveRequest,
} from '../shared/desktop-api'
import { IPC_CHANNELS } from '../shared/ipc-channels'
// Vantage Productivity modification: native workbook saves and CSV write-back participate in safe recovery.
import { atomicWriteFile } from './atomic-write'
import { withNativeSaveRecovery } from './save-recovery'
import { ShutdownLatch } from './close-guard'
import { SaveEditsTransferStore } from './save-edits-transfer'
import { exportPdf, printWorkbook } from './pdf-export'
import { allowsAutomaticWorkbookRecovery } from './recovery-policy'
import {
  setSystemShortDate,
  shortDatePatternForSystemLocale,
} from '@vantage/xlsx-gateway/shared/short-date'
import {
  cleanupExpiredPastedFiles,
  cleanupImportTempDirectory,
  cleanupSessionResources,
} from './temp-files'
import { XlsxSidecarClient, subscribeNativeActualWork, joinNativeActualWork } from './xlsx-sidecar-client'
import { editWorkbookId } from './xlsx-edit-session'
import { editRecalcResultSchema, type EditSessionOpen } from './xlsx-edit-contract'
import { knownRelocationDigest, matchesWorkbookRelocation, sameWorkbookPath, sessionAfterVerifiedRelocation, verifyRelocatedWorkbook } from './workbook-relocation'

/**
 * Sheets main-process logic as an embeddable module: no top-level lifecycle.
 * Standalone mode (apps/sheets entry) calls startSheetsStandalone(); the
 * unified shell calls configureSheetsRuntime() + createSheetsWindow() and
 * owns the app lifecycle. AI IPC is registered separately so the shell can
 * substitute its single unified handler set (same channel names as docs).
 */

const tMain = createI18n({
  zh: {
    filterSpreadsheets: '电子表格',
    filterXlsx: 'Excel 工作簿',
    filterXlsm: 'Excel 启用宏的工作簿',
    odsImportMsg: '转换 .{ext} 工作簿？',
    odsImportDetail:
      'Vantage 只编辑 .xlsx，不编辑 ODF。数值、公式和日期会被转换过来（公式改写为 Excel 语法，无法安全改写的只保留它的当前结果）；样式、列宽和图表不会保留。原文件不会被修改，转换出的副本首次保存时另存为 .xlsx。', // public-hygiene: allow
    odsImportConvertBtn: '转换并打开',
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
    errGskNotLoggedIn: '未登录 Genspark:请点击下方「登录 Genspark」完成登录后重试',
    errNoApiKey: '未配置 {provider} 的 API Key',
    errAiRegion: '该模型的厂商不向当前地区提供服务，请换一个模型或切换网络',
    errAiBusy: 'AI 服务当前繁忙，请稍后重试',
    errNoModel: '未配置模型名称',
    errImgAbsPath: '图片路径必须是绝对路径。',
    errImgNotFound: '找不到图片文件: {path}',
    errImgTooLarge20: '图片超过 20MB,不支持插入。',
    errImgBadType: '该文件不是 PNG/JPEG/GIF 图片。',
    errDiskChanged: '工作簿在打开后被磁盘上的改动覆盖——请改用另存为。',
    autosaveFoundTitle: '发现自动恢复版本',
    autosaveDiskNewer: '注意：此恢复副本保存后，磁盘上的文件又被修改过。恢复将替换这些较新的更改。',
    autosaveFoundBody:
      '上次会话有未保存的更改。要恢复自动保存的版本吗?恢复后,保存将直接覆盖原文件。',
    autosaveRestore: '恢复',
    autosaveDiscard: '放弃',
    menuFile: '文件',
    menuOpenWorkbook: '打开工作簿…',
    menuSave: '保存',
    menuSaveAs: '另存为…',
    menuExportPdf: '导出 PDF…',
    menuPrint: '打印…',
    menuClose: '关闭',
    menuQuit: '退出',
    menuEdit: '编辑',
    menuUndo: '撤销',
    menuRedo: '重做',
    closeUnsavedMsg: '有 {count} 处未保存的修改',
    closeUnsavedDetail: '不保存直接关闭,这些修改将丢失。',
    btnDontSave: '不保存',
    btnCancel: '取消',
    csvSaveAsNotice: 'CSV 格式不保留样式等格式修改——另存为 .xlsx 可保留全部内容。',
    menuExportCsv: '导出 CSV…',
    filterCsv: 'CSV (逗号分隔)',
    csvFormulaLossMsg: '当前工作表包含公式,CSV 格式无法保留。',
    csvFormulaLossDetail: 'CSV 只保留纯文本值——公式会被替换为当前计算结果,格式也会丢失。',
    csvKeepXlsxBtn: '另存为 .xlsx',
    csvContinueBtn: '继续保存为 CSV',
    csvActiveSheetOnlyNotice: 'CSV 文件只包含一张工作表——只会导出当前工作表“{name}”。',
    csvKeepFormatMsg: '继续以 CSV 格式保存吗?',
    csvKeepFormatDetail:
      'CSV 只保留单张工作表的纯文本值——公式、格式和其他工作表不会存入 .csv 文件。',
  },
  en: {
    filterSpreadsheets: 'Spreadsheets',
    filterXlsx: 'Excel Workbooks',
    filterXlsm: 'Excel Macro-Enabled Workbooks',
    odsImportMsg: 'Convert this .{ext} workbook?',
    odsImportDetail:
      'Vantage edits .xlsx, not ODF. Values, formulas and dates carry over (formulas are rewritten into Excel syntax, and any that cannot be rewritten safely keeps its current result). Styles, column widths and charts are not carried over. The original file is never changed; the converted copy saves as .xlsx the first time you save.',
    odsImportConvertBtn: 'Convert and open',
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
    errGskNotLoggedIn:
      'Not signed in to Genspark: click “Sign in to Genspark” below, sign in, then retry',
    errNoApiKey: 'No API key configured for {provider}',
    errAiRegion:
      "This model's provider does not serve your current region — pick another model or change your network",
    errAiBusy: 'The AI service is busy right now — please try again in a moment',
    errNoModel: 'No model name configured',
    errImgAbsPath: 'Image path must be absolute.',
    errImgNotFound: 'Image file not found: {path}',
    errImgTooLarge20: 'Image exceeds 20MB and cannot be inserted.',
    errImgBadType: 'The file is not a PNG/JPEG/GIF image.',
    errDiskChanged: 'The workbook changed on disk after it was opened — use Save As instead.',
    autosaveFoundTitle: 'Recovered version found',
    autosaveDiskNewer:
      'Note: the file on disk was modified after this recovery copy was saved. Restoring replaces those newer changes.',
    autosaveFoundBody:
      'There are unsaved changes from your last session. Restore the autosaved version? Saving after a restore overwrites the original file.',
    autosaveRestore: 'Restore',
    autosaveDiscard: 'Discard',
    menuFile: 'File',
    menuOpenWorkbook: 'Open Workbook…',
    menuSave: 'Save',
    menuSaveAs: 'Save As…',
    menuExportPdf: 'Export PDF…',
    menuPrint: 'Print…',
    menuClose: 'Close',
    menuQuit: 'Quit',
    menuEdit: 'Edit',
    menuUndo: 'Undo',
    menuRedo: 'Redo',
    closeUnsavedMsg: '{count} unsaved change(s)',
    closeUnsavedDetail: 'Your changes will be lost if you close without saving.',
    btnDontSave: "Don't Save",
    btnCancel: 'Cancel',
    csvSaveAsNotice: "CSV files can't keep formatting — saving as .xlsx keeps all your changes.",
    menuExportCsv: 'Export CSV…',
    filterCsv: 'CSV (Comma delimited)',
    csvFormulaLossMsg: 'This sheet contains formulas that CSV cannot keep.',
    csvFormulaLossDetail:
      'CSV keeps plain values only — formulas are flattened to their current results, and formatting is lost.',
    csvKeepXlsxBtn: 'Save as .xlsx',
    csvContinueBtn: 'Continue as CSV',
    csvActiveSheetOnlyNotice:
      'CSV files hold a single sheet — only the active sheet "{name}" will be exported.',
    csvKeepFormatMsg: 'Keep saving in CSV format?',
    csvKeepFormatDetail:
      'CSV keeps plain values of a single sheet only — formulas, formatting, and any additional sheets are not saved to the .csv file.',
  },
  vi: {
    filterSpreadsheets: 'Bảng tính',
    filterXlsx: 'Sổ làm việc Excel',
    filterXlsm: 'Sổ làm việc Excel hỗ trợ Macro',
    odsImportMsg: 'Chuyển đổi sổ làm việc .{ext} này?',
    odsImportDetail:
      'Vantage chỉnh sửa .xlsx chứ không chỉnh sửa ODF. Giá trị, công thức và ngày tháng sẽ được chuyển đổi (công thức viết lại theo cú pháp Excel, công thức không viết lại an toàn được sẽ giữ kết quả hiện tại). Kiểu dáng, độ rộng cột và biểu đồ không được chuyển. Tệp gốc không bao giờ bị sửa; bản sau chuyển đổi sẽ lưu thành .xlsx khi lưu lần đầu.',
    odsImportConvertBtn: 'Chuyển đổi và mở',
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
    errGskNotLoggedIn:
      'Chưa đăng nhập vào Genspark: nhấp vào “Đăng nhập vào Genspark” bên dưới, đăng nhập, sau đó thử lại',
    errNoApiKey: 'Chưa cấu hình khóa API cho {provider}',
    errAiRegion:
      'Nhà cung cấp của mô hình này không phục vụ khu vực hiện tại của bạn — hãy chọn mô hình khác hoặc đổi mạng',
    errAiBusy: 'Dịch vụ AI hiện đang bận — vui lòng thử lại sau giây lát',
    errNoModel: 'Chưa cấu hình tên mô hình',
    errImgAbsPath: 'Đường dẫn hình ảnh phải là đường dẫn tuyệt đối.',
    errImgNotFound: 'Không tìm thấy tệp hình ảnh: {path}',
    errImgTooLarge20: 'Hình ảnh vượt quá 20MB và không thể chèn.',
    errImgBadType: 'Tệp không phải là hình ảnh PNG/JPEG/GIF.',
    errDiskChanged: 'Sổ làm việc đã thay đổi trên đĩa sau khi mở — hãy sử dụng Lưu dưới dạng.',
    autosaveFoundTitle: 'Tìm thấy phiên bản khôi phục',
    autosaveDiskNewer:
      'Lưu ý: tệp trên đĩa đã được sửa đổi sau khi bản sao khôi phục này được lưu. Khôi phục sẽ thay thế những thay đổi mới hơn đó.',
    autosaveFoundBody:
      'Có những thay đổi chưa được lưu từ phiên làm việc trước của bạn. Khôi phục phiên bản đã lưu tự động? Việc lưu sau khi khôi phục sẽ ghi đè lên tệp gốc.',
    autosaveRestore: 'Khôi phục',
    autosaveDiscard: 'Bỏ qua',
    menuFile: 'Tệp',
    menuOpenWorkbook: 'Mở sổ làm việc…',
    menuSave: 'Lưu',
    menuSaveAs: 'Lưu dưới dạng…',
    menuExportPdf: 'Xuất PDF…',
    menuPrint: 'In…',
    menuClose: 'Đóng',
    menuQuit: 'Thoát',
    menuEdit: 'Chỉnh sửa',
    menuUndo: 'Hoàn tác',
    menuRedo: 'Làm lại',
    closeUnsavedMsg: '{count} thay đổi chưa lưu',
    closeUnsavedDetail: 'Các thay đổi của bạn sẽ bị mất nếu bạn đóng mà không lưu.',
    btnDontSave: 'Không lưu',
    btnCancel: 'Hủy',
    csvSaveAsNotice:
      'Tệp CSV không thể giữ lại định dạng — lưu dưới dạng .xlsx sẽ giữ lại tất cả các thay đổi của bạn.',
    menuExportCsv: 'Xuất CSV…',
    filterCsv: 'CSV (Phân tách bằng dấu phẩy)',
    csvFormulaLossMsg: 'Trang tính này chứa các công thức mà định dạng CSV không thể lưu giữ.',
    csvFormulaLossDetail:
      'CSV chỉ giữ các giá trị thuần — các công thức được làm phẳng thành kết quả hiện tại của chúng và định dạng sẽ bị mất.',
    csvKeepXlsxBtn: 'Lưu dưới dạng .xlsx',
    csvContinueBtn: 'Tiếp tục dưới dạng CSV',
    csvActiveSheetOnlyNotice:
      'Tệp CSV chỉ chứa một trang tính duy nhất — chỉ trang tính đang hoạt động "{name}" sẽ được xuất.',
    csvKeepFormatMsg: 'Tiếp tục lưu ở định dạng CSV?',
    csvKeepFormatDetail:
      'CSV chỉ giữ các giá trị thuần của một trang tính duy nhất — các công thức, định dạng và mọi trang tính bổ sung sẽ không được lưu vào tệp .csv.',
  },
  tr: {
    filterSpreadsheets: 'Elektronik Tablolar',
    filterXlsx: 'Excel Çalışma Kitapları',
    filterXlsm: 'Excel Makro İçerebilen Çalışma Kitapları',
    odsImportMsg: 'Bu .{ext} çalışma kitabı dönüştürülsün mü?',
    odsImportDetail:
      'Vantage ODF değil, .xlsx düzenler. Değerler, formüller ve tarihler aktarılır (formüller Excel söz dizimine yeniden yazılır; güvenle yeniden yazılamayanlar mevcut sonucunu korur). Stiller, sütun genişlikleri ve grafikler aktarılmaz. Özgün dosya asla değiştirilmez; dönüştürülen kopya ilk kaydettiğinizde .xlsx olarak kaydedilir.',
    odsImportConvertBtn: 'Dönüştür ve aç',
    dlgAddAttachment: 'Ek Ekle',
    filterSupported: 'Desteklenen Dosyalar',
    filterAll: 'Tüm Dosyalar',
    errUnsupportedExt: '.{ext} dosyaları desteklenmiyor',
    errNotFile: 'bir dosya değil',
    errTooLarge: '{mb}MB sınırını aşıyor',
    errImageTooLarge: 'görsel 5MB sınırını aşıyor',
    errUnreadable: 'okunamıyor',
    errFileTooLarge: 'Dosya boyut sınırını aşıyor',
    errParseFailed: 'Dosya ayrıştırılamadı',
    errImageNoText: 'Görsel eklerin metni yoktur; görsel kullanıcı mesajıyla birlikte gönderilir',
    errNotImage: 'desteklenen bir görsel türü değil',
    errGskNotLoggedIn:
      'Genspark oturumu açılmamış: aşağıdaki “Genspark’ta oturum aç” düğmesine tıklayın, oturum açın ve yeniden deneyin',
    errNoApiKey: '{provider} için API anahtarı yapılandırılmamış',
    errAiRegion:
      'Bu modelin sağlayıcısı bulunduğunuz bölgeye hizmet vermiyor — başka bir model seçin veya ağınızı değiştirin',
    errAiBusy: 'AI hizmeti şu anda meşgul — lütfen birazdan yeniden deneyin',
    errNoModel: 'Model adı yapılandırılmamış',
    errImgAbsPath: 'Görsel yolu mutlak olmalıdır.',
    errImgNotFound: 'Görsel dosyası bulunamadı: {path}',
    errImgTooLarge20: 'Görsel 20MB’ı aşıyor ve eklenemez.',
    errImgBadType: 'Dosya bir PNG/JPEG/GIF görseli değil.',
    errDiskChanged:
      'Çalışma kitabı açıldıktan sonra diskte değişti — bunun yerine Farklı Kaydet kullanın.',
    autosaveFoundTitle: 'Kurtarılan sürüm bulundu',
    autosaveDiskNewer:
      'Not: diskteki dosya bu kurtarma kopyası kaydedildikten sonra değiştirilmiş. Geri yüklemek bu yeni değişikliklerin yerini alır.',
    autosaveFoundBody:
      'Son oturumunuzdan kaydedilmemiş değişiklikler var. Otomatik kaydedilen sürüm geri yüklensin mi? Geri yüklemeden sonra kaydetmek özgün dosyanın üzerine yazar.',
    autosaveRestore: 'Geri Yükle',
    autosaveDiscard: 'Vazgeç',
    menuFile: 'Dosya',
    menuOpenWorkbook: 'Çalışma Kitabı Aç…',
    menuSave: 'Kaydet',
    menuSaveAs: 'Farklı Kaydet…',
    menuExportPdf: 'PDF Olarak Dışa Aktar…',
    menuPrint: 'Yazdır…',
    menuClose: 'Kapat',
    menuQuit: 'Çık',
    menuEdit: 'Düzenle',
    menuUndo: 'Geri Al',
    menuRedo: 'Yinele',
    closeUnsavedMsg: '{count} kaydedilmemiş değişiklik',
    closeUnsavedDetail: 'Kaydetmeden kapatırsanız değişiklikleriniz kaybolur.',
    btnDontSave: 'Kaydetme',
    btnCancel: 'İptal',
    csvSaveAsNotice:
      'CSV dosyaları biçimlendirmeyi koruyamaz — .xlsx olarak kaydetmek tüm değişikliklerinizi korur.',
    menuExportCsv: 'CSV Olarak Dışa Aktar…',
    filterCsv: 'CSV (Virgülle ayrılmış)',
    csvFormulaLossMsg: 'Bu sayfa, CSV’nin koruyamayacağı formüller içeriyor.',
    csvFormulaLossDetail:
      'CSV yalnızca düz değerleri korur — formüller mevcut sonuçlarına indirgenir ve biçimlendirme kaybolur.',
    csvKeepXlsxBtn: '.xlsx olarak kaydet',
    csvContinueBtn: 'CSV olarak devam et',
    csvActiveSheetOnlyNotice:
      'CSV dosyaları tek bir sayfa tutar — yalnızca etkin sayfa "{name}" dışa aktarılacak.',
    csvKeepFormatMsg: 'CSV biçiminde kaydetmeye devam edilsin mi?',
    csvKeepFormatDetail:
      'CSV yalnızca tek bir sayfanın düz değerlerini korur — formüller, biçimlendirme ve ek sayfalar .csv dosyasına kaydedilmez.',
  },
  ja: {
    filterSpreadsheets: 'スプレッドシート',
    filterXlsx: 'Excel ブック',
    filterXlsm: 'Excel マクロ有効ブック',
    odsImportMsg: 'この .{ext} ワークブックを変換しますか？',
    odsImportDetail:
      'Vantage は ODF ではなく .xlsx を編集します。値・数式・日付は変換されます（数式は Excel の構文に書き換えられ、安全に書き換えられないものは現在の値だけが残ります）。スタイル、列の幅、グラフは引き継がれません。元のファイルは変更されず、変換後のコピーは最初に保存する際 .xlsx として保存されます。',
    odsImportConvertBtn: '変換して開く',
    dlgAddAttachment: '添付ファイルを追加',
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
      '画像添付にはテキストがありません。画像はユーザー メッセージと一緒に送信されるため、そのまま画像をご確認ください',
    errNotImage: 'サポートされていない画像形式です',
    errGskNotLoggedIn:
      'Genspark にサインインしていません。下の「Genspark にサインイン」からサインインして再試行してください',
    errNoApiKey: '{provider} の API キーが設定されていません',
    errAiRegion:
      'このモデルの提供元は現在の地域ではサービスを提供していません。別のモデルを選ぶか、ネットワークを切り替えてください',
    errAiBusy: 'AI サービスが混み合っています。しばらくしてからもう一度お試しください',
    errNoModel: 'モデル名が設定されていません',
    errImgAbsPath: '画像パスは絶対パスで指定してください。',
    errImgNotFound: '画像ファイルが見つかりません: {path}',
    errImgTooLarge20: '画像が 20MB を超えているため挿入できません。',
    errImgBadType: 'このファイルは PNG/JPEG/GIF 画像ではありません。',
    errDiskChanged:
      'ブックを開いた後にディスク上で変更されています — 名前を付けて保存を使用してください。',
    autosaveFoundTitle: '自動回復バージョンがあります',
    autosaveDiskNewer:
      '注意: この回復コピーの保存後にディスク上のファイルが変更されています。復元するとその新しい変更は置き換えられます。',
    autosaveFoundBody:
      '前回のセッションに未保存の変更があります。自動保存版を復元しますか?復元後に保存すると、元のファイルは上書きされます。',
    autosaveRestore: '復元',
    autosaveDiscard: '破棄',
    menuFile: 'ファイル',
    menuOpenWorkbook: 'ブックを開く…',
    menuSave: '保存',
    menuSaveAs: '名前を付けて保存…',
    menuExportPdf: 'PDF をエクスポート…',
    menuPrint: '印刷…',
    menuClose: '閉じる',
    menuQuit: '終了',
    menuEdit: '編集',
    menuUndo: '元に戻す',
    menuRedo: 'やり直し',
    closeUnsavedMsg: '未保存の変更が {count} 件あります',
    closeUnsavedDetail: '保存せずに閉じると、これらの変更は失われます。',
    btnDontSave: '保存しない',
    btnCancel: 'キャンセル',
    csvSaveAsNotice:
      'CSV 形式は書式を保持できません。.xlsx として保存すると変更をすべて保持できます。',
    menuExportCsv: 'CSV をエクスポート…',
    filterCsv: 'CSV (コンマ区切り)',
    csvFormulaLossMsg: 'このシートには CSV 形式では保持できない数式が含まれています。',
    csvFormulaLossDetail:
      'CSV は値のみを保持します。数式は現在の計算結果に置き換えられ、書式も失われます。',
    csvKeepXlsxBtn: '.xlsx として保存',
    csvContinueBtn: 'CSV のまま保存',
    csvActiveSheetOnlyNotice:
      'CSV ファイルには 1 枚のシートしか含められません — アクティブなシート「{name}」のみがエクスポートされます。',
    csvKeepFormatMsg: 'CSV 形式のまま保存しますか?',
    csvKeepFormatDetail:
      'CSV は 1 枚のシートの値のみを保持します。数式、書式、追加のシートは .csv ファイルには保存されません。',
  },
  ko: {
    filterSpreadsheets: '스프레드시트',
    filterXlsx: 'Excel 통합 문서',
    filterXlsm: 'Excel 매크로 사용 통합 문서',
    odsImportMsg: '이 .{ext} 워크북을 변환할까요?',
    odsImportDetail:
      'Vantage은 ODF가 아니라 .xlsx를 편집합니다. 값, 수식, 날짜는 변환됩니다(수식은 Excel 구문으로 다시 쓰이며, 안전하게 다시 쓸 수 없는 수식은 현재 값만 남습니다). 스타일, 열 너비, 차트는 옮겨지지 않습니다. 원본 파일은 변경되지 않으며, 변환된 사본은 처음 저장할 때 .xlsx로 저장됩니다.',
    odsImportConvertBtn: '변환 후 열기',
    dlgAddAttachment: '첨부 파일 추가',
    filterSupported: '지원되는 파일',
    filterAll: '모든 파일',
    errUnsupportedExt: '.{ext} 형식은 지원되지 않습니다',
    errNotFile: '파일이 아닙니다',
    errTooLarge: '{mb}MB 제한을 초과했습니다',
    errImageTooLarge: '이미지가 5MB 제한을 초과했습니다',
    errUnreadable: '읽을 수 없습니다',
    errFileTooLarge: '파일이 크기 제한을 초과했습니다',
    errParseFailed: '파일을 구문 분석하지 못했습니다',
    errImageNoText:
      '이미지 첨부에는 텍스트가 없습니다. 이미지는 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하세요',
    errNotImage: '지원되는 이미지 형식이 아닙니다',
    errGskNotLoggedIn:
      'Genspark에 로그인되어 있지 않습니다. 아래 "Genspark 로그인"을 눌러 로그인한 뒤 다시 시도하세요',
    errNoApiKey: '{provider}의 API 키가 설정되지 않았습니다',
    errAiRegion:
      '이 모델의 제공업체는 현재 지역에서 서비스를 제공하지 않습니다. 다른 모델을 선택하거나 네트워크를 변경하세요',
    errAiBusy: 'AI 서비스가 혼잡합니다. 잠시 후 다시 시도해 주세요',
    errNoModel: '모델 이름이 설정되지 않았습니다',
    errImgAbsPath: '이미지 경로는 절대 경로여야 합니다.',
    errImgNotFound: '이미지 파일을 찾을 수 없습니다: {path}',
    errImgTooLarge20: '이미지가 20MB를 초과하여 삽입할 수 없습니다.',
    errImgBadType: '이 파일은 PNG/JPEG/GIF 이미지가 아닙니다.',
    errDiskChanged:
      '통합 문서가 열린 후 디스크에서 변경되었습니다. 다른 이름으로 저장을 사용하세요.',
    autosaveFoundTitle: '자동 복구 버전 발견',
    autosaveDiskNewer:
      '참고: 이 복구 사본이 저장된 후 디스크의 파일이 수정되었습니다. 복원하면 그 최신 변경 내용이 대체됩니다.',
    autosaveFoundBody:
      '마지막 세션에 저장되지 않은 변경 내용이 있습니다. 자동 저장 버전을 복원할까요? 복원 후 저장하면 원본 파일을 덮어씁니다.',
    autosaveRestore: '복원',
    autosaveDiscard: '취소',
    menuFile: '파일',
    menuOpenWorkbook: '통합 문서 열기…',
    menuSave: '저장',
    menuSaveAs: '다른 이름으로 저장…',
    menuExportPdf: 'PDF 내보내기…',
    menuPrint: '인쇄…',
    menuClose: '닫기',
    menuQuit: '끝내기',
    menuEdit: '편집',
    menuUndo: '실행 취소',
    menuRedo: '다시 실행',
    closeUnsavedMsg: '저장하지 않은 변경이 {count}건 있습니다',
    closeUnsavedDetail: '저장하지 않고 닫으면 변경 내용이 손실됩니다.',
    btnDontSave: '저장 안 함',
    btnCancel: '취소',
    csvSaveAsNotice:
      'CSV 형식은 서식을 저장할 수 없습니다. .xlsx로 저장하면 모든 변경 내용이 유지됩니다.',
    menuExportCsv: 'CSV 내보내기…',
    filterCsv: 'CSV (쉼표로 분리)',
    csvFormulaLossMsg: '현재 시트에 CSV 형식이 유지할 수 없는 수식이 포함되어 있습니다.',
    csvFormulaLossDetail:
      'CSV는 값만 유지합니다 — 수식은 현재 계산 결과로 바뀌고 서식은 손실됩니다.',
    csvKeepXlsxBtn: '.xlsx로 저장',
    csvContinueBtn: 'CSV로 계속 저장',
    csvActiveSheetOnlyNotice:
      'CSV 파일에는 시트 하나만 포함됩니다 — 활성 시트 "{name}"만 내보냅니다.',
    csvKeepFormatMsg: 'CSV 형식으로 계속 저장하시겠습니까?',
    csvKeepFormatDetail:
      'CSV는 시트 하나의 값만 유지합니다 — 수식, 서식, 추가 시트는 .csv 파일에 저장되지 않습니다.',
  },
  fr: {
    filterSpreadsheets: 'Feuilles de calcul',
    filterXlsx: 'Classeurs Excel',
    filterXlsm: 'Classeurs Excel prenant en charge les macros',
    odsImportMsg: 'Convertir ce classeur .{ext} ?',
    odsImportDetail:
      'Vantage modifie des .xlsx, pas de l’ODF. Les valeurs, les formules et les dates sont converties (les formules sont réécrites en syntaxe Excel ; celles qui ne peuvent pas l’être en sécurité gardent leur résultat actuel). Les styles, les largeurs de colonne et les graphiques ne sont pas repris. Le fichier d’origine n’est jamais modifié ; la copie convertie s’enregistre en .xlsx lors du premier enregistrement.',
    odsImportConvertBtn: 'Convertir et ouvrir',
    dlgAddAttachment: 'Ajouter des pièces jointes',
    filterSupported: 'Fichiers pris en charge',
    filterAll: 'Tous les fichiers',
    errUnsupportedExt: 'Les fichiers .{ext} ne sont pas pris en charge',
    errNotFile: "n'est pas un fichier",
    errTooLarge: 'dépasse la limite de {mb} Mo',
    errImageTooLarge: "l'image dépasse la limite de 5 Mo",
    errUnreadable: 'illisible',
    errFileTooLarge: 'Le fichier dépasse la taille limite',
    errParseFailed: "Échec de l'analyse du fichier",
    errImageNoText:
      "Les images jointes n'ont pas de texte ; l'image est envoyée avec le message de l'utilisateur",
    errNotImage: "type d'image non pris en charge",
    errGskNotLoggedIn:
      'Non connecté à Genspark : cliquez sur « Se connecter à Genspark » ci-dessous, connectez-vous puis réessayez',
    errNoApiKey: 'Aucune clé API configurée pour {provider}',
    errAiRegion:
      'Le fournisseur de ce modèle ne dessert pas votre région actuelle — choisissez un autre modèle ou changez de réseau',
    errAiBusy: "Le service d'IA est actuellement surchargé — réessayez dans un instant",
    errNoModel: 'Aucun nom de modèle configuré',
    errImgAbsPath: "Le chemin de l'image doit être absolu.",
    errImgNotFound: 'Fichier image introuvable : {path}',
    errImgTooLarge20: "L'image dépasse 20 Mo et ne peut pas être insérée.",
    errImgBadType: "Ce fichier n'est pas une image PNG/JPEG/GIF.",
    errDiskChanged:
      'Le classeur a été modifié sur le disque après son ouverture — utilisez Enregistrer sous.',
    autosaveFoundTitle: 'Version récupérée trouvée',
    autosaveDiskNewer:
      'Remarque : le fichier sur le disque a été modifié après l’enregistrement de cette copie de récupération. La restauration remplacera ces modifications plus récentes.',
    autosaveFoundBody:
      "Des modifications non enregistrées existent. Restaurer la version auto-enregistrée ? Après restauration, l'enregistrement remplacera le fichier d'origine.",
    autosaveRestore: 'Restaurer',
    autosaveDiscard: 'Ignorer',
    menuFile: 'Fichier',
    menuOpenWorkbook: 'Ouvrir un classeur…',
    menuSave: 'Enregistrer',
    menuSaveAs: 'Enregistrer sous…',
    menuExportPdf: 'Exporter en PDF…',
    menuPrint: 'Imprimer…',
    menuClose: 'Fermer',
    menuQuit: 'Quitter',
    menuEdit: 'Édition',
    menuUndo: 'Annuler',
    menuRedo: 'Rétablir',
    closeUnsavedMsg: '{count} modification(s) non enregistrée(s)',
    closeUnsavedDetail: 'Vos modifications seront perdues si vous fermez sans enregistrer.',
    btnDontSave: 'Ne pas enregistrer',
    btnCancel: 'Annuler',
    csvSaveAsNotice:
      'Le format CSV ne conserve pas la mise en forme — enregistrez en .xlsx pour conserver toutes vos modifications.',
    menuExportCsv: 'Exporter en CSV…',
    filterCsv: 'CSV (délimité par des virgules)',
    csvFormulaLossMsg:
      'Cette feuille contient des formules que le format CSV ne peut pas conserver.',
    csvFormulaLossDetail:
      'Le CSV ne conserve que les valeurs — les formules sont remplacées par leur résultat actuel et la mise en forme est perdue.',
    csvKeepXlsxBtn: 'Enregistrer en .xlsx',
    csvContinueBtn: 'Continuer en CSV',
    csvActiveSheetOnlyNotice:
      "Les fichiers CSV ne contiennent qu'une seule feuille — seule la feuille active « {name} » sera exportée.",
    csvKeepFormatMsg: 'Continuer à enregistrer au format CSV ?',
    csvKeepFormatDetail:
      "Le CSV ne conserve que les valeurs d'une seule feuille — les formules, la mise en forme et les feuilles supplémentaires ne sont pas enregistrées dans le fichier .csv.",
  },
  de: {
    filterSpreadsheets: 'Tabellenkalkulationen',
    filterXlsx: 'Excel-Arbeitsmappen',
    filterXlsm: 'Excel-Arbeitsmappen mit Makros',
    odsImportMsg: 'Diese .{ext}-Arbeitsmappe konvertieren?',
    odsImportDetail:
      'Vantage bearbeitet .xlsx, nicht ODF. Werte, Formeln und Datumsangaben werden konvertiert (Formeln werden in Excel-Syntax umgeschrieben; was sich nicht sicher umschreiben lässt, behält seinen aktuellen Wert). Formatierungen, Spaltenbreiten und Diagramme entfallen. Die Originaldatei bleibt unverändert; die konvertierte Kopie wird beim ersten Speichern als .xlsx angelegt.',
    odsImportConvertBtn: 'Konvertieren und öffnen',
    dlgAddAttachment: 'Anlagen hinzufügen',
    filterSupported: 'Unterstützte Dateien',
    filterAll: 'Alle Dateien',
    errUnsupportedExt: '.{ext}-Dateien werden nicht unterstützt',
    errNotFile: 'keine Datei',
    errTooLarge: 'überschreitet das Limit von {mb} MB',
    errImageTooLarge: 'Bild überschreitet das Limit von 5 MB',
    errUnreadable: 'kann nicht gelesen werden',
    errFileTooLarge: 'Datei überschreitet die Größenbeschränkung',
    errParseFailed: 'Datei konnte nicht analysiert werden',
    errImageNoText:
      'Bildanlagen enthalten keinen Text; das Bild wird zusammen mit der Benutzernachricht gesendet',
    errNotImage: 'kein unterstützter Bildtyp',
    errGskNotLoggedIn:
      'Nicht bei Genspark angemeldet: Klicken Sie unten auf „Bei Genspark anmelden“, melden Sie sich an und versuchen Sie es erneut',
    errNoApiKey: 'Kein API-Schlüssel für {provider} konfiguriert',
    errAiRegion:
      'Der Anbieter dieses Modells bedient Ihre aktuelle Region nicht — wählen Sie ein anderes Modell oder wechseln Sie das Netzwerk',
    errAiBusy: 'Der KI-Dienst ist derzeit überlastet — bitte gleich erneut versuchen',
    errNoModel: 'Kein Modellname konfiguriert',
    errImgAbsPath: 'Der Bildpfad muss absolut sein.',
    errImgNotFound: 'Bilddatei nicht gefunden: {path}',
    errImgTooLarge20: 'Das Bild überschreitet 20 MB und kann nicht eingefügt werden.',
    errImgBadType: 'Die Datei ist kein PNG/JPEG/GIF-Bild.',
    errDiskChanged:
      'Die Arbeitsmappe wurde nach dem Öffnen auf dem Datenträger geändert — verwenden Sie stattdessen „Speichern unter“.',
    autosaveFoundTitle: 'Wiederhergestellte Version gefunden',
    autosaveDiskNewer:
      'Hinweis: Die Datei auf dem Datenträger wurde nach dem Speichern dieser Wiederherstellungskopie geändert. Beim Wiederherstellen werden diese neueren Änderungen ersetzt.',
    autosaveFoundBody:
      'Es gibt ungespeicherte Änderungen. Automatisch gespeicherte Version wiederherstellen? Nach der Wiederherstellung überschreibt Speichern die Originaldatei.',
    autosaveRestore: 'Wiederherstellen',
    autosaveDiscard: 'Verwerfen',
    menuFile: 'Datei',
    menuOpenWorkbook: 'Arbeitsmappe öffnen…',
    menuSave: 'Speichern',
    menuSaveAs: 'Speichern unter…',
    menuExportPdf: 'PDF exportieren…',
    menuPrint: 'Drucken…',
    menuClose: 'Schließen',
    menuQuit: 'Beenden',
    menuEdit: 'Bearbeiten',
    menuUndo: 'Rückgängig',
    menuRedo: 'Wiederholen',
    closeUnsavedMsg: '{count} nicht gespeicherte Änderung(en)',
    closeUnsavedDetail: 'Ihre Änderungen gehen verloren, wenn Sie ohne Speichern schließen.',
    btnDontSave: 'Nicht speichern',
    btnCancel: 'Abbrechen',
    csvSaveAsNotice:
      'CSV-Dateien können keine Formatierung speichern – als .xlsx speichern, um alle Änderungen zu behalten.',
    menuExportCsv: 'CSV exportieren…',
    filterCsv: 'CSV (Trennzeichen-getrennt)',
    csvFormulaLossMsg: 'Dieses Blatt enthält Formeln, die das CSV-Format nicht speichern kann.',
    csvFormulaLossDetail:
      'CSV speichert nur reine Werte – Formeln werden durch ihre aktuellen Ergebnisse ersetzt, und die Formatierung geht verloren.',
    csvKeepXlsxBtn: 'Als .xlsx speichern',
    csvContinueBtn: 'Als CSV fortfahren',
    csvActiveSheetOnlyNotice:
      'CSV-Dateien enthalten nur ein Blatt – nur das aktive Blatt „{name}“ wird exportiert.',
    csvKeepFormatMsg: 'Weiter im CSV-Format speichern?',
    csvKeepFormatDetail:
      'CSV speichert nur die Werte eines einzelnen Blatts – Formeln, Formatierungen und weitere Blätter werden nicht in der .csv-Datei gespeichert.',
  },
  es: {
    filterSpreadsheets: 'Hojas de cálculo',
    filterXlsx: 'Libros de Excel',
    filterXlsm: 'Libros de Excel habilitados para macros',
    odsImportMsg: '¿Convertir este libro .{ext}?',
    odsImportDetail:
      'Vantage edita .xlsx, no ODF. Los valores, las fórmulas y las fechas se convierten (las fórmulas se reescriben con sintaxis de Excel; las que no se pueden reescribir con seguridad conservan su resultado actual). Los estilos, el ancho de columna y los gráficos no se conservan. El archivo original nunca se modifica; la copia convertida se guarda como .xlsx la primera vez que se guarda.',
    odsImportConvertBtn: 'Convertir y abrir',
    dlgAddAttachment: 'Agregar datos adjuntos',
    filterSupported: 'Archivos compatibles',
    filterAll: 'Todos los archivos',
    errUnsupportedExt: 'Los archivos .{ext} no son compatibles',
    errNotFile: 'no es un archivo',
    errTooLarge: 'supera el límite de {mb} MB',
    errImageTooLarge: 'la imagen supera el límite de 5 MB',
    errUnreadable: 'no se puede leer',
    errFileTooLarge: 'El archivo supera el límite de tamaño',
    errParseFailed: 'No se pudo analizar el archivo',
    errImageNoText:
      'Las imágenes adjuntas no tienen texto; la imagen se envía junto con el mensaje del usuario',
    errNotImage: 'no es un tipo de imagen compatible',
    errGskNotLoggedIn:
      'No has iniciado sesión en Genspark: pulsa «Iniciar sesión en Genspark» abajo, inicia sesión y vuelve a intentarlo',
    errNoApiKey: 'No hay clave de API configurada para {provider}',
    errAiRegion:
      'El proveedor de este modelo no da servicio en tu región actual — elige otro modelo o cambia de red',
    errAiBusy:
      'El servicio de IA está saturado en este momento; inténtalo de nuevo en unos instantes',
    errNoModel: 'No hay nombre de modelo configurado',
    errImgAbsPath: 'La ruta de la imagen debe ser absoluta.',
    errImgNotFound: 'No se encontró el archivo de imagen: {path}',
    errImgTooLarge20: 'La imagen supera los 20 MB y no se puede insertar.',
    errImgBadType: 'El archivo no es una imagen PNG/JPEG/GIF.',
    errDiskChanged: 'El libro cambió en el disco después de abrirse; usa Guardar como en su lugar.',
    autosaveFoundTitle: 'Se encontró una versión recuperada',
    autosaveDiskNewer:
      'Nota: el archivo en disco se modificó después de guardar esta copia de recuperación. Restaurar reemplazará esos cambios más recientes.',
    autosaveFoundBody:
      'Hay cambios sin guardar de la última sesión. ¿Restaurar la versión autoguardada? Tras restaurar, guardar sobrescribirá el archivo original.',
    autosaveRestore: 'Restaurar',
    autosaveDiscard: 'Descartar',
    menuFile: 'Archivo',
    menuOpenWorkbook: 'Abrir libro…',
    menuSave: 'Guardar',
    menuSaveAs: 'Guardar como…',
    menuExportPdf: 'Exportar a PDF…',
    menuPrint: 'Imprimir…',
    menuClose: 'Cerrar',
    menuQuit: 'Salir',
    menuEdit: 'Edición',
    menuUndo: 'Deshacer',
    menuRedo: 'Rehacer',
    closeUnsavedMsg: '{count} cambio(s) sin guardar',
    closeUnsavedDetail: 'Los cambios se perderán si cierras sin guardar.',
    btnDontSave: 'No guardar',
    btnCancel: 'Cancelar',
    csvSaveAsNotice:
      'El formato CSV no conserva el formato: guarda como .xlsx para conservar todos tus cambios.',
    menuExportCsv: 'Exportar a CSV…',
    filterCsv: 'CSV (delimitado por comas)',
    csvFormulaLossMsg: 'Esta hoja contiene fórmulas que el formato CSV no puede conservar.',
    csvFormulaLossDetail:
      'El CSV solo conserva valores: las fórmulas se sustituyen por sus resultados actuales y el formato se pierde.',
    csvKeepXlsxBtn: 'Guardar como .xlsx',
    csvContinueBtn: 'Continuar como CSV',
    csvActiveSheetOnlyNotice:
      'Los archivos CSV solo contienen una hoja: solo se exportará la hoja activa «{name}».',
    csvKeepFormatMsg: '¿Seguir guardando en formato CSV?',
    csvKeepFormatDetail:
      'CSV solo conserva los valores de una única hoja: las fórmulas, el formato y las hojas adicionales no se guardan en el archivo .csv.',
  },
  th: {
    filterSpreadsheets: 'สเปรดชีต',
    filterXlsx: 'เวิร์กบุ๊ก Excel',
    filterXlsm: 'เวิร์กบุ๊ก Excel ที่เปิดใช้งานแมโคร',
    odsImportMsg: 'แปลงเวิร์กบุ๊ก .{ext} นี้ไหม?',
    odsImportDetail:
      'Vantage แก้ไข .xlsx ไม่ใช่ ODF ค่า สูตร และวันที่จะถูกแปลง (สูตรเขียนใหม่เป็นไวยากรณ์ Excel และสูตรที่เขียนใหม่อย่างปลอดภัยไม่ได้จะคงค่าปัจจุบันไว้) สไตล์ ความกว้างคอลัมน์ และแผนภูมิจะไม่ถูกโอนมา ไฟล์ต้นทางจะไม่ถูกแก้ไข และสำเนาที่แปลงแล้วจะบันทึกเป็น .xlsx ในการบันทึกครั้งแรก',
    odsImportConvertBtn: 'แปลงแล้วเปิด',
    dlgAddAttachment: 'เพิ่มสิ่งที่แนบ',
    filterSupported: 'ไฟล์ที่รองรับ',
    filterAll: 'ไฟล์ทั้งหมด',
    errUnsupportedExt: 'ไม่รองรับไฟล์ชนิด .{ext}',
    errNotFile: 'ไม่ใช่ไฟล์',
    errTooLarge: 'เกินขีดจำกัด {mb}MB',
    errImageTooLarge: 'รูปภาพเกินขีดจำกัด 5MB',
    errUnreadable: 'อ่านไม่ได้',
    errFileTooLarge: 'ไฟล์มีขนาดเกินขีดจำกัด',
    errParseFailed: 'แยกวิเคราะห์ไฟล์ไม่สำเร็จ',
    errImageNoText:
      'รูปภาพแนบไม่มีข้อความ รูปภาพจะถูกส่งไปพร้อมข้อความของผู้ใช้ ให้ดูที่รูปภาพโดยตรง',
    errNotImage: 'ไม่ใช่ชนิดรูปภาพที่รองรับ',
    errGskNotLoggedIn:
      'ยังไม่ได้ลงชื่อเข้าใช้ Genspark: แตะ “ลงชื่อเข้าใช้ Genspark” ด้านล่าง แล้วลองอีกครั้ง',
    errNoApiKey: 'ยังไม่ได้ตั้งค่า API Key ของ {provider}',
    errAiRegion:
      'ผู้ให้บริการของโมเดลนี้ไม่ให้บริการในภูมิภาคปัจจุบันของคุณ — โปรดเลือกโมเดลอื่นหรือเปลี่ยนเครือข่าย',
    errAiBusy: 'บริการ AI มีผู้ใช้งานจำนวนมากในขณะนี้ โปรดลองอีกครั้งในอีกสักครู่',
    errNoModel: 'ยังไม่ได้กำหนดชื่อโมเดล',
    errImgAbsPath: 'เส้นทางรูปภาพต้องเป็นเส้นทางแบบสัมบูรณ์',
    errImgNotFound: 'ไม่พบไฟล์รูปภาพ: {path}',
    errImgTooLarge20: 'รูปภาพเกิน 20MB ไม่สามารถแทรกได้',
    errImgBadType: 'ไฟล์นี้ไม่ใช่รูปภาพ PNG/JPEG/GIF',
    errDiskChanged: 'เวิร์กบุ๊กถูกเปลี่ยนแปลงบนดิสก์หลังจากเปิด — โปรดใช้บันทึกเป็นแทน',
    autosaveFoundTitle: 'พบเวอร์ชันกู้คืนอัตโนมัติ',
    autosaveDiskNewer:
      'หมายเหตุ: ไฟล์บนดิสก์ถูกแก้ไขหลังจากบันทึกสำเนากู้คืนนี้ การกู้คืนจะแทนที่การเปลี่ยนแปลงที่ใหม่กว่าเหล่านั้น',
    autosaveFoundBody:
      'มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึกจากครั้งก่อน ต้องการกู้คืนหรือไม่? หลังกู้คืน การบันทึกจะเขียนทับไฟล์ต้นฉบับ',
    autosaveRestore: 'กู้คืน',
    autosaveDiscard: 'ละทิ้ง',
    menuFile: 'ไฟล์',
    menuOpenWorkbook: 'เปิดเวิร์กบุ๊ก…',
    menuSave: 'บันทึก',
    menuSaveAs: 'บันทึกเป็น…',
    menuExportPdf: 'ส่งออก PDF…',
    menuPrint: 'พิมพ์…',
    menuClose: 'ปิด',
    menuQuit: 'ออก',
    menuEdit: 'แก้ไข',
    menuUndo: 'เลิกทำ',
    menuRedo: 'ทำซ้ำ',
    closeUnsavedMsg: 'มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก {count} รายการ',
    closeUnsavedDetail: 'หากปิดโดยไม่บันทึก การเปลี่ยนแปลงเหล่านี้จะหายไป',
    btnDontSave: 'ไม่บันทึก',
    btnCancel: 'ยกเลิก',
    csvSaveAsNotice:
      'ไฟล์ CSV ไม่สามารถเก็บการจัดรูปแบบได้ — บันทึกเป็น .xlsx เพื่อเก็บการเปลี่ยนแปลงทั้งหมดของคุณ',
    menuExportCsv: 'ส่งออก CSV…',
    filterCsv: 'CSV (คั่นด้วยเครื่องหมายจุลภาค)',
    csvFormulaLossMsg: 'ชีตนี้มีสูตรที่รูปแบบ CSV เก็บไว้ไม่ได้',
    csvFormulaLossDetail:
      'CSV เก็บเฉพาะค่าเท่านั้น — สูตรจะถูกแทนที่ด้วยผลลัพธ์ปัจจุบัน และการจัดรูปแบบจะหายไป',
    csvKeepXlsxBtn: 'บันทึกเป็น .xlsx',
    csvContinueBtn: 'บันทึกเป็น CSV ต่อไป',
    csvActiveSheetOnlyNotice:
      'ไฟล์ CSV มีได้เพียงชีตเดียว — จะส่งออกเฉพาะชีตที่ใช้งานอยู่ “{name}” เท่านั้น',
    csvKeepFormatMsg: 'บันทึกเป็นรูปแบบ CSV ต่อไปหรือไม่',
    csvKeepFormatDetail:
      'CSV เก็บเฉพาะค่าของชีตเดียวเท่านั้น — สูตร การจัดรูปแบบ และชีตอื่น ๆ จะไม่ถูกบันทึกลงในไฟล์ .csv',
  },
  id: {
    filterSpreadsheets: 'Lembar bentang',
    filterXlsx: 'Buku kerja Excel',
    filterXlsm: 'Buku kerja Excel dengan makro aktif',
    odsImportMsg: 'Konversi buku kerja .{ext} ini?',
    odsImportDetail:
      'Vantage mengedit .xlsx, bukan ODF. Nilai, rumus, dan tanggal ikut terkonversi (rumus ditulis ulang ke sintaks Excel; rumus yang tidak bisa ditulis ulang dengan aman mempertahankan hasilnya). Gaya, lebar kolom, dan grafik tidak ikut dibawa. File asli tidak pernah diubah; hasil konversi disimpan sebagai .xlsx saat penyimpanan pertama.',
    odsImportConvertBtn: 'Konversi dan buka',
    dlgAddAttachment: 'Tambahkan lampiran',
    filterSupported: 'File yang didukung',
    filterAll: 'Semua file',
    errUnsupportedExt: 'File .{ext} tidak didukung',
    errNotFile: 'bukan file',
    errTooLarge: 'melebihi batas {mb}MB',
    errImageTooLarge: 'gambar melebihi batas 5MB',
    errUnreadable: 'tidak dapat dibaca',
    errFileTooLarge: 'File melebihi batas ukuran',
    errParseFailed: 'Gagal mengurai file',
    errImageNoText: 'Lampiran gambar tidak memiliki teks; gambar dikirim bersama pesan pengguna',
    errNotImage: 'bukan jenis gambar yang didukung',
    errGskNotLoggedIn: 'Belum masuk ke Genspark: klik “Masuk ke Genspark” di bawah, lalu coba lagi',
    errNoApiKey: 'API Key untuk {provider} belum dikonfigurasi',
    errAiRegion:
      'Penyedia model ini tidak melayani wilayah Anda saat ini — pilih model lain atau ganti jaringan',
    errAiBusy: 'Layanan AI sedang sibuk — silakan coba lagi sebentar lagi',
    errNoModel: 'Nama model belum dikonfigurasi',
    errImgAbsPath: 'Jalur gambar harus berupa jalur absolut.',
    errImgNotFound: 'File gambar tidak ditemukan: {path}',
    errImgTooLarge20: 'Gambar melebihi 20MB dan tidak dapat disisipkan.',
    errImgBadType: 'File ini bukan gambar PNG/JPEG/GIF.',
    errDiskChanged: 'Buku kerja berubah di disk setelah dibuka — gunakan Simpan Sebagai.',
    autosaveFoundTitle: 'Versi pemulihan ditemukan',
    autosaveDiskNewer:
      'Catatan: file di disk diubah setelah salinan pemulihan ini disimpan. Memulihkan akan menggantikan perubahan yang lebih baru tersebut.',
    autosaveFoundBody:
      'Ada perubahan yang belum disimpan dari sesi terakhir. Pulihkan versi tersimpan otomatis? Setelah dipulihkan, menyimpan akan menimpa file asli.',
    autosaveRestore: 'Pulihkan',
    autosaveDiscard: 'Buang',
    menuFile: 'File',
    menuOpenWorkbook: 'Buka Buku Kerja…',
    menuSave: 'Simpan',
    menuSaveAs: 'Simpan Sebagai…',
    menuExportPdf: 'Ekspor PDF…',
    menuPrint: 'Cetak…',
    menuClose: 'Tutup',
    menuQuit: 'Keluar',
    menuEdit: 'Edit',
    menuUndo: 'Urungkan',
    menuRedo: 'Ulangi',
    closeUnsavedMsg: '{count} perubahan belum disimpan',
    closeUnsavedDetail: 'Perubahan Anda akan hilang jika menutup tanpa menyimpan.',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
    csvSaveAsNotice:
      'File CSV tidak dapat menyimpan pemformatan — simpan sebagai .xlsx untuk mempertahankan semua perubahan Anda.',
    menuExportCsv: 'Ekspor CSV…',
    filterCsv: 'CSV (dipisahkan koma)',
    csvFormulaLossMsg: 'Lembar ini berisi rumus yang tidak dapat disimpan dalam format CSV.',
    csvFormulaLossDetail:
      'CSV hanya menyimpan nilai — rumus diganti dengan hasil saat ini, dan pemformatan akan hilang.',
    csvKeepXlsxBtn: 'Simpan sebagai .xlsx',
    csvContinueBtn: 'Lanjutkan sebagai CSV',
    csvActiveSheetOnlyNotice:
      'File CSV hanya memuat satu lembar — hanya lembar aktif “{name}” yang akan diekspor.',
    csvKeepFormatMsg: 'Terus menyimpan dalam format CSV?',
    csvKeepFormatDetail:
      'CSV hanya menyimpan nilai dari satu lembar — rumus, pemformatan, dan lembar tambahan tidak disimpan ke file .csv.',
  },
  ru: {
    filterSpreadsheets: 'Электронные таблицы',
    filterXlsx: 'Книги Excel',
    filterXlsm: 'Книги Excel с поддержкой макросов',
    odsImportMsg: 'Преобразовать эту книгу .{ext}?',
    odsImportDetail:
      'Vantage редактирует .xlsx, а не ODF. Значения, формулы и даты переносятся (формулы переписываются в синтаксис Excel; те, что нельзя переписать безопасно, сохраняют текущий результат). Стили, ширина столбцов и диаграммы не переносятся. Исходный файл никогда не изменяется; преобразованная копия при первом сохранении записывается как .xlsx.',
    odsImportConvertBtn: 'Преобразовать и открыть',
    dlgAddAttachment: 'Добавить вложения',
    filterSupported: 'Поддерживаемые файлы',
    filterAll: 'Все файлы',
    errUnsupportedExt: 'Файлы .{ext} не поддерживаются',
    errNotFile: 'не является файлом',
    errTooLarge: 'превышает лимит {mb} МБ',
    errImageTooLarge: 'изображение превышает лимит 5 МБ',
    errUnreadable: 'не удаётся прочитать',
    errFileTooLarge: 'Файл превышает предельный размер',
    errParseFailed: 'Не удалось разобрать файл',
    errImageNoText:
      'Вложенные изображения не содержат текста; изображение отправляется вместе с сообщением пользователя',
    errNotImage: 'неподдерживаемый тип изображения',
    errGskNotLoggedIn:
      'Вы не вошли в Genspark: нажмите «Войти в Genspark» ниже, войдите и повторите попытку',
    errNoApiKey: 'API-ключ для {provider} не настроен',
    errAiRegion:
      'Поставщик этой модели не обслуживает ваш текущий регион — выберите другую модель или смените сеть',
    errAiBusy: 'Сервис ИИ сейчас перегружен — повторите попытку чуть позже',
    errNoModel: 'Имя модели не настроено',
    errImgAbsPath: 'Путь к изображению должен быть абсолютным.',
    errImgNotFound: 'Файл изображения не найден: {path}',
    errImgTooLarge20: 'Изображение превышает 20 МБ и не может быть вставлено.',
    errImgBadType: 'Этот файл не является изображением PNG/JPEG/GIF.',
    errDiskChanged: 'Книга была изменена на диске после открытия — используйте «Сохранить как».',
    autosaveFoundTitle: 'Найдена восстановленная версия',
    autosaveDiskNewer:
      'Внимание: файл на диске был изменён после сохранения этой копии восстановления. Восстановление заменит эти более новые изменения.',
    autosaveFoundBody:
      'Есть несохранённые изменения из прошлого сеанса. Восстановить автосохранённую версию? После восстановления сохранение перезапишет исходный файл.',
    autosaveRestore: 'Восстановить',
    autosaveDiscard: 'Отклонить',
    menuFile: 'Файл',
    menuOpenWorkbook: 'Открыть книгу…',
    menuSave: 'Сохранить',
    menuSaveAs: 'Сохранить как…',
    menuExportPdf: 'Экспорт в PDF…',
    menuPrint: 'Печать…',
    menuClose: 'Закрыть',
    menuQuit: 'Выход',
    menuEdit: 'Правка',
    menuUndo: 'Отменить',
    menuRedo: 'Повторить',
    closeUnsavedMsg: 'Несохранённых изменений: {count}',
    closeUnsavedDetail: 'Если закрыть без сохранения, эти изменения будут потеряны.',
    btnDontSave: 'Не сохранять',
    btnCancel: 'Отмена',
    csvSaveAsNotice:
      'Формат CSV не сохраняет форматирование — сохраните в .xlsx, чтобы не потерять изменения.',
    menuExportCsv: 'Экспорт в CSV…',
    filterCsv: 'CSV (разделители — запятые)',
    csvFormulaLossMsg: 'Этот лист содержит формулы, которые формат CSV не сохраняет.',
    csvFormulaLossDetail:
      'CSV сохраняет только значения — формулы заменяются текущими результатами, а форматирование теряется.',
    csvKeepXlsxBtn: 'Сохранить как .xlsx',
    csvContinueBtn: 'Продолжить в CSV',
    csvActiveSheetOnlyNotice:
      'Файлы CSV содержат только один лист — будет экспортирован только активный лист «{name}».',
    csvKeepFormatMsg: 'Продолжить сохранение в формате CSV?',
    csvKeepFormatDetail:
      'CSV сохраняет только значения одного листа — формулы, форматирование и дополнительные листы не сохраняются в файле .csv.',
  },
  ar: {
    filterSpreadsheets: 'جداول البيانات',
    filterXlsx: 'مصنفات Excel',
    filterXlsm: 'مصنفات Excel ممكّنة بوحدات الماكرو',
    odsImportMsg: 'تحويل دفتر عمل .{ext} هذا؟',
    odsImportDetail:
      'يحرّر Vantage ملفات ‎.xlsx ولا يحرّر ODF. تُحوَّل القيم والصيغ والتواريخ (تُعاد كتابة الصيغ بصيغة Excel، والصيغ التي لا يمكن إعادة كتابتها بأمان تحتفظ بنتيجتها الحالية). لا تُنقل الأنماط وعرض الأعمدة والرسوم البيانية. لا يتغيّر الملف الأصلي أبدًا؛ والنسخة المحوّلة تُحفظ بصيغة ‎.xlsx عند أول حفظ.',
    odsImportConvertBtn: 'تحويل وفتح',
    dlgAddAttachment: 'إضافة مرفقات',
    filterSupported: 'الملفات المدعومة',
    filterAll: 'كل الملفات',
    errUnsupportedExt: 'ملفات .{ext} غير مدعومة',
    errNotFile: 'ليس ملفًا',
    errTooLarge: 'يتجاوز الحد البالغ {mb} ميغابايت',
    errImageTooLarge: 'الصورة تتجاوز الحد البالغ 5 ميغابايت',
    errUnreadable: 'تعذّرت قراءته',
    errFileTooLarge: 'الملف يتجاوز حد الحجم',
    errParseFailed: 'فشل تحليل الملف',
    errImageNoText: 'مرفقات الصور لا تحتوي على نص؛ تُرسل الصورة مع رسالة المستخدم',
    errNotImage: 'نوع صورة غير مدعوم',
    errGskNotLoggedIn:
      'لم تسجّل الدخول إلى Genspark: انقر على «تسجيل الدخول إلى Genspark» أدناه ثم أعد المحاولة',
    errNoApiKey: 'لم يتم تكوين مفتاح API لـ {provider}',
    errAiRegion:
      'مزوّد هذا النموذج لا يقدم الخدمة في منطقتك الحالية — اختر نموذجًا آخر أو غيّر الشبكة',
    errAiBusy: 'خدمة الذكاء الاصطناعي مشغولة حاليًا — يرجى المحاولة مرة أخرى بعد قليل',
    errNoModel: 'لم يتم تكوين اسم النموذج',
    errImgAbsPath: 'يجب أن يكون مسار الصورة مسارًا مطلقًا.',
    errImgNotFound: 'لم يتم العثور على ملف الصورة: {path}',
    errImgTooLarge20: 'الصورة تتجاوز 20 ميغابايت ولا يمكن إدراجها.',
    errImgBadType: 'هذا الملف ليس صورة PNG/JPEG/GIF.',
    errDiskChanged: 'تم تغيير المصنف على القرص بعد فتحه — استخدم «حفظ باسم» بدلاً من ذلك.',
    autosaveFoundTitle: 'تم العثور على نسخة مستردة',
    autosaveDiskNewer:
      'ملاحظة: تم تعديل الملف على القرص بعد حفظ نسخة الاسترداد هذه. ستؤدي الاستعادة إلى استبدال تلك التغييرات الأحدث.',
    autosaveFoundBody:
      'توجد تغييرات غير محفوظة من الجلسة الأخيرة. هل تريد استعادة النسخة المحفوظة تلقائيًا؟ بعد الاستعادة، سيؤدي الحفظ إلى استبدال الملف الأصلي.',
    autosaveRestore: 'استعادة',
    autosaveDiscard: 'تجاهل',
    menuFile: 'ملف',
    menuOpenWorkbook: 'فتح مصنف…',
    menuSave: 'حفظ',
    menuSaveAs: 'حفظ باسم…',
    menuExportPdf: 'تصدير PDF…',
    menuPrint: 'طباعة…',
    menuClose: 'إغلاق',
    menuQuit: 'إنهاء',
    menuEdit: 'تحرير',
    menuUndo: 'تراجع',
    menuRedo: 'إعادة',
    closeUnsavedMsg: 'يوجد {count} من التغييرات غير المحفوظة',
    closeUnsavedDetail: 'ستفقد هذه التغييرات إذا أغلقت دون حفظ.',
    btnDontSave: 'عدم الحفظ',
    btnCancel: 'إلغاء',
    csvSaveAsNotice: 'ملفات CSV لا تحتفظ بالتنسيق — احفظ بصيغة ‎.xlsx للاحتفاظ بجميع تغييراتك.',
    menuExportCsv: 'تصدير CSV…',
    filterCsv: 'CSV (محدد بفواصل)',
    csvFormulaLossMsg: 'تحتوي هذه الورقة على صيغ لا يمكن لتنسيق CSV الاحتفاظ بها.',
    csvFormulaLossDetail: 'يحتفظ CSV بالقيم فقط — تُستبدل الصيغ بنتائجها الحالية ويُفقد التنسيق.',
    csvKeepXlsxBtn: 'حفظ بصيغة .xlsx',
    csvContinueBtn: 'المتابعة بتنسيق CSV',
    csvActiveSheetOnlyNotice:
      'ملفات CSV تحتوي على ورقة واحدة فقط — سيتم تصدير الورقة النشطة «{name}» فقط.',
    csvKeepFormatMsg: 'هل تريد متابعة الحفظ بتنسيق CSV؟',
    csvKeepFormatDetail:
      'يحتفظ CSV بقيم ورقة واحدة فقط — لا تُحفظ الصيغ والتنسيق والأوراق الإضافية في ملف .csv.',
  },
  pt: {
    filterSpreadsheets: 'Planilhas',
    filterXlsx: 'Pastas de Trabalho do Excel',
    filterXlsm: 'Pastas de Trabalho Habilitadas para Macro do Excel',
    odsImportMsg: 'Converter este livro .{ext}?',
    odsImportDetail:
      'O Vantage edita .xlsx, não ODF. Valores, fórmulas e datas são convertidos (as fórmulas são reescritas na sintaxe do Excel; as que não podem ser reescritas com segurança mantêm o resultado atual). Estilos, largura de coluna e gráficos não são mantidos. O arquivo original nunca é alterado; a cópia convertida é salva como .xlsx no primeiro salvamento.',
    odsImportConvertBtn: 'Converter e abrir',
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
      'Anexos de imagem não têm texto; a imagem é enviada junto com a mensagem do usuário',
    errNotImage: 'não é um tipo de imagem suportado',
    errGskNotLoggedIn:
      'Não conectado ao Genspark: clique em “Entrar no Genspark” abaixo, entre e tente novamente',
    errNoApiKey: 'Nenhuma chave de API configurada para {provider}',
    errAiRegion:
      'O fornecedor deste modelo não atende à sua região atual — escolha outro modelo ou mude de rede',
    errAiBusy: 'O serviço de IA está sobrecarregado no momento — tente novamente em instantes',
    errNoModel: 'Nenhum nome de modelo configurado',
    errImgAbsPath: 'O caminho da imagem deve ser absoluto.',
    errImgNotFound: 'Arquivo de imagem não encontrado: {path}',
    errImgTooLarge20: 'A imagem excede 20MB e não pode ser inserida.',
    errImgBadType: 'O arquivo não é uma imagem PNG/JPEG/GIF.',
    errDiskChanged: 'A pasta de trabalho foi alterada no disco após ser aberta — use Salvar Como.',
    autosaveFoundTitle: 'Versão recuperada encontrada',
    autosaveDiskNewer:
      'Nota: o arquivo no disco foi modificado depois que esta cópia de recuperação foi salva. Restaurar substituirá essas alterações mais recentes.',
    autosaveFoundBody:
      'Há alterações não salvas da sua última sessão. Restaurar a versão salva automaticamente? Após restaurar, salvar sobrescreverá o arquivo original.',
    autosaveRestore: 'Restaurar',
    autosaveDiscard: 'Descartar',
    menuFile: 'Arquivo',
    menuOpenWorkbook: 'Abrir Pasta de Trabalho…',
    menuSave: 'Salvar',
    menuSaveAs: 'Salvar Como…',
    menuExportPdf: 'Exportar PDF…',
    menuPrint: 'Imprimir…',
    menuClose: 'Fechar',
    menuQuit: 'Sair',
    menuEdit: 'Editar',
    menuUndo: 'Desfazer',
    menuRedo: 'Refazer',
    closeUnsavedMsg: '{count} alteração(ões) não salva(s)',
    closeUnsavedDetail: 'Suas alterações serão perdidas se você fechar sem salvar.',
    btnDontSave: 'Não Salvar',
    btnCancel: 'Cancelar',
    csvSaveAsNotice:
      'Arquivos CSV não mantêm a formatação — salve como .xlsx para manter todas as suas alterações.',
    menuExportCsv: 'Exportar CSV…',
    filterCsv: 'CSV (separado por vírgulas)',
    csvFormulaLossMsg: 'Esta planilha contém fórmulas que o formato CSV não pode manter.',
    csvFormulaLossDetail:
      'O CSV mantém apenas valores — as fórmulas são substituídas pelos resultados atuais e a formatação é perdida.',
    csvKeepXlsxBtn: 'Salvar como .xlsx',
    csvContinueBtn: 'Continuar como CSV',
    csvActiveSheetOnlyNotice:
      'Arquivos CSV contêm apenas uma planilha — apenas a planilha ativa “{name}” será exportada.',
    csvKeepFormatMsg: 'Continuar salvando no formato CSV?',
    csvKeepFormatDetail:
      'O CSV mantém apenas os valores de uma única planilha — fórmulas, formatação e planilhas adicionais não são salvas no arquivo .csv.',
  },
  it: {
    filterSpreadsheets: 'Fogli di calcolo',
    filterXlsx: 'Cartelle di lavoro di Excel',
    filterXlsm: 'Cartelle di lavoro di Excel con attivazione macro',
    odsImportMsg: 'Convertire questa cartella di lavoro .{ext}?',
    odsImportDetail:
      'Vantage modifica .xlsx, non ODF. Valori, formule e date vengono convertiti (le formule sono riscritte nella sintassi di Excel; quelle che non possono essere riscritte in sicurezza mantengono il risultato attuale). Stili, larghezza colonne e grafici non vengono riportati. Il file originale non viene mai modificato; la copia convertita si salva come .xlsx al primo salvataggio.',
    odsImportConvertBtn: 'Converti e apri',
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
      "Gli allegati immagine non hanno testo; l'immagine viene inviata insieme al messaggio dell'utente",
    errNotImage: 'tipo di immagine non supportato',
    errGskNotLoggedIn:
      'Accesso a Genspark non effettuato: fai clic su “Accedi a Genspark” qui sotto, accedi e riprova',
    errNoApiKey: 'Nessuna chiave API configurata per {provider}',
    errAiRegion:
      'Il fornitore di questo modello non serve la tua regione attuale — scegli un altro modello o cambia rete',
    errAiBusy: 'Il servizio IA è momentaneamente sovraccarico — riprova tra poco',
    errNoModel: 'Nessun nome di modello configurato',
    errImgAbsPath: "Il percorso dell'immagine deve essere assoluto.",
    errImgNotFound: 'File immagine non trovato: {path}',
    errImgTooLarge20: "L'immagine supera i 20 MB e non può essere inserita.",
    errImgBadType: "Il file non è un'immagine PNG/JPEG/GIF.",
    errDiskChanged:
      "La cartella di lavoro è stata modificata sul disco dopo l'apertura — usa Salva con nome.",
    autosaveFoundTitle: 'Trovata versione recuperata',
    autosaveDiskNewer:
      'Nota: il file su disco è stato modificato dopo il salvataggio di questa copia di ripristino. Il ripristino sostituirà tali modifiche più recenti.',
    autosaveFoundBody:
      "Ci sono modifiche non salvate dall'ultima sessione. Ripristinare la versione salvata automaticamente? Dopo il ripristino, il salvataggio sovrascriverà il file originale.",
    autosaveRestore: 'Ripristina',
    autosaveDiscard: 'Ignora',
    menuFile: 'File',
    menuOpenWorkbook: 'Apri cartella di lavoro…',
    menuSave: 'Salva',
    menuSaveAs: 'Salva con nome…',
    menuExportPdf: 'Esporta PDF…',
    menuPrint: 'Stampa…',
    menuClose: 'Chiudi',
    menuQuit: 'Esci',
    menuEdit: 'Modifica',
    menuUndo: 'Annulla',
    menuRedo: 'Ripeti',
    closeUnsavedMsg: '{count} modifica/e non salvata/e',
    closeUnsavedDetail: 'Le modifiche andranno perse se chiudi senza salvare.',
    btnDontSave: 'Non salvare',
    btnCancel: 'Annulla',
    csvSaveAsNotice:
      'I file CSV non conservano la formattazione: salva come .xlsx per mantenere tutte le modifiche.',
    menuExportCsv: 'Esporta CSV…',
    filterCsv: 'CSV (delimitato da virgole)',
    csvFormulaLossMsg: 'Questo foglio contiene formule che il formato CSV non può conservare.',
    csvFormulaLossDetail:
      'Il CSV conserva solo i valori: le formule vengono sostituite dai risultati attuali e la formattazione viene persa.',
    csvKeepXlsxBtn: 'Salva come .xlsx',
    csvContinueBtn: 'Continua come CSV',
    csvActiveSheetOnlyNotice:
      'I file CSV contengono un solo foglio: verrà esportato solo il foglio attivo “{name}”.',
    csvKeepFormatMsg: 'Continuare a salvare in formato CSV?',
    csvKeepFormatDetail:
      'Il CSV conserva solo i valori di un singolo foglio: formule, formattazione e fogli aggiuntivi non vengono salvati nel file .csv.',
  },
  pl: {
    filterSpreadsheets: 'Arkusze kalkulacyjne',
    filterXlsx: 'Skoroszyty programu Excel',
    filterXlsm: 'Skoroszyty programu Excel z obsługą makr',
    odsImportMsg: 'Skonwertować ten skoroszyt .{ext}?',
    odsImportDetail:
      'Vantage edytuje .xlsx, a nie ODF. Wartości, formuły i daty są konwertowane (formuły są przepisywane na składnię Excela; te, których nie można przepisać bezpiecznie, zachowują bieżący wynik). Style, szerokości kolumn i wykresy nie są przenoszone. Plik oryginalny nigdy nie jest zmieniany; skonwertowana kopia zapisuje się jako .xlsx przy pierwszym zapisaniu.',
    odsImportConvertBtn: 'Konwertuj i otwórz',
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
      'Załączniki graficzne nie zawierają tekstu; obraz jest wysyłany razem z wiadomością użytkownika',
    errNotImage: 'nieobsługiwany typ obrazu',
    errGskNotLoggedIn:
      'Nie zalogowano do Genspark: kliknij „Zaloguj się do Genspark” poniżej, zaloguj się i spróbuj ponownie',
    errNoApiKey: 'Nie skonfigurowano klucza API dla {provider}',
    errAiRegion:
      'Dostawca tego modelu nie obsługuje Twojego obecnego regionu — wybierz inny model lub zmień sieć',
    errAiBusy: 'Usługa AI jest obecnie przeciążona — spróbuj ponownie za chwilę',
    errNoModel: 'Nie skonfigurowano nazwy modelu',
    errImgAbsPath: 'Ścieżka obrazu musi być bezwzględna.',
    errImgNotFound: 'Nie znaleziono pliku obrazu: {path}',
    errImgTooLarge20: 'Obraz przekracza 20 MB i nie może zostać wstawiony.',
    errImgBadType: 'Plik nie jest obrazem PNG/JPEG/GIF.',
    errDiskChanged: 'Skoroszyt został zmieniony na dysku po otwarciu — użyj polecenia Zapisz jako.',
    autosaveFoundTitle: 'Znaleziono odzyskaną wersję',
    autosaveDiskNewer:
      'Uwaga: plik na dysku został zmodyfikowany po zapisaniu tej kopii odzyskiwania. Przywrócenie zastąpi te nowsze zmiany.',
    autosaveFoundBody:
      'Istnieją niezapisane zmiany z ostatniej sesji. Przywrócić wersję zapisaną automatycznie? Po przywróceniu zapisanie nadpisze oryginalny plik.',
    autosaveRestore: 'Przywróć',
    autosaveDiscard: 'Odrzuć',
    menuFile: 'Plik',
    menuOpenWorkbook: 'Otwórz skoroszyt…',
    menuSave: 'Zapisz',
    menuSaveAs: 'Zapisz jako…',
    menuExportPdf: 'Eksportuj PDF…',
    menuPrint: 'Drukuj…',
    menuClose: 'Zamknij',
    menuQuit: 'Zakończ',
    menuEdit: 'Edycja',
    menuUndo: 'Cofnij',
    menuRedo: 'Ponów',
    closeUnsavedMsg: 'Niezapisane zmiany: {count}',
    closeUnsavedDetail: 'Zmiany zostaną utracone, jeśli zamkniesz bez zapisywania.',
    btnDontSave: 'Nie zapisuj',
    btnCancel: 'Anuluj',
    csvSaveAsNotice:
      'Pliki CSV nie zachowują formatowania — zapisz jako .xlsx, aby zachować wszystkie zmiany.',
    menuExportCsv: 'Eksportuj CSV…',
    filterCsv: 'CSV (rozdzielany przecinkami)',
    csvFormulaLossMsg: 'Ten arkusz zawiera formuły, których format CSV nie zachowuje.',
    csvFormulaLossDetail:
      'CSV zachowuje tylko wartości — formuły są zastępowane bieżącymi wynikami, a formatowanie jest tracone.',
    csvKeepXlsxBtn: 'Zapisz jako .xlsx',
    csvContinueBtn: 'Kontynuuj jako CSV',
    csvActiveSheetOnlyNotice:
      'Pliki CSV zawierają tylko jeden arkusz — wyeksportowany zostanie tylko aktywny arkusz „{name}”.',
    csvKeepFormatMsg: 'Kontynuować zapisywanie w formacie CSV?',
    csvKeepFormatDetail:
      'CSV zachowuje tylko wartości jednego arkusza — formuły, formatowanie i dodatkowe arkusze nie są zapisywane w pliku .csv.',
  },
  cs: {
    filterSpreadsheets: 'Tabulky',
    filterXlsx: 'Sešity Excelu',
    filterXlsm: 'Sešity Excelu s podporou maker',
    odsImportMsg: 'Převést tento sešit .{ext}?',
    odsImportDetail:
      'Vantage upravuje .xlsx, nikoli ODF. Hodnoty, vzorce a data se převedou (vzorce se přepíší do syntaxe Excelu; ty, které nelze přepsat bezpečně, ponechají si aktuální výsledek). Styly, šířky sloupců a grafy se nepřenesou. Původní soubor se nikdy nemění; převedená kopie se při prvním uložení uloží jako .xlsx.',
    odsImportConvertBtn: 'Převést a otevřít',
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
    errGskNotLoggedIn:
      'Nejste přihlášeni ke Genspark: klikněte níže na „Přihlásit se ke Genspark“, přihlaste se a zkuste to znovu',
    errNoApiKey: 'Pro {provider} není nakonfigurován žádný klíč API',
    errAiRegion:
      'Poskytovatel tohoto modelu neposkytuje služby ve vaší aktuální oblasti — vyberte jiný model nebo změňte síť',
    errAiBusy: 'Služba AI je momentálně zaneprázdněna — zkuste to prosím za chvíli znovu',
    errNoModel: 'Není nakonfigurován název modelu',
    errImgAbsPath: 'Cesta k obrázku musí být absolutní.',
    errImgNotFound: 'Soubor obrázku nebyl nalezen: {path}',
    errImgTooLarge20: 'Obrázek překračuje 20 MB a nelze ho vložit.',
    errImgBadType: 'Soubor není obrázek PNG/JPEG/GIF.',
    errDiskChanged: 'Sešit byl po otevření změněn na disku — použijte místo toho Uložit jako.',
    autosaveFoundTitle: 'Nalezena obnovená verze',
    autosaveDiskNewer:
      'Poznámka: soubor na disku byl změněn po uložení této kopie pro obnovení. Obnovení tyto novější změny nahradí.',
    autosaveFoundBody:
      'Z poslední relace existují neuložené změny. Obnovit automaticky uloženou verzi? Uložení po obnovení přepíše původní soubor.',
    autosaveRestore: 'Obnovit',
    autosaveDiscard: 'Zahodit',
    menuFile: 'Soubor',
    menuOpenWorkbook: 'Otevřít sešit…',
    menuSave: 'Uložit',
    menuSaveAs: 'Uložit jako…',
    menuExportPdf: 'Exportovat PDF…',
    menuPrint: 'Tisk…',
    menuClose: 'Zavřít',
    menuQuit: 'Ukončit',
    menuEdit: 'Úpravy',
    menuUndo: 'Zpět',
    menuRedo: 'Znovu',
    closeUnsavedMsg: 'Neuložené změny: {count}',
    closeUnsavedDetail: 'Pokud zavřete bez uložení, změny budou ztraceny.',
    btnDontSave: 'Neukládat',
    btnCancel: 'Zrušit',
    csvSaveAsNotice:
      'Soubory CSV nezachovávají formátování — uložením jako .xlsx zachováte všechny změny.',
    menuExportCsv: 'Exportovat CSV…',
    filterCsv: 'CSV (oddělený čárkami)',
    csvFormulaLossMsg: 'Tento list obsahuje vzorce, které formát CSV nezachová.',
    csvFormulaLossDetail:
      'CSV zachovává pouze hodnoty — vzorce se nahradí aktuálními výsledky a formátování se ztratí.',
    csvKeepXlsxBtn: 'Uložit jako .xlsx',
    csvContinueBtn: 'Pokračovat jako CSV',
    csvActiveSheetOnlyNotice:
      'Soubory CSV obsahují jen jeden list — exportován bude pouze aktivní list „{name}“.',
    csvKeepFormatMsg: 'Pokračovat v ukládání ve formátu CSV?',
    csvKeepFormatDetail:
      'CSV zachovává pouze hodnoty jednoho listu — vzorce, formátování a další listy se do souboru .csv neuloží.',
  },
  nl: {
    filterSpreadsheets: 'Spreadsheets',
    filterXlsx: 'Excel-werkmappen',
    filterXlsm: "Excel-werkmappen met macro's",
    odsImportMsg: 'Deze .{ext}-werkmap converteren?',
    odsImportDetail:
      'Vantage bewerkt .xlsx, niet ODF. Waarden, formules en datums worden geconverteerd (formules worden herschreven in Excel-syntaxis; formules die niet veilig herschreven kunnen worden houden hun huidige resultaat). Stijlen, kolombreedtes en diagrammen worden niet overgenomen. Het oorspronkelijke bestand wordt nooit gewijzigd; de geconverteerde kop slaat bij het eerste opslaan op als .xlsx.',
    odsImportConvertBtn: 'Converteren en openen',
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
      'Afbeeldingsbijlagen bevatten geen tekst; de afbeelding wordt samen met het gebruikersbericht verzonden',
    errNotImage: 'geen ondersteund afbeeldingstype',
    errGskNotLoggedIn:
      'Niet aangemeld bij Genspark: klik hieronder op “Aanmelden bij Genspark”, meld u aan en probeer het opnieuw',
    errNoApiKey: 'Geen API-sleutel geconfigureerd voor {provider}',
    errAiRegion:
      'De aanbieder van dit model bedient uw huidige regio niet — kies een ander model of wissel van netwerk',
    errAiBusy: 'De AI-service is momenteel overbelast — probeer het zo opnieuw',
    errNoModel: 'Geen modelnaam geconfigureerd',
    errImgAbsPath: 'Het afbeeldingspad moet absoluut zijn.',
    errImgNotFound: 'Afbeeldingsbestand niet gevonden: {path}',
    errImgTooLarge20: 'De afbeelding is groter dan 20 MB en kan niet worden ingevoegd.',
    errImgBadType: 'Het bestand is geen PNG/JPEG/GIF-afbeelding.',
    errDiskChanged:
      'De werkmap is op de schijf gewijzigd nadat deze was geopend — gebruik Opslaan als.',
    autosaveFoundTitle: 'Herstelde versie gevonden',
    autosaveDiskNewer:
      'Let op: het bestand op schijf is gewijzigd nadat deze herstelkopie is opgeslagen. Herstellen vervangt die nieuwere wijzigingen.',
    autosaveFoundBody:
      'Er zijn niet-opgeslagen wijzigingen van uw laatste sessie. De automatisch opgeslagen versie herstellen? Na herstel overschrijft opslaan het originele bestand.',
    autosaveRestore: 'Herstellen',
    autosaveDiscard: 'Negeren',
    menuFile: 'Bestand',
    menuOpenWorkbook: 'Werkmap openen…',
    menuSave: 'Opslaan',
    menuSaveAs: 'Opslaan als…',
    menuExportPdf: 'PDF exporteren…',
    menuPrint: 'Afdrukken…',
    menuClose: 'Sluiten',
    menuQuit: 'Stoppen',
    menuEdit: 'Bewerken',
    menuUndo: 'Ongedaan maken',
    menuRedo: 'Opnieuw',
    closeUnsavedMsg: '{count} niet-opgeslagen wijziging(en)',
    closeUnsavedDetail: 'Uw wijzigingen gaan verloren als u sluit zonder op te slaan.',
    btnDontSave: 'Niet opslaan',
    btnCancel: 'Annuleren',
    csvSaveAsNotice:
      'CSV-bestanden bewaren geen opmaak — sla op als .xlsx om al uw wijzigingen te behouden.',
    menuExportCsv: 'CSV exporteren…',
    filterCsv: 'CSV (kommagescheiden)',
    csvFormulaLossMsg: 'Dit blad bevat formules die het CSV-formaat niet kan bewaren.',
    csvFormulaLossDetail:
      'CSV bewaart alleen waarden — formules worden vervangen door hun huidige resultaten en opmaak gaat verloren.',
    csvKeepXlsxBtn: 'Opslaan als .xlsx',
    csvContinueBtn: 'Doorgaan als CSV',
    csvActiveSheetOnlyNotice:
      'CSV-bestanden bevatten slechts één blad — alleen het actieve blad “{name}” wordt geëxporteerd.',
    csvKeepFormatMsg: 'Doorgaan met opslaan in CSV-indeling?',
    csvKeepFormatDetail:
      'CSV bewaart alleen de waarden van één blad — formules, opmaak en extra bladen worden niet in het .csv-bestand opgeslagen.',
  },
  ms: {
    filterSpreadsheets: 'Hamparan',
    filterXlsx: 'Buku Kerja Excel',
    filterXlsm: 'Buku Kerja Excel Didayakan Makro',
    odsImportMsg: 'Tukar buku kerja .{ext} ini?',
    odsImportDetail:
      'Vantage menyunting .xlsx, bukan ODF. Nilai, formula dan tarikh ditukar (formula ditulis semula dalam sintaks Excel; yang tidak dapat ditulis semula dengan selamat mengekalkan hasil semasanya). Gaya, lebar lajur dan carta tidak dibawa. Fail asal tidak pernah diubah; salinan yang ditukar disimpan sebagai .xlsx pada simpanan pertama.',
    odsImportConvertBtn: 'Tukar dan buka',
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
    errImageNoText: 'Lampiran imej tiada teks; imej dihantar bersama mesej pengguna',
    errNotImage: 'bukan jenis imej yang disokong',
    errGskNotLoggedIn:
      'Belum log masuk ke Genspark: klik “Log masuk ke Genspark” di bawah, kemudian cuba lagi',
    errNoApiKey: 'Kunci API untuk {provider} belum dikonfigurasikan',
    errAiRegion:
      'Penyedia model ini tidak memberi perkhidmatan di rantau semasa anda — pilih model lain atau tukar rangkaian',
    errAiBusy: 'Perkhidmatan AI sedang sibuk — sila cuba lagi sebentar lagi',
    errNoModel: 'Nama model belum dikonfigurasikan',
    errImgAbsPath: 'Laluan imej mestilah laluan mutlak.',
    errImgNotFound: 'Fail imej tidak ditemui: {path}',
    errImgTooLarge20: 'Imej melebihi 20MB dan tidak boleh disisipkan.',
    errImgBadType: 'Fail ini bukan imej PNG/JPEG/GIF.',
    errDiskChanged: 'Buku kerja telah diubah pada cakera selepas dibuka — gunakan Simpan Sebagai.',
    autosaveFoundTitle: 'Versi pulihan ditemui',
    autosaveDiskNewer:
      'Nota: fail pada cakera telah diubah suai selepas salinan pemulihan ini disimpan. Memulihkan akan menggantikan perubahan yang lebih baharu itu.',
    autosaveFoundBody:
      'Terdapat perubahan yang belum disimpan daripada sesi terakhir anda. Pulihkan versi yang disimpan secara automatik? Selepas pemulihan, menyimpan akan menulis ganti fail asal.',
    autosaveRestore: 'Pulihkan',
    autosaveDiscard: 'Buang',
    menuFile: 'Fail',
    menuOpenWorkbook: 'Buka Buku Kerja…',
    menuSave: 'Simpan',
    menuSaveAs: 'Simpan Sebagai…',
    menuExportPdf: 'Eksport PDF…',
    menuPrint: 'Cetak…',
    menuClose: 'Tutup',
    menuQuit: 'Keluar',
    menuEdit: 'Edit',
    menuUndo: 'Buat Asal',
    menuRedo: 'Buat Semula',
    closeUnsavedMsg: '{count} perubahan belum disimpan',
    closeUnsavedDetail: 'Perubahan anda akan hilang jika anda menutup tanpa menyimpan.',
    btnDontSave: 'Jangan Simpan',
    btnCancel: 'Batal',
    csvSaveAsNotice:
      'Fail CSV tidak dapat menyimpan pemformatan — simpan sebagai .xlsx untuk mengekalkan semua perubahan anda.',
    menuExportCsv: 'Eksport CSV…',
    filterCsv: 'CSV (dipisahkan koma)',
    csvFormulaLossMsg:
      'Helaian ini mengandungi formula yang tidak dapat disimpan dalam format CSV.',
    csvFormulaLossDetail:
      'CSV hanya menyimpan nilai — formula digantikan dengan hasil semasa, dan pemformatan akan hilang.',
    csvKeepXlsxBtn: 'Simpan sebagai .xlsx',
    csvContinueBtn: 'Teruskan sebagai CSV',
    csvActiveSheetOnlyNotice:
      'Fail CSV hanya mengandungi satu helaian — hanya helaian aktif “{name}” akan dieksport.',
    csvKeepFormatMsg: 'Terus simpan dalam format CSV?',
    csvKeepFormatDetail:
      'CSV hanya menyimpan nilai satu helaian — formula, pemformatan dan helaian tambahan tidak disimpan ke fail .csv.',
  },
  he: {
    filterSpreadsheets: 'גיליונות אלקטרוניים',
    filterXlsx: 'חוברות עבודה של Excel',
    filterXlsm: 'חוברות עבודה של Excel מותאמות מאקרו',
    odsImportMsg: 'להמיר חוברת עבודה .{ext} זו?',
    odsImportDetail:
      'Vantage עורך קבצי .xlsx ולא ODF. ערכים, נוסחאות ותאריכים מומרים (נוסחאות נכתבות מחדש בתחביר Excel; כאלה שאי אפשר לכתוב מחדש בבטחה שומרות על התוצאה הנוכחית). עיצוב, רוחב עמודות ותרשימים לא עוברים. קובץ המקור לעולם אינו משתנה; העותק שהומר נשמר כקובץ .xlsx בשמירה הראשונה.',
    odsImportConvertBtn: 'המר ופתח',
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
    errImageNoText: 'קבצים מצורפים מסוג תמונה אינם מכילים טקסט; התמונה נשלחת יחד עם הודעת המשתמש',
    errNotImage: 'סוג תמונה שאינו נתמך',
    errGskNotLoggedIn: 'לא מחובר ל-Genspark: לחץ על "התחבר ל-Genspark" למטה, התחבר ונסה שוב',
    errNoApiKey: 'לא הוגדר מפתח API עבור {provider}',
    errAiRegion: 'ספק המודל הזה אינו פועל באזור הנוכחי שלך — בחרו מודל אחר או החליפו רשת',
    errAiBusy: 'שירות ה-AI עמוס כרגע — נסו שוב בעוד רגע',
    errNoModel: 'לא הוגדר שם מודל',
    errImgAbsPath: 'נתיב התמונה חייב להיות מוחלט.',
    errImgNotFound: 'קובץ התמונה לא נמצא: {path}',
    errImgTooLarge20: 'התמונה חורגת מ-20MB ולא ניתן להוסיף אותה.',
    errImgBadType: 'הקובץ אינו תמונת PNG/JPEG/GIF.',
    errDiskChanged: 'חוברת העבודה השתנתה בדיסק לאחר פתיחתה — השתמש בשמירה בשם.',
    autosaveFoundTitle: 'נמצאה גרסה משוחזרת',
    autosaveDiskNewer:
      'שים לב: הקובץ בדיסק שונה לאחר שמירת עותק השחזור הזה. שחזור יחליף את השינויים החדשים יותר.',
    autosaveFoundBody:
      'קיימים שינויים שלא נשמרו מהפעלה הקודמת. לשחזר את הגרסה שנשמרה אוטומטית? לאחר השחזור, שמירה תדרוס את הקובץ המקורי.',
    autosaveRestore: 'שחזר',
    autosaveDiscard: 'התעלם',
    menuFile: 'קובץ',
    menuOpenWorkbook: 'פתיחת חוברת עבודה…',
    menuSave: 'שמירה',
    menuSaveAs: 'שמירה בשם…',
    menuExportPdf: 'ייצוא PDF…',
    menuPrint: 'הדפסה…',
    menuClose: 'סגירה',
    menuQuit: 'יציאה',
    menuEdit: 'עריכה',
    menuUndo: 'בטל',
    menuRedo: 'בצע שוב',
    closeUnsavedMsg: '{count} שינויים שלא נשמרו',
    closeUnsavedDetail: 'השינויים שלך יאבדו אם תסגור בלי לשמור.',
    btnDontSave: 'אל תשמור',
    btnCancel: 'ביטול',
    csvSaveAsNotice: 'קובצי CSV אינם שומרים עיצוב — שמרו כ‑.xlsx כדי לשמור על כל השינויים.',
    menuExportCsv: 'ייצוא CSV…',
    filterCsv: 'CSV (מופרד באמצעות פסיקים)',
    csvFormulaLossMsg: 'גיליון זה מכיל נוסחאות שתבנית CSV אינה יכולה לשמור.',
    csvFormulaLossDetail:
      'CSV שומר ערכים בלבד — נוסחאות מוחלפות בתוצאות הנוכחיות שלהן, והעיצוב אובד.',
    csvKeepXlsxBtn: 'שמירה כ-.xlsx',
    csvContinueBtn: 'המשך שמירה כ-CSV',
    csvActiveSheetOnlyNotice: 'קובצי CSV מכילים גיליון אחד בלבד — רק הגיליון הפעיל "{name}" ייוצא.',
    csvKeepFormatMsg: 'להמשיך לשמור בתבנית CSV?',
    csvKeepFormatDetail:
      'CSV שומר רק את הערכים של גיליון אחד — נוסחאות, עיצוב וגיליונות נוספים אינם נשמרים בקובץ ה-.csv.',
  },
  hi: {
    filterSpreadsheets: 'स्प्रेडशीट',
    filterXlsx: 'Excel कार्यपुस्तिकाएँ',
    filterXlsm: 'Excel मैक्रो-सक्षम कार्यपुस्तिकाएँ',
    odsImportMsg: 'इस .{ext} वर्कबुक को बदलें?',
    odsImportDetail:
      'Vantage .xlsx संपादित करता है, ODF नहीं। मान, सूत्र और तारीखें बदल दी जाती हैं (सूत्र Excel सिंटैक्स में फिर से लिखे जाते हैं; जिन्हें सुरक्षित रूप से नहीं लिखा जा सका वे अपना वर्तमान मान रखते हैं)। स्टाइल, कॉलम चौड़ाई और चार्ट नहीं आते। मूल फ़ाइल कभी नहीं बदलती; बदली हुई प्रति पहली बार सहेजते समय .xlsx के रूप में सहेजी जाती है।',
    odsImportConvertBtn: 'बदलकर खोलें',
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
    errImageNoText: 'छवि अनुलग्नक में टेक्स्ट नहीं होता; छवि उपयोगकर्ता संदेश के साथ भेजी जाती है',
    errNotImage: 'समर्थित छवि प्रकार नहीं है',
    errGskNotLoggedIn:
      'Genspark में साइन इन नहीं है: नीचे “Genspark में साइन इन करें” पर क्लिक करें, साइन इन करें और फिर से कोशिश करें',
    errNoApiKey: '{provider} के लिए कोई API कुंजी कॉन्फ़िगर नहीं है',
    errAiRegion:
      'इस मॉडल का प्रदाता आपके वर्तमान क्षेत्र में सेवा नहीं देता — कोई दूसरा मॉडल चुनें या नेटवर्क बदलें',
    errAiBusy: 'AI सेवा अभी व्यस्त है — कृपया थोड़ी देर बाद फिर से प्रयास करें',
    errNoModel: 'कोई मॉडल नाम कॉन्फ़िगर नहीं है',
    errImgAbsPath: 'छवि पथ निरपेक्ष होना चाहिए।',
    errImgNotFound: 'छवि फ़ाइल नहीं मिली: {path}',
    errImgTooLarge20: 'छवि 20MB से अधिक है और सम्मिलित नहीं की जा सकती।',
    errImgBadType: 'यह फ़ाइल PNG/JPEG/GIF छवि नहीं है।',
    errDiskChanged:
      'खोले जाने के बाद कार्यपुस्तिका डिस्क पर बदल गई — इसके बजाय इस रूप में सहेजें का उपयोग करें।',
    autosaveFoundTitle: 'पुनर्प्राप्त संस्करण मिला',
    autosaveDiskNewer:
      'ध्यान दें: यह पुनर्प्राप्ति प्रति सहेजे जाने के बाद डिस्क पर फ़ाइल में बदलाव किया गया है। पुनर्स्थापित करने पर वे नए बदलाव बदल दिए जाएँगे।',
    autosaveFoundBody:
      'आपके पिछले सत्र से सहेजे नहीं गए परिवर्तन हैं। स्वतः सहेजा गया संस्करण पुनर्स्थापित करें? पुनर्स्थापना के बाद, सहेजने पर मूल फ़ाइल अधिलेखित हो जाएगी।',
    autosaveRestore: 'पुनर्स्थापित करें',
    autosaveDiscard: 'छोड़ें',
    menuFile: 'फ़ाइल',
    menuOpenWorkbook: 'कार्यपुस्तिका खोलें…',
    menuSave: 'सहेजें',
    menuSaveAs: 'इस रूप में सहेजें…',
    menuExportPdf: 'PDF निर्यात करें…',
    menuPrint: 'प्रिंट करें…',
    menuClose: 'बंद करें',
    menuQuit: 'बाहर निकलें',
    menuEdit: 'संपादन',
    menuUndo: 'पूर्ववत करें',
    menuRedo: 'फिर से करें',
    closeUnsavedMsg: '{count} सहेजे नहीं गए परिवर्तन',
    closeUnsavedDetail: 'यदि आप बिना सहेजे बंद करते हैं तो आपके परिवर्तन खो जाएँगे।',
    btnDontSave: 'न सहेजें',
    btnCancel: 'रद्द करें',
    csvSaveAsNotice:
      'CSV फ़ाइलें फ़ॉर्मेटिंग सहेज नहीं सकतीं — सभी बदलाव बनाए रखने के लिए .xlsx के रूप में सहेजें।',
    menuExportCsv: 'CSV निर्यात करें…',
    filterCsv: 'CSV (अल्पविराम द्वारा सीमांकित)',
    csvFormulaLossMsg: 'इस शीट में ऐसे सूत्र हैं जिन्हें CSV प्रारूप सहेज नहीं सकता।',
    csvFormulaLossDetail:
      'CSV केवल मान रखता है — सूत्र उनके वर्तमान परिणामों से बदल दिए जाते हैं और फ़ॉर्मेटिंग खो जाती है।',
    csvKeepXlsxBtn: '.xlsx के रूप में सहेजें',
    csvContinueBtn: 'CSV के रूप में जारी रखें',
    csvActiveSheetOnlyNotice:
      'CSV फ़ाइलों में केवल एक शीट होती है — केवल सक्रिय शीट “{name}” निर्यात की जाएगी।',
    csvKeepFormatMsg: 'CSV प्रारूप में सहेजना जारी रखें?',
    csvKeepFormatDetail:
      'CSV केवल एक शीट के मान रखता है — सूत्र, स्वरूपण और अतिरिक्त शीट .csv फ़ाइल में सहेजे नहीं जाते।',
  },
  'zh-TW': {
    filterSpreadsheets: '電子試算表',
    filterXlsx: 'Excel 活頁簿',
    filterXlsm: 'Excel 啟用巨集的活頁簿',
    odsImportMsg: '轉換這個 .{ext} 工作簿？',
    odsImportDetail:
      'Vantage 只編輯 .xlsx，不編輯 ODF。數值、公式與日期會被轉換（公式改寫為 Excel 語法，無法安全改寫的僅保留其目前結果）；樣式、欄寬與圖表不會帶入。原始檔案不會被修改，轉換後的複本第一次儲存時會另存為 .xlsx。', // public-hygiene: allow
    odsImportConvertBtn: '轉換並開啟',
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
    errGskNotLoggedIn: '未登入 Genspark:請點擊下方「登入 Genspark」完成登入後重試',
    errNoApiKey: '未設定 {provider} 的 API Key',
    errAiRegion: '該模型的廠商不向目前地區提供服務，請換一個模型或切換網路',
    errAiBusy: 'AI 服務目前繁忙，請稍後重試',
    errNoModel: '未設定模型名稱',
    errImgAbsPath: '圖片路徑必須是絕對路徑。',
    errImgNotFound: '找不到圖片檔案: {path}',
    errImgTooLarge20: '圖片超過 20MB,不支援插入。',
    errImgBadType: '該檔案不是 PNG/JPEG/GIF 圖片。',
    errDiskChanged: '活頁簿在開啟後被磁碟上的變更覆蓋——請改用另存新檔。',
    autosaveFoundTitle: '發現自動復原版本',
    autosaveDiskNewer: '注意：此復原副本儲存後，磁碟上的檔案又被修改過。復原將取代這些較新的變更。',
    autosaveFoundBody:
      '上次工作階段有未儲存的變更。要復原自動儲存的版本嗎?復原後,儲存將直接覆寫原檔案。',
    autosaveRestore: '復原',
    autosaveDiscard: '放棄',
    menuFile: '檔案',
    menuOpenWorkbook: '開啟活頁簿…',
    menuSave: '儲存',
    menuSaveAs: '另存新檔…',
    menuExportPdf: '匯出 PDF…',
    menuPrint: '列印…',
    menuClose: '關閉',
    menuQuit: '結束',
    menuEdit: '編輯',
    menuUndo: '復原',
    menuRedo: '重做',
    closeUnsavedMsg: '有 {count} 處未儲存的修改',
    closeUnsavedDetail: '不儲存直接關閉,這些修改將遺失。',
    btnDontSave: '不儲存',
    btnCancel: '取消',
    csvSaveAsNotice: 'CSV 格式不保留樣式等格式修改——另存為 .xlsx 可保留全部內容。',
    menuExportCsv: '匯出 CSV…',
    filterCsv: 'CSV (逗號分隔)',
    csvFormulaLossMsg: '目前工作表包含公式,CSV 格式無法保留。',
    csvFormulaLossDetail: 'CSV 只保留純文字值——公式會被取代為目前計算結果,格式也會遺失。',
    csvKeepXlsxBtn: '另存為 .xlsx',
    csvContinueBtn: '繼續儲存為 CSV',
    csvActiveSheetOnlyNotice: 'CSV 檔案只包含一張工作表——只會匯出目前工作表「{name}」。',
    csvKeepFormatMsg: '要繼續以 CSV 格式儲存嗎?',
    csvKeepFormatDetail: 'CSV 只保留單張工作表的純值——公式、格式和其他工作表不會存入 .csv 檔案。',
  },
})
const tm = (key: Parameters<typeof tMain>[1], params?: Parameters<typeof tMain>[2]) =>
  tMain(getUiLang(), key, params)

interface SessionInfo {
  readonly path: string
  /// Byte-for-byte copy of the file as it was opened (in the OS temp dir).
  /// Saves patch this snapshot rather than the live path, so an external
  /// overwrite of the file can never corrupt the save base — and Save As
  /// stays usable after one. Removed when the session closes.
  readonly snapshotPath: string
  /// Present only for an Office-encrypted workbook; saves re-encrypt the
  /// patched OOXML package with this password before replacing the source.
  readonly password?: string
  /// Digest of the snapshot (== the file at open time).
  readonly sha256: string
  /** Hash of the imported/decrypted pinned bytes; distinct from encrypted original bytes. */
  readonly nativeSourceFingerprint: string
  readonly readerDisplay?: ReaderDisplay
  /** A physical move was reported but has not yet passed its known-byte proof. */
  readonly relocationPending?: boolean
  /** Trusted known original fingerprint for a newly detached relocation epoch. */
  readonly recoveryOriginalFingerprint?: string | null
  /// Known bytes published by this session, separate from its immutable base.
  readonly publishedVersions?: ReadonlyMap<string, string>
  readonly sheetNames: ReadonlyMap<string, string>
  readonly automaticRecoveryDisabled: boolean
  /// Set when the session opened a converted copy (.xls import): the
  /// first save routes through Save As, defaulting to this .xlsx path.
  readonly suggestSaveAs?: string
  /// The shell's "New spreadsheet" backing file in a temp directory: like an
  /// import the first Save is a Save As, but AutoSave and the recovery copy
  /// keep running (keyed on suggestSaveAs), and a quiet save writes in place.
  readonly unsavedNew?: boolean
  /// The backing bytes contain work that still needs a user-visible save.
  readonly pendingBase?: boolean
  /// The converted copy came from a CSV: the Save As dialog explains that
  /// formatting requires .xlsx (CSV keeps values only).
  readonly csvImport?: boolean
  /// CSV session: the original .csv on disk. Save keeps the CSV identity —
  /// the xlsx save lands on the temp copy and the serialized csvContent is
  /// written back here.
  readonly csvSourcePath?: string
  /// Digest of the original .csv at open/save time — guards the write-back
  /// against external modification, like restoreTargetSha.
  readonly csvSourceSha?: string
  /// Original imported file identity is separate from the Save As suggestion.
  readonly recoverySourcePath?: string
  readonly recoverySourceSha?: string
  /// App-owned directory containing the converted CSV/XLS copy. Removed only
  /// after the sidecar session and its independent snapshot are closed.
  readonly importTempDir?: string
  /// Set when the session opened a restored crash-recovery copy: the restore
  /// prompt was the user's confirmation, so a plain Save silently writes back
  /// to this original path (no Save As detour).
  readonly restoreTarget?: string
  /// Digest of the original file at restore time — guards the silent
  /// write-back against external modification, mirroring the sha256 check on
  /// the session's own path.
  readonly restoreTargetSha?: string
  /// The opened file was 0 bytes: the session runs on a blank archive in the
  /// temp dir and restoreTarget is the empty original. Unlike a restored
  /// recovery copy, this session still needs its own crash-recovery copy,
  /// keyed by the original.
  readonly emptySource?: boolean
}

function expectedWorkbookDigest(
  session: SessionInfo,
  path: string,
  openingDigest: string | undefined,
): string | undefined {
  return session.publishedVersions?.get(path) ?? openingDigest
}

function rememberWorkbookPublication(
  sessions: Map<string, SessionInfo>,
  sessionId: string,
  path: string,
  digest: string,
): void {
  const session = sessions.get(sessionId)
  if (session)
    sessions.set(sessionId, {
      ...session,
      publishedVersions: new Map<string, string>([
        ...(session.publishedVersions ?? []),
        [path, digest],
      ]),
    })
}

// ---- runtime configuration (paths differ when bundled into the shell) ----

/** AI create_document content the sheets app cannot build itself — the shell
 * routes it into the docs-owned creation flow (docx opens a fresh docs tab). */
export interface SheetsAiHostDocumentRequest {
  type: 'docx' | 'pdf' | 'md' | 'html'
  title: string
  content: string
}

interface SheetsRuntimeConfig {
  /** absolute path to the sheets preload bundle */
  preloadPath: string
  /** dev-server URL for the sheets renderer (wins over rendererFile) */
  rendererUrl?: string | undefined
  /** absolute path to the built sheets renderer index.html */
  rendererFile: string
  /** absolute path to the Rust xlsx-sidecar binary */
  sidecarPath?: string | undefined
  /** Shell router used to open exported/AI-generated files in a new Vantage tab. */
  openGeneratedPath?: (path: string) => boolean
  /** Host-owned cross-app document creator (the shell routes docx/pdf/md into Docs). */
  createDocument?: (request: SheetsAiHostDocumentRequest) => Promise<WorkbookCreateDocumentResult>
}

let runtime: SheetsRuntimeConfig = {
  preloadPath: join(__dirname, '../preload/index.js'),
  rendererUrl: process.env.ELECTRON_RENDERER_URL,
  rendererFile: join(__dirname, '../renderer/index.html'),
  createDocument: createStandaloneSheetsDocument,
}

export function configureSheetsRuntime(config: SheetsRuntimeConfig): void {
  runtime = config
}

/** After writing an exported/AI-generated file: open it in the right tab
 * (shell) or reveal it in the folder (standalone). Tab-opening failure must
 * not report the write itself as failed — the file is already persisted. */
function openGeneratedFile(path: string): void {
  // Headless export must stay silent: no tab, no file-manager window
  // (same guard as markdown-main's openExportedPdf, vantage#1815).
  if (isHeadlessMode()) return
  try {
    if (runtime.openGeneratedPath?.(path)) return
  } catch (err) {
    console.warn('[sheets] Failed to open generated file:', err)
  }
  shell.showItemInFolder(path)
}

/** Pick a safe file-name stem for an AI-created file (mirrors docs' sanitizeAiDocFileBase). */
export function sanitizeGeneratedFileBase(title: string): string {
  const cleaned = String(title ?? '')
    // eslint-disable-next-line no-control-regex -- generated file names must reject controls
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 80)
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'Untitled'
}

/** first free path for fileName inside dir: name.ext, name-2.ext, name-3.ext… */
export function uniquePathIn(dir: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const base = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${base}-${i}${ext}`)
  return candidate
}

/** Standalone-window fallback for AI docx/pdf/md/html creation (mirrors pdf-main's
 * createStandaloneDocument): pdf renders in a hidden sandboxed window, md/html
 * write the source as-is; docx needs the Docs app and is refused. */
async function createStandaloneSheetsDocument(
  request: SheetsAiHostDocumentRequest,
): Promise<WorkbookCreateDocumentResult> {
  if (request.type === 'docx') {
    return { ok: false, error: 'Creating DOCX files requires the Vantage shell or Docs app.' }
  }
  const title = sanitizeGeneratedFileBase(request.title)
  try {
    if (request.type === 'pdf') {
      const bytes = await printHtmlToPdf(
        buildPrintableHtml(title, request.content),
        () =>
          new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } }),
      )
      const path = uniquePathIn(configuredDefaultSaveDir(app), `${title}.pdf`)
      await publishNewUserOutput(path, bytes,()=>openGeneratedFile(path))
      return { ok: true, path }
    }
    const path = uniquePathIn(configuredDefaultSaveDir(app), `${title}.${request.type}`)
    await publishNewUserOutput(path, Buffer.from(request.content, 'utf8'),()=>openGeneratedFile(path))
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

let mainWindow: BrowserWindow | null = null
let sidecar: XlsxSidecarClient | null = null

/** the single real BrowserWindow hosting the tab strip, used as dialog parent in tab mode */
let sheetsShellWindow: BrowserWindow | null = null
export function setSheetsShellWindow(win: BrowserWindow | null): void {
  sheetsShellWindow = win
}

/** the window hosting a tab's WebContentsView when BrowserWindow.fromWebContents
 *  cannot tell (detached "Open in New Window" editors) */
let hostWindowHook: ((wc: WebContents) => BrowserWindow | undefined) | null = null
export function setSheetsHostWindowHook(
  fn: ((wc: WebContents) => BrowserWindow | undefined) | null,
): void {
  hostWindowHook = fn
}

function hostWindowFor(wc: WebContents): BrowserWindow | undefined {
  const own = hostWindowHook?.(wc) ?? BrowserWindow.fromWebContents(wc)
  if (own && !own.isDestroyed()) return own
  return sheetsShellWindow && !sheetsShellWindow.isDestroyed() ? sheetsShellWindow : undefined
}

interface SheetsTabSession {
  readonly webContents: WebContents
  readonly client: XlsxSidecarClient
  readonly sessions: Map<string, SessionInfo>
  readonly aiStreams: Map<string, AbortController>
  /// Chunked uploads of large saves' cell edits, pending their save request.
  readonly saveTransfers: SaveEditsTransferStore
}

/** per-tab session state, keyed by webContents.id — replaces the old single-window closures
 * that `registerIpcHandlers`/`validateSender` used to capture, which broke as soon as a second
 * tab (or a closed-then-reopened tab) registered and overwrote the previous closure. */
/// Same ceiling as local add_image (readLocalImage's 20MB check)
const MAX_REMOTE_IMAGE_BYTES = 20 * 1024 * 1024
/** Max .csv/.tsv bytes converted on open: stops a 500MB text file OOMing main before sidecar limits. */
const MAX_DELIMITED_IMPORT_BYTES = 32 * 1024 * 1024

const sheetsTabs = new Map<number, SheetsTabSession>()
// Existing renderer recovery owns app-session restoration. Native journals use
// a stable identity across sidecar restarts, isolated from other tabs and from
// later app launches until the recovery UI adopts the authority's saved edits.
const editAuthorityNamespace = randomUUID()
let documentRecoveryService: WorkbookDocumentRecovery | undefined
let documentRecoveryClient: XlsxSidecarClient | undefined
const documentCandidates = new Map<string, string>()
const adoptedDocumentCandidates = new Map<string, string>()
const materializedRecoveryDirectories = new Map<string, string>()
const materializedRecoveryNames = new Map<string, string>()
const adoptingDocumentCandidates = new Set<string>()
const documentPublicationGates = new Map<string, Promise<void>>()
export interface SheetsCloseRuntime {
  stagePersistent(owner: WebContents, lineage: string, authority: CapturedNativeCloseAuthority): SheetsCleanupAdmission
  stageMemory(owner: WebContents, lineage: string, authority: CapturedNativeCloseAuthority): SheetsCleanupAdmission
  holdNativeUntilSettled(owner: WebContents, actual: Promise<void>): void
  /** Root enables only after its authored-writer coverage audit is complete. */
  coverageComplete(owner: WebContents): boolean
}
let sheetsCloseRuntime: SheetsCloseRuntime | undefined
let standaloneCloseControl: StandaloneSheetsCloseRuntime | null = null
export function setSheetsCloseRuntime(runtime: SheetsCloseRuntime): void { sheetsCloseRuntime = runtime }
const reportedCloseStates = new Map<number, { state: SheetsCloseState; coverage: boolean }>()
const closeCapturedAuthorities = new Map<number, CapturedNativeCloseAuthority>()
const closeCaptureTickets = new Map<number, CloseLeaseTicket>()
const closeResultStamps = new Map<number, { ticket: CloseLeaseTicket; stamp: CloseLeaseStamp }>()
const nativeClosePrompts = new Map<number, { ticket: CloseLeaseTicket; controller: AbortController }>()
const actualCloseReservations = new Map<WebContents, Set<Promise<void>>>()
type NativeAck = { documentId: string; revision: number; sourceFingerprint: string; payloadSha256: string; dirty: boolean; binding?: WorkbookCloseCheckpointBinding }
const nativeDocumentAcks = new Map<string, NativeAck>()
interface SourceOffer {
  id: string; owner: WebContents; source: SheetsCloseSource; previous: SheetsCloseSource | null
  open?: SheetsSourceOpen; publication?: SheetsSourceAdoption; afterAdopt?: () => Promise<void>
  onAdopted?: () => void
  publicationDecision?: WorkbookPublicationDecision
  afterPublicationSettled?: () => void
}
const sourceOffers = new Map<string, SourceOffer>()
const activeWorkbookRenames = new Map<WebContents, Promise<void>>()
const ownerCleanupByContents = new WeakMap<WebContents, Promise<void>>()
const headlessOwnerWork = new WeakMap<WebContents, HeadlessSheetsOwnerWork>()
/** Actual destroyed-owner finalizer; absence is not proof of completion. */
export function sheetsOwnerCleanup(owner: WebContents): Promise<void> | undefined { return ownerCleanupByContents.get(owner) }
const mainPublicationLifecycles = new Map<WebContents, Set<WorkbookPublicationLifecycle>>()

function runMainWorkbookPublication<T>(owner: WebContents, scope: FilePublicationScope,
  actual: (lifecycle: WorkbookPublicationLifecycle) => Promise<T>, otherTargets: readonly string[] = []): Promise<T> {
  if (!sheetsCloseRuntime) return Promise.reject(new Error('Main workbook publication requires its actual-settlement quit ledger.'))
  const lifecycle = new WorkbookPublicationLifecycle()
  const pending = mainPublicationLifecycles.get(owner) ?? new Set<WorkbookPublicationLifecycle>()
  mainPublicationLifecycles.set(owner, pending); pending.add(lifecycle)
  void lifecycle.actualSettled.then(() => {
    pending.delete(lifecycle)
    if (!pending.size && mainPublicationLifecycles.get(owner) === pending) mainPublicationLifecycles.delete(owner)
  })
  try {
    sheetsCloseRuntime.holdNativeUntilSettled(owner, lifecycle.actualSettled)
    const targets = [...new Set([scope.targetPath, ...otherTargets])]
    const admit = (index: number): Promise<T> => withAttestedFilePublication({ ...scope, targetPath: targets[index]! }, () => {
      let result: Promise<T>
      try { result = index + 1 < targets.length ? admit(index + 1) : lifecycle.run(() => actual(lifecycle)) }
      catch (error) { lifecycle.abandonBeforeStart(); result = Promise.reject(error) }
      return { result, actualSettled: lifecycle.actualSettled }
    })
    return admit(0)
  } catch (error) {
    lifecycle.abandonBeforeStart()
    return Promise.reject(error)
  }
}
const sourceOpenAdmissions = new Map<number, SheetsSourceOpen>()
let sheetsCloseCoordinator: SheetsCloseCoordinator<WebContents>
const sheetsSources = new SheetsSourceLineages<WebContents>((owner, reason) => sheetsCloseCoordinator?.invalidateSource(owner, reason))
function ownerPublicationTail(owner: WebContents): Promise<void> {
  const tails = [...documentPublicationGates].filter(([key]) => key.startsWith(`${owner.id}:`)).map(([, tail]) => tail)
  return Promise.all(tails).then(() => undefined)
}
async function completeNativeCommand(client: XlsxSidecarClient,
  command: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<unknown> {
  const native = client.requestAttested(command, timeoutMs)
  void native.result.catch(() => undefined)
  return native.completion
}
const sheetsCloseTransport = new SheetsCloseTransport<WebContents>({
  send: (owner, request) => owner.send(IPC_CHANNELS.workbookPrepareClose, request),
  alive: owner => !owner.isDestroyed(), publicationTail: ownerPublicationTail,
  report: error => console.warn('[sheets] Close transport:', error),
})
const sheetsRenameRefresh = new SheetsRenameRefreshTransport<WebContents>({
  send: (owner, name, metadata) => owner.send(IPC_CHANNELS.workbookRenamed, name, metadata),
  publicationTail: ownerPublicationTail,
  validate: (owner, metadata, result) => {
    const source = sheetsSources.current(owner), entry = sheetsTabs.get(owner.id), session = entry?.sessions.get(metadata.sessionId)
    const ack = nativeDocumentAcks.get(documentOwnerKey(owner.id, metadata.sessionId))
    return !owner.isDestroyed() && !!session && !!source && sameSheetsCloseSource(source, metadata.closeSource) &&
      result.sessionId === metadata.sessionId && isSheetsCloseSource(result.source) && sameSheetsCloseSource(result.source, source) &&
      !!ack && ack.documentId === result.documentId && ack.revision === result.revision && ack.payloadSha256 === result.payloadSha256 &&
      ack.sourceFingerprint === session.nativeSourceFingerprint && documentRecoveryService?.isCurrentProducer(owner.id, metadata.sessionId, ack.documentId) === true
  },
})
function priorNativeActualWork(): Promise<void> {
  const pending: Promise<void>[] = []
  const unsubscribe = subscribeNativeActualWork(actual => { pending.push(actual) })
  unsubscribe()
  return Promise.all(pending).then(() => undefined)
}
const sheetsPromptWriteGate = new SheetsPromptWriteGate<WebContents>({
  alive: owner => !owner.isDestroyed() && sheetsTabs.get(owner.id)?.webContents === owner,
  currentClose: owner => sheetsCloseTransport.current(owner)?.ticket,
  acceptsClose: (owner, ticket) => sheetsCloseTransport.accepts(owner, ticket),
  assertTransportWriter: (owner, ticket) => sheetsCloseTransport.assertWriter(owner, ticket),
  cancelExactClose: (owner, ticket, reason) => sheetsCloseCoordinator.cancel(owner, ticket, reason),
  actualSettled: owner => {
    // Capture before the new operation adds a publication gate. Neither an
    // aborted native dialog nor a rejected result substitutes for actual I/O.
    const publications = ownerPublicationTail(owner)
    return Promise.all([publications, ...(actualCloseReservations.get(owner) ?? [])]).then(() => undefined)
  },
})
sheetsCloseCoordinator = new SheetsCloseCoordinator<WebContents>({
  alive: owner => !owner.isDestroyed() && sheetsTabs.get(owner.id)?.webContents === owner,
  current: owner => sheetsSources.current(owner),
  sourceBusy: owner => activeWorkbookRenames.has(owner) || sheetsSources.busy(owner) || [...sourceOffers.values()].some(offer => offer.owner === owner) ||
    [...documentPublicationGates.keys()].some(key => key.startsWith(`${owner.id}:`)),
  coverageComplete: owner => {
    const report = reportedCloseStates.get(owner.id), source = sheetsSources.current(owner)
    const final = closeResultStamps.get(owner.id)
    return !!source && !!report && report.coverage && !report.state.busy && sameSheetsCloseSource(source, report.state.source) &&
      (!final || report.state.stamp.source === final.stamp.source && report.state.stamp.revision === final.stamp.revision) &&
      sheetsCloseRuntime?.coverageComplete(owner) === true
  },
  prepareRenderer: (owner, request) => sheetsCloseTransport.prepare(owner, request),
  releaseRenderer: (owner, ticket, reason) => {
    sheetsPromptWriteGate.releasePrompt(owner, ticket)
    const prompt = nativeClosePrompts.get(owner.id)
    if (prompt && sameCloseTicket(prompt.ticket, ticket)) {
      nativeClosePrompts.delete(owner.id)
      prompt.controller.abort(new Error(reason))
    }
    sheetsCloseTransport.release(owner, ticket, reason)
    if (closeCaptureTickets.get(owner.id) && sameCloseTicket(closeCaptureTickets.get(owner.id)!, ticket)) {
      closeCapturedAuthorities.delete(owner.id); closeCaptureTickets.delete(owner.id)
    }
    if (closeResultStamps.get(owner.id) && sameCloseTicket(closeResultStamps.get(owner.id)!.ticket, ticket)) closeResultStamps.delete(owner.id)
    if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.workbookCloseRelease, ticket, reason)
  },
  capture: (owner, sessionId) => {
    const authority = documentRecovery().captureNativeCloseAuthority(owner.id, sessionId)
    if (authority) {
      closeCapturedAuthorities.set(owner.id, authority)
      const request = sheetsCloseTransport.current(owner)
      if (request) closeCaptureTickets.set(owner.id, request.ticket)
    }
    return authority
  },
  verifyCapturedRevision: (owner, result, authority) => {
    const envelope = result.closeLease, proof = authority.attest()
    if (!envelope || !proof) return false
    const ack = nativeDocumentAcks.get(documentOwnerKey(owner.id, envelope.source.sessionId))
    const binding = ack?.binding
    return !!ack && !!binding && ack.documentId === authority.id && ack.revision === proof.revision &&
      ack.sourceFingerprint === proof.sourceFingerprint && ack.payloadSha256 === proof.payloadSha256 &&
      binding.requestId === envelope.ticket.id && sameCloseTicket(binding.ticket, envelope.ticket) &&
      binding.stamp.source === envelope.stamp.source && binding.stamp.revision === envelope.stamp.revision &&
      sameSheetsCloseSource(binding.source, envelope.source) && binding.payloadSha256 === envelope.payloadSha256
  },
  stagePersistent: (owner, lineage, authority) => {
    if (!sheetsCloseRuntime) throw new Error('Native close custody is not registered.')
    return sheetsCloseRuntime.stagePersistent(owner, lineage, authority)
  },
  stageMemory: (owner, lineage, authority) => {
    if (!sheetsCloseRuntime) throw new Error('Protected close custody is not registered.')
    return sheetsCloseRuntime.stageMemory(owner, lineage, authority)
  },
  holdNativeUntilSettled: (owner, actual) => {
    const reservations = actualCloseReservations.get(owner) ?? new Set<Promise<void>>()
    actualCloseReservations.set(owner, reservations)
    reservations.add(actual)
    const settled = () => {
      reservations.delete(actual)
      if (!reservations.size && actualCloseReservations.get(owner) === reservations) actualCloseReservations.delete(owner)
    }
    void actual.then(settled, settled)
    if (!sheetsCloseRuntime) throw new Error('The native close quit ledger is not registered.')
    sheetsCloseRuntime.holdNativeUntilSettled(owner, actual)
  },
  report: error => console.warn('[sheets] Close preparation:', error),
})
function sameCloseTicket(a: CloseLeaseTicket, b: CloseLeaseTicket): boolean { return a.id === b.id && a.sequence === b.sequence && a.source === b.source }
function offeredSource(owner: WebContents, sessionId: string): SheetsCloseSource | null {
  const current = sheetsSources.current(owner)
  if (current?.sessionId === sessionId) return current
  return [...sourceOffers.values()].find(offer => offer.owner === owner && offer.source.sessionId === sessionId)?.source ?? null
}
function canAdoptSourceOffer(owner: WebContents, offer: SourceOffer): boolean {
  if (offer.owner !== owner || owner.isDestroyed() || !sheetsTabs.get(owner.id)?.sessions.has(offer.source.sessionId)) return false
  if (offer.open) return sourceOpenAdmissions.get(owner.id) === offer.open
  const current = sheetsSources.current(owner)
  return !!current && !!offer.previous && !sheetsSources.busy(owner) && sameSheetsCloseSource(current, offer.previous)
}
function beginSourceOpen(owner: WebContents): SheetsSourceOpen {
  const open = sheetsSources.beginOpen(owner)
  sourceOpenAdmissions.set(owner.id, open)
  return open
}
function offerOpenedSource(owner: WebContents, open: SheetsSourceOpen, file: WorkbookFile, onAdopted?: () => void): WorkbookFile {
  const source: SheetsCloseSource = { lineage: open.lineage, sessionId: file.sessionId, openedSha256: file.sha256, documentPath: sourceDocumentPath(owner, file) }
  const id = randomUUID()
  sourceOffers.set(id, { id, owner, source, previous: sheetsSources.current(owner), open, ...(onAdopted ? { onAdopted } : {}) })
  return { ...file, closeSource: source, ownedOpen: { id, source } }
}
function offerSavedSource(owner: WebContents, previous: SheetsCloseSource, file: WorkbookFile,
  afterAdopt: () => Promise<void>, lifecycle: WorkbookPublicationLifecycle, afterPublicationSettled?: () => void) {
  const publication = sheetsSources.offerOwnedPublication(owner, previous, {
    sessionId: file.sessionId, openedSha256: file.sha256, documentPath: sourceDocumentPath(owner, file),
  })
  const id = randomUUID(), source = { ...publication.next }
  sourceOffers.set(id, { id, owner, source, previous, publication,
    // Adoption arrives in a later IPC. Keep the original admitted W2 context
    // for true finalizers, rather than borrowing a new publisher during a move.
    afterAdopt: AsyncResource.bind(afterAdopt), publicationDecision: lifecycle.retainOffer(),
    ...(afterPublicationSettled ? { afterPublicationSettled: () => {
      void lifecycle.actualSettled.then(() => {
        const current = sheetsSources.current(owner)
        if (!owner.isDestroyed() && current && sameSheetsCloseSource(current, source) && !sheetsSources.busy(owner) &&
          ![...sourceOffers.values()].some(offer => offer.owner === owner)) afterPublicationSettled()
      }).catch(error => console.warn('[sheets] Settled publication host handoff failed:', error))
    } } : {}) })
  return { id, source }
}
function sourceDocumentPath(owner: WebContents, file: WorkbookFile): string | null {
  const session = sheetsTabs.get(owner.id)?.sessions.get(file.sessionId)
  if (session?.unsavedNew) return null
  return session?.restoreTarget ?? session?.recoverySourcePath ?? session?.csvSourcePath ?? file.path ?? null
}
async function releaseWorkbookReader(owner: WebContents, sessionId: string, retire: boolean, preserveImportDir?: string): Promise<void> {
  const entry = sheetsTabs.get(owner.id), session = entry?.sessions.get(sessionId)
  if (!entry || !session) return
  if (retire) await retireDocumentSession(owner.id, sessionId, session)
  else await documentRecoveryService?.releaseDocument(owner.id, sessionId)
  nativeDocumentAcks.delete(documentOwnerKey(owner.id, sessionId))
  await cleanupSessionResources({ tempRoot: app.getPath('temp'), snapshotPath: session.snapshotPath,
    importTempDir: session.importTempDir === preserveImportDir ? undefined : session.importTempDir,
    closeSidecar: () => entry.client.closeSettled(sessionId) })
  await releasePreparedDocumentRecovery(session.path)
  if (entry.sessions.get(sessionId) === session) entry.sessions.delete(sessionId)
  entry.saveTransfers.discardSession(sessionId)
}
export function sheetsCloseState(contents: WebContents): SheetsCloseState | null {
  const report = reportedCloseStates.get(contents.id), current = sheetsSources.current(contents)
  return report && current && sameSheetsCloseSource(report.state.source, current) ? structuredClone(report.state) : null
}
export function prepareSheetsClose(contents: WebContents, intent: 'save' | 'discard', approvedStamp?: CloseLeaseStamp,
  target?: { path?: string; overwrite?: boolean }, options: SheetsClosePrepareOptions = {}): Promise<SheetsCloseReceipt> {
  return sheetsCloseCoordinator.prepare(contents, intent, approvedStamp, target, options)
}
export function isSheetsClosePrepared(contents: WebContents, receipt: SheetsCloseReceipt): boolean { return sheetsCloseCoordinator.isPrepared(contents, receipt) }
export function sealSheetsClose(contents: WebContents, receipt: SheetsCloseReceipt): SheetsCloseReceipt | null { return sheetsCloseCoordinator.seal(contents, receipt) }
export function completeSheetsClose(contents: WebContents, receipt: SheetsCloseReceipt, remove: () => boolean): boolean { return sheetsCloseCoordinator.complete(contents, receipt, remove) }
export function cancelSheetsClose(contents: WebContents, receipt: SheetsCloseReceipt, reason = 'close canceled'): void { sheetsCloseCoordinator.cancel(contents, receipt.closeLease.ticket, reason) }
const documentSnapshotResponseSchema = z
  .object({
    apiVersion: z.literal(1),
    documentId: z.string().uuid(),
    revision: z.number().int().nonnegative().safe(),
    payload: z.unknown(),
  })
  .passthrough()

function documentRecovery(): WorkbookDocumentRecovery {
  if (!documentRecoveryService) {
    documentRecoveryClient = new XlsxSidecarClient(resolveSidecarPath())
    documentRecoveryService = new WorkbookDocumentRecovery({
      privateRoot: join(app.getPath('userData'), 'sheets-document-recovery'),
      nativeClient: createSettledDocumentNativeClient(documentRecoveryClient),
      ...(recoveryRuntimeState().phase === 'disabled' ? { storage: 'volatile' as const } : {}),
    })
  }
  return documentRecoveryService
}

function documentOwnerKey(ownerId: number, sessionId: string): string {
  return `${ownerId}:${sessionId}`
}

function runDocumentPublication<T>(
  ownerId: number,
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = documentOwnerKey(ownerId, sessionId)
  const previous = documentPublicationGates.get(key) ?? Promise.resolve()
  const pending = previous.then(task)
  const settled = pending.then(
    () => undefined,
    () => undefined,
  )
  documentPublicationGates.set(key, settled)
  void settled.then(() => {
    if (documentPublicationGates.get(key) === settled) documentPublicationGates.delete(key)
  })
  return pending
}

async function checkpointDocumentForSession(
  ownerId: number,
  sessionId: string,
  session: SessionInfo,
  request: WorkbookSaveRequest,
  context: { dirty?: boolean; binding?: WorkbookCloseCheckpointBinding; closeTicket?: CloseLeaseTicket | undefined; writeAdmission: SheetsWorkbookWriteAdmission },
) {
  if (sheetsTabs.get(ownerId)?.sessions.get(sessionId) !== session)
    throw new Error('Unknown workbook session.')
  const originalPath =
    session.restoreTarget ??
    session.recoverySourcePath ??
    session.csvSourcePath ??
    session.suggestSaveAs ??
    session.path
  const digest =
    session.restoreTarget !== undefined
      ? session.restoreTargetSha
      : session.recoverySourcePath !== undefined
        ? session.recoverySourceSha
        : session.csvSourcePath !== undefined
          ? session.csvSourceSha
          : session.suggestSaveAs !== undefined
            ? undefined
            : session.sha256
  const owner = sheetsTabs.get(ownerId)!.webContents
  const payload = canonicalDocumentPayload(documentPayloadFromSave(request))
  const payloadSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  sheetsPromptWriteGate.assert(owner, context.writeAdmission)
  sheetsCloseTransport.assertWriter(owner, context?.binding?.ticket ?? context?.closeTicket)
  if (context?.binding) validateCloseCheckpointBinding(owner, sessionId, context.binding, payloadSha256)
  const originalFingerprint = session.recoveryOriginalFingerprint !== undefined ? session.recoveryOriginalFingerprint : digest === undefined ? null : `sha256:${digest}`
  const receipt = await documentRecovery().checkpoint({
    ownerId,
    sessionId,
    originalPath,
    sourcePath: session.snapshotPath,
    originalFingerprint,
    sheets: [...session.sheetNames].map(([id, name]) => ({ id, name })),
    payload,
    encrypted: session.password !== undefined,
    actor: 'desktop',
  })
  if (sheetsTabs.get(ownerId)?.sessions.get(sessionId) !== session) {
    throw new Error(
      'The workbook closed or changed while its document checkpoint was being committed.',
    )
  }
  const key = documentOwnerKey(ownerId, sessionId)
  // Memory-only protected documents also need explicit retirement on save,
  // undo-to-clean and close; their document ID has no disk candidate.
  const currentProducer = documentRecovery().isCurrentProducer(ownerId, sessionId, receipt.documentId)
  const captured = closeCapturedAuthorities.get(ownerId)
  const capturedBinding = !!context?.binding && captured?.id === receipt.documentId &&
    sheetsCloseTransport.accepts(owner, context.binding.ticket)
  if (!currentProducer && !capturedBinding) throw new Error('An obsolete native checkpoint cannot replace the current recovery producer.')
  if (currentProducer) documentCandidates.set(key, receipt.documentId)
  nativeDocumentAcks.set(key, { documentId: receipt.documentId, revision: receipt.revision,
    sourceFingerprint: session.nativeSourceFingerprint, payloadSha256, dirty: context?.dirty ?? true,
    ...(context?.binding ? { binding: structuredClone(context.binding) } : {}) })
  return receipt
}

function validateCloseCheckpointBinding(owner: WebContents, sessionId: string, binding: WorkbookCloseCheckpointBinding, payloadSha256: string): void {
  const expected = offeredSource(owner, sessionId)
  if (!binding || binding.requestId !== binding.ticket?.id || !isCloseLeaseTicket(binding.ticket) || !isCloseLeaseStamp(binding.stamp) ||
    !isSheetsCloseSource(binding.source) || !expected || !sameSheetsCloseSource(binding.source, expected) ||
    binding.source.sessionId !== sessionId || binding.source.lineage !== binding.ticket.source ||
    binding.payloadSha256 !== payloadSha256 || !sheetsCloseTransport.accepts(owner, binding.ticket))
    throw new Error('The full checkpoint is not bound to the current sender, close ticket, source and authored revision.')
}

async function retireDocumentSession(
  ownerId: number,
  sessionId: string,
  session?: SessionInfo,
): Promise<void> {
  const key = documentOwnerKey(ownerId, sessionId)
  const candidate = documentCandidates.get(key)
  const adopted = session && adoptedDocumentCandidates.get(session.path)
  if (candidate) await documentRecovery().retire(candidate)
  if (adopted && adopted !== candidate) await documentRecovery().retire(adopted)
  documentCandidates.delete(key)
  if (session) {
    adoptedDocumentCandidates.delete(session.path)
    const directory = materializedRecoveryDirectories.get(session.path)
    if (directory) {
      await rm(session.path, { force: true }).catch(() => undefined)
      await rmdir(directory).catch(() => undefined)
      materializedRecoveryDirectories.delete(session.path)
      materializedRecoveryNames.delete(session.path)
    }
  }
}

async function nativeDocumentRecoveryForOpen(
  client: XlsxSidecarClient,
  originalPath: string,
  contents?: WebContents,
  parent?: BrowserWindow,
  newWorkbookPath?: string,
): Promise<{
  handled: boolean
  prepared?: {
    openPath: string
    restoreTarget?: string
    suggestSaveAs?: string
    recoverySourcePath?: string
    recoverySourceSha?: string
  }
}> {
  if (recoveryRuntimeState().phase === 'disabled' || (contents && headlessOwnerWork.has(contents))) return { handled: false }
  const candidates = await documentRecovery().listCandidates(originalPath)
  const adopted = new Set(adoptedDocumentCandidates.values())
  const candidate = candidates.find(
    (item) => !adopted.has(item.id) && !adoptingDocumentCandidates.has(item.id),
  )
  if (!candidate) return { handled: false }
  adoptingDocumentCandidates.add(candidate.id)
  try {
    const recovered = await documentRecovery().readCandidate(candidate.id, originalPath)
    const promptPath = join(dirname(recovered.pinnedBasePath), 'manifest.json')
    const choice =
      contents && !contents.isDestroyed()
        ? await promptRecoveryRestore(
            contents,
            originalPath,
            promptPath,
            newWorkbookPath === undefined,
            recovered.sourceConflict,
          )
        : await promptRecoveryRestoreNative(
            originalPath,
            promptPath,
            parent,
            newWorkbookPath === undefined,
            recovered.sourceConflict,
          )
    if (choice === 'discard') {
      await documentRecovery().retire(candidate.id)
      if (newWorkbookPath) forgetUnsavedNewRecovery(originalPath)
      else clearWorkbookRecovery(originalPath)
      return { handled: true }
    }
    if (choice !== 'restore') return { handled: true }
    const payload = validateDocumentPayload(recovered.snapshot.payload)
    await mkdir(recoveryDir(), { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(recoveryDir(), 'native-document-'))
    const target = join(directory, 'recovered.bin')
    try {
      const source: SessionInfo = {
        path: originalPath,
        snapshotPath: recovered.pinnedBasePath,
        sha256: recovered.snapshot.sourceFingerprint.replace(/^sha256:/, ''),
        nativeSourceFingerprint: recovered.snapshot.sourceFingerprint,
        sheetNames: new Map(recovered.snapshot.sheets.map((sheet) => [sheet.id, sheet.name])),
        automaticRecoveryDisabled: false,
      }
      await writeWorkbookTo(
        client,
        source,
        { ...payload, sessionId: randomUUID(), mode: 'save-as' },
        target,
      )
      if (newWorkbookPath) {
        await copyFile(target, newWorkbookPath)
        await rm(target, { force: true })
        await rmdir(directory)
        adoptedDocumentCandidates.set(newWorkbookPath, candidate.id)
        return { handled: true, prepared: { openPath: newWorkbookPath } }
      }
      materializedRecoveryDirectories.set(target, directory)
      materializedRecoveryNames.set(target, originalPath)
      adoptedDocumentCandidates.set(target, candidate.id)
      // A changed original or a non-OOXML source always gets an explicit Save As.
      const current = await sha256File(originalPath)
        .then((digest) => `sha256:${digest}`)
        .catch(() => null)
      const changed = current !== null && current !== recovered.originalFingerprint
      const officePackage = /\.(xlsx|xlsm)$/i.test(originalPath)
      return {
        handled: true,
        prepared:
          officePackage && !changed
            ? {
                openPath: target,
                restoreTarget: originalPath,
                recoverySourcePath: originalPath,
                ...(recovered.originalFingerprint === null
                  ? {}
                  : {
                      recoverySourceSha: recovered.originalFingerprint.replace(/^sha256:/, ''),
                    }),
              }
            : {
                openPath: target,
                suggestSaveAs: officePackage
                  ? originalPath
                  : originalPath.replace(/\.[^.]+$/, '.xlsx'),
                recoverySourcePath: originalPath,
                ...(recovered.originalFingerprint === null
                  ? {}
                  : { recoverySourceSha: recovered.originalFingerprint.replace(/^sha256:/, '') }),
              },
      }
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined)
      await rmdir(directory).catch(() => undefined)
      throw error
    }
  } finally {
    adoptingDocumentCandidates.delete(candidate.id)
  }
}
let activeSheetsWebContents: WebContents | null = null
let pastedTempCleanupStarted = false

function startPastedTempCleanup(): void {
  if (pastedTempCleanupStarted) return
  pastedTempCleanupStarted = true
  void cleanupExpiredPastedFiles(app.getPath('temp'))
}

function sessionFor(event: IpcMainInvokeEvent): SheetsTabSession {
  const entry = sheetsTabs.get(event.sender.id)
  if (!entry) throw new Error('Untrusted IPC sender.')
  return entry
}

/**
 * Local media roots for a sheets renderer: the directories of the workbooks its
 * tab has open, plus the directory sheets stages pasted images in. A tab can
 * hold several workbook sessions, so every open one contributes its directory —
 * a tool call naming a file the user put next to the workbook they are editing
 * is the legitimate case, and nothing else is readable.
 */
function sheetsMediaRoots(wcId: number): string[] {
  const tab = sheetsTabs.get(wcId)
  const workbookDirs = tab ? [...tab.sessions.values()].map((s) => dirname(s.path)) : []
  return localMediaRoots(...workbookDirs, join(app.getPath('temp'), 'vantage-pasted'))
}

/// A save request referencing a chunked edit transfer gets the accumulated
/// edits spliced back in; the transfer is consumed either way.
function resolveTransferredEdits(
  entry: SheetsTabSession,
  request: WorkbookSaveRequest,
): WorkbookSaveRequest {
  if (request.editsTransferId === undefined) return request
  if (request.edits.length > 0) throw new Error('Save request mixes inline and transferred edits.')
  const edits = entry.saveTransfers.take(request.editsTransferId, request.sessionId)
  return { ...request, edits }
}

function dialogParent(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  return hostWindowFor(event.sender)
}

async function openFileDialog(event: IpcMainInvokeEvent, options: OpenDialogOptions) {
  return showOpenDialogWithMemory(dialog, dialogParent(event), options)
}

async function saveFileDialog(event: IpcMainInvokeEvent, options: SaveDialogOptions) {
  // before any pick is remembered, bare-name suggestions anchor in the
  // configurable default save folder instead of Electron's Downloads pin
  return showSaveDialogWithMemory(
    dialog,
    dialogParent(event),
    options,
    configuredDefaultSaveDir(app),
  )
}

/** Workbook file extensions the open pipeline accepts. Single source for the
 *  picker filters, the merge-source check, and the crash re-open check.
 *  .ods opens through the same import conversion as .xls. */
const WORKBOOK_EXTS = new Set(['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'])
const WORKBOOK_FILTER_EXTENSIONS = [...WORKBOOK_EXTS]

/** register a tab's webContents/client pair and wire up cleanup on teardown */
/** Clients whose process-death notification is already wired. A sidecar client
 *  is shared by every tab (the `sidecar ?? new XlsxSidecarClient(...)` reuse),
 *  so the wiring is per client and the crash is broadcast to the tabs using
 *  it — not attached once per tab, which would notify N times over. */
const crashNotifiedClients = new WeakSet<XlsxSidecarClient>()

/** Tell every live tab that the sidecar died, so it can re-open its workbook
 *  and adopt a live session. Positive signal: a workbook the app closed on
 *  purpose (closeWorkbook) or swapped during Save never reaches the client,
 *  because those only send a `close` command down the live pipe. */
function broadcastSidecarCrash(client: XlsxSidecarClient): void {
  for (const entry of sheetsTabs.values()) {
    if (entry.client !== client) continue
    if (entry.webContents.isDestroyed()) continue
    entry.webContents.send(IPC_CHANNELS.sidecarCrashed)
  }
}

function registerSheetsSession(webContents: WebContents, client: XlsxSidecarClient): void {
  if (ownerCleanupByContents.has(webContents)) throw new Error('The spreadsheet owner is already registered.')
  let completeOwner!: () => void
  let failOwner!: (error: unknown) => void
  const actualOwnerCleanup = new Promise<void>((resolve, reject) => { completeOwner = resolve; failOwner = reject })
  // Publish the genuine destruction finalizer before any registration effect.
  // Only the full teardown below settles it; an interrupted handler stays pending.
  ownerCleanupByContents.set(webContents, actualOwnerCleanup)
  void actualOwnerCleanup.catch(() => {})
  startPastedTempCleanup()
  if (!crashNotifiedClients.has(client)) {
    crashNotifiedClients.add(client)
    client.onProcessExit(() => broadcastSidecarCrash(client))
  }
  sheetsTabs.set(webContents.id, {
    webContents,
    client,
    sessions: new Map(),
    aiStreams: new Map(),
    saveTransfers: new SaveEditsTransferStore(),
  })
  activeSheetsWebContents = webContents
  webContents.once('destroyed', () => {
    const entry = sheetsTabs.get(webContents.id)
    const publicationTail = ownerPublicationTail(webContents)
    sheetsCloseCoordinator.destroy(webContents)
    sheetsSources.destroy(webContents)
    const actualTransport = sheetsCloseTransport.destroy(webContents)
    sheetsTabs.delete(webContents.id)
    reportedCloseStates.delete(webContents.id)
    const abandonedOffers = [...sourceOffers.values()].filter(offer => offer.owner === webContents)
    for (const offer of abandonedOffers) sourceOffers.delete(offer.id)
    sourceOpenAdmissions.delete(webContents.id)
    // Destruction proves renderer termination; accepted native publications
    // still settle before handles/resources close. It never means discard.
    const actualCleanup = Promise.all([publicationTail, actualTransport]).then(async () => {
      await documentRecoveryService?.forgetOwner(webContents.id)
    if (entry) {
      const recoveryPaths = [...entry.sessions.values()].map((session) => session.path)
      for (const [sessionId, session] of entry.sessions) {
        documentCandidates.delete(documentOwnerKey(webContents.id, sessionId))
        adoptedDocumentCandidates.delete(session.path)
      }
      // Free pending chunked-save uploads with the tab (the sweep timer's
      // closure would otherwise keep them reachable until the idle expiry).
      entry.saveTransfers.dispose()
      await closeAllSessions(entry, headlessOwnerWork.has(webContents)).finally(() => Promise.all(recoveryPaths.map(releasePreparedDocumentRecovery)))
    }
    })
    const renameActual = activeWorkbookRenames.get(webContents)
    // The rename's verified-destruction path below waits the BASE cleanup.
    // Only the exported outer join waits rename continuation too; making the
    // captured publication lifecycle wait this outer join would self-deadlock.
    const fullOwnerCleanup = renameActual ? Promise.allSettled([actualCleanup, renameActual]).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason
    }) : actualCleanup
    void fullOwnerCleanup.then(completeOwner, failOwner)
    // Include teardown even if adoption already removed its map entry while
    // its finalizer was running. No offered lifecycle can escape on owner loss.
    for (const lifecycle of mainPublicationLifecycles.get(webContents) ?? []) {
      if (!lifecycle.isSettled()) lifecycle.hold(actualCleanup)
    }
    for (const offer of abandonedOffers) offer.publicationDecision?.finishAfter(actualCleanup)
    sheetsRenameRefresh.destroy(webContents, actualCleanup)
    sheetsCloseRuntime?.holdNativeUntilSettled(webContents, fullOwnerCleanup)
    void fullOwnerCleanup.catch(error => console.warn('[sheets] Lost renderer session cleanup failed:', error))
    if (activeSheetsWebContents === webContents) activeSheetsWebContents = null
  })
}

export function getSheetsWindow(): BrowserWindow | null {
  return mainWindow
}

/** the webContents of whichever sheets tab most recently registered or activated */
export function getActiveSheetsWebContents(): WebContents | null {
  return activeSheetsWebContents
}

/** shell tab switching keeps menu actions routed at the visible sheets tab */
export function setActiveSheetsWebContents(wc: WebContents | null): void {
  activeSheetsWebContents = wc
}

/** Shell notification: an open view's file was renamed on disk (renamed in the
 *  Home list) — sync the matching session's path in that tab (later saves write
 *  the new file) and push the renderer to update the title-bar file name. */
export async function sheetsFileRenamed(wc: WebContents, oldPath: string, newPath: string,
  writeContext: WorkbookWriteContext = { origin: 'manual' },
  notifyRefresh?: (name: string, metadata: WorkbookRenamedMetadata) => void): Promise<void> {
  const entry = sheetsTabs.get(wc.id)
  if (!entry) return
  if (!isAbsolute(oldPath) || !isAbsolute(newPath)) throw new Error('A workbook relocation requires absolute owned paths.')
  if (sameWorkbookPath(oldPath, newPath)) return
  const source = sheetsSources.current(wc)
  const matched = [...entry.sessions].filter(([, session]) => matchesWorkbookRelocation(session, oldPath)).map(([id, session]) => ({
    id, session, expected: knownRelocationDigest(session, oldPath), blocked: { ...session, relocationPending: true } as SessionInfo,
  }))
  if (!matched.length) return
  // Caller MUST await this exported promise after its physical move. Blocking
  // in-place publication immediately prevents recreating an unverified old path.
  const writeAdmission = sheetsPromptWriteGate.admit(wc, writeContext)
  for (const item of matched) entry.sessions.set(item.id, item.blocked)
  // ready was captured before our publication registration; never wait for
  // ownerPublicationTail from inside the operation it would include.
  await writeAdmission.ready
  const active = matched.find(item => item.id === source?.sessionId)
  return runDocumentPublication(wc.id, active?.id ?? matched[0]!.id, async () => {
    sheetsPromptWriteGate.assert(wc, writeAdmission)
    sheetsCloseTransport.assertWriter(wc)
    if (wc.isDestroyed() || sheetsTabs.get(wc.id) !== entry || matched.some(item => entry.sessions.get(item.id) !== item.blocked) ||
      sheetsSources.busy(wc) || [...sourceOffers.values()].some(offer => offer.owner === wc)) throw new Error('The workbook changed before its relocated path could be verified.')
    for (const expected of new Set(matched.map(item => item.expected))) await verifyRelocatedWorkbook(newPath, expected)
    sheetsPromptWriteGate.assert(wc, writeAdmission)
    const changes = matched.map(item => ({ ...item, next: sessionAfterVerifiedRelocation(item.session, oldPath, newPath, item.expected!) }))
    for (const { session, next } of changes) {
      if (session.unsavedNew && session.suggestSaveAs && next.suggestSaveAs !== session.suggestSaveAs && pendingUnsavedNewRecoveryFor(session.suggestSaveAs) &&
        !retargetUnsavedNewRecovery(session.suggestSaveAs, next.suggestSaveAs!)) throw new Error('The previous unsaved recovery name could not be safely relocated.')
    }
    let nextSource = source
    if (active && source) {
      nextSource = sheetsSources.relocateOwnedPath(wc, source, source.documentPath !== null && sameWorkbookPath(source.documentPath, oldPath) ? newPath : source.documentPath)
      if (!nextSource) throw new Error('The active source changed before its owned path relocation.')
    }
    for (const { id, next } of changes) entry.sessions.set(id, next)
    // Detach every old producer synchronously before awaiting close. Its exact
    // candidate survives; the renderer must acknowledge full state in a fresh epoch.
    const releases = changes.map(({ id }) => {
      nativeDocumentAcks.delete(documentOwnerKey(wc.id, id)); documentCandidates.delete(documentOwnerKey(wc.id, id))
      return documentRecoveryService?.releaseDocument(wc.id, id) ?? Promise.resolve()
    })
    const released = await Promise.allSettled(releases)
    for (const result of released) if (result.status === 'rejected') console.warn('[sheets] Relocated source old recovery-handle cleanup incomplete:', result.reason)
    const stem = (path: string) => basename(path).replace(/ \(\d+\)(?=\.[^.]+$)/, '')
    if (untitledWorkbookPaths.delete(oldPath) && stem(newPath) === stem(oldPath)) untitledWorkbookPaths.add(newPath)
    if (active && nextSource) {
      const moved = changes.find(item => item.id === active.id)!.next
      const metadata: WorkbookRenamedMetadata = { sessionId: active.id,
        ...(moved.readerDisplay?.path ? { path: moved.readerDisplay.path } : {}), ...(moved.csvSourcePath ? { csvPath: moved.csvSourcePath } : {}),
        closeSource: nextSource, requiresCheckpoint: true, writeContext }
      if (notifyRefresh) notifyRefresh(moved.readerDisplay?.name ?? basename(newPath), metadata)
      else wc.send(IPC_CHANNELS.workbookRenamed, moved.readerDisplay?.name ?? basename(newPath), metadata)
    }
  })
}

/**
 * Workbooks the shell pre-created on disk with the localized untitled name
 * ("New Spreadsheet"). Only these ever qualify for the content-derived
 * auto-rename after an AI run; any manual rename removes the mark.
 */
const untitledWorkbookPaths = new Set<string>()
export function markSheetsUntitledPath(path: string): void {
  untitledWorkbookPaths.add(path)
}

/**
 * Backing workbooks the shell created in a temp directory for "New
 * spreadsheet". The user has no file yet — it only comes into existence at the
 * first Save, which this routes through Save As — and a tab closed without
 * saving discards the temp directory with it. Same shape as an .xls/.tsv
 * import: the file the session edits is not the user's file.
 */
const unsavedNewWorkbooks = new Map<string, { suggestSaveAs: string; tempDir: string }>()

/**
 * shell: a would-be path already promised to another unsaved new workbook (open
 * tab, tab about to open, or a crash copy waiting to be re-offered). The file
 * itself does not exist yet, so uniqueness on disk is not enough.
 */
export function sheetsSuggestedPathTaken(path: string): boolean {
  for (const pending of unsavedNewWorkbooks.values())
    if (pending.suggestSaveAs === path) return true
  for (const tab of sheetsTabs.values())
    for (const session of tab.sessions.values()) if (session.suggestSaveAs === path) return true
  return readUnsavedNewIndex().includes(path)
}

/** shell: mark a backing workbook it just created as not-yet-saved (see above) */
export function markSheetsUnsavedNew(
  openPath: string,
  suggestSaveAs: string,
  tempDir: string,
): void {
  unsavedNewWorkbooks.set(openPath, { suggestSaveAs, tempDir })
}

/** shell: the backing workbook could not be written, release its name */
export function unmarkSheetsUnsavedNew(openPath: string): void {
  unsavedNewWorkbooks.delete(openPath)
}

const mcpWritablePaths = new Map<number, Set<string>>()

/** MCP save_session: the shell resolved this path for the tab, so a dialog-free save may write it */
export function authorizeMcpSheetWrite(wcId: number, filePath: string): void {
  const set = mcpWritablePaths.get(wcId) ?? new Set<string>()
  set.add(filePath)
  mcpWritablePaths.set(wcId, set)
}

function canMcpSheetWrite(wcId: number, filePath: string): boolean {
  return mcpWritablePaths.get(wcId)?.has(filePath) === true
}

/** Sanitize an AI-provided sheet name into a safe filename base: strip illegal path chars, collapse whitespace, cap length; null if invalid. (Mirrors slides' draft naming.) */
function sanitizeAutoRenameBase(raw: string): string | null {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point here
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40).trim() : cleaned
}

/** shell hook: a tab opened a workbook (dialog or queued path) — used for tab titles/dedupe */
let workbookOpenedHook: ((wc: WebContents, path: string) => void) | null = null
export function setSheetsWorkbookOpenedHook(
  fn: ((wc: WebContents, path: string) => void) | null,
): void {
  workbookOpenedHook = fn
}

/** forward an application-menu File command into the sheets renderer */
export function sendSheetsMenuAction(
  action: 'open' | 'save' | 'save-as' | 'print' | 'export-pdf' | 'export-csv' | 'undo' | 'redo',
): void {
  activeSheetsWebContents?.send(IPC_CHANNELS.menuAction, action)
}

/** An already-mounted renderer polled for its queued workbook before one existed. */
export function nudgeQueuedWorkbook(contents: WebContents): void {
  contents.send(IPC_CHANNELS.menuAction, 'open')
}

// ---- AI settings persistence (main process avoids renderer CORS for the chat/stream proxy) ----

function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

// ── Crash recovery ──────────────────────────────────────────
// A dirty renderer asks for a recovery copy every 30s; it is written through the
// normal save pipeline (writeWorkbookTo) to a userData path, so it is a real .xlsx.
// A successful save removes it; opening a file whose copy is newer offers Restore.
const recoveryDir = () => userDataPath('sheets-autosave')
const recoveryPathFor = (filePath: string) =>
  join(recoveryDir(), `${createHash('sha1').update(filePath).digest('hex').slice(0, 16)}.xlsx`)

function clearWorkbookRecovery(filePath: string): void {
  if (recoveryRuntimeState().phase === 'disabled') return
  try {
    unlinkSync(recoveryPathFor(filePath))
  } catch {
    /* nothing to clean */
  }
}

// An unsaved new workbook has no file for pendingRecoveryFor to compare
// against, so the would-be paths of its recovery copies are listed here and
// the shell re-offers them at launch (and "New spreadsheet" reuses the name).
const unsavedNewIndexPath = () => join(recoveryDir(), 'unsaved-new.json')

function readUnsavedNewIndex(): string[] {
  if (recoveryRuntimeState().phase === 'disabled') return []
  const list = readJson<unknown>(unsavedNewIndexPath(), [])
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
}

function writeUnsavedNewIndex(list: string[]): void {
  if (recoveryRuntimeState().phase === 'disabled') return
  try {
    mkdirSync(recoveryDir(), { recursive: true })
    writeFileSync(unsavedNewIndexPath(), JSON.stringify(list))
  } catch (error) {
    console.warn('[sheets] unsaved-new index write failed:', error)
  }
}

function rememberUnsavedNewRecovery(suggestSaveAs: string): void {
  const list = readUnsavedNewIndex()
  if (!list.includes(suggestSaveAs)) writeUnsavedNewIndex([...list, suggestSaveAs])
}

function forgetUnsavedNewRecovery(suggestSaveAs: string): void {
  clearWorkbookRecovery(suggestSaveAs)
  const list = readUnsavedNewIndex()
  if (list.includes(suggestSaveAs)) writeUnsavedNewIndex(list.filter((p) => p !== suggestSaveAs))
}

/** shell, at launch: would-be paths of new workbooks whose recovery copy survived a crash */
export async function pendingUnsavedNewRecoveries(): Promise<string[]> {
  if (recoveryRuntimeState().phase === 'disabled') return []
  const live = readUnsavedNewIndex().filter((p) => existsSync(recoveryPathFor(p)))
  writeUnsavedNewIndex(live)
  const native = await documentRecovery().listAllCandidates()
  return [
    ...new Set([
      ...live,
      ...native
        .filter(
          (candidate) =>
            /\.(xlsx|xlsm)$/i.test(candidate.originalPath) && !existsSync(candidate.originalPath),
        )
        .map((candidate) => candidate.originalPath),
    ]),
  ]
}

/** the would-be name changed: the crash copy keyed on it follows (false = copy stays under the old key) */
function retargetUnsavedNewRecovery(from: string, to: string): boolean {
  if (!pendingUnsavedNewRecoveryFor(from)) return true
  try {
    renameSync(recoveryPathFor(from), recoveryPathFor(to))
    rememberUnsavedNewRecovery(to)
    forgetUnsavedNewRecovery(from)
    return true
  } catch (err) {
    console.warn('[sheets] recovery copy rename failed:', err)
    return false
  }
}

function pendingUnsavedNewRecoveryFor(suggestSaveAs: string): string | null {
  if (recoveryRuntimeState().phase === 'disabled') return null
  const copy = recoveryPathFor(suggestSaveAs)
  return readUnsavedNewIndex().includes(suggestSaveAs) && existsSync(copy) ? copy : null
}

/// Restore/Discard choice for a pending recovery copy. Rendered as a styled
/// in-app dialog by the renderer (the native message box looks dated,
/// especially on Windows); strings ship pre-localized in the payload.
/// 'dismissed' (renderer gone before answering) opens the original file and
/// keeps the copy, so the offer repeats on the next open.
type RecoveryChoice = 'restore' | 'discard' | 'dismissed'

const recoveryPromptWaiters = new Map<number, (choice: RecoveryChoice) => void>()

function promptRecoveryRestore(
  contents: WebContents,
  filePath: string,
  recoveryPath: string,
  onDisk = true,
  sourceConflict = false,
): Promise<RecoveryChoice> {
  return new Promise((resolve) => {
    let savedAtMs = Date.now()
    try {
      savedAtMs = statSync(recoveryPath).mtimeMs
    } catch {
      /* copy vanished: the prompt still works, just without a precise time */
    }
    const settle = (choice: RecoveryChoice): void => {
      recoveryPromptWaiters.delete(contents.id)
      contents.removeListener('destroyed', onDestroyed)
      resolve(choice)
    }
    const onDestroyed = (): void => settle('dismissed')
    recoveryPromptWaiters.set(contents.id, settle)
    contents.once('destroyed', onDestroyed)
    contents.send(IPC_CHANNELS.recoveryPrompt, {
      title: tm('autosaveFoundTitle'),
      body:
        recoveryPromptBody(filePath, recoveryPath, onDisk) +
        (sourceConflict ? `\n\n${tm('errDiskChanged')}` : ''),
      restoreLabel: tm('autosaveRestore'),
      discardLabel: tm('autosaveDiscard'),
      fileName: basename(filePath),
      savedAtMs,
    })
  })
}

/** Native message-box fallback for the rare open with no live renderer to draw the prompt. */
async function promptRecoveryRestoreNative(
  filePath: string,
  recoveryPath: string,
  parent?: BrowserWindow | undefined,
  onDisk = true,
  sourceConflict = false,
): Promise<RecoveryChoice> {
  const options = {
    type: 'question' as const,
    buttons: [tm('autosaveRestore'), tm('autosaveDiscard')],
    defaultId: 0,
    cancelId: 1,
    message: tm('autosaveFoundTitle'),
    detail:
      recoveryPromptBody(filePath, recoveryPath, onDisk) +
      (sourceConflict ? `\n\n${tm('errDiskChanged')}` : ''),
  }
  const answer = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return answer.response === 0 ? 'restore' : 'discard'
}

/** Recovery copy left by a lost session. A newer original does not discard it (the copy
 * may hold the only pre-crash edits): the prompt just says the disk file is newer. */
function pendingRecoveryFor(filePath: string): string | null {
  if (recoveryRuntimeState().phase === 'disabled') return null
  const copy = recoveryPathFor(filePath)
  try {
    return existsSync(copy) ? copy : null
  } catch {
    return null
  }
}

function recoveryPromptBody(filePath: string, recoveryPath: string, onDisk: boolean): string {
  const body = tm('autosaveFoundBody')
  // an unsaved workbook's would-be name is not the file restore writes to
  if (!onDisk) return body
  try {
    return recoveryCopyDiskNewer(statSync(recoveryPath).mtimeMs, statSync(filePath).mtimeMs)
      ? `${body}\n\n${tm('autosaveDiskNewer')}`
      : body
  } catch {
    return body
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    /* corrupted state file: fall back to defaults */
  }
  return fallback
}

const SETTINGS_PATH = () => userDataPath('ai-settings.json')

// Dev-only automation hooks: a fixed CDP port for driving the app from test
// scripts, and a workbook path that bypasses the native file dialog.
const debugPort = app.isPackaged ? undefined : process.env.XLSX_DEBUG_PORT
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort)
let forcedWorkbookPath = app.isPackaged ? undefined : process.env.XLSX_OPEN_PATH
/** shell-queued workbook paths keyed by tab webContents id: a multi-select Open
 * creates several sheets tabs at once, so the path must be bound to its own tab
 * (a single global would be overwritten by the next iteration). One-shot, unlike
 * the sticky dev env/capture-server path above. */
const queuedWorkbookPaths = new Map<number, string>()

/** queue a workbook this tab's first selectWorkbook call opens without a dialog (shell routing) */
export function queueWorkbookForView(contents: WebContents, path: string): void {
  queuedWorkbookPaths.set(contents.id, path)
  contents.once('destroyed', () => {
    queuedWorkbookPaths.delete(contents.id)
  })
}

/** is the active tab still waiting for the renderer to consume a shell-queued workbook? */
export function hasActiveQueuedWorkbook(): boolean {
  return activeSheetsWebContents !== null && queuedWorkbookPaths.has(activeSheetsWebContents.id)
}

/** set by shell for home:new-sheet: renderer opens blank workbook instead of demo */
let pendingNewBlank = false

/** signal the next sheets renderer to open a new blank workbook (shell mode only) */
export function setSheetsNewBlank(): void {
  pendingNewBlank = true
}

// capturePage forces a renderer frame even when the window is occluded or on
// another Space, unlike CDP Page.captureScreenshot / macOS screencapture.
function startCaptureServer(): void {
  if (!debugPort) return
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/open') {
      forcedWorkbookPath = url.searchParams.get('path') ?? undefined
      response.writeHead(200)
      response.end('ok')
      return
    }
    // Drives the File menu from test scripts: CDP input can't reach native
    // menu accelerators, and osascript focus-stealing is flaky.
    if (url.pathname === '/menu') {
      const action = url.searchParams.get('action')
      if (
        action === 'open' ||
        action === 'save' ||
        action === 'save-as' ||
        action === 'print' ||
        action === 'export-pdf' ||
        action === 'export-csv' ||
        action === 'undo' ||
        action === 'redo'
      ) {
        sendSheetsMenuAction(action)
        response.writeHead(200)
        response.end('ok')
      } else {
        response.writeHead(400)
        response.end('unknown action')
      }
      return
    }
    const webContents = getActiveSheetsWebContents()
    if (url.pathname !== '/capture' || !webContents) {
      response.writeHead(404)
      response.end()
      return
    }
    webContents
      .capturePage()
      .then((image) => {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(image.toPNG())
      })
      .catch((error: unknown) => {
        response.writeHead(500)
        response.end(String(error))
      })
  })
  server.listen(Number(debugPort) + 1, '127.0.0.1')
}

const sidecarOpenResultSchema = workbookFileSchema.omit({
  sha256: true,
  readOnly: true,
})

export async function createSheetsWindow(
  options: { includeAiHandlers?: boolean } = {},
): Promise<BrowserWindow> {
  await getSessionSnapshotDirectory()
  const client = sidecar ?? new XlsxSidecarClient(resolveSidecarPath())
  sidecar = client
  client.start()
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 550,
    show: false,
    title: 'Vantage Sheets',
    // Traffic lights sit inside the toolbar row.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  mainWindow = window
  registerSheetsIpc()
  if (options.includeAiHandlers ?? true) registerSheetsAiIpc()
  if (options.includeAiHandlers ?? true) registerProjectIpc()
  registerSheetsSession(window.webContents, client)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!app.isPackaged) {
    window.webContents.on('console-message', (details) => {
      process.stderr.write(`[renderer:${details.level}] ${details.message}\n`)
    })
  }
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    event.preventDefault()
    void requestSheetsClose(window.webContents, window, () => {
      if (window.isDestroyed()) return false
      window.destroy()
      return window.isDestroyed()
    }).then((proceed) => {
      // not proceeding vetoes any quit that was in flight: go back to
      // prompting on later closes (see resetSheetsShuttingDown)
      if (!proceed) cancelStandaloneSheetsQuit()
    }).catch(() => {
      cancelStandaloneSheetsQuit()
      warnStandaloneSheets('Spreadsheet close preparation failed. The application will remain open.')
    })
  })
  window.on('closed', () => {
    mainWindow = null
  })

  await window.loadURL(rendererUrl(runtime.rendererUrl, 'sheets'))
  return window
}

/** hidden export windows: webContents id -> the PDF path the renderer must write */
const headlessExportTargets = new Map<number, string>()
/** settled by 'sheets:headless-export-done' (or by the renderer dying) */
const headlessExportWaiters = new Map<number, (result: HeadlessSheetsReport) => void>()

interface HeadlessSheetsReport {
  ok: boolean
  error?: string
}

/** End a headless run early (a failure the renderer can never observe). */
function failHeadlessExport(wcId: number, message: string): void {
  const settle = headlessExportWaiters.get(wcId)
  if (!settle) return
  headlessExportWaiters.delete(wcId)
  settle({ ok: false, error: message })
}

/**
 * Render `input` to `outPath` with no visible window: a hidden sheets
 * renderer opens the workbook through the normal queued-open path, lays the
 * active sheet out with its Page Layout settings and prints via the existing
 * hidden print window (main/pdf-export.ts).
 */
export async function exportSheetsPdfHeadless(
  input: string,
  outPath: string,
  timeoutMs = 600_000,
): Promise<void> {
  const client = sidecar ?? new XlsxSidecarClient(resolveSidecarPath())
  sidecar = client
  let win: BrowserWindow | undefined
  let contents: WebContents | undefined
  let wcId: number | undefined
  let registrationAttempted = false
  let actualOwnerCleanup: Promise<void> | undefined
  const ownerWork = new HeadlessSheetsOwnerWork()
  const stoppedClients = new Map<XlsxSidecarClient, Promise<void>>()
  const stopNative = async (): Promise<void> => {
    // Re-evaluate the document client after teardown continuations, not just
    // the clients that happened to exist when a grace stop first began.
    const clients = new Set([client, ...(documentRecoveryClient ? [documentRecoveryClient] : [])])
    const results = await Promise.allSettled([...clients].map(native => {
      let actual = stoppedClients.get(native)
      if (!actual) {
        try { actual = native.stopSettled() }
        catch (error) { actual = Promise.reject(error) }
        stoppedClients.set(native, actual)
      }
      return actual
    }))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    client.start()
    win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      webPreferences: {
        preload: runtime.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    const owner = win.webContents
    contents = owner
    headlessOwnerWork.set(owner, ownerWork)
    registerSheetsIpc()
    registrationAttempted = true
    registerSheetsSession(owner, client)
    actualOwnerCleanup = sheetsOwnerCleanup(owner)
    owner.setWindowOpenHandler(() => ({ action: 'deny' }))
    owner.on('will-navigate', (event) => event.preventDefault())
    const id = owner.id
    wcId = id
    queueWorkbookForView(owner, input)
    headlessExportTargets.set(id, outPath)
    const report = await new Promise<HeadlessSheetsReport>((resolve) => {
      headlessExportWaiters.set(id, resolve)
      owner.on('render-process-gone', (_event, details) =>
        resolve({ ok: false, error: `sheets renderer stopped (${details.reason})` }),
      )
      timer = setTimeout(
        () => resolve({ ok: false, error: `sheets export timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
      void owner.loadURL(rendererUrl(runtime.rendererUrl, 'sheets')).catch(() =>
        resolve({ ok: false, error: 'The headless spreadsheet renderer could not load.' }))
    })
    if (!report.ok) throw new Error(report.error ?? 'sheets export failed')
  } finally {
    if (timer) clearTimeout(timer)
    // Close producer admission before removing targets or destroying the owner;
    // queued IPC cannot sneak another export into the teardown snapshot.
    ownerWork.closeAdmission()
    if (wcId !== undefined) {
      headlessExportWaiters.delete(wcId)
      headlessExportTargets.delete(wcId)
    }
    let destroyFailed = false
    let destroyFailure: unknown
    try { if (win && !win.isDestroyed()) win.destroy() }
    catch (error) { destroyFailed = true; destroyFailure = error }
    // Saved at registration, before owner destruction. A late getter can only
    // recover that same genuine bridge, never manufacture a resolved fallback.
    actualOwnerCleanup ??= contents ? sheetsOwnerCleanup(contents) : undefined
    try {
      await settleHeadlessSheetsCleanup({
        ownerCleanup: actualOwnerCleanup ? ownerWork.joinOwner(actualOwnerCleanup) : undefined,
        setupOnly: !registrationAttempted,
        onMissingOwner: () => console.warn('[sheets] Headless cleanup is waiting for its registered owner finalizer.'),
        joinNative: joinNativeActualWork,
        stopNative,
      })
      if (destroyFailed) throw destroyFailure
    } finally {
        // Keep this closed owner membership until WebContents is collected;
        // an already-queued late IPC must never fall back to GUI admission.
      if (sidecar === client && stoppedClients.has(client)) sidecar = null
      if (documentRecoveryClient && stoppedClients.has(documentRecoveryClient)) {
        documentRecoveryClient = undefined
        documentRecoveryService = undefined
      }
    }
  }
}

/** tab-mode equivalent of createSheetsWindow: same runtime/IPC wiring, no BrowserWindow of its own. */
export function createSheetsView(
  options: { includeAiHandlers?: boolean; openingWorkbook?: boolean } = {},
): WebContentsView {
  const client = sidecar ?? new XlsxSidecarClient(resolveSidecarPath())
  sidecar = client
  client.start()
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  registerSheetsIpc()
  if (options.includeAiHandlers ?? true) registerSheetsAiIpc()
  registerSheetsSession(view.webContents, client)
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event) => event.preventDefault())
  if (!app.isPackaged) {
    view.webContents.on('console-message', (details) => {
      process.stderr.write(`[renderer:${details.level}] ${details.message}\n`)
    })
  }
  // mode=tab: the shell's tab strip owns the traffic lights / caption buttons,
  // so the ribbon must not reserve space for them
  void view.webContents.loadURL(
    rendererUrl(runtime.rendererUrl, 'sheets', {
      mode: 'tab',
      ...(options.openingWorkbook ? { openingWorkbook: '1' } : {}),
    }),
  )
  return view
}

// ---- Chat attachments: local files parsed and fed to the agent (copied from
// the apps/docs docs-main attachment pipeline) ----

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
/** Plain-text extensions, read as UTF-8 */
const ATTACHMENT_TEXT_EXTS = new Set([
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
/** office/pdf formats extract text via @vantage/file-parse; images skip text
 * extraction and go multimodal (sheets:files-read-image) */
const ATTACHMENT_EXTS = new Set([
  ...ATTACHMENT_TEXT_EXTS,
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
/** Multimodal cap per image attachment (protects the context window) */
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Extracted-text cache keyed by path; invalidated when mtime+size change */
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

/** Persists clipboard-pasted image bytes to a temp file (screenshots/bitmaps
 * without a local path); returns null for non-images or empty data */
let pastedImageSeq = 0
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
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const filePath = join(dir, `pasted-${stamp}-${++pastedImageSeq}.${cleanExt}`)
  writeFileSync(filePath, bytes)
  return filePath
}

/** Attachment text extraction via @vantage/file-parse (docx/pdf/pptx/xlsx/plain text) */
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
  // The cache is bounded (keeping a few recent files is enough)
  if (attachmentTextCache.size > 8) {
    const oldest = attachmentTextCache.keys().next().value
    if (oldest) attachmentTextCache.delete(oldest)
  }
  return parsed.text
}

// Close guard: the renderer mirrors its pending-save count here, used to show a
// save confirmation before closing the window/tab.
const pendingEditCounts = new Map<number, number>()
const trackedEditSenders = new Set<number>()

export function sheetsPendingEditCount(webContentsId: number): number {
  return pendingEditCounts.get(webContentsId) ?? 0
}

/**
 * Close guard for a sheets renderer: true means proceed with the close.
 * Clean → true; dirty → Save/Don't Save/Cancel dialog. Save asks the renderer to run
 * its journal save and waits for the outcome — a failed or canceled save
 * keeps the window open (the renderer already surfaced the error).
 */
/**
 * The app is shutting down (quit menu, SIGTERM from a restart/installer/killall,
 * SIGINT from a terminal). The close guard must not save then: nobody answered the
 * prompt, and a dialog raised during shutdown resolves to its default button, which
 * silently overwrote the user's original file. Unsaved work is covered
 * by the 30s recovery copy instead — the next launch offers to restore it.
 */
const shutdownLatch = new ShutdownLatch()

export function markSheetsShuttingDown(): void {
  shutdownLatch.mark()
}

/**
 * The quit was vetoed (a prevented window close that ended up not proceeding).
 * The latch must go back down: from now on closes are interactive again and
 * the save prompt must run — leaving it set would silently discard unsaved
 * edits on every later close.
 */
export function resetSheetsShuttingDown(): void {
  shutdownLatch.reset()
}

app.on('will-quit', markSheetsShuttingDown)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.quit() // the common/native close path must still collect permission
  })
}

export async function prepareSheetsNativeClose(
  contents: WebContents,
  parent?: BrowserWindow | null,
  options: SheetsClosePrepareOptions = {},
): Promise<SheetsCloseReceipt | null> {
  const operationCurrent = (): boolean => {
    if (contents.isDestroyed() || options.signal?.aborted) return false
    try { return options.isCurrent?.() !== false } catch { return false }
  }
  if (!operationCurrent()) return null
  const state = sheetsCloseState(contents)
  if (!state) return null
  let prompt: SheetsClosePromptHandle | undefined
  let success = false
  const controller = new AbortController()
  try {
  // The original120s clock starts before dialog.showMessageBox can await.
  prompt = sheetsCloseCoordinator.beginPrompt(contents, options)
  sheetsPromptWriteGate.beginPrompt(contents, prompt.ticket)
  nativeClosePrompts.set(contents.id, { ticket: prompt.ticket, controller })
  if (!operationCurrent() || !sheetsCloseCoordinator.isPromptCurrent(contents, prompt)) return null
  let intent: 'save' | 'discard' = 'discard'
  const approvedStamp = { ...state.stamp }
  const count = pendingEditCounts.get(contents.id) ?? (state.dirty ? 1 : 0)
  if (state.dirty) {
  const options = {
    // On macOS 'warning' shows the system warning triangle + app-icon badge
    type: 'warning' as const,
    message: tm('closeUnsavedMsg', { count }),
    detail: tm('closeUnsavedDetail'),
    buttons: [tm('menuSave'), tm('btnDontSave'), tm('btnCancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    // Installed Electron MessageBoxOptions supports AbortSignal. Matching
    // broker release aborts only this dialog; a later prompt is untouched.
    signal: controller.signal,
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  if (!operationCurrent() || !sheetsCloseCoordinator.isPromptCurrent(contents, prompt)) return null
  if (response === 2) return null
  intent = response === 0 ? 'save' : 'discard'
  }
  if (!operationCurrent() || !sheetsCloseCoordinator.isPromptCurrent(contents, prompt)) return null
  const receipt = await sheetsCloseCoordinator.prepareReserved(contents, prompt, intent, intent === 'discard' ? approvedStamp : undefined)
  if (!operationCurrent()) { cancelSheetsClose(contents, receipt, 'native operation no longer current'); return null }
  success = true
  return receipt
  } catch (error) { console.warn('[sheets] Close preparation refused; workbook/recovery retained:', error); return null }
  finally {
    if (prompt) {
      sheetsPromptWriteGate.releasePrompt(contents, prompt.ticket)
      if (nativeClosePrompts.get(contents.id)?.controller === controller) nativeClosePrompts.delete(contents.id)
      sheetsCloseCoordinator.endPrompt(contents, prompt, success)
    }
  }
}

export async function requestSheetsClose(contents: WebContents, parent?: BrowserWindow | null, remove?: () => boolean): Promise<boolean> {
  // Legacy Boolean-only callers cannot carry permission through actual removal.
  if (!remove || contents.isDestroyed()) return false
  const receipt = await prepareSheetsNativeClose(contents, parent)
  if (!receipt) return false
  try { return completeSheetsClose(contents, receipt, remove) }
  finally { cancelSheetsClose(contents, receipt, 'native close attempt finished') }
}

let coreIpcRegistered = false

export function registerSheetsIpc(): void {
  if (coreIpcRegistered) return
  coreIpcRegistered = true

  const trustedCloseSender = (sender: WebContents): boolean => sheetsTabs.get(sender.id)?.webContents === sender && !sender.isDestroyed()
  ipcMain.on(IPC_CHANNELS.workbookRenameRefreshResult, (event, id: unknown, result: unknown) => {
    if (trustedCloseSender(event.sender)) sheetsRenameRefresh.receiveResult(event.sender, id, result)
  })
  ipcMain.on(IPC_CHANNELS.workbookRenameRefreshActualSettled, (event, id: unknown) => {
    if (trustedCloseSender(event.sender)) sheetsRenameRefresh.receiveActualSettled(event.sender, id)
  })
  ipcMain.handle(IPC_CHANNELS.workbookCloseSource, (event, id: unknown) => {
    sessionFor(event)
    return typeof id === 'string' ? offeredSource(event.sender, id) : null
  })
  ipcMain.handle(IPC_CHANNELS.recoverWorkbookReader, async (event, rawId: unknown, rawWriteContext: unknown) => {
    const sessionId = z.string().uuid().parse(rawId)
    const entry = sessionFor(event), previous = sheetsSources.current(event.sender)
    const old = entry.sessions.get(sessionId)
    if (!old || !previous || previous.sessionId !== sessionId) return null
    // Admission revokes close permission before it can await any bytes. A
    // still-running actual close writer/capture is not assumed canceled.
    const writeAdmission = sheetsPromptWriteGate.admit(event.sender, parseWorkbookWriteContext(rawWriteContext))
    await writeAdmission.ready
    sheetsPromptWriteGate.assert(event.sender, writeAdmission)
    sheetsCloseCoordinator.invalidateSource(event.sender, 'immutable reader recovery admitted')
    if (sheetsSources.busy(event.sender) || [...sourceOffers.values()].some(offer => offer.owner === event.sender))
      throw new Error('A source replacement is already pending.')
    return runDocumentPublication(event.sender.id, sessionId, async () => {
      sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      const stillCurrent = () => !event.sender.isDestroyed() && sheetsTabs.get(event.sender.id) === entry && entry.sessions.get(sessionId) === old &&
        !!sheetsSources.current(event.sender) && sameSheetsCloseSource(sheetsSources.current(event.sender)!, previous) && !sheetsSources.busy(event.sender) &&
        ![...sourceOffers.values()].some(offer => offer.owner === event.sender)
      sheetsCloseTransport.assertWriter(event.sender)
      if (!stillCurrent()) throw new Error('The workbook changed before reader recovery could begin.')
      let fresh: WorkbookFile | undefined
      let freshSnapshot: string | undefined
      try {
        // This is the ONLY source argument. Never session.path/current disk,
        // never explicit reopen/recovery prompts, and never decrypt again.
        fresh = await openWorkbookSession(entry.client, old.snapshotPath, entry.sessions, {
          retainExistingBaseOnFailure: true, preserveExistingReaderIds: true,
        })
        const freshSession = entry.sessions.get(fresh.sessionId)
        if (!freshSession) throw new Error('The replacement reader did not register its own snapshot.')
        freshSnapshot = freshSession.snapshotPath
        sheetsPromptWriteGate.assert(event.sender, writeAdmission)
        if (!stillCurrent()) throw new Error('A newer source operation superseded reader recovery.')
        if (fresh.sessionId === sessionId) throw new Error('Reader recovery did not allocate a distinct native reader.')
        const rebound = rebindRecoveredReader(old, freshSession)
        entry.sessions.set(fresh.sessionId, rebound)
        const file = recoveredReaderFile(old, fresh)
        const nextSource = recoveredReaderSource(previous, file.sessionId)
        const publication = sheetsSources.offerOwnedPublication(event.sender, previous, nextSource)
        const offer = { id: randomUUID(), source: { ...publication.next } }
        sourceOffers.set(offer.id, { id: offer.id, owner: event.sender, source: offer.source, previous, publication,
          afterAdopt: () => releaseWorkbookReader(event.sender, sessionId, false, old.importTempDir) })
        return { ...file, closeSource: offer.source, ownedOpen: offer }
      } catch (error) {
        // Refusal affects only the new native reader and its distinct snapshot.
        // All old source guards, pinned bytes, import directories and ACKs stay.
        if (fresh && fresh.sessionId !== sessionId) {
          entry.sessions.delete(fresh.sessionId)
          if (freshSnapshot && freshSnapshot !== old.snapshotPath)
            await cleanupSessionResources({ tempRoot: app.getPath('temp'), snapshotPath: freshSnapshot,
              closeSidecar: () => entry.client.close(fresh!.sessionId) }).catch(cleanupError => console.warn('[sheets] Refused reader recovery cleanup failed:', cleanupError))
          else await entry.client.close(fresh.sessionId).catch(() => undefined)
        }
        throw error
      }
    })
  })
  ipcMain.on(IPC_CHANNELS.workbookCloseState, (event, state: unknown, coverage: unknown) => {
    if (!trustedCloseSender(event.sender) || typeof coverage !== 'boolean' || !state || typeof state !== 'object') return
    const value = state as SheetsCloseState
    if (!isSheetsCloseSource(value.source) || !isCloseLeaseStamp(value.stamp) || typeof value.dirty !== 'boolean' ||
      typeof value.busy !== 'boolean' || typeof value.protectedMemoryOnly !== 'boolean') return
    const source = offeredSource(event.sender, value.source.sessionId)
    if (!source || !sameSheetsCloseSource(source, value.source)) return
    const session = sheetsTabs.get(event.sender.id)?.sessions.get(value.source.sessionId)
    if (!session || value.protectedMemoryOnly !== (session.password !== undefined)) return
    reportedCloseStates.set(event.sender.id, { state: structuredClone(value), coverage })
  })
  ipcMain.handle(IPC_CHANNELS.workbookCloseClaim, (event, ticket: unknown) => {
    sessionFor(event)
    if (!isCloseLeaseTicket(ticket) || !sheetsCloseCoordinator.claim(event.sender, ticket)) return false
    if (sheetsCloseTransport.claim(event.sender, ticket)) return true
    sheetsCloseCoordinator.cancel(event.sender, ticket, 'renderer transport claim refused')
    return false
  })
  ipcMain.handle(IPC_CHANNELS.workbookCloseCancel, (event, ticket: unknown, reason: unknown) => {
    sessionFor(event)
    if (!isCloseLeaseTicket(ticket)) throw new Error('Invalid workbook close ticket.')
    sheetsCloseCoordinator.cancel(event.sender, ticket, typeof reason === 'string' ? reason.slice(0, 1024) : 'renderer canceled close')
  })
  ipcMain.on(IPC_CHANNELS.workbookCloseResult, (event, id: unknown, result: unknown) => {
    if (trustedCloseSender(event.sender) && sheetsCloseTransport.receiveResult(event.sender, id, result)) {
      const envelope = (result as import('../shared/sheets-close').SheetsPrepareCloseResult).closeLease
      if (envelope) closeResultStamps.set(event.sender.id, { ticket: envelope.ticket, stamp: envelope.stamp })
    }
  })
  ipcMain.on(IPC_CHANNELS.workbookCloseActualSettled, (event, id: unknown) => {
    if (trustedCloseSender(event.sender)) sheetsCloseTransport.receiveActualSettled(event.sender, id)
  })
  ipcMain.handle(IPC_CHANNELS.workbookPublicationCanAdopt, (event, id: unknown) => {
    sessionFor(event)
    const offer = typeof id === 'string' ? sourceOffers.get(id) : undefined
    return !!offer && canAdoptSourceOffer(event.sender, offer)
  })
  ipcMain.handle(IPC_CHANNELS.workbookPublicationAdopt, async (event, id: unknown, raw: unknown) => {
    const entry = sessionFor(event), offer = typeof id === 'string' ? sourceOffers.get(id) : undefined
    if (!offer || !canAdoptSourceOffer(event.sender, offer) || !raw || typeof raw !== 'object') return false
    const adoption = raw as WorkbookPublicationAdoption
    if (!isSheetsCloseSource(adoption.source) || !isCloseLeaseStamp(adoption.stamp) ||
      !sameSheetsCloseSource(adoption.source, offer.source) || !/^[a-f0-9]{64}$/.test(adoption.payloadSha256)) return false
    const ack = nativeDocumentAcks.get(documentOwnerKey(event.sender.id, offer.source.sessionId))
    if (!ack || ack.payloadSha256 !== adoption.payloadSha256 || !documentRecovery().isCurrentProducer(event.sender.id, offer.source.sessionId, ack.documentId)) return false
    let actualAdoption!: Promise<boolean>
    actualAdoption = runDocumentPublication(event.sender.id, offer.source.sessionId, async () => {
      if (!canAdoptSourceOffer(event.sender, offer)) return false
      const latest = nativeDocumentAcks.get(documentOwnerKey(event.sender.id, offer.source.sessionId))
      if (!latest || latest.documentId !== ack.documentId || latest.revision !== ack.revision || latest.payloadSha256 !== adoption.payloadSha256 ||
        !documentRecovery().isCurrentProducer(event.sender.id, offer.source.sessionId, latest.documentId)) return false
      sheetsCloseTransport.assertWriter(event.sender, latest.binding?.ticket)
      const accepted = offer.open
        ? sheetsSources.commitOpen(event.sender, offer.open, offer.source)
        : !!offer.publication && sheetsSources.adoptOwnedPublication(event.sender, offer.publication) !== null
      if (!accepted) return false
      // Bind before any source-map/metadata/finalizer continuation can fail.
      offer.publicationDecision?.finishAfter(actualAdoption)
      if (offer.open && sourceOpenAdmissions.get(event.sender.id) === offer.open) sourceOpenAdmissions.delete(event.sender.id)
      sourceOffers.delete(offer.id)
      const session = entry.sessions.get(offer.source.sessionId)!
      reportedCloseStates.set(event.sender.id, { coverage: reportedCloseStates.get(event.sender.id)?.coverage ?? false,
        state: { source: offer.source, stamp: adoption.stamp, dirty: ack.dirty, busy: false, protectedMemoryOnly: session.password !== undefined } })
      // Adoption is committed. Resource cleanup cannot roll it back or erase its accepted new checkpoint.
      try {
        if (offer.afterAdopt) await offer.afterAdopt()
        else if (offer.previous && offer.previous.sessionId !== offer.source.sessionId)
          await releaseWorkbookReader(event.sender, offer.previous.sessionId, false, session.importTempDir)
        offer.onAdopted?.()
      } catch (error) { console.warn('[sheets] Adopted source previous-reader cleanup failed:', error) }
      // Host callbacks may initiate a file move of this output. They run after
      // the lifecycle releases; awaiting them inside it would wait on ourselves.
      offer.afterPublicationSettled?.()
      return true
    })
    return actualAdoption
  })
  ipcMain.handle(IPC_CHANNELS.workbookPublicationReject, async (event, id: unknown) => {
    const entry = sessionFor(event)
    const offer = typeof id === 'string' ? sourceOffers.get(id) : undefined
    if (!offer || offer.owner !== event.sender) return
    const actualRejection = runDocumentPublication(event.sender.id, offer.source.sessionId, async () => {
      // A preceding queued adoption may already have consumed this exact offer.
      // Its reader must never be closed by a later stale rejection.
      if (sourceOffers.get(offer.id) !== offer) return
      sourceOffers.delete(offer.id)
      if (offer.open) {
        sheetsSources.cancelOpen(event.sender, offer.open)
        if (sourceOpenAdmissions.get(event.sender.id) === offer.open) sourceOpenAdmissions.delete(event.sender.id)
      }
      if (offer.publication) sheetsSources.rejectOwnedPublication(offer.publication)
      await releaseWorkbookReader(event.sender, offer.source.sessionId, false,
        offer.previous ? entry.sessions.get(offer.previous.sessionId)?.importTempDir : undefined)
    })
    offer.publicationDecision?.finishAfter(actualRejection)
    await actualRejection
  })

  ipcMain.handle(IPC_CHANNELS.userDisplayName, (event): string => {
    sessionFor(event)
    return configuredAuthorName(app)
  })

  // Registered here (not in registerSheetsAiIpc, skipped in shell mode):
  // slides' ai:generate-image only exists once a slides view opens, so sheets
  // owns its channel the way pdf does.
  ipcMain.handle(
    IPC_CHANNELS.aiGenerateImage,
    (event, op: { prompt?: unknown; aspectRatio?: unknown }) =>
      generateImageTool(
        SETTINGS_PATH(),
        {
          prompt: String(op?.prompt ?? ''),
          ...(op?.aspectRatio ? { aspectRatio: String(op.aspectRatio) } : {}),
        },
        { mediaRoots: sheetsMediaRoots(event.sender.id) },
      ),
  )

  ipcMain.on(IPC_CHANNELS.recoveryPromptReply, (event, restore: unknown) => {
    recoveryPromptWaiters.get(event.sender.id)?.(restore === true ? 'restore' : 'discard')
  })

  ipcMain.on(IPC_CHANNELS.pendingEditsChanged, (event, count: unknown) => {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return
    const senderId = event.sender.id
    pendingEditCounts.set(senderId, Math.floor(count))
    if (!trackedEditSenders.has(senderId)) {
      trackedEditSenders.add(senderId)
      event.sender.once('destroyed', () => {
        trackedEditSenders.delete(senderId)
        pendingEditCounts.delete(senderId)
      })
    }
  })

  // Legacy Boolean replies never grant a close lease.

  // shared with the other editor modules — last (identical) registration wins
  ipcMain.removeHandler('app:get-language')
  ipcMain.handle('app:get-language', () => getUiLang())

  /** returns true once when shell opened this tab for a new blank workbook */
  ipcMain.handle('sheets:consume-new-blank', () => {
    if (pendingNewBlank) {
      pendingNewBlank = false
      return true
    }
    return false
  })

  /**
   * Is a shell-queued workbook still waiting to be opened? The shell's 'open'
   * nudge loop gives up after 30s; on slow dev cold starts (vite compiles the
   * renderer on demand) Univer mounts later than that and the queued path
   * would strand the tab as a blank in-memory workbook. The renderer polls
   * this once it is ready and triggers the open itself.
   */
  ipcMain.handle('sheets:has-queued-workbook', (event) => queuedWorkbookPaths.has(event.sender.id))

  // ---- headless export mode (--headless-export) ----

  ipcMain.handle('sheets:consume-headless-export', (event): string | null => {
    const target = headlessExportTargets.get(event.sender.id) ?? null
    headlessExportTargets.delete(event.sender.id)
    return target
  })

  ipcMain.on('sheets:headless-export-done', (event, result: unknown) => {
    const settle = headlessExportWaiters.get(event.sender.id)
    if (!settle) return
    headlessExportWaiters.delete(event.sender.id)
    const state = result as { ok?: unknown; error?: unknown } | null
    settle({
      ok: state?.ok === true,
      ...(typeof state?.error === 'string' ? { error: state.error } : {}),
    })
  })

  /// `explicitPath` re-opens a known file without the picker or the shell
  /// queue — the crash-recovery entry point. It runs the SAME pipeline
  /// (prepareWorkbookForOpen + openWorkbookSession + the opened hook) as a
  /// user-picked or shell-queued open, so a recovered workbook is a normal
  /// session rather than a merge source.
  const openSelectedWorkbookActual = async (
    event: IpcMainInvokeEvent,
    explicitPath?: string,
    password?: string,
  ) => {
    const entry = sessionFor(event)
    const sourceOpen = beginSourceOpen(event.sender)
    let offerReturned = false
    try {
    let path = explicitPath ?? queuedWorkbookPaths.get(event.sender.id) ?? forcedWorkbookPath
    // consume immediately (before the slow session open) so the shell's
    // retry loop stops re-sending 'open' for the same file
    queuedWorkbookPaths.delete(event.sender.id)
    if (!path) {
      const selection = await openFileDialog(event, {
        properties: ['openFile'],
        filters: [{ name: tm('filterSpreadsheets'), extensions: WORKBOOK_FILTER_EXTENSIONS }],
      })
      if (selection.canceled || !selection.filePaths[0]) return null
      path = selection.filePaths[0]
    }
    // Password first, recovery prompt second: the prompt's Restore/Discard
    // choice is consumed by prepareWorkbookForOpen, so asking for the
    // password (or rejecting a wrong one) must happen before it runs.
    if (await isCfbWorkbookFile(path)) {
      const bytes = await readFile(path)
      if (isEncryptedOoxml(bytes)) {
        if (password === undefined) return { passwordRequired: true as const, path }
        await decryptOoxml(bytes, password)
      }
    }
    const prepared = await prepareWorkbookForOpen(
      entry.client,
      path,
      event.sender,
      dialogParent(event),
    )
    // a declined import (an .ods the user chose not to convert) opens nothing
    if (!prepared) return null
    // The recovery prompt (or the file dialog / import conversion) can outlive
    // the tab: once the renderer is destroyed, its 'destroyed' handler has
    // already run closeAllSessions and dropped the tab entry, so a session
    // opened now would never be closed and its snapshot would leak.
    if (event.sender.isDestroyed()) {
      await discardPreparedOpen(prepared)
      return null
    }
    let result: WorkbookFile
    try {
      result = await openWorkbookSession(entry.client, prepared.openPath, entry.sessions, {
        suggestSaveAs: prepared.suggestSaveAs,
        csvImport: prepared.csvImport,
        csvSourcePath: prepared.csvSourcePath,
        recoverySourcePath: prepared.recoverySourcePath,
        recoverySourceSha: prepared.recoverySourceSha,
        emptyCsv: prepared.emptyCsv,
        importTempDir: prepared.importTempDir,
        restoreTarget: prepared.restoreTarget,
        emptySource: prepared.emptySource,
        unsavedNew: prepared.unsavedNew,
        requireExitOnCloseFailure: headlessOwnerWork.has(event.sender),
        password,
      })
    } catch (error) {
      await discardPreparedOpen(prepared)
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('PASSWORD_REQUIRED') && password === undefined) {
        return { passwordRequired: true as const, path }
      }
      throw error
    }
    // The sidecar open itself can also outlive the tab after the pre-open
    // check. Close the newly registered session instead of stranding it in
    // the detached entry map.
    if (event.sender.isDestroyed()) {
      const session = entry.sessions.get(result.sessionId)
      entry.sessions.delete(result.sessionId)
      if (session !== undefined) {
        await cleanupSessionResources({
          tempRoot: app.getPath('temp'),
          snapshotPath: session.snapshotPath,
          importTempDir: session.importTempDir,
          closeSidecar: async () => {
            if (!headlessOwnerWork.has(event.sender)) return entry.client.close(result.sessionId)
            try { await entry.client.closeSettled(result.sessionId) }
            catch (error) {
              // Temp cleanup swallows close errors. A headless late open may
              // release its staging only after its reader has truly exited.
              await entry.client.stopSettled()
              throw error
            }
          },
        })
        await releasePreparedDocumentRecovery(session.path)
      }
      return null
    }
    // an unsaved new workbook's tab already shows the untitled name; its temp
    // backing path must not become a recent file
    const adoptedPath = path
    const offered = offerOpenedSource(event.sender, sourceOpen, result,
      prepared.unsavedNew ? undefined : () => workbookOpenedHook?.(event.sender, adoptedPath))
    offerReturned = true
    return offered
    } finally {
      if (!offerReturned) {
        sheetsSources.cancelOpen(event.sender, sourceOpen)
        if (sourceOpenAdmissions.get(event.sender.id) === sourceOpen) sourceOpenAdmissions.delete(event.sender.id)
      }
    }
  }

  const openSelectedWorkbook = (
    event: IpcMainInvokeEvent,
    explicitPath?: string,
    password?: string,
  ) => {
    const open = () => openSelectedWorkbookActual(event, explicitPath, password)
    const headless = headlessOwnerWork.get(event.sender)
    // Reserve the entire open continuation before it can create a snapshot or
    // native reader. Owner teardown must join late-open staging cleanup too.
    if (headless) {
      if (event.sender.isDestroyed()) return Promise.reject(new Error('The headless spreadsheet owner is closing.'))
      return headless.run(open)
    }
    return open()
  }

  ipcMain.handle(IPC_CHANNELS.selectWorkbook, async (event) => {
    try {
      const result = await openSelectedWorkbook(event)
      if (result !== null && 'passwordRequired' in result) {
        failHeadlessExport(event.sender.id, 'the input workbook is password-protected')
      }
      return result
    } catch (err) {
      // A headless export has no dialog to report a failed open through, and
      // its renderer would poll to the deadline waiting for a workbook that
      // will never arrive — settle the run with the real reason instead.
      failHeadlessExport(event.sender.id, `the input workbook did not open (${String(err)})`)
      throw err
    }
  })

  ipcMain.handle(IPC_CHANNELS.openEncryptedWorkbook, async (event, input: unknown) => {
    const { path, password } = z
      .object({ path: z.string().min(1), password: z.string().min(1) })
      .parse(input)
    if (!existsSync(path)) throw new Error('Workbook file not found.')
    return openSelectedWorkbook(event, path, password)
  })

  ipcMain.handle(IPC_CHANNELS.updateWorkbookPassword, async (event, input: unknown) => {
    const { sessionId, newPassword } = z
      .object({
        sessionId: z.string().uuid(),
        newPassword: z.string().min(1).max(1024),
      })
      .strict()
      .parse(input)
    const entry = sessionFor(event)
    const session = entry.sessions.get(sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const source = sheetsSources.current(event.sender)
    if (!source || source.sessionId !== sessionId) throw new Error('The password action does not own the active reader.')
    // This endpoint is an explicit password action, never a timer/AI save.
    const writeAdmission = sheetsPromptWriteGate.admit(event.sender, { origin: 'manual' })
    await writeAdmission.ready
    if (sheetsSources.busy(event.sender) || [...sourceOffers.values()].some(offer => offer.owner === event.sender))
      throw new Error('A source replacement is already pending.')
    return runDocumentPublication(event.sender.id, sessionId, () => runMainWorkbookPublication(event.sender,
      { targetPath: session.path, sourcePaths: [session.snapshotPath] }, async () => withAtomicSaveQueue(session.path, async () => {
    sheetsPromptWriteGate.assert(event.sender, writeAdmission)
    const stillCurrent = () => !event.sender.isDestroyed() && sheetsTabs.get(event.sender.id) === entry && entry.sessions.get(sessionId) === session &&
      !!sheetsSources.current(event.sender) && sameSheetsCloseSource(sheetsSources.current(event.sender)!, source) && !sheetsSources.busy(event.sender)
    if (!stillCurrent()) throw new Error('The workbook changed before password publication.')
    if (session.password === undefined) {
      throw new Error('This workbook is not protected by an open password.')
    }

    const expectedCiphertext = expectedWorkbookDigest(session, session.path, session.sha256)
    await assertWorkbookTargetUnchanged(session.path, expectedCiphertext, tm('errDiskChanged'), sha256File)
    const pinnedBase = await readFile(session.snapshotPath)
    if (`sha256:${createHash('sha256').update(pinnedBase).digest('hex')}` !== session.nativeSourceFingerprint)
      throw new Error('The immutable loaded workbook base changed before password publication.')
    const encryptedBytes = encryptOoxml(pinnedBase, newPassword)
    sheetsPromptWriteGate.assert(event.sender, writeAdmission)
    if (!stillCurrent()) throw new Error('The workbook changed before its password could be published.')
    await assertWorkbookTargetUnchanged(session.path, expectedCiphertext, tm('errDiskChanged'), sha256File)
    sheetsPromptWriteGate.assert(event.sender, writeAdmission)
    await atomicWriteFile(session.path, encryptedBytes)
    const sha256 = createHash('sha256').update(encryptedBytes).digest('hex')
    const published = sessionAfterPasswordPublication(session, newPassword, sha256, encryptedBytes.byteLength)
    entry.sessions.set(sessionId, published)
    // The old producer captured the previous original ciphertext fingerprint.
    // Detach it after our publication; retain its candidate and exact base.
    nativeDocumentAcks.delete(documentOwnerKey(event.sender.id, sessionId))
    documentCandidates.delete(documentOwnerKey(event.sender.id, sessionId))
    let recoveryWarning: string | undefined
    try { await documentRecoveryService?.releaseDocument(event.sender.id, sessionId) }
    catch (error) {
      recoveryWarning = 'The new password was published; previous recovery-handle cleanup remains incomplete.'
      console.warn('[sheets] Password publication old recovery handle cleanup failed:', error)
    }
    clearWorkbookRecovery(session.path)
    return { sha256, fileBytes: encryptedBytes.byteLength, passwordProtected: true as const,
      closeSource: source, ...(recoveryWarning ? { recoveryWarning } : {}) }
    })))
  })

  ipcMain.handle(IPC_CHANNELS.reopenWorkbook, async (event, path: unknown) => {
    const validated = z.string().min(1).parse(path)
    // A crash re-open targets the file the user already has open, so a
    // missing/deleted file is a real failure rather than a reason to pop the
    // picker at someone who did not ask to open anything.
    if (!existsSync(validated)) throw new Error('Workbook file not found.')
    const ext = validated.slice(validated.lastIndexOf('.') + 1).toLowerCase()
    if (!WORKBOOK_EXTS.has(ext)) throw new Error(`Unsupported workbook: ${ext}`)
    const priorSession = [...sessionFor(event).sessions.values()].find(
      (session) => session.path === validated || session.restoreTarget === validated,
    )
    return openSelectedWorkbook(event, validated, priorSession?.password)
  })

  // Merge sources: same open pipeline as selectWorkbook, but multi-select,
  // never consuming the shell's queued open path and never retitling the tab
  // (workbookOpenedHook) — these sessions exist only to be read from and
  // closed by the renderer's merge routine.
  /** Open the given spreadsheet paths as merge-source sessions; cleans up
   *  everything already opened when a later file fails or the tab dies. */
  const openMergeSources = async (
    event: Electron.IpcMainInvokeEvent,
    paths: readonly string[],
  ): Promise<unknown[] | null> => {
    const entry = sessionFor(event)
    const opened: { sessionId: string }[] = []
    const closeOpened = async () => {
      for (const { sessionId } of opened) {
        const session = entry.sessions.get(sessionId)
        entry.sessions.delete(sessionId)
        if (session !== undefined) {
          await cleanupSessionResources({
            tempRoot: app.getPath('temp'),
            snapshotPath: session.snapshotPath,
            importTempDir: session.importTempDir,
            closeSidecar: () => entry.client.close(sessionId),
          })
        }
      }
    }
    try {
      for (const path of paths) {
        const prepared = await prepareWorkbookForOpen(
          entry.client,
          path,
          event.sender,
          dialogParent(event),
          { skipRecoveryPrompt: true },
        )
        // imports are never declined on this path (no per-file prompt), but a
        // declined open must skip the file rather than abort the batch
        if (!prepared) continue
        if (event.sender.isDestroyed()) {
          await discardPreparedOpen(prepared)
          break
        }
        const result = await openWorkbookSession(entry.client, prepared.openPath, entry.sessions, {
          suggestSaveAs: prepared.suggestSaveAs,
          csvImport: prepared.csvImport,
          csvSourcePath: prepared.csvSourcePath,
          recoverySourcePath: prepared.recoverySourcePath,
          recoverySourceSha: prepared.recoverySourceSha,
          importTempDir: prepared.importTempDir,
          restoreTarget: prepared.restoreTarget,
          emptySource: prepared.emptySource,
          unsavedNew: prepared.unsavedNew,
        })
        opened.push(result as { sessionId: string })
        if (event.sender.isDestroyed()) break
      }
    } catch (error) {
      // a later file failing must not strand the sessions already opened
      await closeOpened()
      throw error
    }
    if (event.sender.isDestroyed()) {
      await closeOpened()
      return null
    }
    return opened.length > 0 ? opened : null
  }

  ipcMain.handle(IPC_CHANNELS.selectWorkbooksForMerge, async (event) => {
    const selection = await openFileDialog(event, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: tm('filterSpreadsheets'), extensions: WORKBOOK_FILTER_EXTENSIONS }],
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return openMergeSources(event, selection.filePaths)
  })

  const MERGE_SOURCE_EXTS = WORKBOOK_EXTS
  ipcMain.handle(IPC_CHANNELS.openWorkbooksForMerge, async (event, input: unknown) => {
    const paths = z.array(z.string().min(1)).min(1).max(20).parse(input)
    for (const path of paths) {
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      if (!MERGE_SOURCE_EXTS.has(ext)) throw new Error(`Unsupported merge source: ${ext}`)
      if (!existsSync(path)) throw new Error('Merge source not found.')
    }
    return openMergeSources(event, paths)
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookRange, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookRangeRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readRange(request)
    return workbookRangeResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookFormulas, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookFormulaCellsRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readFormulaCells(request)
    return workbookFormulaCellsResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.findWorkbookCells, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookFindCellsRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.findCells(request)
    return workbookFindCellsResultSchema.parse(result)
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookRowOutline, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookFormulaCellsRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readRowOutline(request)
    return workbookRowOutlineResultSchema.parse(result)
  })

  // IronCalc recalculation: sheet ids resolve through the session's file
  // sheet names, so the renderer never sees paths and sheets added this
  // session (no file part) fail closed before reaching the engine.
  ipcMain.handle(IPC_CHANNELS.recalcWorkbook, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookRecalcRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    const fileSheetName = (sheetId: string): string => {
      const name = session.sheetNames.get(sheetId)
      if (name === undefined) throw new Error(`Unknown sheet for recalculation: ${sheetId}`)
      return name
    }
    // Validate every sheet before opening authority or writing its journal.
    for (const edit of request.edits) fileSheetName(edit.sheetId)
    const reads = request.reads.map((read) => ({
      sheet: fileSheetName(read.sheetId),
      range: read.range,
    }))
    const workbookId = editWorkbookId(
      session.csvSourcePath ?? session.restoreTarget ?? session.path,
      `${editAuthorityNamespace}:${event.sender.id}`,
      session.sha256,
    )
    // Password-protected inputs must never reach a plaintext SQLite journal.
    // They still use revision-checked transactions in an in-memory authority.
    const journalDirectory = join(app.getPath('userData'), 'sheets-edit-sessions')
    if (session.password === undefined)
      await mkdir(journalDirectory, { recursive: true, mode: 0o700 })
    if (entry.sessions.get(request.sessionId) !== session)
      throw new Error('Unknown workbook session.')
    const authority: EditSessionOpen = {
      apiVersion: 1,
      workbookId,
      // Native calculation and the existing save planner share the immutable
      // opened bytes, even if another program changes the original on disk.
      sourcePath: session.snapshotPath,
      sheets: [...session.sheetNames].map(([id, name]) => ({ id, name })),
      ...(session.password === undefined
        ? { storePath: join(journalDirectory, `${workbookId}.sqlite`) }
        : {}),
    }
    await entry.client.bindEditSession(request.sessionId, authority)
    if (entry.sessions.get(request.sessionId) !== session) {
      await entry.client.close(request.sessionId).catch(() => undefined)
      throw new Error('Unknown workbook session.')
    }
    const result = editRecalcResultSchema.parse(
      await entry.client.recalculateEditSession(authority, request.edits, reads),
    )
    const idsByName = new Map([...session.sheetNames].map(([id, name]) => [name, id]))
    return workbookRecalcResultSchema.parse({
      ...(result.cacheWritebackAllowed === undefined
        ? {}
        : { cacheWritebackAllowed: result.cacheWritebackAllowed }),
      ...(result.calculationCompleteness === undefined
        ? {}
        : { calculationCompleteness: result.calculationCompleteness }),
      ...(result.cacheWritebackReasons === undefined
        ? {}
        : { cacheWritebackReasons: result.cacheWritebackReasons }),
      cells: result.cells.flatMap((cell) => {
        const sheetId = idsByName.get(cell.sheet)
        if (sheetId === undefined) return []
        return [
          {
            sheetId,
            row: cell.row,
            column: cell.column,
            formatted: cell.formatted,
            ...(cell.value === undefined ? {} : { value: cell.value }),
            ...(cell.number === undefined ? {} : { number: cell.number }),
            ...(cell.isError ? { isError: true } : {}),
            isFormula: cell.isFormula,
          },
        ]
      }),
    })
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookMedia, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookMediaRequestSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    const result = await entry.client.readMedia(request)
    return workbookMediaResultSchema.parse(result)
  })

  function sniffImageType(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | null {
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    )
      return 'image/png'
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg'
    }
    if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
    return null
  }

  ipcMain.handle(IPC_CHANNELS.readLocalImage, async (event, input: unknown) => {
    sessionFor(event)
    const request = localImageRequestSchema.parse(input)
    const resolved = request.path.startsWith('~/')
      ? join(app.getPath('home'), request.path.slice(2))
      : request.path
    if (!isAbsolute(resolved)) throw new Error(tm('errImgAbsPath'))
    const info = await stat(resolved).catch(() => null)
    if (!info?.isFile()) throw new Error(tm('errImgNotFound', { path: request.path }))
    if (info.size > 20 * 1024 * 1024) throw new Error(tm('errImgTooLarge20'))
    const bytes = await readFile(resolved)
    const mediaType = sniffImageType(bytes)
    if (mediaType === null) {
      throw new Error(tm('errImgBadType'))
    }
    return localImageResultSchema.parse({ mediaType, base64: bytes.toString('base64') })
  })

  ipcMain.handle(IPC_CHANNELS.captureScreenSources, async (event) => {
    sessionFor(event)
    // macOS gates desktopCapturer behind the Screen Recording permission and
    // returns black frames instead of failing; surface a real denied state.
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('screen')
      if (status !== 'granted' && status !== 'not-determined') {
        return screenSourcesResultSchema.parse({ status: 'denied', sources: [] })
      }
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    })
    if (
      process.platform === 'darwin' &&
      systemPreferences.getMediaAccessStatus('screen') !== 'granted'
    ) {
      return screenSourcesResultSchema.parse({ status: 'denied', sources: [] })
    }
    const selfWindow = hostWindowFor(event.sender)
    const selfId = selfWindow?.getMediaSourceId()
    return screenSourcesResultSchema.parse({
      status: 'ok',
      sources: sources
        .filter((source) => source.id !== selfId)
        .map((source) => ({
          id: source.id,
          name: source.name,
          kind: source.id.startsWith('screen') ? 'screen' : 'window',
          thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
        })),
    })
  })

  ipcMain.handle(IPC_CHANNELS.captureScreenSource, async (event, input: unknown) => {
    sessionFor(event)
    const request = screenCaptureRequestSchema.parse(input)
    // desktopCapturer only ever returns thumbnails, so a full-res capture is
    // a re-listing with the thumbnail sized to the largest physical display.
    const displays = screen.getAllDisplays()
    const captureSize = {
      width: Math.min(
        4096,
        Math.max(1920, ...displays.map((d) => Math.ceil(d.size.width * d.scaleFactor))),
      ),
      height: Math.min(
        4096,
        Math.max(1080, ...displays.map((d) => Math.ceil(d.size.height * d.scaleFactor))),
      ),
    }
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: captureSize,
      fetchWindowIcons: false,
    })
    const source = sources.find((candidate) => candidate.id === request.id)
    if (!source || source.thumbnail.isEmpty()) return null
    let image = source.thumbnail
    let png = image.toPNG()
    if (png.length > 20 * 1024 * 1024) {
      image = image.resize({ width: Math.round(image.getSize().width / 2) })
      png = image.toPNG()
    }
    const { width, height } = image.getSize()
    return screenCaptureResultSchema.parse({
      mediaType: 'image/png',
      base64: png.toString('base64'),
      width,
      height,
    })
  })

  ipcMain.handle(IPC_CHANNELS.readPivotDefinition, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookPivotRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // Read from the session snapshot so the definition matches what the
    // renderer shows even if the file on disk changed since open.
    const [pivotXml, cacheXml] = await Promise.all([
      readArchiveEntryText(entry.client, session.snapshotPath, request.path),
      readArchiveEntryText(entry.client, session.snapshotPath, request.cachePath),
    ])
    return workbookPivotDefinitionSchema.parse(parsePivotDefinition(pivotXml, cacheXml))
  })

  ipcMain.handle(IPC_CHANNELS.readWorkbookRedactions, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookRedactionsRequestSchema.parse(input)
    const session = entry.sessions.get(request.sessionId)
    if (!session) throw new Error('Unknown workbook session.')
    // A damaged part answers `unreadable` rather than an empty list: reporting
    // "nothing is withheld" would hand the model the values it holds.
    return workbookRedactionsResultSchema.parse(
      await readWorkbookRedactionPart(entry.client, session.snapshotPath),
    )
  })

  ipcMain.handle(IPC_CHANNELS.exportPdf, async (event, input: unknown) => {
    sessionFor(event)
    const request = workbookExportPdfRequestSchema.parse(input)
    const write = async () => {
      const result = await exportPdf(event, request)
      if (!result.canceled && result.path) openGeneratedFile(result.path)
      return result
    }
    const headless = headlessOwnerWork.get(event.sender)
    // run() records the actual JS lifetime before invoking the first export
    // effect. Closed headless owners cannot admit a queued late print/write.
    if (headless) {
      if (event.sender.isDestroyed()) throw new Error('The headless spreadsheet owner is closing.')
      return headless.run(write)
    }
    return write()
  })

  ipcMain.handle(IPC_CHANNELS.printWorkbook, async (event, input: unknown) => {
    return runInteractiveSheetsPrint({
      recoveryDisabled: recoveryRuntimeState().phase === 'disabled',
      headlessOwner: headlessOwnerWork.has(event.sender),
    }, () => {
      sessionFor(event)
      return printWorkbook(event, workbookExportPdfRequestSchema.parse(input))
    })
  })

  ipcMain.handle(IPC_CHANNELS.listPrinters, async (event) => {
    sessionFor(event)
    const printers = await event.sender.getPrintersAsync()
    return printers.map((printer) =>
      printerInfoSchema.parse({
        name: printer.name,
        displayName: printer.displayName || printer.name,
      }),
    )
  })

  ipcMain.handle(IPC_CHANNELS.exportCsv, async (event, input: unknown, rawWriteContext: unknown, rawCloseTicket: unknown) => {
    const entry = sessionFor(event)
    const request = workbookExportCsvRequestSchema.parse(input)
    const closeTicket = rawCloseTicket === undefined ? undefined : isCloseLeaseTicket(rawCloseTicket) ? rawCloseTicket : null
    if (closeTicket === null) throw new Error('Invalid CSV close save ticket.')
    const writeAdmission = sheetsPromptWriteGate.admit(event.sender, parseWorkbookWriteContext(rawWriteContext), closeTicket)
    await writeAdmission.ready
    const source = sheetsSources.current(event.sender)
    // Demo/in-memory grids also export CSV. This synthetic queue key grants no
    // source/close authority; it only accounts for their exact owner's I/O.
    return runDocumentPublication(event.sender.id, source?.sessionId ?? 'csv-export', async () => {
    const assertExport = () => {
      sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      const current = sheetsSources.current(event.sender)
      if (sheetsTabs.get(event.sender.id) !== entry || sheetsSources.busy(event.sender) ||
        (source ? !current || !sameSheetsCloseSource(current, source) : current !== null))
        throw new Error('The CSV source changed before publication.')
    }
    assertExport()
    const parent = dialogParent(event)
    if (request.hasFormulas) {
      // Excel's CSV warning flow: offer keeping the formulas via .xlsx first.
      const options = {
        type: 'warning' as const,
        message: tm('csvFormulaLossMsg'),
        detail: tm('csvFormulaLossDetail'),
        buttons: [tm('csvKeepXlsxBtn'), tm('csvContinueBtn'), tm('btnCancel')],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      }
      const { response } = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options)
      assertExport()
      if (response === 0) return { canceled: true, saveAsXlsxInstead: true }
      if (response === 2) return { canceled: true }
    }
    let pickedPath = request.targetPath
    if (pickedPath === undefined) {
      const selection = await saveFileDialog(event, {
        defaultPath: request.fileName,
        filters: [{ name: tm('filterCsv'), extensions: ['csv'] }],
        ...(request.activeSheetName
          ? {
              title: tm('csvActiveSheetOnlyNotice', { name: request.activeSheetName }),
              message: tm('csvActiveSheetOnlyNotice', { name: request.activeSheetName }),
            }
          : {}),
      })
      assertExport()
      if (selection.canceled || !selection.filePath) return { canceled: true }
      pickedPath = selection.filePath
    }
    const targetPath = pickedPath.toLowerCase().endsWith('.csv') ? pickedPath : `${pickedPath}.csv`
    // Pin the main-observed chooser version before admitting preparation.
    // The renderer supplies content, never destination version authority.
    const selectedOutput = await captureSelectedSheetsOutput(targetPath, assertExport)
    await publishCapturedSheetsOutput(selectedOutput, {
      sourcePaths: source?.documentPath ? [source.documentPath] : [],
      assertCurrent: assertExport,
      prepare: async () => Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(request.content, 'utf8'),
      ]),
      afterPublished: async () => {
        // A CSV export may replace its own source; keep subsequent Save's
        // main-owned digest aligned with the completed publication.
        const writtenSha = await sha256File(targetPath).catch(() => undefined)
        if (writtenSha !== undefined) refreshCsvDigest(entry.sessions, targetPath, writtenSha)
      },
    }, (scope, actual) => runMainWorkbookPublication(event.sender, scope, actual))
    return { canceled: false, path: targetPath }
    })
  })

  // AI create_document: dialog-free — the file lands in the default save
  // folder under a unique sanitized name and opens in a new tab. xlsx/csv
  // write the renderer-serialized worksheet data here (xlsx through the same
  // CSV→xlsx conversion as CSV imports, values only); docx/pdf/md go through
  // the host-owned creator (the shell routes them into the docs flow, #960).
  ipcMain.handle(
    IPC_CHANNELS.createDocument,
    async (event, input: unknown): Promise<WorkbookCreateDocumentResult> => {
      const entry = sessionFor(event)
      const request = workbookCreateDocumentRequestSchema.parse(input)
      const source = sheetsSources.current(event.sender)
      const assertGeneratedSource = () => {
        const current = sheetsSources.current(event.sender)
        if (event.sender.isDestroyed() || sheetsTabs.get(event.sender.id) !== entry || sheetsSources.busy(event.sender) ||
          (source ? !current || !sameSheetsCloseSource(current, source) : current !== null))
          throw new Error('The spreadsheet source changed before generated output publication.')
      }
      const generatedSourcePaths = source?.documentPath ? [source.documentPath] : []
      try {
        if (request.type === 'csv') {
          const filePath = uniquePathIn(
            configuredDefaultSaveDir(app),
            `${sanitizeGeneratedFileBase(request.title)}.csv`,
          )
          // uniquePathIn is main-owned naming; a peer winning this fresh path
          // must conflict with the explicit absence expectation, never replace it.
          await publishCapturedSheetsOutput(captureFreshSheetsOutput(filePath), {
            sourcePaths: generatedSourcePaths,
            assertCurrent: assertGeneratedSource,
            prepare: async () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(request.content, 'utf8')]),
            afterPublished: () => openGeneratedFile(filePath),
          }, (scope, actual) => runMainWorkbookPublication(event.sender, scope, actual))
          return { ok: true, path: filePath }
        }
        if (request.type === 'xlsx') {
          const filePath = uniquePathIn(
            configuredDefaultSaveDir(app),
            `${sanitizeGeneratedFileBase(request.title)}.xlsx`,
          )
          await publishCapturedSheetsOutput(captureFreshSheetsOutput(filePath), {
            sourcePaths: generatedSourcePaths,
            assertCurrent: assertGeneratedSource,
            prepare: () => sheetCsvToXlsxBuffer(request.content, request.sheetName ?? 'Sheet1'),
            afterPublished: () => openGeneratedFile(filePath),
          }, (scope, actual) => runMainWorkbookPublication(event.sender, scope, actual))
          return { ok: true, path: filePath }
        }
        const create = runtime.createDocument
        if (!create) return { ok: false, error: 'Document creation is unavailable in this host.' }
        return await create({ type: request.type, title: request.title, content: request.content })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // First Save of a CSV session: Excel's "keep this format?" question. The
  // renderer remembers the answer for the file, so it is asked once.
  ipcMain.handle(IPC_CHANNELS.csvSaveConfirm, async (event, rawWriteContext: unknown, rawCloseTicket: unknown) => {
    sessionFor(event)
    const closeTicket = rawCloseTicket === undefined ? undefined : isCloseLeaseTicket(rawCloseTicket) ? rawCloseTicket : null
    if (closeTicket === null) throw new Error('Invalid CSV close save ticket.')
    const writeAdmission = sheetsPromptWriteGate.admit(event.sender, parseWorkbookWriteContext(rawWriteContext), closeTicket)
    await writeAdmission.ready
    sheetsPromptWriteGate.assert(event.sender, writeAdmission)
    const options = {
      type: 'warning' as const,
      message: tm('csvKeepFormatMsg'),
      detail: tm('csvKeepFormatDetail'),
      buttons: [tm('csvContinueBtn'), tm('csvKeepXlsxBtn'), tm('btnCancel')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    }
    const parent = dialogParent(event)
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    sheetsPromptWriteGate.assert(event.sender, writeAdmission)
    return response === 0 ? 'csv' : response === 1 ? 'xlsx' : 'cancel'
  })

  ipcMain.handle(IPC_CHANNELS.saveWorkbook, async (event, input: unknown, rawCloseTicket: unknown, rawWriteContext: unknown) => {
    const validatedRequest = workbookSaveRequestSchema.parse(input)
    if (!sessionFor(event).sessions.has(validatedRequest.sessionId)) throw new Error('Unknown workbook session.')
    const closeTicket = rawCloseTicket === undefined ? undefined : isCloseLeaseTicket(rawCloseTicket) ? rawCloseTicket : null
    if (closeTicket === null) throw new Error('Invalid workbook close save ticket.')
    const writeAdmission = sheetsPromptWriteGate.admit(event.sender, parseWorkbookWriteContext(rawWriteContext), closeTicket)
    await writeAdmission.ready
    return runDocumentPublication(event.sender.id, validatedRequest.sessionId, async () => {
      sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      const entry = sessionFor(event)
      const client = entry.client
      let request = resolveTransferredEdits(entry, validatedRequest)
      const session = entry.sessions.get(request.sessionId)
      if (!session) throw new Error('Unknown workbook session.')
      if (session.relocationPending && request.mode === 'save' && request.targetPath === undefined)
        throw new Error('The moved workbook path is not verified yet. Retry its relocation or use Save As.')
      sheetsCloseTransport.assertWriter(event.sender, closeTicket)
      const previousSource = sheetsSources.current(event.sender)
      if (!previousSource || previousSource.sessionId !== request.sessionId || sheetsSources.busy(event.sender) ||
        [...sourceOffers.values()].some(offer => offer.owner === event.sender)) throw new Error('The active source is not ready for another publication.')

      // A CSV session's plain Save keeps the CSV identity: the xlsx save lands
      // on the temp copy and the serialized csvContent is written back to the
      // original .csv afterwards.
      const csvInPlace = request.mode === 'save' && session.csvSourcePath !== undefined
      let targetPath = session.path
      let checkLoadedSource: (() => Promise<void>) | undefined
      // MCP explicit-path save (planning/mcp-server.md): dialog-free Save As to
      // an exact path with a clobber guard — docs:save-to parity. Only the xlsx
      // pipeline is reachable this way (.xlsm/.csv need their interactive flows).
      if (request.targetPath !== undefined) {
        if (request.mode !== 'save-as') throw new Error('An explicit save path needs Save As.')
        if (!isAbsolute(request.targetPath)) throw new Error('Save path must be absolute.')
        targetPath = /\.xlsx$/i.test(request.targetPath)
          ? request.targetPath
          : `${request.targetPath}.xlsx`
        // only a target the MCP layer resolved for this tab may be written without a dialog
        if (!canMcpSheetWrite(event.sender.id, targetPath)) {
          throw new Error('save target was not authorized')
        }
        if (existsSync(targetPath) && request.overwrite !== true) {
          throw new Error(`file already exists: ${targetPath}`)
        }
      } else if (request.mode === 'save' && request.quiet && session.unsavedNew) {
        // AutoSave / AI-run autosave of a workbook the user has not named yet:
        // no dialog mid-flow, the edits land in the backing temp file and the
        // session stays an unsaved new one (Ctrl+S still asks where to save)
        targetPath = session.path
      } else if (request.mode === 'save-as' || session.suggestSaveAs !== undefined) {
        // .xlsm keeps its extension: untouched archive entries (vbaProject.bin,
        // the macro-enabled content type) round-trip verbatim through the save.
        const macroEnabled = /\.xlsm$/i.test(
          session.suggestSaveAs ?? session.restoreTarget ?? session.path,
        )
        const ext = macroEnabled ? 'xlsm' : 'xlsx'
        // A name the model proposed for the reader's own request prefills the
        // dialog rather than replacing it: the reader still chooses where the
        // file goes, and cancelling still cancels. Without one, the dialog opens
        // on the name the save would have offered anyway.
        const fallbackPath =
          session.suggestSaveAs ??
          session.csvSourcePath?.replace(/\.[^.]+$/, '.xlsx') ??
          session.restoreTarget ??
          session.path
        const proposed = request.defaultName ? sanitizeAutoRenameBase(request.defaultName) : null
        const selection = await saveFileDialog(event, {
          defaultPath: proposed ? join(dirname(fallbackPath), `${proposed}.${ext}`) : fallbackPath,
          filters: macroEnabled
            ? [{ name: tm('filterXlsm'), extensions: ['xlsm'] }]
            : [
                { name: tm('filterXlsx'), extensions: ['xlsx'] },
                { name: tm('filterCsv'), extensions: ['csv'] },
              ],
          // CSV import: explain why the save goes through .xlsx (CSV keeps values only)
          ...(session.csvImport
            ? { title: tm('csvSaveAsNotice'), message: tm('csvSaveAsNotice') }
            : {}),
        })
        if (selection.canceled || !selection.filePath) return { canceled: true }
        // A CSV pick can't ride the xlsx pipeline: hand the path back so the
        // renderer serializes the active sheet through the CSV export channel.
        if (!macroEnabled && selection.filePath.toLowerCase().endsWith('.csv')) {
          return { canceled: true, csvSaveAsPath: selection.filePath }
        }
        targetPath = selection.filePath.toLowerCase().endsWith(`.${ext}`)
          ? selection.filePath
          : `${selection.filePath}.${ext}`
      } else if (session.restoreTarget !== undefined) {
        // Restored crash-recovery copy: the restore prompt was the confirmation,
        // so Save writes straight back to the original — unless someone else
        // changed it since the restore.
        targetPath = session.restoreTarget
        checkLoadedSource = async () => {
          const currentSha = await sha256File(session.restoreTarget!).catch(() => undefined)
          if (currentSha !== undefined && currentSha !== expectedWorkbookDigest(session, session.restoreTarget!, session.restoreTargetSha))
            throw new Error(tm('errDiskChanged'))
        }
      } else {
        // Plain in-place save: refuse to silently overwrite a file some other
        // program changed after this session opened it. Save As (above) skips
        // this guard on purpose — it patches the session snapshot, not the live
        // file, and writes to a path the user just confirmed, so it stays
        // usable as the escape hatch this error message points to. A file that
        // was deleted on disk is fine: saving recreates it.
        checkLoadedSource = async () => {
          const currentSha = await sha256File(session.path).catch(() => undefined)
          if (currentSha !== undefined && currentSha !== expectedWorkbookDigest(session, session.path, session.sha256))
            throw new Error(tm('errDiskChanged'))
        }
      }
      const quietUnsavedNew = targetPath === session.path && session.unsavedNew === true
      const otherPhysicalOutputs = [
        ...(csvInPlace && session.csvSourcePath !== undefined && request.csvContent !== undefined ? [session.csvSourcePath] : []),
        ...(quietUnsavedNew && session.suggestSaveAs !== undefined ? [recoveryPathFor(session.suggestSaveAs)] : []),
      ]
      return runMainWorkbookPublication(event.sender, { targetPath, sourcePaths: [session.snapshotPath,
        ...(csvInPlace && session.csvSourcePath !== undefined ? [session.csvSourcePath] : []),
        ...(materializedRecoveryDirectories.has(session.path) ? [session.path] : []),
      ] }, async lifecycle => {
      await checkLoadedSource?.()
      // The CSV write-back gets the same external-change guard as restoreTarget;
      // a deleted .csv is fine — the write recreates it.
      if (csvInPlace && session.csvSourcePath !== undefined) {
        const csvSha = await sha256File(session.csvSourcePath).catch(() => undefined)
        if (
          csvSha !== undefined &&
          csvSha !== expectedWorkbookDigest(session, session.csvSourcePath, session.csvSourceSha)
        ) {
          throw new Error(tm('errDiskChanged'))
        }
      }

      // The I/O adapter consumes the exact immutable revision acknowledged by
      // Rust, rather than a second independently interpreted renderer payload.
      const acknowledged = await checkpointDocumentForSession(
        event.sender.id,
        request.sessionId,
        session,
        request,
        { closeTicket, writeAdmission },
      )
      const pinned = documentSnapshotResponseSchema.parse(
        await completeNativeCommand(documentRecoveryClient!, { command: 'document_snapshot',
          apiVersion: 1,
          documentId: acknowledged.documentId,
          revision: acknowledged.revision,
        }, 180_000),
      )
      if (
        pinned.documentId !== acknowledged.documentId ||
        pinned.revision !== acknowledged.revision
      ) {
        throw new Error(
          'The native document snapshot does not match the acknowledged save revision.',
        )
      }
      const { editsTransferId: _consumedTransfer, ...saveOptions } = request
      request = { ...saveOptions, ...validateDocumentPayload(pinned.payload) }
      const beforePublish = async () => {
        sheetsPromptWriteGate.assert(event.sender, writeAdmission)
        if (sheetsTabs.get(event.sender.id)?.sessions.get(request.sessionId) !== session) {
          throw new Error('The workbook closed or changed before its save could be published.')
        }
        const activeSource = sheetsSources.current(event.sender)
        if (!activeSource || sheetsSources.busy(event.sender) || !sameSheetsCloseSource(activeSource, previousSource))
          throw new Error('A newer source-open operation superseded this publication.')
        const latest = documentSnapshotResponseSchema.parse(
          await completeNativeCommand(documentRecoveryClient!, { command: 'document_snapshot',
            apiVersion: 1,
            documentId: acknowledged.documentId,
          }, 180_000),
        )
        if (
          latest.documentId !== acknowledged.documentId ||
          latest.revision !== acknowledged.revision
        ) {
          throw new Error(
            'The document advanced while saving. Retry Save to include its latest changes.',
          )
        }
        if (
          request.mode === 'save' &&
          request.targetPath === undefined &&
          session.suggestSaveAs === undefined
        ) {
          const guardedPath = session.restoreTarget ?? session.path
          const expected = expectedWorkbookDigest(
            session,
            guardedPath,
            session.restoreTarget !== undefined ? session.restoreTargetSha : session.sha256,
          )
          await assertWorkbookTargetUnchanged(guardedPath, expected, tm('errDiskChanged'), sha256File)
        }
        sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      }
      const mutation = await writeWorkbookTo(client, session, request, targetPath, beforePublish)
      rememberWorkbookPublication(
        entry.sessions,
        request.sessionId,
        targetPath,
        mutation.publishedSha256,
      )

      if (csvInPlace && session.csvSourcePath !== undefined && request.csvContent !== undefined) {
        // The temp copy already holds the saved bytes: refresh the session's
        // guard digest first, so a failed CSV write-back below leaves a
        // retryable session instead of stranding the next Save on
        // errDiskChanged against its own write.
        // UTF-8 BOM so Excel decodes the reopened file correctly.
        const currentCsvSha = await sha256File(session.csvSourcePath).catch(() => undefined)
        if (
          currentCsvSha !== undefined &&
          currentCsvSha !==
            expectedWorkbookDigest(session, session.csvSourcePath, session.csvSourceSha)
        ) {
          throw new Error(tm('errDiskChanged'))
        }
        const csvBytes = Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(request.csvContent, 'utf8'),
        ])
        sheetsPromptWriteGate.assert(event.sender, writeAdmission)
        await atomicWriteFile(session.csvSourcePath, csvBytes)
        rememberWorkbookPublication(
          entry.sessions,
          request.sessionId,
          session.csvSourcePath,
          createHash('sha256').update(csvBytes).digest('hex'),
        )
      }

      // The sidecar session still streams the pre-save bytes; swap it for a
      // fresh session over the saved file so future reads match the disk state.
      const file = await openWorkbookSession(client, targetPath, entry.sessions, {
        retainExistingBaseOnFailure: true,
        ...(csvInPlace
          ? {
              csvImport: true,
              csvSourcePath: session.csvSourcePath,
              importTempDir: session.importTempDir,
            }
          : quietUnsavedNew
            ? {
                suggestSaveAs: session.suggestSaveAs,
                importTempDir: session.importTempDir,
                unsavedNew: true,
                pendingBase: true,
              }
            : {}),
        ...(session.password === undefined ? {} : { password: session.password }),
      }).catch((error: unknown) => {
        throw new Error(
          `The workbook was saved to "${targetPath}", but its replacement view could not be opened. Your edits remain available; retry Save or reopen the saved file. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      })
      // Keep the previous reader and checkpoint usable until a replacement has
      // opened successfully. Cleanup after publication cannot turn a saved file
      // into a failed save or strand the renderer on a deleted session.
      const ownedPublication = offerSavedSource(event.sender, previousSource, file, async () => {
      await releaseWorkbookReader(event.sender, request.sessionId, true,
        csvInPlace || quietUnsavedNew ? session.importTempDir : undefined)
      if (quietUnsavedNew && session.suggestSaveAs !== undefined &&
        recoveryRuntimeState().phase !== 'disabled' && !headlessOwnerWork.has(event.sender)) {
        // Keep the newly saved backing file under a fresh durable authority.
        // Its base already includes the saved changes, so do not replay the old
        // structural operations when recording its recovery checkpoint.
        // The replacement full checkpoint was acknowledged before adoption.
        // Never replay or manufacture an independent empty state here.
        // the temp path must not reach the title or recents; the recovery copy
        // is what a crash restores from, so it tracks the saved bytes
        try {
          await mkdir(recoveryDir(), { recursive: true })
          await copyFile(targetPath, recoveryPathFor(session.suggestSaveAs))
          rememberUnsavedNewRecovery(session.suggestSaveAs)
        } catch (error) {
          console.warn('[sheets] recovery copy of an unsaved new workbook failed:', error)
        }
        return
      }
      // The file on disk now carries these edits
      clearWorkbookRecovery(targetPath)
      if (session.suggestSaveAs !== undefined) {
        if (session.unsavedNew) forgetUnsavedNewRecovery(session.suggestSaveAs)
        else clearWorkbookRecovery(session.suggestSaveAs)
      }
      // Restored session saved (possibly Save As elsewhere): the unsaved work is
      // persisted, so the original's recovery copy must not re-offer it.
      if (session.restoreTarget !== undefined) clearWorkbookRecovery(session.restoreTarget)
      }, lifecycle, quietUnsavedNew ? undefined : () => workbookOpenedHook?.(
        event.sender, (csvInPlace ? session.csvSourcePath : undefined) ?? targetPath))
      return { canceled: false, file: { ...file, closeSource: ownedPublication.source },
        touchedEntries: mutation.touchedEntries, ownedPublication }
      }, otherPhysicalOutputs)
    })
  })

  // Chunked upload for edit sets too large to inline in one save request:
  // the renderer opens a transfer, streams ordered slices, then references
  // the transfer id from the save (or recovery) request that follows.
  ipcMain.handle(IPC_CHANNELS.saveEditsBegin, (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookSaveEditsBeginSchema.parse(input)
    if (!entry.sessions.has(request.sessionId)) throw new Error('Unknown workbook session.')
    entry.saveTransfers.begin(request)
  })

  ipcMain.handle(IPC_CHANNELS.saveEditsChunk, (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookSaveEditsChunkSchema.parse(input)
    // The chunk crosses the bridge and the IPC hop as a flat JSON string;
    // the edits stay untrusted input until they pass the cell-edit schema.
    entry.saveTransfers.addChunk({
      sessionId: request.sessionId,
      transferId: request.transferId,
      seq: request.seq,
      edits: saveEditsChunkArraySchema.parse(JSON.parse(request.editsJson)),
    })
  })

  // Best-effort cleanup from renderer failure paths; a no-op if the transfer
  // was already consumed or expired.
  ipcMain.handle(IPC_CHANNELS.saveEditsAbort, (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = workbookSaveEditsAbortSchema.parse(input)
    entry.saveTransfers.discard(request.transferId, request.sessionId)
  })

  // Crash-recovery copy of a dirty workbook: the same save pipeline with a
  // userData target, no session swap and no dialogs — best-effort, silent on failure.
  ipcMain.handle(
    IPC_CHANNELS.checkpointWorkbookDocument,
    async (event, input: unknown, dirty: unknown, rawBinding: unknown, rawWriteContext: unknown) => {
      if (typeof dirty !== 'boolean') throw new Error('Invalid document checkpoint state.')
      const validatedRequest = workbookSaveRequestSchema.parse(input)
      if (!sessionFor(event).sessions.has(validatedRequest.sessionId)) throw new Error('Unknown workbook session.')
      const binding = rawBinding === undefined ? undefined : rawBinding as WorkbookCloseCheckpointBinding
      if (rawBinding !== undefined && (!rawBinding || typeof rawBinding !== 'object')) throw new Error('Invalid close checkpoint binding.')
      const writeAdmission = sheetsPromptWriteGate.admit(event.sender, parseWorkbookWriteContext(rawWriteContext), binding?.ticket)
      await writeAdmission.ready
      return runDocumentPublication(event.sender.id, validatedRequest.sessionId, async () => {
      sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      const entry = sessionFor(event)
      const request = resolveTransferredEdits(entry, validatedRequest)
      const session = entry.sessions.get(request.sessionId)
      if (!session) throw new Error('Unknown workbook session.')
      if (!offeredSource(event.sender, request.sessionId)) throw new Error('The checkpoint reader is not an active or offered source.')
      if ([...sourceOffers.values()].some(offer => offer.owner === event.sender && offer.previous?.sessionId === request.sessionId))
        throw new Error('The previous reader cannot accept another checkpoint while its replacement is offered.')
      const receipt = await checkpointDocumentForSession(
        event.sender.id,
        request.sessionId,
        session,
        request,
        { dirty, writeAdmission, ...(binding ? { binding } : {}) },
      )
      const offered = [...sourceOffers.values()].some(offer => offer.owner === event.sender && offer.source.sessionId === request.sessionId)
      if (
        !dirty &&
        !binding && !offered &&
        !session.pendingBase &&
        session.restoreTarget === undefined &&
        !adoptedDocumentCandidates.has(session.path)
      ) {
        await retireDocumentSession(event.sender.id, request.sessionId, session)
        return { ...receipt, candidateId: null }
      }
      return receipt
      })
    },
  )

  ipcMain.handle(IPC_CHANNELS.writeWorkbookRecovery, async (event, input: unknown, rawWriteContext: unknown) => {
    const entry = sessionFor(event)
    if (headlessOwnerWork.has(event.sender) || recoveryRuntimeState().phase === 'disabled') return { ok: false }
    const request = resolveTransferredEdits(entry, workbookSaveRequestSchema.parse(input))
    if (!entry.sessions.has(request.sessionId)) return { ok: false }
    const writeAdmission = sheetsPromptWriteGate.admit(event.sender, parseWorkbookWriteContext(rawWriteContext))
    await writeAdmission.ready
    return runDocumentPublication(event.sender.id, request.sessionId, async () => {
    sheetsPromptWriteGate.assert(event.sender, writeAdmission)
    const session = entry.sessions.get(request.sessionId)
    // A converted import has no original file to recover into (and a CSV
    // session's original can't hold the workbook bytes); a restored recovery
    // session is backed by the recovery copy itself — writing over the file
    // the sidecar streams from would corrupt the open session.
    if (
      !session ||
      (session.suggestSaveAs !== undefined && !session.unsavedNew) ||
      session.csvSourcePath !== undefined ||
      (session.restoreTarget !== undefined && !session.emptySource)
    )
      return { ok: false }
    if (session.automaticRecoveryDisabled) return { ok: false }
    // an unsaved new workbook recovers under the name its first save would get;
    // an empty original's session runs on a temp blank and recovers into the file the user opened
    const recoveryKey = session.unsavedNew
      ? session.suggestSaveAs!
      : session.emptySource
        ? (session.restoreTarget ?? session.path)
        : session.path
    try {
      await mkdir(recoveryDir(), { recursive: true })
      sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      await writeWorkbookTo(entry.client, session, request, recoveryPathFor(recoveryKey), async () => {
        sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      })
      if (session.unsavedNew) rememberUnsavedNewRecovery(recoveryKey)
      return { ok: true }
    } catch (error) {
      console.warn('[sheets] recovery copy failed:', error)
      return { ok: false }
    }
    })
  })

  ipcMain.handle(IPC_CHANNELS.closeWorkbook, async (event, sessionId: unknown) => {
    const validatedSessionId = z.string().uuid().parse(sessionId)
    sessionFor(event)
    return runDocumentPublication(event.sender.id, validatedSessionId, async () => {
      // Reader lifetime is not an explicit discard/close receipt. Preserve ACKs.
      if (sheetsSources.current(event.sender)?.sessionId === validatedSessionId) {
        sheetsSources.destroy(event.sender)
        reportedCloseStates.delete(event.sender.id)
      }
      await releaseWorkbookReader(event.sender, validatedSessionId, false)
    })
  })

  // Content-derived naming for AI-generated workbooks (sheets' analog of slides'
  // deckName): the renderer proposes a base name after an AI run lands; the file
  // is renamed only while it still carries the shell's auto-created untitled name.
  ipcMain.handle(
    IPC_CHANNELS.autoRenameWorkbook,
    async (event, sessionId: unknown, baseName: unknown, rawWriteContext: unknown) => {
      const entry = sessionFor(event)
      const validatedSessionId = z.string().uuid().parse(sessionId)
      const session = entry.sessions.get(validatedSessionId)
      if (!session || !untitledWorkbookPaths.has(session.path)) return { renamed: false }
      const base = sanitizeAutoRenameBase(z.string().min(1).max(100).parse(baseName))
      if (!base) return { renamed: false }
      const source = sheetsSources.current(event.sender)
      if (!source || source.sessionId !== validatedSessionId) return { renamed: false }
      // Old callers of the AI naming endpoint are conservative automatic work,
      // never an implicit manual escape from a native close question.
      const writeContext = parseWorkbookWriteContext(rawWriteContext) ?? { origin: 'automatic' as const }
      const writeAdmission = sheetsPromptWriteGate.admit(event.sender, writeContext)
      const expected = knownRelocationDigest(session, session.path)
      const originalSuggestion = session.suggestSaveAs
      await writeAdmission.ready
      sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      if (activeWorkbookRenames.has(event.sender)) return { renamed: false }
      if (!sheetsCloseRuntime) throw new Error('Automatic naming requires its actual-settlement quit ledger.')
      const current = () => !event.sender.isDestroyed() && entry.sessions.get(validatedSessionId) === session &&
        !sheetsSources.busy(event.sender) && ![...sourceOffers.values()].some(offer => offer.owner === event.sender) &&
        !!sheetsSources.current(event.sender) && sameSheetsCloseSource(sheetsSources.current(event.sender)!, source)
      const priorPublications = ownerPublicationTail(event.sender)
      const priorNative = priorNativeActualWork()
      sheetsCloseCoordinator.invalidateSource(event.sender, 'owned workbook naming admitted')
      let target = session.suggestSaveAs === undefined ? join(dirname(session.path), `${base}.xlsx`) : join(dirname(session.suggestSaveAs), `${base}.xlsx`)
      const taken = (path: string) => existsSync(path) || sheetsSuggestedPathTaken(path)
      for (let i = 2; taken(target) && i < 100; i++) target = join(dirname(target), `${base}-${i}.xlsx`)
      if (taken(target) || target === (session.suggestSaveAs ?? session.path)) return { renamed: false }
      const mutation = session.suggestSaveAs === undefined
        ? reserveFileMutation([{ path: session.path, kind: 'file' }, { path: target, kind: 'file' }]) : undefined
      let moved = false, changed = false, ledgerHeld = false
      let refreshedSource: SheetsCloseSource | undefined
      const actual = Promise.resolve().then(async () => {
      if (!ledgerHeld) throw new Error('The rename actual-work hold was not registered.')
      const moveAndRefresh = async () => {
      await Promise.all([priorPublications, priorNative])
      sheetsPromptWriteGate.assert(event.sender, writeAdmission)
      if (!current()) return { renamed: false }
      let refresh: ReturnType<typeof sheetsRenameRefresh.begin> | undefined
      // An unsaved new workbook has no user-visible file to rename — it sits in
      // a temp directory that closing the tab discards. Retarget the suggested
      // Save As name instead, so the AI-derived name is what the first save
      // offers, and leave the mark in place for a later run. No rename on disk
      // and no open hook: the temp path must not reach the title or recents.
      if (originalSuggestion !== undefined) {
        const suggested = target
        await runDocumentPublication(event.sender.id, validatedSessionId, async () => {
        if (!current() || taken(suggested)) throw new Error('The proposed workbook name changed before admission.')
        // a failed move leaves the copy valid under the old name; a crash can still restore it
        if (session.unsavedNew && pendingUnsavedNewRecoveryFor(originalSuggestion) && !retargetUnsavedNewRecovery(originalSuggestion, suggested))
          throw new Error('The previous unsaved recovery name could not be retained safely.')
        entry.sessions.set(validatedSessionId, { ...session, suggestSaveAs: suggested, relocationPending: false,
          ...(!session.restoreTarget && !session.recoverySourcePath && !session.csvSourcePath ? { recoveryOriginalFingerprint: null } : {}),
          readerDisplay: { ...(session.readerDisplay ?? { path: session.path, readOnly: false }), name: basename(suggested) } })
        nativeDocumentAcks.delete(documentOwnerKey(event.sender.id, validatedSessionId)); documentCandidates.delete(documentOwnerKey(event.sender.id, validatedSessionId))
        try { await documentRecoveryService?.releaseDocument(event.sender.id, validatedSessionId) }
        catch (error) { console.warn('[sheets] Named workbook old recovery handle cleanup incomplete:', error) }
        changed = true
        const metadata: WorkbookRenamedMetadata = { sessionId: validatedSessionId,
          ...(session.readerDisplay?.path ? { path: session.readerDisplay.path } : {}),
          ...(session.csvSourcePath ? { csvPath: session.csvSourcePath } : {}), closeSource: source, requiresCheckpoint: true, writeContext }
        refreshedSource = metadata.closeSource
        refresh = sheetsRenameRefresh.begin(event.sender, basename(suggested), metadata)
        })
      } else {
        if (!expected) throw new Error('The loaded workbook has no trusted source version for a physical move.')
        await moveWorkbookExclusively(session.path, target, expected)
        moved = true
        await sheetsFileRenamed(event.sender, session.path, target, writeContext, (name, metadata) => {
          refreshedSource = metadata.closeSource
          refresh = sheetsRenameRefresh.begin(event.sender, name, metadata)
        })
        changed = true
      }
      // This wait is OUTSIDE both metadata publication queues. The renderer's
      // full checkpoint can therefore enter the same session queue and finish.
      if (!refresh) throw new Error('The renamed workbook no longer has its original renderer owner.')
      await refresh.completion
      await refresh.actualSettled
      return { renamed: true, name: basename(target), path: moved ? target : undefined, refreshComplete: true }
      }
      try {
        return mutation ? await mutation.run(moveAndRefresh) : await moveAndRefresh()
      } catch (error) {
        const currentSession = entry.sessions.get(validatedSessionId)
        if ((moved || changed) && currentSession) entry.sessions.set(validatedSessionId, { ...currentSession, relocationPending: true })
        return { renamed: moved || changed, ...(moved || changed ? { name: basename(target) } : {}), path: target,
          refreshComplete: false, error: moved ? `The file was moved to "${target}", but its complete checkpoint refresh failed. The new path was retained; use Save As or reopen it.` : String(error) }
      }
      })
      const actualSettled = actual.then(() => undefined, () => undefined)
      activeWorkbookRenames.set(event.sender, actualSettled)
      try { sheetsCloseRuntime.holdNativeUntilSettled(event.sender, actualSettled); ledgerHeld = true }
      catch (error) { mutation?.cancelPending(); activeWorkbookRenames.delete(event.sender); throw error }
      const finish = () => { if (activeWorkbookRenames.get(event.sender) === actualSettled) activeWorkbookRenames.delete(event.sender) }
      void actualSettled.then(finish)
      const result = await actual
      await actualSettled
      if (moved && 'refreshComplete' in result && result.refreshComplete && refreshedSource && !event.sender.isDestroyed() &&
        !sheetsSources.busy(event.sender) && ![...sourceOffers.values()].some(offer => offer.owner === event.sender) &&
        sheetsSources.current(event.sender) && sameSheetsCloseSource(sheetsSources.current(event.sender)!, refreshedSource)) {
        workbookOpenedHook?.(event.sender, target)
      }
      return result
    },
  )

  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, url: unknown) => {
    sessionFor(event)
    const validatedUrl = safeExternalUrl(url)
    if (!validatedUrl) {
      throw new Error('Only http(s) links can be opened.')
    }
    await shell.openExternal(validatedUrl)
  })

  // ── Chat attachments (same structure as the docs/slides files:* pipeline) ──

  ipcMain.handle(IPC_CHANNELS.filesPick, async (event): Promise<AttachmentAddResult | null> => {
    sessionFor(event)
    const selection = await openFileDialog(event, {
      title: tm('dlgAddAttachment'),
      filters: [
        { name: tm('filterSupported'), extensions: [...ATTACHMENT_EXTS] },
        { name: tm('filterAll'), extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return collectAttachments(selection.filePaths)
  })

  ipcMain.handle(IPC_CHANNELS.filesAdd, (event, paths: unknown): AttachmentAddResult => {
    sessionFor(event)
    return collectAttachments(z.array(z.string().min(1).max(1024)).max(50).parse(paths))
  })

  ipcMain.handle(
    IPC_CHANNELS.filesRead,
    async (
      event,
      filePath: unknown,
      offset: unknown,
      maxChars: unknown,
    ): Promise<AttachmentReadResult> => {
      sessionFor(event)
      const validatedPath = z.string().min(1).max(1024).parse(filePath)
      const name = basename(validatedPath)
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (!ATTACHMENT_EXTS.has(ext)) return { ok: false, error: tm('errUnsupportedExt', { ext }) }
      if (ATTACHMENT_IMAGE_EXTS.has(ext)) {
        return { ok: false, error: tm('errImageNoText') }
      }
      try {
        const text = await extractAttachmentText(validatedPath)
        const start = Math.max(0, Math.floor(Number(offset)) || 0)
        const size = Math.min(Math.max(1, Math.floor(Number(maxChars)) || 1), 48_000)
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

  // Image attachments read raw bytes → base64; the renderer puts them into the
  // user message's images for multimodal input
  ipcMain.handle(IPC_CHANNELS.filesReadImage, (event, filePath: unknown): AttachmentImageResult => {
    sessionFor(event)
    const validatedPath = z.string().min(1).max(1024).parse(filePath)
    const name = basename(validatedPath)
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = ATTACHMENT_IMAGE_MIME[ext]
    if (!mime) return { ok: false, error: `${name}: ${tm('errNotImage')}` }
    try {
      const stat = statSync(validatedPath)
      if (stat.size > ATTACHMENT_IMAGE_MAX_BYTES) {
        return { ok: false, error: `${name}: ${tm('errImageTooLarge')}` }
      }
      return { ok: true, base64: readFileSync(validatedPath).toString('base64'), mime }
    } catch {
      return { ok: false, error: `${name}: ${tm('errUnreadable')}` }
    }
  })

  // Clipboard-pasted images (screenshots and other bitmaps without a local
  // path): persisted to a temp file, then go through the regular attachment flow
  ipcMain.handle(
    IPC_CHANNELS.filesAddPastedImage,
    (event, data: unknown, ext: unknown): AttachmentAddResult => {
      sessionFor(event)
      const filePath = savePastedImage(data, ext)
      return filePath
        ? collectAttachments([filePath])
        : { accepted: [], rejected: [tm('errNotImage')] }
    },
  )
}

let aiIpcRegistered = false

export function registerSheetsAiIpc(): void {
  if (aiIpcRegistered) return
  aiIpcRegistered = true
  app.once('will-quit', shutdownCodexAppServers)

  // Node fetch (undici) direct connections get reset under VPN/tun setups; retry over Chromium's stack
  setRescueFetch((url, init) => net.fetch(url, init))
  setAiUserAgent(`Vantage/${app.getVersion()}`)

  ipcMain.handle(IPC_CHANNELS.aiGetSettings, (event): AiSettings => {
    sessionFor(event)
    const stored = readJson<Partial<AiSettings> & LegacyAiSettings>(SETTINGS_PATH(), {})
    const settings = resolveAiSettings(stored, defaultAiSettings())
    // a stored BYOK provider is honored when usable; half-filled configs fall back to genspark
    settings.provider = activeProvider(settings)
    return settings
  })

  // Genspark account (gsk login state): the auth source for AI features; the
  // frontend uses it to guide sign-in when logged out
  ipcMain.handle(
    IPC_CHANNELS.aiGskStatus,
    async (_event, withEmail?: unknown): Promise<GenSparkAccountStatus> => {
      if (!hasGskAuth()) return { loggedIn: false }
      if (!withEmail) return { loggedIn: true }
      const info = await gskLoginInfo()
      return info?.email ? { loggedIn: true, email: info.email } : { loggedIn: true }
    },
  )

  // a 401 on the gsk key opens the device-code login once (vantage-auth recovery)
  setVantageLoginOpener((url) => void shell.openExternal(url))

  ipcMain.handle(IPC_CHANNELS.aiGskLogin, () => {
    ensureVantageLogin((url) => void shell.openExternal(url))
  })

  ipcMain.handle(IPC_CHANNELS.aiSetSettings, async (event, input: unknown) => {
    sessionFor(event)
    const settings = aiSettingsInputSchema.parse(input)
    writeJsonAtomic(SETTINGS_PATH(), settings)
    for (const wc of webContents.getAllWebContents())
      if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.aiSettingsChanged)
  })

  ipcMain.handle(IPC_CHANNELS.aiChat, async (event, input: unknown) => {
    sessionFor(event)
    const request = aiChatRequestSchema.parse(input)
    const provider = request.settings.provider as AiProviderId
    let config = request.settings.providers[provider]
    // set only when the gsk key was injected: a 401 then means that key expired
    let gskKey = ''
    if (provider === 'genspark' && config && !config.apiKey) {
      gskKey = gskApiKey()
      config = { ...config, apiKey: gskKey }
    }
    // a custom endpoint may name an environment variable instead of storing a key
    config = config ? resolveProfileCredential(config) : config
    if (!config || (provider !== 'codex' && !config.apiKey)) {
      return {
        ok: false,
        error: provider === 'genspark' ? tm('errGskNotLoggedIn') : tm('errNoApiKey', { provider }),
      }
    }
    if (provider !== 'codex' && !config.model) return { ok: false, error: tm('errNoModel') }
    try {
      const result = await chatForProvider(provider, config, request.system, request.user)
      // the one-shot path reports HTTP failures as ok:false with the raw body —
      // replace capacity/rate-limit dumps with the localized "busy" message
      if (!result.ok && isAiOverloadedError(result.error)) {
        return { ok: false, error: tm('errAiBusy') }
      }
      if (!result.ok && isAiRegionBlockedError(result.error)) {
        return { ok: false, error: tm('errAiRegion') }
      }
      if (!result.ok) noteGskCallFailure(gskKey, result.error)
      return result
    } catch (err) {
      noteGskCallFailure(gskKey, err)
      return {
        ok: false,
        error: isAiOverloadedError(err)
          ? tm('errAiBusy')
          : isAiRegionBlockedError(err)
            ? tm('errAiRegion')
            : String(err),
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.aiStream, async (event, input: unknown) => {
    const entry = sessionFor(event)
    const request = aiStreamRequestSchema.parse(input)
    const { requestId, system, messages } = request
    const tools = request.tools ?? []
    const maxTokens = request.maxTokens ?? maxOutputTokensOf(request.settings)
    const provider = request.settings.provider as AiProviderId
    let config = request.settings.providers[provider]
    // Genspark's key never enters the settings file; it is read from the gsk
    // login state per request
    // set only when the gsk key was injected: a 401 then means that key expired
    let gskKey = ''
    if (provider === 'genspark' && config && !config.apiKey) {
      gskKey = gskApiKey()
      config = { ...config, apiKey: gskKey }
    }
    // a custom endpoint may name an environment variable instead of storing a key
    config = config ? resolveProfileCredential(config) : config
    const send = (chunk: AiStreamChunk) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.aiStreamChunk, chunk)
    }
    if (!config || (provider !== 'codex' && !config.apiKey)) {
      send({
        requestId,
        type: 'error',
        error: provider === 'genspark' ? tm('errGskNotLoggedIn') : tm('errNoApiKey', { provider }),
      })
      return
    }
    if (provider !== 'codex' && !config.model) {
      send({ requestId, type: 'error', error: tm('errNoModel') })
      return
    }
    const controller = new AbortController()
    entry.aiStreams.set(requestId, controller)
    const unwatchSender = abortOnDestroyed(event.sender, controller)
    // wire-activity keepalive: lets the renderer's silence watchdog tell a slow turn from a dead one
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 5_000) return
      lastPing = now
      send({ requestId, type: 'ping' })
    }
    try {
      let stopReason: string | undefined
      await streamForProvider(provider, config, system, messages, tools, maxTokens, {
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        signal: controller.signal,
        onDelta: (text) => send({ requestId, type: 'delta', text }),
        onReasoningDelta: (text) => send({ requestId, type: 'reasoning', text }),
        onToolCall: (toolCall) => send({ requestId, type: 'tool-call', toolCall }),
        onActivity: ping,
        onStopReason: (reason) => {
          stopReason = reason
        },
        onUsage: (usage) => send({ requestId, type: 'usage', usage }),
      })
      // sheets tsconfig sets exactOptionalPropertyTypes: an explicit
      // `stopReason: undefined` is not assignable to AiStreamChunk, so only
      // include the property when a reason was actually reported.
      send(
        stopReason === undefined
          ? { requestId, type: 'done' }
          : { requestId, type: 'done', stopReason },
      )
    } catch (err) {
      if (controller.signal.aborted) {
        send({ requestId, type: 'done' })
      } else {
        // an expired/revoked key drops to signed-out so the inline sign-in button shows
        noteGskCallFailure(gskKey, err)
        send({
          requestId,
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof AiTimeoutError
            ? { errorCode: 'timeout' as const }
            : err instanceof AiCreditsError
              ? { errorCode: 'credits' as const }
              : isAiNetworkError(err)
                ? { errorCode: 'network' as const }
                : isAiOverloadedError(err)
                  ? { errorCode: 'overloaded' as const }
                  : isAiRegionBlockedError(err)
                    ? { errorCode: 'region' as const }
                    : {}),
        })
      }
    } finally {
      unwatchSender()
      entry.aiStreams.delete(requestId)
    }
  })

  ipcMain.handle(IPC_CHANNELS.aiStreamCancel, (event, requestId: unknown) => {
    const entry = sessionFor(event)
    entry.aiStreams.get(z.string().min(1).parse(requestId))?.abort()
  })

  // Shared search tools (content + images): Serper with DuckDuckGo fallback
  // (same source as slides/docs)
  ipcMain.handle('ai:web-search', async (_event, query: unknown, maxResults?: unknown) => {
    try {
      return await webSearchTool(
        SETTINGS_PATH(),
        z.string().parse(query),
        typeof maxResults === 'number' ? maxResults : 6,
      )
    } catch (err) {
      return { results: [], method: 'error', error: String(err) }
    }
  })
  ipcMain.handle('ai:image-search', async (_event, query: unknown, maxResults?: unknown) => {
    try {
      return await imageSearchTool(
        SETTINGS_PATH(),
        z.string().parse(query),
        typeof maxResults === 'number' ? maxResults : 8,
      )
    } catch (err) {
      return { images: [], method: 'error', error: String(err) }
    }
  })

  // Standalone parity with docs-main's shell-wide handler: AI-supplied URLs are
  // prompt-injectable, so fetchRemoteImage refuses non-http schemes and
  // private/link-local targets and validates every redirect hop. Size-capped to
  // match the local add_image limit.
  ipcMain.handle(
    'ai:fetch-image',
    async (_event, url: unknown): Promise<{ base64: string; mime: string } | null> => {
      try {
        const resp = await fetchRemoteImage(z.string().parse(url))
        if (!resp || !resp.ok || !resp.body) return null
        const declared = Number(resp.headers.get('content-length') ?? 0)
        if (declared > MAX_REMOTE_IMAGE_BYTES) return null
        // Stream with a running cap: a missing/understated Content-Length must
        // not let a prompt-injected URL buffer unbounded bytes before a
        // post-hoc size check
        const reader = resp.body.getReader()
        const chunks: Buffer[] = []
        let received = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > MAX_REMOTE_IMAGE_BYTES) {
            await reader.cancel()
            return null
          }
          chunks.push(Buffer.from(value))
        }
        const buf = Buffer.concat(chunks)
        const ct = resp.headers.get('content-type') ?? ''
        const mime = ct.includes('png')
          ? 'image/png'
          : ct.includes('gif')
            ? 'image/gif'
            : 'image/jpeg'
        return { base64: buf.toString('base64'), mime }
      } catch {
        return null
      }
    },
  )
}

// ── project-store IPC (standalone mode) ────────────────────────────────────
// In shell mode docs-main.registerProjectIpc has already registered it
// (idempotency guard).

let sheetsProjectStore: ProjectStore | null = null
let sheetsProjectIpcRegistered = false

function getSheetsProjectStore(): ProjectStore {
  if (!sheetsProjectStore) sheetsProjectStore = new ProjectStore(app.getPath('userData'))
  return sheetsProjectStore
}

export function registerProjectIpc(): void {
  if (sheetsProjectIpcRegistered) return
  sheetsProjectIpcRegistered = true

  ipcMain.handle(
    'project:resolveChat',
    (event, args: { filePath: string | null; tempChatId?: string; sessionId?: string }) => {
      const store = getSheetsProjectStore()
      store.ensureDefaultProject()

      // sheets mode: reverse-look up the file path via sessionId
      let resolvedPath = args.filePath
      if (!resolvedPath && args.sessionId) {
        const tabEntry = sheetsTabs.get(event.sender.id)
        if (tabEntry) {
          resolvedPath = tabEntry.sessions.get(args.sessionId)?.path ?? null
        }
      }

      if (!resolvedPath) {
        return { projectId: 'default', chatId: args.tempChatId ?? `unsaved-${Date.now()}` }
      }
      return store.resolveChatForFile(resolvedPath)
    },
  )

  ipcMain.handle(
    'project:appendChat',
    (
      _event,
      args: {
        projectId: string
        chatId: string
        role: 'user' | 'assistant'
        text: string
        tools?: Array<{
          name: string
          summary: string
          isError?: boolean
          input?: string
          output?: string
        }>
        attachments?: Array<{ name: string; path?: string; ext?: string; sizeBytes?: number }>
        scope?: { label: string; text?: string }
      },
    ) => {
      if (args.role !== 'user' && args.role !== 'assistant') {
        throw new Error(`Invalid chat role: ${String(args.role)}`)
      }
      if (typeof args.text !== 'string' || args.text.length > 200_000) {
        throw new Error('Invalid chat text: must be a string up to 200000 chars')
      }
      if (args.tools && !Array.isArray(args.tools)) throw new Error('Invalid chat tools')
      if (args.attachments && !Array.isArray(args.attachments)) {
        throw new Error('Invalid chat attachments')
      }
      const msg: Parameters<ProjectStore['appendChatMessage']>[2] = {
        role: args.role,
        text: args.text,
      }
      if (args.tools) msg.tools = args.tools
      if (args.attachments) msg.attachments = args.attachments
      if (args.scope) msg.scope = args.scope

      getSheetsProjectStore().appendChatMessage(args.projectId, args.chatId, msg)
    },
  )

  ipcMain.handle(
    'project:loadChat',
    (_event, args: { projectId: string; chatId: string; limit?: number }) => {
      return getSheetsProjectStore().loadChat(args.projectId, args.chatId, args.limit ?? 200)
    },
  )

  ipcMain.handle(
    'project:rebindChat',
    (
      event,
      args: {
        projectId: string
        tempChatId: string
        newChatId?: string
        newFilePath?: string
        sessionId?: string
      },
    ) => {
      const store = getSheetsProjectStore()
      let path = args.newFilePath ?? null
      if (!path && args.sessionId) {
        path = resolveSheetsSessionPath(event.sender.id, args.sessionId)
      }
      if (path) {
        return store.rebindChatToFile(args.projectId, args.tempChatId, path)
      }
      if (args.newChatId) store.rebindChat(args.projectId, args.tempChatId, args.newChatId)
      return { projectId: args.projectId, chatId: args.newChatId ?? args.tempChatId }
    },
  )
}

/**
 * sessionId → workbook file path reverse lookup (injected into docs-main's
 * project:resolveChat in shell mode). In standalone mode the handler registered
 * above queries sheetsTabs directly.
 */
export function resolveSheetsSessionPath(senderId: number, sessionId: string): string | null {
  return sheetsTabs.get(senderId)?.sessions.get(sessionId)?.path ?? null
}

/**
 * Resolve a save request's sheet ops / name mappings and write the workbook through
 * the sidecar. Split out of the save handler so a crash-recovery copy can reuse the
 * exact same pipeline with a different targetPath.
 */
async function writeWorkbookTo(
  client: XlsxSidecarClient,
  session: SessionInfo,
  request: WorkbookSaveRequest,
  targetPath: string,
  beforePublish?: () => Promise<void>,
): Promise<Awaited<ReturnType<typeof saveWorkbookViaSidecar>> & { publishedSha256: string }> {
  type PhaseSession = DocumentWriteSession & { nativeSessionId?: string }
  return withAtomicSaveQueue(targetPath, () => withFilePublication({ targetPath, sourcePaths: [session.snapshotPath] }, async () => {
    const privateRoot = await getSessionSnapshotDirectory()
    const readyDirectory = await mkdtemp(join(privateRoot, 'document-publish-'))
    const readyPath = join(readyDirectory, 'complete.bin')
    let readyStarted = false
    try {
    return await withFilePublication({ targetPath: readyPath, sourcePaths: [session.snapshotPath] }, async () => {
    readyStarted = true
    try {
      const mutation = await writeDocumentSavePipeline<
        PhaseSession,
        Awaited<ReturnType<typeof saveWorkbookViaSidecar>>
      >({
        sheetNames: (phase) => phase.sheetNames,
        session,
        request,
        targetPath: readyPath,
        write: (base, payload, target) =>
          writeWorkbookDocumentPackage({
            client,
            session: { ...base, password: undefined },
            request: payload,
            targetPath: target,
            tempRoot: privateRoot,
            verifyPreservation: false,
            encryptOoxml,
            atomicWriteFile,
            withNativeSaveRecovery,
          }),
        allocatePhase: async () => {
          const directory = await mkdtemp(join(privateRoot, 'document-phase-'))
          const path = join(directory, 'phase.bin')
          return {
            path,
            cleanup: async () => {
              await rm(path, { force: true })
              await rmdir(directory)
            },
          }
        },
        openPhase: async (path) => {
          const opened = sidecarOpenResultSchema.parse(
            await completeNativeCommand(client, { command: 'open', path, locale: getUiLang(), shortDateFormat: systemShortDate() }),
          )
          return {
            snapshotPath: path,
            sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
            nativeSessionId: opened.sessionId,
          }
        },
        closePhase: async (phase) => {
          if (phase.nativeSessionId) await client.closeSettled(phase.nativeSessionId)
        },
        combineResults: (first, last) => ({
          ...last,
          touchedEntries: [...new Set([...first.touchedEntries, ...last.touchedEntries])],
          addedEntries: [...new Set([...first.addedEntries, ...last.addedEntries])],
          removedEntries: [...new Set([...first.removedEntries, ...last.removedEntries])],
        }),
      })
      const report = (await completeNativeCommand(client, { command: 'audit_preservation',
        sourcePath: session.snapshotPath,
        targetPath: readyPath,
        allowedChangedEntries: [
          ...new Set([
            ...mutation.touchedEntries,
            ...mutation.addedEntries,
            ...mutation.removedEntries,
          ]),
        ],
      }, 180_000)) as { preserved?: unknown; violations?: readonly { message?: string }[] }
      if (
        report?.preserved !== true ||
        !Array.isArray(report.violations) ||
        report.violations.length !== 0
      )
        throw new Error(
          report?.violations
            ?.map((item) => item.message)
            .filter(Boolean)
            .join(' ') || 'Workbook package preservation verification failed.',
        )
      // Encode first, then recheck the input revision and file version just
      // before publishing. A bad plan can never reach the user's destination.
      const encrypted =
        session.password === undefined
          ? undefined
          : encryptOoxml(await readFile(readyPath), session.password)
      const publishedSha256 =
        encrypted === undefined
          ? await sha256File(readyPath)
          : createHash('sha256').update(encrypted).digest('hex')
      await beforePublish?.()
      // Reserve the physical output and actual copy input across the final
      // version check, recovery wrapper and complete JS filesystem publisher.
      // Shared atomic writers may nest under this same-target reservation.
      await withFilePublication({ targetPath, sourcePaths: [readyPath] }, () => withNativeSaveRecovery(targetPath, async () => {
        await beforePublish?.()
        if (encrypted !== undefined) await atomicWriteFile(targetPath, encrypted)
        else await atomicCopyFile(readyPath, targetPath)
      }))
      return { ...mutation, publishedSha256 }
    } finally {
      await rm(readyPath, { force: true }).catch(() => undefined)
      await rmdir(readyDirectory).catch(() => undefined)
    }
    })
    } catch (error) {
      // No native/package body began if the private-output reservation refused.
      // Remove only our still-empty new directory; never guess at file ownership.
      if (!readyStarted) await rmdir(readyDirectory).catch(() => undefined)
      throw error
    }
  }))
}

let sessionSnapshotDirectoryPromise: Promise<string> | undefined

/** Create a private per-process snapshot directory and sweep abandoned sessions. */
async function createSessionSnapshotDirectory(): Promise<string> {
  return allocateSessionSnapshotDirectory(app.getPath('temp'))
}

async function getSessionSnapshotDirectory(): Promise<string> {
  if (!sessionSnapshotDirectoryPromise) {
    sessionSnapshotDirectoryPromise = createSessionSnapshotDirectory().catch((error: unknown) => {
      sessionSnapshotDirectoryPromise = undefined
      throw error
    })
  }
  return sessionSnapshotDirectoryPromise
}

/** Header sniff only: an encrypted workbook is a CFB container, a plain one a zip. */
async function isCfbWorkbookFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(8)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return isCfbFile(header.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/** Snapshot bytes in a private temporary directory; this is the session's
 * save base (see SessionInfo.snapshotPath). */
async function snapshotWorkbook(path: string, bytes?: Buffer): Promise<string> {
  const dir = await getSessionSnapshotDirectory()
  const snapshotPath = join(dir, `${randomUUID()}.xlsx`)
  if (bytes) await writeFile(snapshotPath, bytes, { mode: 0o600 })
  else await copyFile(path, snapshotPath)
  return snapshotPath
}

let cachedShortDate: string | undefined

/// Derived from the OS region (not the UI language) and shared with the
/// gateway's save-side numFmtId mapping via setSystemShortDate.
function systemShortDate(): string {
  if (cachedShortDate === undefined) {
    cachedShortDate = shortDatePatternForSystemLocale(app.getSystemLocale())
    setSystemShortDate(cachedShortDate)
  }
  return cachedShortDate
}

/** the tab died between prepare and open: release the temp copy and any name reserved for it */
async function discardPreparedOpen(prepared: {
  openPath: string
  importTempDir?: string | undefined
}): Promise<void> {
  unsavedNewWorkbooks.delete(prepared.openPath)
  await releasePreparedDocumentRecovery(prepared.openPath)
  if (prepared.importTempDir !== undefined)
    await cleanupImportTempDirectory(app.getPath('temp'), prepared.importTempDir)
}

/** Release an unused materialized view; the durable recovery candidate survives. */
async function releasePreparedDocumentRecovery(path: string): Promise<void> {
  adoptedDocumentCandidates.delete(path)
  const directory = materializedRecoveryDirectories.get(path)
  materializedRecoveryDirectories.delete(path)
  materializedRecoveryNames.delete(path)
  if (directory) {
    await rm(path, { force: true }).catch((error) =>
      console.warn('[sheets] Recovery view cleanup failed:', error),
    )
    await rmdir(directory).catch(() => undefined)
  }
}

async function openWorkbookSession(
  client: XlsxSidecarClient,
  path: string,
  sessions: Map<string, SessionInfo>,
  options?: {
    suggestSaveAs?: string | undefined
    csvImport?: boolean | undefined
    csvSourcePath?: string | undefined
    recoverySourcePath?: string | undefined
    recoverySourceSha?: string | undefined
    emptyCsv?: boolean | undefined
    importTempDir?: string | undefined
    restoreTarget?: string | undefined
    emptySource?: boolean | undefined
    unsavedNew?: boolean | undefined
    pendingBase?: boolean | undefined
    password?: string | undefined
    /** A save replacement shares the existing session's backing resources. */
    retainExistingBaseOnFailure?: boolean | undefined
    /** Recovery refusal must not overwrite or close an existing reader UUID. */
    preserveExistingReaderIds?: boolean | undefined
    /** Headless staging may be removed only after a failed reader close has actual exit proof. */
    requireExitOnCloseFailure?: boolean | undefined
  },
): Promise<WorkbookFile> {
  const {
    suggestSaveAs,
    csvImport,
    csvSourcePath,
    recoverySourcePath,
    recoverySourceSha,
    emptyCsv,
    importTempDir,
    restoreTarget,
    emptySource,
    unsavedNew,
    pendingBase,
    password,
    retainExistingBaseOnFailure,
    preserveExistingReaderIds,
    requireExitOnCloseFailure,
  } = options ?? {}
  // Only a CFB container (the encrypted wrapper) is read into memory; a plain
  // zip package keeps the streamed copy + file digest so large workbooks do
  // not double their footprint at open.
  const sourceBytes = (await isCfbWorkbookFile(path)) ? await readFile(path) : undefined
  const encryptedBytes = sourceBytes && isEncryptedOoxml(sourceBytes) ? sourceBytes : undefined
  const encrypted = encryptedBytes !== undefined
  if (encryptedBytes && password === undefined) {
    throw new Error('This workbook is password-protected. PASSWORD_REQUIRED')
  }
  const snapshotBytes = encryptedBytes ? await decryptOoxml(encryptedBytes, password!) : undefined
  // Snapshot first, then the sidecar opens the snapshot (not the live path):
  // everything the session serves — cell reads, media, recalc, saves — comes
  // from the same bytes, even if the file on disk changes right after the
  // copy. The digest also describes exactly those bytes.
  const snapshotPath = await snapshotWorkbook(path, snapshotBytes)
  let openedSessionId: string | undefined
  let conflictingReaderId = false
  try {
    const snapshotDigest = sha256File(snapshotPath)
    const [digest, fileBytes, restoreTargetSha, csvSourceSha, nativeDigest] = await Promise.all([
      sourceBytes
        ? createHash('sha256').update(sourceBytes).digest('hex')
        : snapshotDigest,
      sourceBytes ? sourceBytes.byteLength : stat(snapshotPath).then((s) => s.size),
      // Missing original (deleted since the crash) is fine: the write-back recreates it.
      restoreTarget === undefined
        ? Promise.resolve(undefined)
        : sha256File(restoreTarget)
            .catch(() => undefined)
            .then((value) => {
              if (
                recoverySourcePath === restoreTarget &&
                value !== undefined &&
                value !== recoverySourceSha
              ) {
                throw new Error(tm('errDiskChanged'))
              }
              return recoverySourcePath === restoreTarget ? recoverySourceSha : value
            }),
      csvSourcePath === undefined
        ? Promise.resolve(undefined)
        : sha256File(csvSourcePath).then((value) => {
            if (
              recoverySourcePath === csvSourcePath &&
              recoverySourceSha !== undefined &&
              value !== recoverySourceSha
            ) {
              throw new Error(tm('errDiskChanged'))
            }
            return value
          }),
      snapshotDigest,
    ])
    const rawOpened = await completeNativeCommand(client, { command: 'open', path: snapshotPath, locale: getUiLang(), shortDateFormat: systemShortDate() })
    const openingIdentity = z.object({ sessionId: z.string().uuid() }).safeParse(rawOpened)
    if (openingIdentity.success) openedSessionId = openingIdentity.data.sessionId
    const opened = sidecarOpenResultSchema.parse(rawOpened)
    openedSessionId = opened.sessionId
    if (preserveExistingReaderIds && sessions.has(opened.sessionId)) {
      conflictingReaderId = true
      throw new Error('Reader recovery refused a reused native reader UUID; the previous source was retained.')
    }
    sessions.set(opened.sessionId, {
      path,
      snapshotPath,
      sha256: digest,
      nativeSourceFingerprint: `sha256:${nativeDigest}`,
      sheetNames: new Map(opened.sheets.map((sheet) => [sheet.id, sheet.name])),
      automaticRecoveryDisabled: !allowsAutomaticWorkbookRecovery(opened.sheets),
      ...(encrypted ? { password: password! } : {}),
      ...(suggestSaveAs === undefined ? {} : { suggestSaveAs }),
      ...(csvImport ? { csvImport } : {}),
      ...(csvSourcePath === undefined ? {} : { csvSourcePath }),
      ...(csvSourceSha === undefined ? {} : { csvSourceSha }),
      ...(recoverySourcePath === undefined ? {} : { recoverySourcePath }),
      ...(recoverySourceSha === undefined ? {} : { recoverySourceSha }),
      ...(importTempDir === undefined ? {} : { importTempDir }),
      ...(restoreTarget === undefined ? {} : { restoreTarget }),
      ...(restoreTargetSha === undefined ? {} : { restoreTargetSha }),
      ...(emptySource ? { emptySource } : {}),
      ...(unsavedNew ? { unsavedNew } : {}),
      ...(pendingBase ? { pendingBase } : {}),
    })
    unsavedNewWorkbooks.delete(path)
    const file = workbookFileSchema.parse({
      ...opened,
      // The renderer-facing path is what the user opened: for a restored
      // recovery copy that is the original file, not the copy under userData.
      path: restoreTarget ?? materializedRecoveryNames.get(path) ?? path,
      ...(materializedRecoveryNames.has(path)
        ? { name: basename(materializedRecoveryNames.get(path)!) }
        : {}),
      sha256: digest,
      fileBytes,
      readOnly: false,
      needsSaveAs: suggestSaveAs !== undefined,
      passwordProtected: encrypted,
      ...(unsavedNew ? { unsavedNew: true } : {}),
      ...(csvSourcePath === undefined ? {} : { csvPath: csvSourcePath }),
      ...(emptyCsv ? { emptyCsv: true } : {}),
      restoredFromRecovery:
        restoreTarget !== undefined || pendingBase === true || adoptedDocumentCandidates.has(path),
      automaticRecoveryDisabled: !allowsAutomaticWorkbookRecovery(opened.sheets),
    })
    const session = sessions.get(opened.sessionId)!
    sessions.set(opened.sessionId, { ...session, readerDisplay: captureReaderDisplay(file) })
    return file
  } catch (error) {
    if (openedSessionId !== undefined && !conflictingReaderId) {
      sessions.delete(openedSessionId)
      await client.closeSettled(openedSessionId).catch(async () => {
        if (requireExitOnCloseFailure) await client.stopSettled()
      })
    }
    await rm(snapshotPath, { force: true }).catch(() => undefined)
    if (!retainExistingBaseOnFailure) await releasePreparedDocumentRecovery(path)
    unsavedNewWorkbooks.delete(path)
    if (importTempDir !== undefined && !retainExistingBaseOnFailure) {
      await cleanupImportTempDirectory(app.getPath('temp'), importTempDir)
    }
    throw error
  }
}

/// A 0-byte .xlsx is an empty workbook, not a corrupt one. The sidecar needs a
/// real archive, so a blank one opens from the temp dir with the original as
/// the write-back target (the restore path: Save writes it even with no edits).
async function openEmptyXlsx(path: string): Promise<{
  openPath: string
  importTempDir: string
  restoreTarget: string
  emptySource: true
}> {
  const directory = join(app.getPath('temp'), 'vantage-imports', randomUUID())
  await mkdir(directory, { recursive: true })
  const openPath = join(directory, basename(path))
  try {
    await writeFile(openPath, (await csvToXlsxBufferForOpen('', 'Sheet1')).buffer)
  } catch (error) {
    await cleanupImportTempDirectory(app.getPath('temp'), directory)
    throw error
  }
  return { openPath, importTempDir: directory, restoreTarget: path, emptySource: true }
}

/** which legacy charset an Excel CSV most likely uses, judged by the UI language */
function legacyCsvCharset(): string | undefined {
  const byLang: Partial<Record<Lang, string>> = {
    zh: 'gb18030',
    'zh-TW': 'big5',
    ja: 'shift_jis',
    ko: 'euc-kr',
  }
  return byLang[getUiLang()]
}

/**
 * Confirm an .ods/.ots import before it converts. Unlike .xls, the loss here is not
 * "what the editor did not touch survives": reading ODF re-enters the workbook
 * model as a brand-new .xlsx, so styles beyond date formats are dropped by
 * construction. Returns false when the user declines, which cancels the open.
 * Batch opens pass skipRecoveryPrompt and never reach this.
 */
async function promptOdsImport(
  parent: BrowserWindow | undefined,
  extension: string,
): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    message: tm('odsImportMsg', { ext: extension }),
    detail: tm('odsImportDetail'),
    buttons: [tm('odsImportConvertBtn'), tm('btnCancel')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return response === 0
}

/// .xls, .tsv and the ODF imports (.ods/.ots) open as a converted copy in the temp dir; the session
/// remembers the original's .xlsx sibling as the Save As default. .csv converts
/// the same way but keeps its file identity, so Save writes values back to it.
async function prepareWorkbookForOpen(
  client: XlsxSidecarClient,
  path: string,
  contents?: WebContents | undefined,
  parent?: BrowserWindow | undefined,
  options?: { skipRecoveryPrompt?: boolean },
): Promise<{
  openPath: string
  suggestSaveAs?: string
  csvImport?: boolean
  csvSourcePath?: string
  recoverySourcePath?: string
  recoverySourceSha?: string
  emptyCsv?: boolean
  importTempDir?: string
  restoreTarget?: string
  emptySource?: boolean
  unsavedNew?: boolean
} | null> {
  // A shell-created "New spreadsheet" opens from a temp directory and has no
  // user-visible file yet: Save As produces it, and closing unsaved discards
  // the directory. The mark is consumed once the session exists (see
  // openWorkbookSession) so the name stays reserved through the open and a
  // reopened path is a normal file.
  const unsavedNew = unsavedNewWorkbooks.get(path)
  const nativeRecovery: Awaited<ReturnType<typeof nativeDocumentRecoveryForOpen>> =
    options?.skipRecoveryPrompt
      ? { handled: false }
      : await nativeDocumentRecoveryForOpen(
          client,
          unsavedNew?.suggestSaveAs ?? path,
          contents,
          parent,
          unsavedNew ? path : undefined,
        )
  if (unsavedNew !== undefined) {
    const base = {
      suggestSaveAs: unsavedNew.suggestSaveAs,
      importTempDir: unsavedNew.tempDir,
      unsavedNew: true,
    }
    if (nativeRecovery.prepared) return { ...nativeRecovery.prepared, ...base }
    // a crash left work under this would-be name: offer it like a file's
    // recovery copy, opening the copy itself as the (still unsaved) workbook
    const recovery = nativeRecovery.handled
      ? null
      : pendingUnsavedNewRecoveryFor(unsavedNew.suggestSaveAs)
    if (recovery) {
      const choice =
        contents && !contents.isDestroyed()
          ? await promptRecoveryRestore(contents, unsavedNew.suggestSaveAs, recovery, false)
          : await promptRecoveryRestoreNative(unsavedNew.suggestSaveAs, recovery, parent, false)
      // the copy is what the recovery writer keeps overwriting, so the session
      // streams from the backing file, not from the copy
      if (choice === 'restore') {
        try {
          await copyFile(recovery, path)
        } catch (error) {
          await discardPreparedOpen({ openPath: path, importTempDir: unsavedNew.tempDir })
          throw error
        }
      } else if (choice === 'discard') forgetUnsavedNewRecovery(unsavedNew.suggestSaveAs)
    }
    return { openPath: path, ...base }
  }
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (nativeRecovery.prepared) return nativeRecovery.prepared
  // ODF has no editable representation here at all (.ots is the same package
  // with a -template mimetype): the user confirms the lossy .xlsx copy first,
  // and declining leaves the file unopened and unwritten.
  const odfImport = extension === 'ods' || extension === 'ots'
  if (odfImport && !options?.skipRecoveryPrompt && !(await promptOdsImport(parent, extension))) {
    return null
  }
  if (!odfImport && extension !== 'csv' && extension !== 'tsv' && extension !== 'xls') {
    // Unsaved work from a lost session: offer the recovery copy. Restoring
    // opens it with restoreTarget pointing back at the original, so a plain
    // Save writes straight back over the file the user opened — the restore
    // prompt (which spells out the overwrite) was the confirmation.
    // Merge sources are read-only picks: never surface (or worse, discard)
    // another workbook's crash recovery from here.
    const recovery =
      options?.skipRecoveryPrompt || nativeRecovery.handled ? undefined : pendingRecoveryFor(path)
    if (recovery) {
      const choice =
        contents && !contents.isDestroyed()
          ? await promptRecoveryRestore(contents, path, recovery)
          : await promptRecoveryRestoreNative(path, recovery, parent)
      if (choice === 'restore') return { openPath: recovery, restoreTarget: path }
      if (choice === 'discard') clearWorkbookRecovery(path)
    }
    if (extension === 'xlsx' && (await stat(path)).size === 0) return openEmptyXlsx(path)
    return { openPath: path }
  }
  const stem = basename(path).replace(/\.[^.]+$/, '')
  const recoverySourceSha = await sha256File(path)
  const directory = join(app.getPath('temp'), 'vantage-imports', randomUUID())
  await mkdir(directory, { recursive: true })
  const openPath = join(directory, `${stem}.xlsx`)
  let emptyCsv = false
  try {
    if (extension === 'csv' || extension === 'tsv') {
      const csvStat = await stat(path)
      if (csvStat.size > MAX_DELIMITED_IMPORT_BYTES) throw new Error(tm('errFileTooLarge'))
      const converted = await csvToXlsxBufferForOpen(
        decodeCsvBuffer(await readFile(path), legacyCsvCharset()),
        'Sheet1',
        // A .tsv's delimiter is declared by its extension, and sniffing by
        // frequency can get it wrong: annotation-heavy exports (gene
        // descriptions, database cross-references) hold comma-separated
        // lists, so a narrow table ends up with more commas than tabs and
        // every row shatters on the comma. A .csv keeps the sniff — the prose
        // guard in resolveImportDelimiter is what that path needs.
        extension === 'tsv' ? '\t' : undefined,
      )
      emptyCsv = converted.empty
      await writeFile(openPath, converted.buffer)
    } else {
      await client.convertWorkbook({ path, targetPath: openPath })
    }
    if ((await sha256File(path)) !== recoverySourceSha) throw new Error(tm('errDiskChanged'))
  } catch (error) {
    await cleanupImportTempDirectory(app.getPath('temp'), directory)
    throw error
  }
  // CSV keeps its file identity: Save writes the values back to the original
  // .csv (Excel's behavior), so no Save As detour is suggested. Legacy .xls and
  // view-only .tsv route the first save through Save As to a fresh .xlsx —
  // writing values back to a .tsv would need a tab serializer this path lacks.
  return extension === 'csv'
    ? {
        openPath,
        importTempDir: directory,
        csvImport: true,
        csvSourcePath: path,
        recoverySourcePath: path,
        recoverySourceSha,
        ...(emptyCsv ? { emptyCsv: true } : {}),
      }
    : {
        openPath,
        importTempDir: directory,
        suggestSaveAs: path.replace(/\.[^.]+$/, '.xlsx'),
        recoverySourcePath: path,
        recoverySourceSha,
      }
}

/** shell-injected items appended to the File menu (e.g. Back to Home) */
let extraFileMenuItems: MenuItemConstructorOptions[] = []

export function setSheetsExtraFileMenuItems(items: MenuItemConstructorOptions[]): void {
  extraFileMenuItems = items
}

/** tab mode: closes the sheets tab instead of the whole shell window (Cmd+W / role:'close') */
let closeActiveTabHook: (() => void) | null = null
export function setSheetsCloseTabHook(fn: (() => void) | null): void {
  closeActiveTabHook = fn
}

/// The ribbon has no File tab; file commands live in
/// the application menu and are forwarded to the renderer.
function installApplicationMenu(): void {
  const sendMenuAction = sendSheetsMenuAction
  const labels = appMenuLabels(getUiLang())
  const appMenu = appMenuTemplate(process.platform, labels, {
    appLabel: app.name,
    extra: [settingsMenuItem(labels)],
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(appMenu ? [appMenu] : []),
      {
        label: tm('menuFile'),
        submenu: [
          {
            label: tm('menuOpenWorkbook'),
            accelerator: 'CmdOrCtrl+O',
            click: () => sendMenuAction('open'),
          },
          ...(extraFileMenuItems.length > 0
            ? [{ type: 'separator' as const }, ...extraFileMenuItems]
            : []),
          { type: 'separator' },
          {
            label: tm('menuSave'),
            accelerator: 'CmdOrCtrl+S',
            click: () => sendMenuAction('save'),
          },
          {
            label: tm('menuSaveAs'),
            accelerator: 'Shift+CmdOrCtrl+S',
            click: () => sendMenuAction('save-as'),
          },
          { type: 'separator' },
          {
            label: tm('menuPrint'),
            accelerator: 'CmdOrCtrl+P',
            click: () => sendMenuAction('print'),
          },
          { type: 'separator' },
          {
            label: tm('menuExportPdf'),
            click: () => sendMenuAction('export-pdf'),
          },
          {
            label: tm('menuExportCsv'),
            click: () => sendMenuAction('export-csv'),
          },
          { type: 'separator' },
          closeActiveTabHook
            ? {
                label: process.platform === 'darwin' ? tm('menuClose') : tm('menuQuit'),
                accelerator: process.platform === 'darwin' ? 'CmdOrCtrl+W' : 'CmdOrCtrl+Q',
                click: () => closeActiveTabHook?.(),
              }
            : process.platform === 'darwin'
              ? { role: 'close' as const, label: tm('menuClose') }
              : { role: 'quit' as const, label: tm('menuQuit') },
          { type: 'separator' },
          settingsMenuItem(labels),
        ],
      },
      {
        label: tm('menuEdit'),
        submenu: [
          // role: 'editMenu' would bind ⌘Z to webContents.undo(), a text-editing
          // no-op that starves Univer of the shortcut — forward it instead.
          {
            label: tm('menuUndo'),
            accelerator: 'CmdOrCtrl+Z',
            click: () => sendMenuAction('undo'),
          },
          {
            label: tm('menuRedo'),
            accelerator: 'Shift+CmdOrCtrl+Z',
            click: () => sendMenuAction('redo'),
          },
          { type: 'separator' },
          { role: 'cut', label: labels.cut },
          { role: 'copy', label: labels.copy },
          { role: 'paste', label: labels.paste },
          { type: 'separator' },
          { role: 'selectAll', label: labels.selectAll },
        ],
      },
      // ⌘R is Fill Right and ⌘0/⌘+/⌘- hide columns / zoom the sheet; menu
      // accelerators would swallow them on macOS.
      viewMenuTemplate(labels, { devItems: !app.isPackaged, pageZoom: false }),
      windowMenuTemplate(process.platform, labels),
      helpMenuTemplate(labels),
    ]),
  )
}

/** stop the Rust sidecar (shell calls this from its own before-quit hook) */
export function stopSheetsSidecar(): void {
  sidecar?.stop()
  sidecar = null
}

export {
  installApplicationMenu as installSheetsMenu,
  startCaptureServer as startSheetsCaptureServer,
}

/**
 * Attaches a proxy to the main process's global fetch (same source as
 * slides-main.applyMainProcessProxy): main-process Node fetch (undici) ignores
 * the system proxy by default, so direct connections from mainland networks to
 * overseas LLM endpoints like api.anthropic.com time out or get rejected by
 * egress region (403 Request not allowed). Environment variables take priority;
 * otherwise the system proxy is read via session.resolveProxy() after app ready.
 */
async function applyMainProcessProxy(): Promise<void> {
  const setDispatcher = async (proxyUrl: string) => {
    // spawned gsk CLI children do their own fetch and never see the
    // dispatcher below — forward the proxy to them via env
    setGskProxyUrl(proxyUrl)
    try {
      const { setGlobalDispatcher } = await import('undici')
      // loopback stays direct: a Custom provider on 127.0.0.1 must not ride
      // the proxy as an absolute-form request (vantage#2084)
      setGlobalDispatcher(await createMainProcessProxyDispatcher(proxyUrl))
      // strip user:pass credentials before logging
      console.log('[proxy] main-process fetch via', proxyUrl.replace(/\/\/[^@/]*@/, '//***@'))
    } catch (e) {
      console.warn('[proxy] failed to set proxy dispatcher:', e)
    }
  }
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (envProxy) {
    await setDispatcher(envProxy)
    return
  }
  try {
    await app.whenReady()
    // PAC/rule proxies answer per-host: probe the host the login flow, the
    // Genspark LLM proxy and the gsk CLI actually target
    const resolved = await electronSession.defaultSession.resolveProxy('https://www.genspark.ai/')
    const m = /PROXY\s+([^;]+)/i.exec(resolved || '')
    if (m?.[1]) {
      await setDispatcher(`http://${m[1].trim()}`)
    } else {
      console.log('[proxy] system proxy = DIRECT, no dispatcher set')
    }
  } catch (e) {
    console.warn('[proxy] resolveProxy failed:', e)
  }
}

function cancelStandaloneSheetsQuit(): void {
  if (standaloneCloseControl) standaloneCloseControl.cancel()
  else resetSheetsShuttingDown()
}

function warnStandaloneSheets(message: string): void {
  void dialog.showMessageBox({ type: 'warning', message }).catch(() => {})
}

export function startSheetsStandalone(): void {
  // VANTAGE_USER_DATA: test drivers point this at a scratch dir so automated
  // instances get their own userData AND single-instance lock (the lock is scoped
  // to userData), allowing parallel instances alongside a normal dev run.
  // Same dev-only hook as apps/slides/src/main/slides-main.ts.
  if (!app.isPackaged && process.env.VANTAGE_USER_DATA) {
    app.setPath('userData', process.env.VANTAGE_USER_DATA)
  }
  const standaloneRecoveryProfile = configureRecoveryProfile({ app, mode: 'gui', guiProfile: app.getPath('userData') })
  const lockAcquired = app.requestSingleInstanceLock()
  if (!lockAcquired) { app.quit(); return }
  standaloneCloseControl = initializeStandaloneSheetsCloseRuntime({
    mode: 'gui', lockAcquired, app,
    setRuntime: setSheetsCloseRuntime,
    closeState: sheetsCloseState,
    initializeShared: () => {
      initializeStandaloneRecovery({ app, ...standaloneRecoveryProfile, lockAcquired: true,
        warning: warnStandaloneSheets,
        terminal: cleanup => { app.once('will-quit', cleanup) },
      })
    },
    resetShutdown: resetSheetsShuttingDown,
    warning: warnStandaloneSheets,
    onBlocked: retry => {
      void dialog.showMessageBox({
        type: 'warning',
        message: 'Spreadsheet cleanup is incomplete. Keep the application open.',
        buttons: ['Retry cleanup', 'Keep open'], defaultId: 1, cancelId: 1,
      }).then(async result => {
        if (result.response !== 0) return
        try { await retry() }
        catch { warnStandaloneSheets('Spreadsheet cleanup is still incomplete. Keep the application open.') }
      }).catch(() => warnStandaloneSheets('Spreadsheet cleanup is incomplete. Keep the application open.'))
    },
    startEditors: () => {
      registerRendererScheme()
      installNavigationGuard(app)
      installContextMenu(app, () => contextMenuLabels(getUiLang()))
      void applyMainProcessProxy()
      void app.whenReady().then(() => {
        installRendererProtocol({ sheets: join(__dirname, '../renderer') })
        setUiLang(normalizeLang(process.env.VANTAGE_LANG ?? app.getLocale()))
        app.setAccessibilitySupportEnabled(true)
        installApplicationMenu()
        startCaptureServer()
        return createSheetsWindow()
      }).catch(() => {
        cancelStandaloneSheetsQuit()
        warnStandaloneSheets('Spreadsheet startup did not complete. Keep the application open.')
      })
      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit()
      })
      app.on('will-quit', () => {
        stopSheetsSidecar()
      })
      app.on('activate', () => {
        if (!mainWindow) void createSheetsWindow().catch(() => {
          cancelStandaloneSheetsQuit()
          warnStandaloneSheets('Spreadsheet startup did not complete. Keep the application open.')
        })
      })
    },
  })
}

function resolveSidecarPath(): string {
  const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar'
  if (runtime.sidecarPath) return runtime.sidecarPath
  if (process.env.XLSX_SIDECAR_PATH) return process.env.XLSX_SIDECAR_PATH
  if (app.isPackaged) return join(process.resourcesPath, 'native', executable)
  return join(app.getAppPath(), 'native', 'xlsx-engine', 'target', 'release', executable)
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

async function closeAllSessions(entry: {
  client: XlsxSidecarClient
  sessions: Map<string, SessionInfo>
}, requireExitOnCloseFailure = false): Promise<void> {
  const sessions = [...entry.sessions.entries()]
  entry.sessions.clear()
  await Promise.allSettled(
    sessions.map(async ([sessionId, session]) => {
      await cleanupSessionResources({
        tempRoot: app.getPath('temp'),
        snapshotPath: session.snapshotPath,
        importTempDir: session.importTempDir,
        closeSidecar: async () => {
          try { await entry.client.closeSettled(sessionId) }
          catch (error) {
            // Temp cleanup swallows close rejection. Headless staging cannot
            // be removed until even a refused/failed close has actual exit proof.
            if (requireExitOnCloseFailure) await entry.client.stopSettled()
            throw error
          }
        },
      })
    }),
  )
}
