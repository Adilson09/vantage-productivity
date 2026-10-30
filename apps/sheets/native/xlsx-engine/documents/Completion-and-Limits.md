# Spreadsheet backend: implemented capabilities and limits

Status recorded on 2026-10-29. The backend has a Rust document authority, native
calculation and package verification, plus a shared TypeScript OOXML writer used
by the desktop application and the headless Node/Python clients. This is a working
implementation with explicit compatibility limits. It is not full Excel parity,
an entirely Rust OOXML editor, or a completed public-release acceptance gate.

## Ownership and document lifecycle

| Component                                                            | Responsibility                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Rust `document.rs` / `document_store.rs`                             | Complete typed pending document state, revisions, command receipts, immutable snapshots, memory or SQLite persistence |
| Rust `document_backend.rs` / `document_calculation.rs` / `recalc.rs` | Source-bound calculation leases, typed calculation input/output, bounded IronCalc evaluation and cache provenance     |
| Shared Node writer and `packages/xlsx-gateway`                       | Materialize supported document changes into preserving OOXML packages                                                 |
| Rust `preservation.rs`                                               | Compare source/output parts and internal relationships before publication                                             |
| Desktop/headless host                                                | Validate the full application DTO, own paths/passwords/readers, coordinate recovery and atomic publication            |
| Python `aster` package                                               | Trusted bulk automation over the headless host; Python does not become an engine runtime                              |
| Optional C ABI                                                       | Synchronous, versioned access to native JSON commands with explicit handle/buffer ownership                           |

The complete document API is separate from the older value-input transaction API,
which remains available for compatibility. Native transport v1, document API v1
and C ABI v1 are separately versioned. The complete native commands are
`open_document`, `checkpoint_document`, `document_snapshot`,
`document_command_result`, `recalc_document` and `close_document`.
`audit_preservation` provides the read-only package gate. Query `capabilities`
instead of assuming an installed worker exposes every command.

A document binds an immutable ID, source SHA-256 fingerprint and original stable
sheet descriptors. Current additions, duplicates, renames, removals and tab order
travel in the document payload. A checkpoint replaces the **complete pending
payload** against that original base; it is not a partial patch. Start from the
current snapshot when updating only some fields. Values, formulas, style deltas,
rich text and the supported table/chart/pivot/name/protection/metadata families
retain their JSON types. Operational fields such as output paths, passwords,
reader session IDs and save modes do not belong in a checkpoint.

The host validates the existing full document DTO; Rust separately checks the
top-level allowlist, source/sheet identity, structural and cell shapes, ranges and
resource bounds. Validation and persistence complete before the new revision,
receipt index or snapshot is published. Each newly accepted command advances the
revision. SQLite uses an atomic head update and receipt append with revision
comparison, WAL and FULL synchronization. A stale writer cannot silently replace
another writer's head. Memory stores return `durable: false`.

A command ID and canonical SHA-256 request hash provide idempotency. Repeating
the identical command returns its original receipt, even when its expected
revision is now old. Reusing that ID with changed payload, actor or expected
revision conflicts. An unknown acknowledgment should be reconciled with the
same sealed command; do not invent a new ID and assume the first command failed.
There is no automatic conflict merge or collaborative editing protocol.

## Calculation and cache provenance

Calculation reads one acknowledged document revision. Leases are invalidated by
later checkpoints or close, and source fingerprints are checked around native
calculation. Simple value/formula changes can project directly into the native
model. Structure, names, tables, formatting, rich text and other metadata changes
require a private, revision-pinned export through the preserving writer. Hosts
also use materialization when direct overlay expansion exceeds its budget. The
native API returns a typed error when required materialization is absent; it does
not silently calculate using obsolete workbook metadata.

Text `"12"`, number `12`, text `"TRUE"`, boolean `true`, empty text and blank
remain distinct. The calculation-only user-input encoding is never used to
reconstruct saved document values. Results include raw `value`
(`number | boolean | string | null | {error: string}`), display `formatted`,
`isFormula` and error information. Display text is not a reliable source of type.

An engine-produced preview alone does not authorize replacement of Excel's
stored formula caches. Native results include:

- `cacheWritebackAllowed`: permission to retain derived values for save;
- `calculationCompleteness`: `complete` or `unverified`;
- `cacheWritebackReasons`: bounded diagnostic reason codes.

