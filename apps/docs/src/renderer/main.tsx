import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@vantage/i18n'
import { App } from './App'
import { setAuthorName } from './author-name'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import type { DocTheme, UiTheme } from '../shared/ipc'
import '@vantage/ui/tokens.css'
import '@vantage/ui/screentip.css'
import '@vantage/ui/ai-model-picker.css'
import '@vantage/ui/ai-queue-strip.css'
import '@vantage/ui/ai-usage.css'
import '@vantage/ui/ai-skills.css'
import '@vantage/ui/color-picker.css'
import '@vantage/ui/dropdown.css'
import '@vantage/ui/ribbon-collapse.css'
import '@vantage/ui/markdown.css'
import '@vantage/ui/ai-panel-prefs.css'
import '@vantage/ui/ai-scope-quote.css'
import '@vantage/ui/image-viewer.css'
import './styles.css'
import './fonts/fonts.css'
import { applyAiPanelPrefs, installScreenTips } from '@vantage/ui'
import { setAltChunkHtmlConverter } from '@vantage/docx-engine'

installScreenTips()
if (window.desktop?.convertAltChunkHtml) {
  setAltChunkHtmlConverter((html) => window.desktop.convertAltChunkHtml(html))
}

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function applyDocumentTheme(theme: DocTheme): void {
  // data-doc-theme drives the canvas/paper (vantage#1811); absent means 'follow' the UI theme
  if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme')
  else document.documentElement.setAttribute('data-doc-theme', theme)
}

async function bootstrap(): Promise<void> {
  let lang: Lang = 'zh'
  let theme: UiTheme = 'system'
  let docTheme: DocTheme = 'follow'
  try {
    // per-promise catch: standalone runs have no app:get-theme handler, and
    // that rejection must not drop a resolved language
    ;[lang, theme, docTheme] = await Promise.all([
      window.desktop.getLanguage().catch(() => 'zh' as const),
      window.desktop.getTheme().catch(() => 'system' as const),
      window.desktop.getDocumentTheme?.().catch(() => 'follow' as const),
    ])
  } catch {
    /* dev renderer without the preload bridge */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  applyDocumentTheme(docTheme ?? 'follow')
  window.desktop?.onThemeChanged(applyTheme)
  window.desktop?.onDocumentThemeChanged?.(applyDocumentTheme)
  await window.desktop
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  window.desktop?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  await window.desktop
    ?.getAuthorName?.()
    .then(setAuthorName)
    .catch(() => {})
  window.desktop?.onAuthorNameChanged?.(setAuthorName)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App />
    </LocaleProvider>,
  )
}

void bootstrap()
