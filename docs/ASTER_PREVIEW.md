<!-- Aster Office addition (2026): truthful preview scope, acceptance gates and static UI review. -->

# Aster Office preview scope and release gates

This is a development preview of a distinct GenOffice-based suite. “Better
than Microsoft Office in every detail” is an ambition, not an established
result. A polished workspace, a successful build and passing helper tests
cannot establish complete Office parity.

## Capability and evidence matrix

| Area              | Inherited or added in Aster                                                                                    | Evidence still required                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| DOCX              | Inherited editor and incremental OOXML engine; added structural spot checks                                    | No-op/edited Word round trips, pagination, fonts, fields, revisions, tables, RTL/CJK and render comparison                |
| XLSX formulas     | Inherited spreadsheet UI, Rust calculation/native save and cached-value handling                               | Published supported-function matrix; deterministic Excel result comparisons; distinguish recalculation from cached values |
| Macros and models | Preserve-only VBA/advanced-model contract; no new runtime                                                      | XLSM part preservation and warnings; VBA editing/execution and external refresh remain unsupported                        |
| PivotTables       | Inherited limited pivot creation and native package writing                                                    | Existing/advanced pivot edits, source refresh, grouping, filters, cache and result comparisons                            |
| PPTX              | Inherited slide editor/rendering and timing/narration code; added package checks                               | Static layout plus live animation order, triggers, transitions, media and narration fidelity                              |
| Collaboration     | Inherited file review/comment features                                                                         | No validated concurrent co-authoring service, conflict resolution or shared permissions                                   |
| Mail/calendar     | Aster Mail is a separate native mail companion with its own data/credential identities; no calendar | Live account/provider interoperability, mail workflows, and calendar implementation                                      |
| Access databases  | No dedicated Access-style application                                                                          | Tables, relationships, queries, forms, reports, transactions and ACCDB workflow tests                                     |
| Accessibility     | Added command keyboard access, dialog focus handling, reduced motion and selected content checks               | Keyboard and Narrator/NVDA acceptance across every editor; magnification/high contrast; accessible exported content       |
| Offline/privacy   | Inherited local engines, local/remote model choices and cloud/account services; added local inspection/history | All-editor offline and packet-capture tests; release configuration and enabled remote data flows                          |
| Save/recovery     | Added stricter shared publication, previous-version history and verified separate-copy recovery                | Final component rerun and desktop crash/lock/permission tests on the actual candidate                                     |
| Performance       | Inherited streaming, sidecar and tab-memory management                                                         | Reproducible startup, open/edit/save/export/recalculation and all-process memory measurements                             |
| AI                | Inherited provider adapters, agents and review/undo mechanisms                                                 | Repeated blinded quality tasks, factual/cell checks, citations, undo, edit scope, privacy and cost/latency measurements   |

The separate PDF, Markdown and HTML editors are also inherited real editing
modules. They require the same create/open/edit/save/reopen and failure-path
acceptance as the three Office document formats. Upstream marketing and
upstream test claims are not current Aster acceptance results.

## Inspection and history boundaries

- Inspector: regular files up to 32 MiB. Office ZIP checks are bounded to
  4,000 parts, 12 MiB per part and 64 MiB expanded total. Detailed XML checks
  are capped at 4 MiB per part; detailed text checks at 2 MiB. XML depth and
  tag limits also apply. A limit failure is not a passed inspection.
- PDF inspection covers header/end markers, not a PDF page parser, rendering
  or accessibility validation. No inspector result certifies Office fidelity.
- Recovery captures an existing supported document's previous saved bytes.
  There is no previous-version snapshot on a new file's first save, and an
  oversized previous version (over 32 MiB) is excluded.
- The vault bounds are 10 versions per file, 128 entries and 128 MiB of stored
  document payload. Metadata adds disk overhead; older entries are pruned.
  Application data/caches and non-document assets are excluded.
- Recovery creates a separate new file after an integrity check. The vault
  adds no encryption; encrypted source bytes remain encrypted, while an
  unencrypted document remains unencrypted. It is not a complete backup or
  a promise to recover unsaved work.