The check examines the whole imported/edited model, not only the requested
viewport. It retains evidence when imported formulas are pinned to cached values.
Unsupported functions, unresolved names, parse failures, array/dynamic metadata,
uncertified syntax, inspection budgets and known engine gaps withhold write-back.
This covers hidden failures such as an out-of-viewport unsupported precedent
being masked by `IFERROR(...,0)`.

The current conservative certification subset includes scalar literals and cell
references, basic arithmetic/comparison/concatenation, static `SUM` ranges and
selected scalar logical/error/type predicates. A recognized function is not
necessarily certified: `ROUND` is currently uncertified; `CELL`, `INFO` and `RATE`
are explicit known-gap cases. Names, tables, arrays, dynamic references, locale
behavior and the wider Excel function library are not generally certified.
Even `complete` describes this implementation's checks, not independent proof of
Excel equivalence or a promise of universal numerical agreement.

Headless cache retention requires coherent explicit permission, `complete` and
an empty reason list. Missing, denied or inconsistent provenance clears prior
derived state for that revision and returns `cacheWriteback: "withheld"`.
Python combines provenance across all requested pages. Withheld results remain
unverified previews; reads/saves preserve original or explicitly supplied caches.
Only requested, certified formula cells gain new derived caches. A checkpoint or
restart requires recalculation before relying on new derived state.

## Preserving saves and recovery

The host pins the acknowledged typed payload, materializes it through the shared
writer, audits the completed private package, rechecks revision/source guards,
and publishes atomically. Multi-phase structural saves bind surviving and new
stable sheet IDs to the actual reopened sheet names before applying dependent
tables, pivots and scoped names. Missing or ambiguous bindings fail before final
publication. Unsupported operations and protected macro/opaque cases remain
conservative refusals instead of a promise to rewrite arbitrary OOXML safely.

The native preservation report streams SHA-256 hashes for untouched original
parts, identifies changes/additions/removals, and checks known internal
relationship targets. Existing dangling relationships are distinguished from
newly introduced failures. External relationship targets are counted but never
fetched. Protected VBA, signature, ActiveX/control, custom XML, embedding and
unknown opaque content cannot be changed merely by adding it to a host allowlist.
This is package preservation evidence, not validation of every producer-specific
XML semantic or executable component.

`preserved: true` does not mean a digital signature is valid. Package signatures
are reported as unverified and can be invalidated by edits even when signature
parts remain byte-identical. Preserved VBA signature bytes are also not
cryptographically verified. No macros, controls or embedded objects are executed.

Acknowledged pending recovery is retained on ordinary headless close; explicit
discard or a successful clean handoff retires it according to the host lifecycle.
Recovery checks original identity and source changes, and restoring a candidate
creates pending state rather than overwriting the original automatically.
Password-protected workbooks use memory-only checkpoints and private decrypted
working files while open; unsaved protected edits have no persistent plaintext
restart-recovery guarantee. Hosts must own and clean their private directories.

Saving can publish successfully and then fail to reopen a replacement reader.
Callers must inspect the result: the headless save receipt can have `handle: null`
with warnings, requiring an explicit open of the saved path. A save acknowledgment
and a usable post-save reader are separate outcomes.

## Resource and history limits

| Boundary                               | Current limit/behavior                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Complete native checkpoint             | 256 MiB serialized JSON, depth 64, up to 10,000,000 typed cell entries; individual DTO families impose smaller caps |
| Host inline save edits                 | 1,000,000; existing transfer routes have their own bounds                                                           |
| Direct document calculation projection | 1,000,000 unique inputs, 256 MiB encoded inputs and bounded overlap scanning; materialization can avoid expansion   |
| Legacy input calculation               | 10,000 edits                                                                                                        |
| Calculation result/read request        | At most 20,000 cells; clients page larger requests                                                                  |
| Retained immutable snapshots           | Latest 16 in memory; an already leased `Arc` stays valid after eviction                                             |
| Formula certification                  | Bounded AST and source-metadata inspection; exhaustion withholds cache write-back                                   |
| Package hash audit                     | Bounded decompressed work, currently 8 GiB total, plus ZIP/XML-specific limits                                      |
| Native ABI input                       | 256 MiB plus 1 MiB framing, with smaller per-command limits still enforced                                          |

These are refusal ceilings, not performance claims or evidence that a particular
machine can process the maximum within an interactive deadline. Full document
checkpoints still serialize and persist a complete current payload; paging and
compact fills do not turn this into an out-of-core formula engine.

The durable store retains the latest full snapshot and ordered command receipts.
Receipts and their lookup index grow with accepted commands; journal compaction
and a bounded receipt-retention policy are not implemented. Receipt history is
not a complete operation-delta audit trail, arbitrary historical snapshot
restoration, or unlimited undo. Older in-memory snapshots may be unavailable;
restart recovery restores the durable head, not the previous 16 snapshots.

