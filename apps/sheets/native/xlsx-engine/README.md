# Spreadsheet Rust backend

`xlsx-sidecar` is the Rust workbook import, calculation, archive-writing, and
revisioned input service used by the desktop spreadsheet app. The new editing
layers preserve the existing interface and workbook package design.

## Modules and desktop integration

| Module                                         | Responsibility                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `transaction.rs`                               | Typed operations, whole-batch validation, bounded input overlays, canonical command hashing.                           |
| `session.rs`                                   | One in-process writer per workbook ID, revisions, immutable snapshots, command replay, persistence-before-publication. |
| `snapshot.rs`                                  | Stable worksheet IDs, entered-input overlays, and SDK coordinate types.                                                |
| `store.rs`                                     | Desktop SQLite recovery, revision fencing, and durable command receipts. Excluded on `wasm32`.                         |
| `edit_backend.rs`                              | Source-byte fingerprints, store binding, workbook lifetimes, and calculation leases.                                   |
| `recalc.rs`                                    | Resident IronCalc models and formula evaluation against a complete input overlay.                                      |
| `protocol.rs`                                  | Versioned JSON-lines requests and asynchronous calculation responses.                                                  |
| `workbook.rs`, `worksheet.rs`, related readers | Streaming import, indexing, and existing workbook metadata/features.                                                   |
| `archive.rs`                                   | Native ZIP publication that copies untouched compressed members.                                                       |

The desktop main process routes the existing Rust calculation fallback through
`open_edit_session`, `apply_transaction`, and `recalc_snapshot`. It serializes a
tab's cumulative inputs as `replace_inputs`, skips an already acknowledged
identical overlay, and keeps the same command ID when an outcome is uncertain.
Window/session ownership checks remain in the main process; the renderer does
not choose source or journal paths.

This is an input transaction backend, not a replacement of the entire desktop
stack. Univer remains the primary interactive grid and calculation path.
TypeScript still plans OOXML changes for save/export, including styles and
structural features, before the Rust archive writer publishes the package.
Those existing preservation paths must remain in use. A successful input
transaction does not mean an XLSX file has been saved.

## Build and check

From `apps/sheets`, with Rust/Cargo and the platform's native build tools:

```sh
cargo build --release --locked --manifest-path native/xlsx-engine/Cargo.toml --config native/xlsx-engine/.cargo/config.toml
cargo test --release --locked --manifest-path native/xlsx-engine/Cargo.toml --config native/xlsx-engine/.cargo/config.toml
cargo test --release --locked --features single-thread --manifest-path native/xlsx-engine/Cargo.toml --config native/xlsx-engine/.cargo/config.toml
```

The equivalent package scripts are `npm run native:build` and
`npm run native:test`. Use the checked-in `Cargo.lock`; record the compiler and
target in release provenance. On Windows, use an MSVC developer environment
with a Windows SDK. The explicit config enables the static MSVC runtime for
x64/ARM64. Keep `--config` when building from `apps/sheets`: Cargo does not
discover the crate's config merely from `--manifest-path`.

`single-thread` exercises inline indexing/calculation, useful for embedded
targets. The Rust transaction core supports an in-memory store without SQLite
on WebAssembly; this does not by itself establish that every target/toolchain
combination has been built or validated.

Changes under `apps/sheets/src/main` also require rebuilding the desktop shell.
Native tests cover transaction atomicity, recovery and replay, competing writers,
calculation leases, protocol validation, and existing workbook behavior. See the
release's validation report for actual results; this README makes no test-count
or performance claim.

## JSON-lines API

Start `target/release/xlsx-sidecar` (`.exe` on Windows) and send one JSON object
per stdin line. Responses are one JSON object per stdout line. Each response
contains `version`, `requestId`, `ok`, and either `result` or `error`. Match
responses by `requestId`; calculation runs on a worker and can finish after a
later synchronous request. Embedded callers can use `protocol::Engine`.

The transport remains `version: 1`. Editing commands separately require
`apiVersion: 1`. Editing payloads reject unknown top-level fields; transaction
operations are also strict. Calculation reads reuse the legacy read types.
Paths below are examples; use an immutable local copy of the imported source
and an app-owned local journal path.

Open an input authority. The host supplies stable sheet IDs matching its import
metadata; the backend hashes the actual source bytes:

```json
{
  "version": 1,
  "requestId": "open-1",
  "command": "open_edit_session",
  "apiVersion": 1,
  "workbookId": "book-7",
  "sourcePath": "C:/Documents/book.xlsx",
  "storePath": "C:/LocalData/Spreadsheet/book-7.sqlite",
  "sheets": [{ "id": "sheet-1", "name": "Sheet1" }]
}
```

The result contains `apiVersion`, `workbookId`, `revision`,
`sourceFingerprint`, and `recovered`. A new authority starts at revision zero.
Omit `storePath` for memory-only operation.

Commit one atomic batch against the expected revision:

```json
{
  "version": 1,
  "requestId": "apply-1",
  "command": "apply_transaction",
  "apiVersion": 1,
  "workbookId": "book-7",
  "commandId": "command-51",
  "expectedRevision": 0,
  "actor": "desktop",
  "operations": [{ "type": "set_cell", "sheetId": "sheet-1", "row": 0, "column": 0, "input": "21" }]
}
```

Example durable receipt:

```json
{
  "version": 1,
  "requestId": "apply-1",
  "ok": true,
  "result": {
    "apiVersion": 1,
    "workbookId": "book-7",
    "commandId": "command-51",
    "revision": 1,
    "changed": 1,
    "durable": true
  }
}
```

