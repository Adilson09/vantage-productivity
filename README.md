# Vantage Productivity

Vantage Productivity is a Windows desktop development preview with six editors: documents (DOCX), spreadsheets (XLSX), presentations (PPTX), PDF, Markdown, and HTML. Vantage Mail is a separate bundled native companion. The workspace includes command search, bounded document inspection, and recovery of previous saved versions.

## Run the Windows preview

Extract the entire release folder and open **Vantage Productivity.exe**. Keep all resources and helpers beside it. The local **Open-Vantage-Productivity.cmd** launcher preserves the established Office and Mail profiles; ordinary downloaded launches use the new product default for Office. Mail retains its established credential namespace so the rename does not disconnect existing accounts. WebView2 is required by Mail.

## Scope

This is an unsigned preview. Full Microsoft Office compatibility, complete keyboard/screen-reader acceptance, clean-machine portability, calendar, database, and concurrent collaboration are not established. XLSM preservation does not mean VBA execution, and cached pivots do not mean in-app refresh. PDF inspection currently checks markers rather than full page structure. Recovery is bounded saved-version history, not a complete backup or a promise to recover unsaved work.

Historical 0.12 evidence includes 75 targeted component/filesystem cases and 14 selected desktop behaviors. Historical 0.13 evidence includes 13 packaged smoke checks. Neither should be presented as fresh evidence for version 0.14. See the delivered **Vantage-Validation.json** for checks actually performed on the renamed candidate.

## Build

Requires Node.js 24 or newer with SQLite FTS5, npm >=10, Rust and an x64 Windows MSVC/SDK toolchain for the spreadsheet helper. The pinned development runtime is 24.19.0 (`.nvmrc`); `npm run check:runtime` verifies the required SQLite capability before testing.

```powershell
npm ci
npm run build:all
npm run notices
npm exec -w @vantage/shell -- electron-builder --win zip --x64 --publish never
```

A Mail build also requires its own toolchain and dependency setup; see companions/depesha and tools/build-mail.mjs. The internal workspace namespace and CLI are **@vantage** and **vantage**. Windows is the validated delivery target for this preview; inherited Linux/macOS deployment recipes require separate release configuration and validation.

The root lint command uses the workspace configuration. CI installs Mail's separate locked frontend dependencies and runs its type, lint and unit checks in the `Mail frontend checks` job. Native Mail builds and provider interoperability have separate validation requirements.

## Review and next implementation choices

The delivered **Vantage-Productivity-Review.html** maps the review requirements to alternatives, tradeoffs, official sources and acceptance criteria. The preview implements the subsets recorded in [implementation choices](docs/implementation/choices.json), which also lists the remaining acceptance work for each area.

## Licenses and source provenance

The suite retains its Apache-2.0 license and all applicable third-party terms. Required original attribution is in [NOTICE](NOTICE), [LICENSE](LICENSE), [source provenance](legal/UPSTREAM-PROVENANCE.txt), and generated third-party notices. Original historical project documentation is archived under legal/. The Mail companion retains its MIT OR Apache-2.0 notices. The separately licensed ee/ directory is excluded from the distributable source and application.
