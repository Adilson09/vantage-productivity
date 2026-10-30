# Vantage Sheets Backend — release candidate

This package marks the **complete-core milestone** for the spreadsheet backend:
Rust owns complete typed document revisions, receipts, recovery and calculation;
the shared Node adapter writes supported OOXML changes and audits the completed
package before atomic publication. The Python client provides trusted bulk
automation through that same host. This is a backend runtime package, not a new
desktop installer or a claim of full Microsoft Excel/Office parity.

Source label: Vantage Sheets Backend release candidate, 2026-10-30
Bundled Node runtime: v24.19.0

## Start a local host

Open PowerShell in this extracted folder and choose separate private data and
temporary directories. The host takes one JSON object per stdin line and writes
correlated JSON responses to stdout; diagnostics use stderr. No HTTP server is
started.

```powershell
$package = (Get-Location).Path
& "$package/runtime/node.exe" "$package/runtime/spreadsheet-backend.cjs" --binary "$package/runtime/xlsx-sidecar.exe" --data C:/private/aster-sheets/data --temp C:/private/aster-sheets/temp
```

A request such as `{"requestId":"hello","command":"capabilities"}` describes
the installed host's operations. Open workbooks using absolute paths. Supported
headless package formats are XLSX and XLSM; keep the original format on save.

## Use Python

Python 3.10+ is required separately. The SDK itself has no third-party Python
runtime dependencies. The included example requires explicit input/output and
private working paths:

```powershell
python examples/use_backend.py --input C:/work/input.xlsx --output C:/work/output.xlsx --data C:/private/aster-python/data --temp C:/private/aster-python/temp
```

It demonstrates a single bulk transaction, revision-bound calculation and save
to a separate output. See python/README.md for types, metadata, retries, recovery
and stale-handle rules. Python runs with its caller's permissions; it is not an
embedded workbook language or an untrusted-code sandbox.

The explicit synthetic acceptance script can be run separately if desired:

```powershell
python python/tests/run_native_smoke.py --node "$package/runtime/node.exe" --host "$package/runtime/spreadsheet-backend.cjs" --binary "$package/runtime/xlsx-sidecar.exe" --work-dir C:/private/aster-smoke --output C:/private/aster-smoke/receipt.json
```

Assembly does not run this check. It creates only its own synthetic workbook and
private outputs when explicitly invoked. The optional native DLL and C header are included. Read docs/native/documents/ABI.md before using them.

The matching MSVC import library is included at runtime/xlsx_sidecar.dll.lib. Define ASTER_SHEET_SHARED before including aster_sheet.h and link that .lib for normal C/C++ DLL imports. See docs/native/documents/MSVC-Linking.md for the packaged linking
paths; the copied ABI guide retains the full handle and buffer ownership rules.

## Evidence and integrity

Start with **evidence/evidence-index.json** and the coordinator-provided validation
manifest linked there, if supplied. Reports are copied as selected; the assembler
does not infer pass/fail or replace earlier reports with a fixed test-count claim.
Read each report for its actual command, scope, skips, failures and artifact
coverage. A successful source test is not by itself an acceptance test of these
packaged binaries.

manifest.json records the exact copied runtime/SDK/docs/evidence bytes and SHA-256
digests; SHA256SUMS.txt provides the same file inventory. These inventories omit
themselves to avoid circular hashes. They provide integrity checks, not a code
signature or third-party certification. If a ZIP was requested, its SHA-256 is
written next to that archive.

## Current limits

- Formula previews are not automatically safe cache replacements. Native
  whole-model provenance must explicitly permit write-back with complete status
  and no reason codes. Unsupported/uncertified formulas, hidden precedents,
  names, arrays, known engine gaps or inspection limits can withhold it.
- When write-back is withheld, original/explicit input caches are preserved.
  Only requested, certified formula cells gain new derived caches. Certification
  is conservative and is not a guarantee of universal Excel equivalence.
- The preserving OOXML writer supports the existing document DTO families;
  unsupported edits are refused. Package preservation does not validate every
  producer-specific XML semantic or prove digital signatures remain valid.
- Normal close retains acknowledged pending recovery. Explicit discard or
  successful save retires it; clean revision-zero sessions are cleaned up.
  Protected documents use memory-only checkpoints and private decrypted working
  files while open; unsaved protected edits have no persistent restart recovery.
- Requests have resource limits, including 20,000-cell read/calculation viewports.
  Full checkpoints serialize current payloads. Receipt history grows; compaction,
  unlimited history, collaboration and arbitrary snapshot recovery are absent.
- There is no VBA runtime, COM layer, embedded Python runtime, Arrow/zero-copy
  transport or authenticated network service. The optional native DLL and C header are included. Read docs/native/documents/ABI.md before using them.

Read docs/native/documents/Completion-and-Limits.md for the full implemented
contract and limits. Native code, OOXML adapter and client remain separate layers.

## Notices

Available project and component licenses/notices are retained under notices/;
the Node notice is from its matching official version. Additional explicit
component notices can be supplied to the assembler. This package does not claim
comprehensive legal certification. Original author/license notices remain intact.
