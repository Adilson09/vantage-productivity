# Contributing to Vantage Productivity

Help improve the documents and workflows people use every day. Feedback, reproducible bugs, small sample files, documentation corrections and focused code changes are welcome.

## Share an experience or a problem

Search [existing issues](https://github.com/Adilson09/vantage-productivity/issues) first. Add a comment to an existing report when your example provides more detail. Otherwise choose the bug, feature or general feedback form in [New issue](https://github.com/Adilson09/vantage-productivity/issues/new/choose).

For bugs, include the Vantage version or commit, Windows version, affected tool, exact steps, expected result and actual result. If a file is needed, attach the smallest sanitized sample that reproduces the behavior. Do not upload private documents or credentials. Use [SECURITY.md](SECURITY.md) for vulnerability reporting.

For features, explain the task, your current workaround and the result you want. A concrete workflow is more useful than a claim of general Office parity.

## Work on the source

Use Node 24.19.0 from .nvmrc, npm >=10, Rust and the Windows x64 MSVC/SDK toolchain for native Sheets builds. Node must support SQLite FTS5. Mail requires its own documented Tauri/WebView2 prerequisites.

```powershell
npm ci
npm run check:runtime
npm run build:all
npm run dev
```

Packaging requires additional staged resources. Review apps/shell/electron-builder.cjs and tools/build-mail.mjs before attempting a distributable package. A source run is not a packaged release acceptance test.

Create a branch from the current main branch and keep a pull request focused. The repository also has draft integration work; do not assume those changes are in the published preview.

## Verify and explain a change

Run the affected workspace's tests and typecheck. The repository provides npm run test, npm run typecheck, npm run lint and npm run test:e2e for broader checks when relevant. Report the exact command, revision, result, failures and any skipped or interrupted workload. Do not infer a complete pass from a selected test set.

For file-format changes, include a minimal input and explain the edit/save/reopen or export behavior. Check relevant unsupported parts and relationships. Successful loading or a no-op round trip does not prove every edited file retains its layout or features. Performance and accessibility claims need their own measurements and tasks.

Describe the user-visible problem, the resulting behavior, how it was checked and any remaining limits in the pull request. Preserve useful evidence of failures rather than relabeling them as passes.

## Licenses and community

Retain applicable copyright, license, NOTICE and provenance records. New dependencies need compatible redistribution terms and notices. The ee/ directory contains original separately licensed documents and accepts no implementation contributions through this project.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). The repository maintainer is [@Adilson09](https://github.com/Adilson09). Feedback and contributions do not imply a promised release date, response time or acceptance.