Supported operations are `set_cell`, `clear_range`, and `replace_inputs`.
`replace_inputs` supplies the complete pending overlay as
`edits: [{sheetId,row,column,input}]`, including formulas as entered strings.
An empty input explicitly clears an imported cell. Omitting an address from a
replacement overlay restores the imported input, which supports undo.
`changed` counts overlay addresses whose pending input changed; it is not a
count of calculated or exported cells.

Read a snapshot, calculate its inputs, or discover an earlier command outcome:

```json
{"version":1,"requestId":"snapshot-1","command":"snapshot","apiVersion":1,"workbookId":"book-7","revision":1}
{"version":1,"requestId":"calculate-1","command":"recalc_snapshot","apiVersion":1,"workbookId":"book-7","revision":1,"reads":[{"sheet":"Sheet1","range":{"startRow":0,"endRow":1,"startColumn":0,"endColumn":0}}]}
{"version":1,"requestId":"receipt-1","command":"command_result","apiVersion":1,"workbookId":"book-7","commandId":"command-51"}
{"version":1,"requestId":"close-1","command":"close_edit_session","apiVersion":1,"workbookId":"book-7"}
```

Omitting `revision` from `snapshot` returns the latest snapshot.
`command_result` returns the original receipt or `null` for an unknown command.
Closing a native authority releases it; closing through the desktop host also
retires that tab's private recovery state.

### Coordinates and ranges

All new cell addresses are zero-based. The new `clear_range` SDK operation uses
**half-open** ranges: `startRow:0,endRow:2,startColumn:0,endColumn:1` means A1:A2.
Empty or reversed SDK ranges are rejected.

Legacy import/recalculation range requests retain **inclusive** end coordinates.
This includes the `reads` in `recalc_snapshot`: its example above also means
A1:A2 because `endRow` is 1 and `endColumn` is 0. Do not pass an SDK range
directly to a legacy read without translating its ends.

## Transactions, recovery, and calculation

- A new accepted command advances the revision exactly once, even for a no-op.
  The complete batch is validated before any candidate becomes authoritative.
  Validation or storage failure leaves the prior input snapshot and revision.
- `commandId` identifies a mutation; `requestId` only correlates transport.
  Retrying the same command ID and typed payload returns the original receipt,
  including after recovery. Reusing an ID with different inputs, actor, or
  expected revision is an `idempotency_conflict`. After a timeout, query
  `command_result` or retry the unchanged command, not a newly generated ID.
- SQLite enables WAL, `synchronous=FULL`, foreign keys, and a busy timeout.
  A single immediate transaction updates the latest snapshot and appends its
  immutable command receipt. A conditional prior-revision check fences stale
  writers. The commit completes before the Rust session publishes its revision
  or acknowledges `durable: true`. This relies on the OS/storage honoring flushes.
- The session indexes command IDs for replay and outcome lookup. The SQLite
  and memory stores append one new receipt without cloning or scanning prior
  receipts on each edit. SQLite recovery still reads and validates the full
  receipt sequence once when reopening a workbook; receipt history remains in
  session memory. Each commit also validates and writes the complete current
  input overlay, so this is not a constant-cost edit or a measured latency claim.
  Custom stores that implement only `load` and `commit` retain the compatible
  full-candidate fallback until they implement the optional append path.
- Recovery binds a workbook ID to the source SHA-256 and sheet descriptors.
  Identical source bytes can move to a different cache path. Changed source or
  sheet identity is rejected rather than silently merging unrelated inputs.
  The journal must be local, app-owned, and separate from the source workbook;
  it is not an XLSX file or a shared/network database.
- The desktop host omits the plaintext SQLite store for password-protected
  workbooks. Their input transactions remain revision checked but return
  `durable: false`; a lost native process rebuilds them from the live renderer's
  complete overlay. SQLite journals are not encrypted credential vaults.
- A calculation leases an immutable input revision. New edits, close, or source
  changes invalidate its publication; successful results carry `workbookId` and
  `revision`. A durable edit receipt is separate from calculation completion.
- The open authority retains at most 16 addressable input snapshots. Existing
  `Arc` leases remain immutable after eviction. Recovery loads the latest
  snapshot and command receipts, not historical input snapshots.

Representative machine errors include `revision_conflict` with
`currentRevision`, `idempotency_conflict`, `persistence_conflict`,
`source_conflict`, `source_changed`, `stale_revision`, and `storage_error`.
`invalid_json` covers malformed/unknown request fields; `invalid_request`
covers typed input validation. Native resource limits currently include 10,000
overlay inputs/expanded transaction cells, 8 MiB of input text, and 20,000
calculation read cells. These are processing safeguards, not measured scale
guarantees.

## Scope and dependencies

The desktop adapter can recover a restarted native child while the application
still holds its workbook identity and snapshot. Automatic discovery/restoration
of these journals after a full application restart is not implemented. This
store is neither a complete undo history nor collaboration/cloud persistence.
Python execution, VBA execution, COM, a public C ABI, HTTP services, and ERP
connectors remain future work. Existing formula/import compatibility limits
apply; there is no claim of full Excel compatibility or measured p95 latency.

The backend application code is Rust, licensed Apache-2.0 as declared in
`Cargo.toml`. Desktop persistence uses MIT-licensed `rusqlite` and
`libsqlite3-sys`, which bundle SQLite's C implementation (public-domain source).
That native dependency does not make this a C++ spreadsheet backend. Preserve
dependency notices and run the repository's license checks when distributing
the sidecar; `deny.toml` contains the license policy.
