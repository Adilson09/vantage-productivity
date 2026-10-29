<!-- Vantage Productivity modification (2026): current, evidence-scoped preview guidance. -->

# Vantage Productivity 0.15.0-dev.1 preview

This is an unsigned development preview of an independently maintained open-source productivity suite. Its native document engines remain central, with licensed open-source components filling selected gaps. Full Office compatibility and production release acceptance remain unproven.

The current records are [all 32 implementation choices](implementation/choices.json), [delivery evidence](implementation/delivery-evidence.json), and [open-source components](implementation/open-source-components.json). Their remaining gates are part of the work, not completed capabilities.

## Running the preview

Extract the entire Windows ZIP and run `Start-Vantage-Preview.cmd`. It creates a separate preview profile and authentication folder under `%LOCALAPPDATA%`. Keep the application, resources and libraries together.

Open **Tools and privacy** for local calendar/contact tools, database records, document-engine status, saved history, draft recovery and privacy choices. Remote services are disabled in local mode. Provider adapters require explicit enablement and consented credentials; account registration, consent and refresh workflows remain incomplete.

## Implemented scope

- Six editing modules: DOCX, XLSX, PPTX, PDF, Markdown and HTML. Their inherited and added features have different acceptance scopes; successful loading does not certify editing or interoperability.
- Native spreadsheet calculation, selected pivot refresh and XLSM resource preservation. VBA/XLM execution, full Excel models and external refresh are unsupported.
- Local SQLite typed records, saved form definitions, escaped reports/CSV and bounded isolated read-only queries. The desktop exposes basic record entry and queries; this is not an Access-compatible application or a complete visual form/report designer.
- Local iCalendar creation/import/export, bounded recurrence with embedded time zones, and vCard contacts. Live invitations, delegation, offline write queues and a complete time-zone database remain open.
- A bounded child-process document inspector, actual PDF object/page-tree parsing, and bundled qpdf structural checking. These results do not certify rendered fidelity, PDF/A, PDF/UA or human accessibility. LibreOffice conversion and veraPDF runtime acceptance were unavailable for this candidate.
- Cooperative local/shared-registry checkout commands and separate conflict copies. All writers must participate; this is not authenticated real-time coauthoring or enforcement in every editor save.

## Save, history and draft boundaries

Shared publication supports first-save history, visible history warnings, completed rescue files and optional outside-change checks. Native Sheets publication uses the shared completed-file contract. Contract tests do not establish every failure path through every editor.

History has configurable size, entry, revision and free-space budgets. Skipped and pruned history remains visible. Optional encryption protects new history/draft payloads using an OS-protected key; existing plaintext history is counted and is not silently migrated. Password-protected history export contains saved history, not a complete current-file, application, system or asset backup.

Dirty named and unnamed Markdown drafts are journaled every 15 seconds and on blur, with separate-copy recovery and discard. Draft limits apply, and pasted assets are not bundled. Complete draft-state recovery for the five other editors remains unfinished.

Unmodified Markdown can retain its original source bytes without enabling the experimental round-trip preference. Edited documents still use the established serializer by default and may normalize unsupported syntax. No universal lossless-editing claim is made.

Recovery verifies integrity and creates a separate destination. It cannot guarantee recovery of every unsaved state or every storage failure. See [the save/recovery contract](implementation/save-recovery-contract.md).

## Recorded verification

- All 12 corrected packaged checks passed: startup, SQLite FTS5, isolated PDF/qpdf and database paths, local-mode blocking, CLI/native workbook inspection, and loading each of the six editors. Editor checks cover loading only.
- All 11 selected rebuilt desktop workflows passed, including local calendar/database tools, privacy/focus, inspection, saved-history restore and the named Markdown retention/crash-recovery paths.
- 1,200 native calculation cases in 12 categories matched installed Excel, including typed/financial results and dependency refresh. This does not certify every function or workbook.
- The native format corpus passed 82 no-op/reopen and 79 targeted-edit cases; five Office raster smoke pairs passed. Synthetic cases and the interrupted broader reference run remain identified in the evidence.
- Earlier source typecheck baselines and targeted regressions passed. An additional typecheck repeat did not complete within its deadline; it is not represented as a fresh full-suite pass.
- The frozen app inventory has 3,204 files; 1,097 generated build outputs matched their packaged copies. Release ZIPs also undergo content and checksum verification.

Counts describe separate workloads and are not combined into a completeness, parity or quality score. Historical failures and superseding targeted checks retain their individual scopes.

## Remaining release gates

Every-editor create/edit/save/reopen/export/failure acceptance, independent rendered Office coverage, whole-process network observation, cold/warm performance, accessibility tasks with screen readers, live provider interoperability, signing, clean-machine installation/update/uninstall and migration still require evidence. Local AI model/runtime selection and blinded quality evaluation also remain open.

Follow the repository README and pinned Node runtime for source builds. `npm run check:runtime` verifies required SQLite capabilities. Native builds require the documented Rust and platform toolchains. All third-party notices and applicable source/license materials must accompany redistribution.