There is no VBA runtime, COM/Excel automation layer, embedded Python runtime,
untrusted-script sandbox, Arrow/zero-copy interchange, universal Excel function
coverage or full Excel/Office feature parity. Python runs with its caller's
permissions. The Node host is a trusted local process, not an authenticated
network service. The native C ABI similarly trusts caller pointers and cannot
contain invalid pointer access, process aborts or out-of-memory termination.
See [ABI.md](ABI.md) for ownership and threading rules and
[the Python README](../../../python/README.md) for the automation API.

## Reproduce the checks

The following PowerShell examples start at the repository root and require its
installed dependencies, Node 24+, the Rust toolchain and Python 3.10+. Choose
dedicated absolute private paths and a native binary matching the host/platform.
These commands document separate opt-in checks; bundling does not run acceptance.

```powershell
npm run native:build -w @vantage/sheets
npm run backend:bundle -w @vantage/sheets
$repo = (Get-Location).Path
$worker = Join-Path $repo 'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe'
$backendHost = Join-Path $repo 'apps/sheets/dist/backend/spreadsheet-backend.cjs'
node $backendHost --binary $worker --data C:/private/sheet-sdk/data --temp C:/private/sheet-sdk/temp
```

The bundled host has no Electron runtime requirement; it still requires Node and
the matching native sidecar. Its stdin/stdout protocol is one JSON object per
line; diagnostics use stderr. The source host can instead run through
`npm run backend:host -w @vantage/sheets -- --binary <absolute-path> --data <absolute-path> --temp <absolute-path>`.
Python source-host use needs the `tsx` loader; bundled-host use sets `node_args=()`.

```powershell
npm run native:test -w @vantage/sheets
python -m unittest discover -s apps/sheets/python/tests -v
$env:SHEET_BACKEND_TEST_BINARY = $worker
Push-Location apps/sheets
npx vitest run tests/document-backend-native.integration.test.ts --maxWorkers=1
Pop-Location
Remove-Item Env:SHEET_BACKEND_TEST_BINARY
python apps/sheets/python/tests/run_native_smoke.py --node C:/runtime/node.exe --host $backendHost --binary $worker --work-dir C:/private/sheet-native-smoke --output C:/private/sheet-native-smoke/receipt.json
```

The real-host script creates only synthetic fixtures and private outputs. Its
retained `ffi-fixture.xlsx` has first-sheet A1=10 and B1=`A1*2` with cached 20,
and is kept unchanged for the separate actual-library probe:

```powershell
cargo rustc --release --locked --manifest-path apps/sheets/native/xlsx-engine/Cargo.toml --features native-ffi --crate-type cdylib --lib
python apps/sheets/native/xlsx-engine/scripts/verify_ffi.py --library C:/build/xlsx_sidecar.dll --workbook C:/private/sheet-native-smoke/ffi-fixture.xlsx --work-dir C:/private/sheet-ffi-probe
```

Use the actual library output path and architecture; the DLL is optional and does
not replace the Node writer. `verify_ffi.py` checks version/handles/buffers, typed
calculation, memory/durable checkpoints and SQLite reopening with a bounded child
process. Read its JSON receipt rather than treating library loading as a pass.
To include native ABI unit tests, add `--features native-ffi --lib` to a direct
`cargo test` invocation. Ordinary desktop builds do not enable the ABI feature.

## Verification records

The release candidate carries a separate evidence manifest with the exact source
and production artifact hashes, latest executed test cases, and actual Python
and native-library probe receipts. Read those records for the verified counts
and outcomes; the presence of a test script alone does not establish a pass.

The checks cover the native core and optional ABI, selected backend and renderer
contracts, nine real-process OOXML scenarios, the Python SDK's fake-process
transport contracts, and actual bundled-host and library operation. Desktop
recovery acceptance uses a separate scratch profile and synthetic workbooks.
Overlapping test runs must not be summed, and focused checks do not represent
every repository test or exhaustive Excel compatibility.

Calculation imports normalize structural XML trivia in a guarded private copy
because the upstream importer treats indentation and comments as list entries.
The original package, literal strings, formulas, CDATA, entities, inherited
`xml:space`, and unknown extension scopes remain intact. Dedicated regressions
check valid pretty-printed workbook, style and string parts, unchanged source
bytes, bounded processing, and resident-model reuse.
