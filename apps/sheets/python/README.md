# Aster spreadsheet Python client

This package lets trusted Python programs edit Aster workbooks through the same Rust document authority and OOXML writer used by the desktop app. The Python runtime dependencies are the standard library. The local Node host, its workspace dependencies and a matching Rust sidecar binary are also required. This client uses the Node JSON-lines host, rather than loading the separate native C ABI, so it can reuse the full document save and preservation adapter.

Python code runs in the caller's own process with the caller's permissions. This is a trusted automation SDK; it does not embed Python in the workbook engine, execute workbook scripts, or provide an execution sandbox. Values cross the process boundary as UTF-8 JSON batches. There is no Arrow or zero-copy transport.

Install from this directory with `python -m pip install .`, or add this directory to `PYTHONPATH` for source development. Use Python 3.10 or newer. All configured executable and directory paths must be absolute. Install the repository's JavaScript dependencies before launching its TypeScript source host.

```python
from pathlib import Path
from aster import EngineSession

repo = Path(r"C:\source\aster-office")
with EngineSession(
    node=r"C:\runtime\node.exe",
    host=repo / "apps/sheets/scripts/spreadsheet-backend-host.ts",
    binary=repo / "apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe",
    data=r"C:\private\aster-python\data",
    temp=r"C:\private\aster-python\temp",
    cwd=repo / "apps/sheets",
) as sh:
    wb = sh.open_workbook(r"C:\work\budget.xlsx")
    with wb.transaction(expected_revision=wb.revision, command_id="budget-import-001") as tx:
        tx.range("Budget", "A1:B3").set_values([
            ["Item", "Amount"],
            ["Travel", 120],
            ["Meals", 35.5],
        ])
        tx.range("Budget", "B4").set_formula("=SUM(B2:B3)")
        tx.range("Budget", "A1:B1").set_style({"bold": True})
    calculated = wb.calculate_and_wait([("Budget", "B4")])
    rows = wb.sheet("Budget").read("A1:B4")
    result = wb.save(r"C:\work\budget-updated.xlsx")
    wb.close()
```

The built Windows worker is named `xlsx-sidecar.exe`; pass its actual packaged or build path for your installation. For an already bundled JavaScript host, pass `node_args=()` to omit the source development `--import tsx` loader.

## Transactions and types

`wb.sheet(name_or_id)` accepts a sheet name or its stable ID. `wb.snapshot()` returns the complete native revision and typed pending document payload. A transaction starts from that snapshot, edits the detached payload locally, then sends **one** `checkpoint` RPC. It does not send a request for each cell. Text such as `"12"` stays text; numbers, booleans and `None` remain distinct. NaN, infinity, integers outside JavaScript's exact integer range, ragged matrices and mismatched rectangles are rejected before mutation submission.

After a successful commit or current snapshot refresh, `wb.sheets` and `wb.sheet(...)` reflect all committed add, duplicate, rename, remove and tab-order operations before save. These names map to the original stable authority IDs; a stale `Sheet` object for a renamed or removed worksheet must be selected again. Calculation uses the current committed names.

Range strings use A1 notation, with the sheet supplied separately. Numeric ranges use zero-based, half-open bounds: `Bounds(0, 0, 3, 2)` or `(0, 0, 3, 2)` is A1:B3. Empty and out-of-worksheet ranges are rejected. `set_formula` assigns the same formula text to each selected cell; it does not auto-adjust relative references. Formula results remain subject to the installed Rust formula engine's supported functions.

`calculate_and_wait()` returns typed preview values with `calculationCompleteness`, `cacheWritebackAllowed`, `cacheWriteback` and `cacheWritebackReasons`. The SDK combines this metadata across every requested page. Only an explicitly certified complete result may update the revision's derived formula cache. Subsequent reads and saves include certified values without creating another input revision. Unsupported, uncertified, parser/name/array or known engine gaps anywhere in the model can withhold write-back even when the visible result appears numeric, such as `IFERROR` returning zero for an unsupported precedent outside the viewport. The certification whitelist is deliberately narrower than the functions the engine can evaluate.

When `cacheWriteback` is `"withheld"`, inspect the reason codes and treat the returned calculation cells as unverified previews. Earlier derived values for that revision are invalidated; reads and saves preserve the original or explicitly supplied input caches instead of publishing a potentially false result. A newer checkpoint invalidates the revision's derived state; after process restart, recalculate recovered inputs before relying on new formula results. Formula cells outside the requested calculation ranges keep their existing stored caches.

`set_style` merges the pending style delta with any pending value edit. `clear()` clears contents while retaining style; `clear(formats=True)` also resets cell formatting. The convenience functions in `aster.cmds` accept the same transaction object, so they share its single commit.