- Shared JavaScript publication failures can retain a completed rescue
  temporary file and report its location. Native Sheets uses its existing
  safe writer; do not assume every native failure yields the same rescue file.

## Current validation record

The final targeted component/real-filesystem rerun passed:

| Scope                                   | Passing cases |
| --------------------------------------- | ------------: |
| Shared atomic writes and recovery vault |            40 |
| Shell audit/export/fsync helpers        |            23 |
| Sheets native-save wrapper              |             4 |
| Slides PDF exporter                     |             8 |

These 75 cases include the final bounded reads, metadata flushes,
deduplication/integrity checks, quota/fault cases and app-data exclusions.
The shared Electron utility TypeScript check also passed. Separately,
13/13 workspace helper tests and the shell TypeScript check passed. Workspace
theme-token, whitespace and formatting checks passed.

These results do not prove Electron GUI acceptance, Microsoft rendering
parity or production readiness. Four new workspace E2E cases cover keyboard
focus, actual Markdown inspection/cancellation, an empty vault, and recovery
created by a real Markdown editor save. They are written but await execution
against rebuilt outputs. Build, packaging and broader integration evidence
must accompany the delivered candidate.

## Required preview release gates

1. **Current build:** build the shell, every editor, CLI and matching release
   sidecar; launch the actual Windows artifact on a clean profile and verify
   create/open/edit/save/reopen in all six editors. Retain license notices
   and publish artifact hashes and native-helper provenance.
2. **Current tests:** rerun relevant component/unit suites after all final
   changes. Run the workspace/launcher E2E cases against rebuilt outputs.
   Label unavailable or skipped tests explicitly.
3. **Save integrity:** inject lock, publication failure, corrupt snapshot,
   metadata failure, quota and exclusion cases through real editor paths.
   Failed publication must preserve original bytes; recovered output must
   match the snapshot hash and use a separate new destination.
4. **Interaction/access:** verify command focus, arrow navigation, Enter,
   Escape, Tab containment/restoration and no overlapping dialogs. Confirm
   original file browsing/search/settings, cancel/error states, responsive
   layout, light/dark/system and reduced motion in the candidate.
5. **Truthful scope:** identify unsupported and experimental features,
   history limits, English-only new workspace text and unvalidated areas.
   Do not use upstream stars as Aster popularity or add a universal Office
   compatibility/superiority badge.

Portable launch and installation are distinct checks. Keep an unpacked
application folder intact; the profile still defaults to the user's
application-data directory. Building or testing on a developer workstation
does not establish clean-machine compatibility, signing or installer quality.

## Proposed comparative acceptance targets

These are **targets**, not measured results or Microsoft guarantees. Pin the
Microsoft build/channel, license, Windows version, CPU/RAM, fonts, locale,
display and printer settings. Keep the same hashed corpus and publish every
failure. Treat desktop, web, consumer and enterprise configurations separately.

- **Document fidelity:** at least 50 Word documents and 30 PowerPoint decks,
  each with no-op and targeted edits. Require no repair prompt, no lost text
  or required relationships, matching page counts and preserved untouched
  parts. Proposed render tolerance is at most 1% differing non-antialias
  pixels, plus zero human-reviewed critical layout defects.
- **Calculations:** at least 1,000 deterministic cases covering every
  advertised function/reference category. Match strings, dates, booleans and
  errors exactly; proposed numeric tolerance is
  `max(1e-9, abs(reference) * 1e-9)`, with exact displayed financial rounding.
  Freeze volatile inputs and compare live calculation separately from caches.
- **Advanced formats:** at least 10 XLSM preservation fixtures and 10 pivot
  fixtures with changed sources/refresh. Full macro/advanced-model parity
  requires execution and refresh implementations, not preservation alone.
- **Slideshow playback:** at least 10 timed/interactive decks. For advertised
  playback, require correct effect order, timing within one frame at 30 fps
  and audio offset within 100 ms; static PDF export is a separate result.
