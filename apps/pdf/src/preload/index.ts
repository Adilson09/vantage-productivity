import type { AiPanelPrefs } from '@vantage/ui'
import { contextBridge, ipcRenderer } from 'electron'
import type { Lang } from '@vantage/i18n'
import type { AiStreamChunk } from '@vantage/ai-provider'
import { installDropOpenBridge } from '@vantage/electron-utils/drop-open'
import { AI_CHANNELS, PDF_CHANNELS } from '../shared/ipc'
import type { PdfApi, UiTheme } from '../shared/ipc'

const api: PdfApi = {
  claimClose: (ticket) => ipcRenderer.invoke(PDF_CHANNELS.closeClaim, ticket),
  cancelClose: (ticket, reason) => ipcRenderer.invoke(PDF_CHANNELS.closeCancel, ticket, reason),
  onClosePrepare: (handler) => { const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof handler>[0]) => handler(request); ipcRenderer.on(PDF_CHANNELS.closePrepare, listener); return () => ipcRenderer.removeListener(PDF_CHANNELS.closePrepare, listener) },
  sendClosePrepared: (response) => ipcRenderer.send(PDF_CHANNELS.closePrepared, response),
  onCloseRelease: (handler) => { const listener = (_event: Electron.IpcRendererEvent, response: Parameters<typeof handler>[0]) => handler(response); ipcRenderer.on(PDF_CHANNELS.closeRelease, listener); return () => ipcRenderer.removeListener(PDF_CHANNELS.closeRelease, listener) },
  onCloseStateRequest: (handler) => { const listener = (_event: Electron.IpcRendererEvent, id: string) => handler(id); ipcRenderer.on(PDF_CHANNELS.closeStateRequest, listener); return () => ipcRenderer.removeListener(PDF_CHANNELS.closeStateRequest, listener) },
  sendCloseState: (id, state) => ipcRenderer.send(PDF_CHANNELS.closeStateResponse, id, state),
  readSource: (path, closeTicket) => ipcRenderer.invoke(PDF_CHANNELS.readSource, path, closeTicket),
  activateDraft: (readId, unjournaledPath) => ipcRenderer.invoke(PDF_CHANNELS.activateDraft, readId, unjournaledPath),
  writeDraft: (request) => ipcRenderer.invoke(PDF_CHANNELS.writeDraft, request),
  discardDraft: (token) => ipcRenderer.invoke(PDF_CHANNELS.discardDraft, token),
  retryDraftCleanup: () => ipcRenderer.invoke(PDF_CHANNELS.retryDraftCleanup),
  forkAfterSave: request => ipcRenderer.invoke(PDF_CHANNELS.forkAfterSave, request),
  acknowledgeCopy: (request) => ipcRenderer.invoke(PDF_CHANNELS.acknowledgeCopy, request),
  requestWorkspaceCopy: (path) => ipcRenderer.invoke(PDF_CHANNELS.requestWorkspaceCopy, path),
  onDraftRetired: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, value: Parameters<typeof handler>[0]) => handler(value)
    ipcRenderer.on(PDF_CHANNELS.draftRetired, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.draftRetired, listener)
  },
  consumePending: () => ipcRenderer.invoke(PDF_CHANNELS.consumePending),
  openSourcePath: (path: string) => ipcRenderer.invoke('home:open-path', path),
  readFile: (path, closeTicket) => ipcRenderer.invoke(PDF_CHANNELS.readFile, path, closeTicket),
  save: (request) => ipcRenderer.invoke(PDF_CHANNELS.save, request),
  requestRedactionCopy: (path) => ipcRenderer.invoke(PDF_CHANNELS.requestRedactionCopy, path),
  autoRename: (path, baseName) => ipcRenderer.invoke(PDF_CHANNELS.autoRename, path, baseName),
  isUntitled: (path) => ipcRenderer.invoke(PDF_CHANNELS.isUntitled, path),
  validateTextEdits: (request) => ipcRenderer.invoke(PDF_CHANNELS.validateTextEdits, request),
  listEditFonts: () => ipcRenderer.invoke(PDF_CHANNELS.listEditFonts),
  canDrawText: (text, font, bold, italic) =>
    ipcRenderer.invoke(PDF_CHANNELS.canDrawText, text, font, bold, italic),
  listPageImages: (path) => ipcRenderer.invoke(PDF_CHANNELS.listPageImages, path),
  listStaticFormFills: (path) => ipcRenderer.invoke(PDF_CHANNELS.listStaticFormFills, path),
  ocrPage: (png) => ipcRenderer.invoke(PDF_CHANNELS.ocrPage, png),
  pageImagePng: (request) => ipcRenderer.invoke(PDF_CHANNELS.pageImagePng, request),
  pagePreviewPng: (request) => ipcRenderer.invoke(PDF_CHANNELS.pagePreviewPng, request),
  extractPages: (request) => ipcRenderer.invoke(PDF_CHANNELS.extractPages, request),
  insertPdf: (request) => ipcRenderer.invoke(PDF_CHANNELS.insertPdf, request),
  compareReadPdf: () => ipcRenderer.invoke(PDF_CHANNELS.compareReadPdf),
  compareReadOpen: (path: string) => ipcRenderer.invoke(PDF_CHANNELS.compareReadOpen, path),
  insertBlankPage: (request) => ipcRenderer.invoke(PDF_CHANNELS.insertBlankPage, request),
  splitPdf: (request) => ipcRenderer.invoke(PDF_CHANNELS.splitPdf, request),
  mergePdf: (request) => ipcRenderer.invoke(PDF_CHANNELS.mergePdf, request),
  mergePages: (request) => ipcRenderer.invoke(PDF_CHANNELS.mergePages, request),
  replacePages: (request) => ipcRenderer.invoke(PDF_CHANNELS.replacePages, request),
  setPageSize: (request) => ipcRenderer.invoke(PDF_CHANNELS.setPageSize, request),
  splitPages: (request) => ipcRenderer.invoke(PDF_CHANNELS.splitPages, request),
  cropPages: (request) => ipcRenderer.invoke(PDF_CHANNELS.cropPages, request),
  exportImages: (request) => ipcRenderer.invoke(PDF_CHANNELS.exportImages, request),
  convertOffice: (format) => ipcRenderer.invoke(PDF_CHANNELS.convertOffice, format),
  createDocument: (request) => ipcRenderer.invoke(PDF_CHANNELS.createDocument, request),
  imageSearch: (query, maxResults) =>
    ipcRenderer.invoke(AI_CHANNELS.imageSearch, query, maxResults),
  fetchImage: (url) => ipcRenderer.invoke(AI_CHANNELS.fetchImage, url),
  generateImage: (op) => ipcRenderer.invoke(PDF_CHANNELS.generateImage, op),
  listDigitalSignatures: (path) => ipcRenderer.invoke(PDF_CHANNELS.listDigitalSignatures, path),
  pickCertificate: () => ipcRenderer.invoke(PDF_CHANNELS.pickCertificate),
  listSystemCertificates: (storePassword) =>
    ipcRenderer.invoke(PDF_CHANNELS.listSystemCertificates, storePassword),
  releaseCertificate: (certId) => ipcRenderer.send(PDF_CHANNELS.releaseCertificate, certId),
  inspectCertificate: (certId, password, storePassword) =>
    ipcRenderer.invoke(PDF_CHANNELS.inspectCertificate, certId, password, storePassword),
  signWithCertificate: (request) => ipcRenderer.invoke(PDF_CHANNELS.signWithCertificate, request),
  listSavedSignatures: () => ipcRenderer.invoke(PDF_CHANNELS.listSignatures),
  addSavedSignature: (data) => ipcRenderer.invoke(PDF_CHANNELS.addSignature, data),
  removeSavedSignature: (id) => ipcRenderer.invoke(PDF_CHANNELS.removeSignature, id),
  getUsername: () => ipcRenderer.invoke(PDF_CHANNELS.getUsername),
  setDirty: (dirty) => ipcRenderer.send(PDF_CHANNELS.dirtyChanged, dirty),
  onCloseSaveRequest: (handler) => {
    const listener = (_e: unknown, opts?: { flushAll?: boolean }) =>
      handler({ flushAll: opts?.flushAll === true })
    ipcRenderer.on(PDF_CHANNELS.closeSaveRequest, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.closeSaveRequest, listener)
  },
  sendCloseSaveResult: (ok) => ipcRenderer.send(PDF_CHANNELS.closeSaveResult, ok),
  onSaveAsRequest: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, targetPath: string) => handler(targetPath)
    ipcRenderer.on(PDF_CHANNELS.saveAsRequest, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.saveAsRequest, listener)
  },
  sendSaveAsResult: (ok) => ipcRenderer.send(PDF_CHANNELS.saveAsResult, ok),
  onSaveAsFlow: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, inFlight: boolean) => handler(inFlight)
    ipcRenderer.on(PDF_CHANNELS.saveAsFlow, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.saveAsFlow, listener)
  },
  print: (job) => ipcRenderer.invoke(PDF_CHANNELS.print, job),
  listPrinters: () => ipcRenderer.invoke(PDF_CHANNELS.printers),
  onPrintRequest: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(PDF_CHANNELS.printRequest, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.printRequest, listener)
  },
  onFileRenamed: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, newPath: string) => handler(newPath)
    ipcRenderer.on(PDF_CHANNELS.fileRenamed, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.fileRenamed, listener)
  },
  getLanguage: () => ipcRenderer.invoke(PDF_CHANNELS.getLanguage),
  onLanguageChanged: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, lang: Lang) => handler(lang)
    ipcRenderer.on(PDF_CHANNELS.languageChanged, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.languageChanged, listener)
  },
  getTheme: () => ipcRenderer.invoke(PDF_CHANNELS.getTheme),
  onThemeChanged: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, theme: UiTheme) => handler(theme)
    ipcRenderer.on(PDF_CHANNELS.themeChanged, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.themeChanged, listener)
  },
  getAiPanelPrefs: () => ipcRenderer.invoke(PDF_CHANNELS.getAiPanelPrefs),
  setAiPanelPrefs: (patch) => ipcRenderer.invoke('app:set-ai-panel-prefs', patch),
  onAiPanelPrefsChanged: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, prefs: AiPanelPrefs) => handler(prefs)
    ipcRenderer.on(PDF_CHANNELS.aiPanelPrefsChanged, listener)
    return () => ipcRenderer.removeListener(PDF_CHANNELS.aiPanelPrefsChanged, listener)
  },
  onChromePressed: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('app:chrome-pressed', listener)
    return () => ipcRenderer.removeListener('app:chrome-pressed', listener)
  },
  getAiSettings: () => ipcRenderer.invoke(AI_CHANNELS.getSettings),
  setAiSettings: (settings) => ipcRenderer.invoke(AI_CHANNELS.setSettings, settings),
  onAiSettingsChanged: (handler) => {
    const listener = () => handler()
    ipcRenderer.on(AI_CHANNELS.settingsChanged, listener)
    return () => ipcRenderer.removeListener(AI_CHANNELS.settingsChanged, listener)
  },
  openAiModelSettings: () => ipcRenderer.invoke(AI_CHANNELS.openModelSettings),
  openSkillsSettings: () => ipcRenderer.invoke(AI_CHANNELS.openSkillsSettings),
  skillsList: () => ipcRenderer.invoke(AI_CHANNELS.skillsList),
  skillText: (name: string) => ipcRenderer.invoke(AI_CHANNELS.skillText, name),
  gskStatus: () => ipcRenderer.invoke(AI_CHANNELS.gskStatus),
  aiStream: (request) => ipcRenderer.invoke(AI_CHANNELS.stream, request),
  aiStreamCancel: (requestId) => ipcRenderer.invoke(AI_CHANNELS.streamCancel, requestId),
  onAiStream: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, chunk: AiStreamChunk) => handler(chunk)
    ipcRenderer.on(AI_CHANNELS.streamChunk, listener)
    return () => ipcRenderer.removeListener(AI_CHANNELS.streamChunk, listener)
  },
}

// Shared project chat store (registered app-wide by the shell's main init):
// AI PDF conversations persist per file, like Docs/Sheets
const projectApi = {
  resolveChat: (args: { filePath: string | null; tempChatId?: string }) =>
    ipcRenderer.invoke('project:resolveChat', args),
  appendChat: (args: unknown) => ipcRenderer.invoke('project:appendChat', args),
  loadChat: (args: { projectId: string; chatId: string; limit?: number }) =>
    ipcRenderer.invoke('project:loadChat', args),
  rebindChat: (args: { projectId: string; tempChatId: string; newFilePath: string }) =>
    ipcRenderer.invoke('project:rebindChat', args),
}

contextBridge.exposeInMainWorld('pdfApi', api)
contextBridge.exposeInMainWorld('projectApi', projectApi)

// open documents dragged from the OS onto this tab as a new shell tab
installDropOpenBridge()