`tx.set_metadata(field, value)` replaces a supported document DTO array or state, such as `structuralOps`, `sheetOps`, `tableAdditions`, `noteStates`, `sheetOrder` or `definedNamesState`. It preserves all other snapshot families. The host validates the existing desktop DTO contracts; this method does not translate arbitrary Python objects into table/chart definitions. After structural changes, supply cell coordinates in the final layout expected by those DTOs. The shared save pipeline maps stable IDs after reopening its private structural phase, including supported tables and pivots on newly added or duplicated sheets. Missing or ambiguous worksheet bindings fail before final publication. Original paths, output paths and transport handles cannot be inserted as metadata.

For retry control, keep the transaction object:

```python
tx = wb.transaction(command_id="stable-import-002")
tx.range("Budget", "C1").set_values([["pending"]])
try:
    receipt = tx.commit()
except Exception:
    # Inspect the typed failure and retry only when appropriate.
    # tx.commit() reuses the exact same payload, expected revision and command ID.
    raise
```

After the first commit attempt the payload is sealed. A successful repeated `commit()` returns its receipt without another RPC. A real revision conflict requires a new transaction from a current snapshot and a new command ID; the SDK never rebases silently. An unknown acknowledgment can be reconciled by retrying the same transaction while the host session remains available.

## Reads, saves and recovery

Reads use viewport requests of at most 20,000 cells, split by rows. `read` assembles a Python matrix; use `iter_read_pages` to consume large ranges without assembling the complete matrix. Calculation requests are similarly bounded and pinned to one document revision. They are bulk calls rather than per-cell RPC.

Saving audits the complete materialized package before publication, checks source/destination changes and returns the native preservation report. A successful save replaces the old native handle with a clean handle; the `Workbook` object adopts it automatically. Previously obtained `Sheet` objects and transactions become stale, and must be reacquired. This prevents a pending payload from being applied twice. If publication succeeds but reopening fails, the receipt has `handle: None`; inspect its warnings and explicitly open the saved file again.

Closing a workbook or engine session retains acknowledged pending recovery checkpoints by default. Only `wb.close(discard=True)` explicitly discards its recovery. An engine context manager closes its own stdin, lets the host shut down, and reaps the child it launched. A request timeout poisons the connection so late responses cannot be mistaken for later results; the outcome of that request may be unknown. Closing allows a grace period, then terminates its owned host if necessary. It never retries a timed-out mutation with a fresh command ID.

For a new engine session using the same private data directory, inspect candidates and choose explicitly:

```python
candidates = sh.candidates(r"C:\work\budget.xlsx")
# Select only after inspecting the candidate's original path and conflict state.
recovered = sh.recover(candidates[0]["id"], r"C:\work\budget.xlsx")
snapshot = recovered.snapshot()
# Restore creates a pending handle; it does not publish over the original.
recovered.save(r"C:\work\budget-recovered.xlsx")
```

Do not automatically select the first candidate in a production application. Recovery is durable for unencrypted workbooks. Password-protected workbooks use memory-only checkpoints and private decrypted working files while the session is open; they do not create persistent plaintext recovery checkpoints. The SDK does not promise process-restart recovery of unsaved protected workbooks. Pass `password=""` when an empty password is intentional.

## Verification

Build the standalone host from the repository root with `npm run backend:bundle -w @vantage/sheets`. Its default output is `apps/sheets/dist/backend/spreadsheet-backend.cjs`; a matching Node 24+ runtime and Rust sidecar are still required. Set `node_args=()` when `EngineSession` launches this bundle. This build command does not run acceptance checks.

Run `python -m unittest discover -s tests -v` from this directory. These stdlib tests launch an owned fake JSON-lines process in temporary directories and verify transport, exact types, bulk transactions, retries, stale handles and cleanup. They do not replace real sidecar/OOXML integration tests. To exercise the installed implementation, use the example with a disposable workbook and dedicated private data/temp directories.

The explicit real-host acceptance script generates its own compact XLSX, then checks typed bulk updates, native calculation, bounded pages, cached results in actual saved OOXML, stale handles, process-restart recovery, Save As and explicit discard. Pass a bundled JavaScript host and matching sidecar; the script does not build them. Its work directory must be new, empty, or already marked as owned by this script.

```powershell
python tests/run_native_smoke.py --node C:/runtime/node.exe --host C:/build/spreadsheet-backend-host.js --binary C:/build/xlsx-sidecar.exe --work-dir C:/private/aster-native-smoke --output C:/private/aster-native-smoke/receipt.json
```

The JSON receipt records success or the concrete failure. The retained `--work-dir/ffi-fixture.xlsx` remains unchanged with A1=10 and B1=`A1*2` cached as20, so it can also serve as the separate native C-ABI probe fixture. Save and recovery outputs live in a unique run subdirectory. No real user workbook, password or profile is used by this script.

See [backend capabilities, limits and verification status](../native/xlsx-engine/documents/Completion-and-Limits.md) for the implemented Rust/Node boundary, resource and history limits, conservative calculation certification, signature caveats and the separate actual-library probe. The preserving OOXML writer remains TypeScript. This SDK does not provide VBA/COM support, an embedded Python runtime, a script sandbox or full Excel compatibility.