- **Collaboration and missing apps:** a complete replacement claim requires
  working equivalents, including at least 100 multi-user/reconnect trials,
  mail/calendar interoperability and database/query/form/report cases.
  Until then, disclose those areas outside the preview scope.
- **Accessibility/privacy:** complete keyboard and two-screen-reader passes,
  high contrast and 200% zoom. With remote features disabled and non-loopback
  traffic blocked, perform five local workflow cycles in each editor and
  inspect traffic; separately document every user-enabled remote feature.
- **Performance/AI:** record cold and repeated warm measurements with raw
  p50/p95 and all-process memory. Reject unexplained p95 regressions over
  10% versus a same-machine upstream build. Establish specific Office speed
  claims with quality-equivalent workloads and confidence intervals. Evaluate
  AI on at least 30 fixed tasks with five runs each, a blinded rubric and
  explicit provider, entitlement and data-flow context.

## Official Microsoft references

Microsoft documents [Word compatibility behavior](https://support.microsoft.com/en-us/word/compatibility-changes-between-versions),
[Excel functions](https://support.microsoft.com/en-us/excel/excel-functions-alphabetical),
[VBA macros](https://support.microsoft.com/en-us/excel/run-a-macro-in-excel) and
[PivotTables](https://support.microsoft.com/en-us/excel/get-started/create-a-pivottable-to-analyze-worksheet-data).

The presentation baseline includes [animation timing](https://support.microsoft.com/en-us/powerpoint/apply-multiple-animation-effects-to-one-object)
and [supported media](https://support.microsoft.com/en-us/powerpoint/video-and-audio-file-formats-supported-in-powerpoint).
The wider suite includes [co-authoring](https://support.microsoft.com/en-us/excel/get-started/collaborate-on-excel-workbooks-at-the-same-time-with-co-authoring),
[Outlook workflows](https://support.microsoft.com/en-us/outlook/basic-tasks-in-outlook) and
[Access database objects](https://support.microsoft.com/en-us/access/learn-the-structure-of-an-access-database).

Microsoft's [accessibility rules and limitations](https://support.microsoft.com/en-us/accessibility/office-accessibility/rules-for-the-accessibility-checker),
[offline/edition comparison](https://support.microsoft.com/en-gb/accounts-billing/subscriptions/compare-microsoft-365-and-office-plans),
[enterprise privacy controls](https://learn.microsoft.com/en-us/microsoft-365-apps/privacy/manage-privacy-controls)
and [required service data](https://learn.microsoft.com/en-us/microsoft-365-apps/privacy/required-service-data)
define separate comparison dimensions. Installed Office can work offline
after activation; product and configured policy matter.

Recovery comparisons distinguish [AutoSave/history and AutoRecover](https://support.microsoft.com/en-us/office/collab-files/save-back-up-and-recover-a-file-in-microsoft-office)
from [unsaved-document recovery](https://support.microsoft.com/en-us/word/recover-an-earlier-version-of-a-word-file).
Use [Excel calculation measurement guidance](https://learn.microsoft.com/en-us/office/vba/excel/concepts/excel-performance/excel-improving-calculation-performance)
for reproducible timings. AI comparisons must record [Copilot feature entitlement](https://support.microsoft.com/en-us/word/copilot/edit-rewrite-content)
and [account/privacy context](https://support.microsoft.com/en-us/privacy/copilot-in-microsoft-365-apps-for-home-your-data-and-privacy).
These official pages were researched on 2026-10-28; recheck changing features
and entitlements before publishing a comparative claim.

## Static workspace review

The review corrected named command controls at narrow widths, grouped and
named editor launchers, duplicate-action handling without discarding keyboard
focus, inspection completion/previous-result messages, recovery count/search
feedback and binary size units. The existing recents, folders, search and
settings remain connected to the original Home callbacks. English creation
labels retain localized legacy titles as command-search aliases, and the
localized greeting declares its language.

Static review cannot establish screen-reader behavior or all focus/timing
interactions. The corresponding E2E cases and manual accessibility gates
remain required. No fake inspector result, vault entry, metric or popularity
count was introduced by the workspace.
