#!/usr/bin/env python3
"""Exercise a built native-ffi library with a caller-provided synthetic XLSX.

The first actual worksheet must contain numeric A1=10 and B1=A1*2. The source
workbook is read only. SQLite journals and JSON receipts belong to --work-dir.
This is a trusted native-library probe, not an isolation boundary for arbitrary
DLLs. A child process bounds hangs/crashes and keeps their outcome in JSON.

Example:
  python verify_ffi.py --library xlsx_sidecar.dll --workbook ffi-fixture.xlsx \
    --work-dir private-ffi-verification
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


ABI_VERSION = 1
OK = 0
STALE_HANDLE = 2
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_FIXTURE_BYTES = 16 * 1024 * 1024
MAX_ERROR_CHARACTERS = 2000
RECEIPT_FORMAT = "aster-sheet-native-ffi-probe-v1"


class ProbeError(RuntimeError):
    """A failed invariant, independent of Python's optional assert statements."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProbeError(message)


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            checksum.update(block)
    return checksum.hexdigest()


class AsterBufferV1(ctypes.Structure):
    _fields_ = [
        ("struct_size", ctypes.c_uint32),
        ("abi_version", ctypes.c_uint32),
        ("handle", ctypes.c_uint64),
        ("data", ctypes.POINTER(ctypes.c_uint8)),
        ("len", ctypes.c_uint64),
    ]

    @classmethod
    def initialized(cls) -> AsterBufferV1:
        result = cls()
        result.struct_size = ctypes.sizeof(cls)
        result.abi_version = ABI_VERSION
        return result


class Native:
    def __init__(self, library: Path) -> None:
        # CDLL is intentional: ASTER_SHEET_CALL is __cdecl, also on Windows.
        self.lib = ctypes.CDLL(str(library))
        self.lib.aster_abi_version_v1.argtypes = []
        self.lib.aster_abi_version_v1.restype = ctypes.c_uint32
        self.lib.aster_engine_create_v1.argtypes = [ctypes.POINTER(ctypes.c_uint64)]
        self.lib.aster_engine_create_v1.restype = ctypes.c_uint32
        self.lib.aster_engine_request_v1.argtypes = [
            ctypes.c_uint64, ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint64,
            ctypes.POINTER(AsterBufferV1),
        ]
        self.lib.aster_engine_request_v1.restype = ctypes.c_uint32
        self.lib.aster_engine_release_v1.argtypes = [ctypes.c_uint64]
        self.lib.aster_engine_release_v1.restype = ctypes.c_uint32
        self.lib.aster_buffer_release_v1.argtypes = [ctypes.c_uint64]
        self.lib.aster_buffer_release_v1.restype = ctypes.c_uint32
        self.engines: set[int] = set()
        self.buffers: dict[int, AsterBufferV1] = {}
        self.maximum_handle = 0
        self.requests = 0

    def register(self, handle: int) -> None:
        require(handle > self.maximum_handle, "Native resource handles were zero, reused, or nonmonotonic.")
        self.maximum_handle = handle

    def create(self) -> int:
        output = ctypes.c_uint64(0)
        status = self.lib.aster_engine_create_v1(ctypes.byref(output))
        require(status == OK, f"Engine creation returned ABI status {status}.")
        handle = int(output.value)
        self.engines.add(handle)
        self.register(handle)
        return handle

    def release_engine(self, handle: int) -> None:
        status = self.lib.aster_engine_release_v1(handle)
        require(status == OK, f"Engine release returned ABI status {status}.")
        self.engines.discard(handle)

    def read_buffer(self, buffer: AsterBufferV1) -> bytes:
        require(int(buffer.handle) in self.buffers, "Attempted to read a released response buffer.")
        require(buffer.struct_size == ctypes.sizeof(AsterBufferV1), "Response structure size changed.")
        require(buffer.abi_version == ABI_VERSION, "Response ABI version changed.")
        require(bool(buffer.data) and 0 < buffer.len <= MAX_RESPONSE_BYTES, "Invalid or oversized native response buffer.")
        # Pointer validity is the trusted library's ABI obligation. No pointer
        # is ever dereferenced after its owning buffer handle is released.
        return ctypes.string_at(buffer.data, int(buffer.len))

    def release_buffer(self, buffer: AsterBufferV1) -> None:
        handle = int(buffer.handle)
        status = self.lib.aster_buffer_release_v1(handle)
        require(status == OK, f"Buffer release returned ABI status {status}.")
        self.buffers.pop(handle, None)

    def call(self, engine: int, request: dict, expected_status: int = OK) -> AsterBufferV1 | None:
        data = canonical(request).encode("utf-8")
        require(len(data) <= 1024 * 1024, "Probe request unexpectedly exceeds its one MiB budget.")
        borrowed = ctypes.create_string_buffer(data)
        output = AsterBufferV1.initialized()
        status = self.lib.aster_engine_request_v1(
            engine, ctypes.cast(borrowed, ctypes.POINTER(ctypes.c_uint8)), len(data), ctypes.byref(output),
        )
        # Track a successful allocation even if a later assertion fails.
        if status == OK and output.handle:
            self.buffers[int(output.handle)] = output
            self.register(int(output.handle))
        require(status == expected_status, f"Request {request['command']} returned ABI status {status}, expected {expected_status}.")
        if status != OK:
            require(output.handle == 0 and not output.data and output.len == 0, "Failed ABI request allocated a response.")
            return None
        require(output.handle != 0, "Successful ABI request omitted its response handle.")
        return output

    def rpc(self, engine: int, command: str, *, error_code: str | None = None,
            retain: bool = False, **fields: object) -> object:
        self.requests += 1
        request_id = f"ffi-probe-{self.requests}"
        request = {"version": 1, "requestId": request_id, "command": command, **fields}
        buffer = self.call(engine, request)
        require(buffer is not None, "Missing successful response buffer.")
        retained = False
        try:
            data = self.read_buffer(buffer)
            envelope = json.loads(data.decode("utf-8"))
            require(isinstance(envelope, dict), f"{command} did not return a JSON object.")
            require(envelope.get("version") == 1 and envelope.get("requestId") == request_id,
                    f"{command} returned the wrong transport version or request ID.")
            if error_code is not None:
                error = envelope.get("error")
                require(envelope.get("ok") is False and isinstance(error, dict)
                        and error.get("code") == error_code,
                        f"{command} did not return structured RPC error {error_code}.")
                result = error
            else:
                error = envelope.get("error", {})
                code = error.get("code") if isinstance(error, dict) else None
                require(envelope.get("ok") is True and "result" in envelope,
                        f"{command} failed with RPC error code {code!r}.")
                result = envelope["result"]
            if retain:
                retained = True
                return result, buffer, data
            return result
        finally:
            if not retained:
                self.release_buffer(buffer)

    def cleanup(self) -> list[str]:
        errors = []
        for handle in list(self.buffers):
            try:
                status = self.lib.aster_buffer_release_v1(handle)
                if status != OK:
                    errors.append(f"Buffer {handle}: cleanup status {status}")
            except Exception as error:
                errors.append(str(error)[:200])
            finally:
                self.buffers.pop(handle, None)
        for handle in list(self.engines):
            try:
                status = self.lib.aster_engine_release_v1(handle)
                if status != OK:
                    errors.append(f"Engine {handle}: cleanup status {status}")
            except Exception as error:
                errors.append(str(error)[:200])
            finally:
                self.engines.discard(handle)
        return errors


def payload_for(sheet_id: str) -> dict:
    arrays = (
        "edits bulkConstantFills structuralOps chartEdits visualEdits visualAdditions "
        "cellImageAdditions tableAdditions tableEdits pivotAdditions sheetOps sheetOrder "
        "filterStates hyperlinkEdits cfStates dvStates pageSetupStates noteStates formulaValues "
        "pivotCacheRefreshPaths pivotRefreshUpdates sheetProtections sparklineAdditions protectedRangeStates"
    ).split()
    payload = {name: [] for name in arrays}
    payload.update({name: None for name in (
        "definedNamesState", "themeState", "workbookProtectionState", "redactionStates",
    )})
    for column, value in ((0, 21), (2, "12"), (3, True), (4, ""), (5, None), (6, "TRUE"), (7, "=A1")):
        payload["edits"].append({"sheetId": sheet_id, "row": 0, "column": column, "writeValue": True, "value": value})
    for column, formula in ((2, "=ISTEXT(C1)"), (3, "=ISLOGICAL(D1)"), (4, "=ISTEXT(E1)"),
                            (5, "=ISBLANK(F1)"), (6, "=ISTEXT(G1)"), (7, "=ISTEXT(H1)")):
        payload["edits"].append({"sheetId": sheet_id, "row": 1, "column": column,
                                 "writeValue": True, "value": None, "formula": formula})
    return payload


def cell_at(result: dict, sheet: str, row: int, column: int) -> dict:
    cells = result.get("cells")
    require(isinstance(cells, list), "Calculation result omitted its cell array.")
    found = [cell for cell in cells if isinstance(cell, dict) and cell.get("sheet") == sheet
             and cell.get("row") == row and cell.get("column") == column]
    require(len(found) == 1, f"Calculation did not return exactly one cell ({row},{column}).")
    require("value" in found[0], "Calculation omitted its additive raw typed value field.")
    return found[0]


def checked_calculation(native: Native, engine: int, document_id: str, sheet: str,
                        revision: int, expected_a1: int, typed: bool) -> dict:
    result = native.rpc(engine, "recalc_document", apiVersion=1, documentId=document_id,
                        revision=revision, reads=[{"sheet": sheet, "range": {
                            "startRow": 0, "endRow": 1 if typed else 0,
                            "startColumn": 0, "endColumn": 7 if typed else 1,
                        }}])
    require(isinstance(result, dict) and result.get("revision") == revision
            and result.get("workbookId") == document_id, "Calculation was not pinned to its document revision.")
    first = cell_at(result, sheet, 0, 0)
    dependent = cell_at(result, sheet, 0, 1)
    require(type(first["value"]) in (int, float) and first["value"] == expected_a1,
            "A1 is not the expected numeric value.")
    require(type(dependent["value"]) in (int, float) and dependent["value"] == expected_a1 * 2
            and dependent.get("isFormula") is True and not dependent.get("isError", False),
            "B1 did not calculate A1*2 as the expected numeric formula result.")
    if typed:
        for column in range(2, 8):
            value = cell_at(result, sheet, 1, column)
            require(value["value"] is True and value.get("isFormula") is True,
                    f"Typed input predicate in column {column} was not true.")
        require(type(cell_at(result, sheet, 0, 2)["value"]) is str, 'Literal "12" lost its text type.')
        require(cell_at(result, sheet, 0, 3)["value"] is True, "Boolean input lost its type.")
        require(cell_at(result, sheet, 0, 6)["value"] == "TRUE", 'Literal "TRUE" lost its text type.')
        literal = cell_at(result, sheet, 0, 7)
        require(literal["value"] == "=A1" and literal.get("isFormula") is False,
                "Formula-looking text was reinterpreted as a formula.")
    return {"revision": revision, "a1": first["value"], "b1": dependent["value"], "typedPredicates": 6 if typed else 0}


def write_receipt(path: Path, report: dict) -> None:
    encoded = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode("utf-8") + b"\n"
    require(len(encoded) <= 1024 * 1024, "Probe receipt exceeded its one MiB limit.")
    descriptor, temporary = tempfile.mkstemp(prefix="ffi-receipt-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def exercise(args: argparse.Namespace, run_dir: Path) -> int:
    report = {"format": RECEIPT_FORMAT, "runId": args._run_id, "status": "failed", "checks": []}
    native = None
    source_hash = digest(args.workbook)
    started = time.monotonic()
    try:
        native = Native(args.library)
        require(native.lib.aster_abi_version_v1() == ABI_VERSION, "Native library does not expose ABI v1.")
        engine = native.create()
        capabilities = native.rpc(engine, "capabilities")
        require(isinstance(capabilities, dict) and capabilities.get("transportVersion") == 1
                and capabilities.get("documentApiVersion") == 1
                and capabilities.get("typedDocumentCheckpoints") is True
                and capabilities.get("revisionPinnedDocumentCalculation") is True
                and capabilities.get("durableDocuments") is True, "Required native document capabilities are absent.")
        require(capabilities.get("pythonExecution") is False and capabilities.get("vbaExecution") is False,
                "Capabilities unexpectedly advertise embedded script execution.")
        report["checks"].append({"check": "abi_and_capabilities", "status": "passed", "abiVersion": ABI_VERSION})
        opened = native.rpc(engine, "open", path=str(args.workbook), locale="en")
        require(isinstance(opened, dict) and isinstance(opened.get("sheets"), list)
                and len(opened["sheets"]) > 0 and isinstance(opened.get("sessionId"), str),
                "Native open did not expose actual worksheet identities.")
        sheets = [{"id": item["id"], "name": item["name"]} for item in opened["sheets"]]
        require(all(isinstance(item["id"], str) and isinstance(item["name"], str) for item in sheets),
                "Native worksheet identities are malformed.")
        sheet = sheets[0]
        payload = payload_for(sheet["id"])
        expected_payload = canonical(payload)
        fingerprint = "sha256:" + source_hash
        memory_id = "ffi-memory-" + args._run_id
        durable_id = "ffi-durable-" + args._run_id

        def open_document(handle: int, document_id: str, durable: bool) -> dict:
            fields = {"apiVersion": 1, "documentId": document_id, "sourcePath": str(args.workbook), "sheets": sheets}
            if durable:
                fields["storePath"] = str(run_dir / "document.sqlite3")
            result = native.rpc(handle, "open_document", **fields)
            require(isinstance(result, dict) and result.get("sourceFingerprint") == fingerprint
                    and result.get("durable") is durable, "Document open lost source or durability binding.")
            return result

        def checkpoint(handle: int, document_id: str) -> tuple[dict, dict]:
            command = {"apiVersion": 1, "documentId": document_id, "commandId": "typed-checkpoint",
                       "expectedRevision": 0, "actor": "ctypes-ffi-probe", "payload": payload}
            receipt = native.rpc(handle, "checkpoint_document", **command)
            require(isinstance(receipt, dict) and receipt.get("revision") == 1
                    and receipt.get("documentId") == document_id, "Checkpoint did not acknowledge revision one.")
            replay = native.rpc(handle, "checkpoint_document", **command)
            require(canonical(replay) == canonical(receipt), "Idempotent replay changed the acknowledged receipt.")
            return command, receipt

        info = open_document(engine, memory_id, False)
        require(info.get("revision") == 0 and info.get("recovered") is False, "New memory document was not empty.")
        baseline = checked_calculation(native, engine, memory_id, sheet["name"], 0, 10, False)
        command, memory_receipt = checkpoint(engine, memory_id)
        require(memory_receipt.get("durable") is False, "Memory checkpoint claimed persistence.")
        changed = {**command, "payload": {**payload, "edits": []}}
        native.rpc(engine, "checkpoint_document", error_code="idempotency_conflict", **changed)
        native.rpc(engine, "recalc_document", error_code="stale_revision", apiVersion=1,
                   documentId=memory_id, revision=0, reads=[])
        snapshot = native.rpc(engine, "document_snapshot", apiVersion=1, documentId=memory_id, revision=1)
        require(snapshot.get("revision") == 1 and canonical(snapshot.get("payload")) == expected_payload,
                "Memory checkpoint changed typed payload data or published a failed command.")
        calculated = checked_calculation(native, engine, memory_id, sheet["name"], 1, 21, True)
        require(native.rpc(engine, "close_document", apiVersion=1, documentId=memory_id).get("closed") is True,
                "Memory document did not close.")
        native.rpc(engine, "document_snapshot", error_code="unknown_document", apiVersion=1, documentId=memory_id)
        report["checks"].append({"check": "memory_checkpoint_and_typed_calculation", "status": "passed",
                                  "baseline": baseline, "calculated": calculated})

        info = open_document(engine, durable_id, True)
        require(info.get("revision") == 0 and info.get("recovered") is False, "New private journal was not empty.")
        durable_command, receipt = checkpoint(engine, durable_id)
        require(receipt.get("durable") is True, "Durable checkpoint did not acknowledge persistence.")
        native.rpc(engine, "close_document", apiVersion=1, documentId=durable_id)
        recovered = open_document(engine, durable_id, True)
        require(recovered.get("revision") == 1 and recovered.get("recovered") is True,
                "Closing and reopening the SQLite authority did not recover its head.")
        current = native.rpc(engine, "document_snapshot", apiVersion=1, documentId=durable_id, revision=1)
        require(canonical(current.get("payload")) == expected_payload, "Reopened SQLite checkpoint lost exact typed data.")
        require(canonical(native.rpc(engine, "document_command_result", apiVersion=1, documentId=durable_id,
                                     commandId=durable_command["commandId"])) == canonical(receipt),
                "Reopened SQLite journal lost its original acknowledged receipt.")
        native.rpc(engine, "close_document", apiVersion=1, documentId=durable_id)
        native.rpc(engine, "close", sessionId=opened["sessionId"])

        retained, buffer, before = native.rpc(engine, "capabilities", retain=True)
        native.release_engine(engine)
        require(native.read_buffer(buffer) == before and json.loads(before.decode("utf-8"))["result"] == retained,
                "Response buffer did not survive its engine's release.")
        buffer_handle = int(buffer.handle)
        native.release_buffer(buffer)
        require(native.lib.aster_buffer_release_v1(buffer_handle) == STALE_HANDLE,
                "Releasing an already released buffer did not return ABI status two.")
        require(native.lib.aster_engine_release_v1(engine) == STALE_HANDLE,
                "Releasing an already released engine did not return ABI status two.")
        native.call(engine, {"version": 1, "requestId": "stale-engine", "command": "capabilities"}, STALE_HANDLE)
        report["checks"].append({"check": "buffer_lifetime_and_stale_handles", "status": "passed"})

        second_engine = native.create()
        recovered = open_document(second_engine, durable_id, True)
        require(recovered.get("revision") == 1 and recovered.get("recovered") is True,
                "A new engine did not recover the SQLite authority.")
        current = native.rpc(second_engine, "document_snapshot", apiVersion=1, documentId=durable_id, revision=1)
        require(current.get("sourceFingerprint") == fingerprint and canonical(current.get("payload")) == expected_payload,
                "New-engine recovery changed the acknowledged source or typed checkpoint.")
        require(canonical(native.rpc(second_engine, "checkpoint_document", **durable_command)) == canonical(receipt),
                "New-engine idempotency replay changed the persisted receipt.")
        reopened_calc = checked_calculation(native, second_engine, durable_id, sheet["name"], 1, 21, True)
        native.rpc(second_engine, "close_document", apiVersion=1, documentId=durable_id)
        native.release_engine(second_engine)
        require(digest(args.workbook) == source_hash, "Synthetic input workbook bytes changed during the read-only probe.")
        report["checks"].append({"check": "sqlite_recovery_across_engine_release", "status": "passed",
                                  "acknowledgement": receipt, "calculated": reopened_calc})
        report.update({"status": "passed", "library": str(args.library), "librarySha256": digest(args.library),
                       "workbook": str(args.workbook), "workbookSha256": source_hash,
                       "worksheet": sheet, "journalPath": str(run_dir / "document.sqlite3"),
                       "payloadSha256": hashlib.sha256(expected_payload.encode("utf-8")).hexdigest()})
    except Exception as error:
        report["error"] = {"type": type(error).__name__, "message": str(error)[:MAX_ERROR_CHARACTERS]}
    finally:
        if native is not None:
            cleanup_errors = native.cleanup()
            report["requestCount"] = native.requests
            if cleanup_errors:
                report["status"] = "failed"
                report["cleanupErrors"] = cleanup_errors[:20]
        report["elapsedSeconds"] = round(time.monotonic() - started, 3)
        write_receipt(args.output, report)
    return 0 if report["status"] == "passed" else 1


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--library", type=Path, required=True, help="Built native-ffi DLL/shared library for this Python architecture")
    parser.add_argument("--workbook", type=Path, required=True, help="Read-only synthetic XLSX: first worksheet A1=10, B1=A1*2")
    parser.add_argument("--work-dir", type=Path, required=True, help="Private directory for this probe's journal and receipts")
    parser.add_argument("--output", type=Path, help="JSON receipt inside --work-dir (default: ffi-verification.json)")
    parser.add_argument("--timeout-seconds", type=int, default=180, help="Maximum child runtime, 1..3600 (default: 180)")
    parser.add_argument("--_worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--_run-id", default="", help=argparse.SUPPRESS)
    parser.add_argument("--_run-dir", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    args.library = args.library.resolve(strict=True)
    args.workbook = args.workbook.resolve(strict=True)
    require(args.library.is_file() and args.workbook.is_file(), "Library and workbook must be files.")
    require(0 < args.workbook.stat().st_size <= MAX_FIXTURE_BYTES, "Synthetic fixture must be nonempty and at most 16 MiB.")
    require(1 <= args.timeout_seconds <= 3600, "Timeout must be between one and 3600 seconds.")
    args.work_dir = args.work_dir.resolve()
    args.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.output = (args.output.resolve() if args.output else args.work_dir / "ffi-verification.json")
    require(args.output.is_relative_to(args.work_dir) and args.output != args.work_dir,
            "Receipt output must be a file inside the private work directory.")
    require(args.output not in (args.library, args.workbook), "Receipt output must not alias either input file.")
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return args


def main() -> int:
    try:
        args = arguments()
        if args._worker:
            require(len(args._run_id) == 32 and all(character in "0123456789abcdef" for character in args._run_id), "Invalid private run ID.")
            run_dir = args._run_dir.resolve(strict=True)
            require(run_dir.parent == args.work_dir and run_dir.name == "ffi-probe-" + args._run_id,
                    "Worker journal must stay inside its own private run directory.")
            return exercise(args, run_dir)
        run_id = uuid.uuid4().hex
        run_dir = args.work_dir / ("ffi-probe-" + run_id)
        run_dir.mkdir(mode=0o700)
        initial = {"format": RECEIPT_FORMAT, "runId": run_id, "status": "running", "checks": []}
        write_receipt(args.output, initial)
        command = [sys.executable, str(Path(__file__).resolve()), "--library", str(args.library),
                   "--workbook", str(args.workbook), "--work-dir", str(args.work_dir), "--output", str(args.output),
                   "--_worker", "--_run-id", run_id, "--_run-dir", str(run_dir)]
        try:
            completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, timeout=args.timeout_seconds, check=False)
            require(args.output.stat().st_size <= 1024 * 1024, "Worker receipt is oversized.")
            report = json.loads(args.output.read_text(encoding="utf-8"))
            require(report.get("format") == RECEIPT_FORMAT and report.get("runId") == run_id,
                    "Worker receipt does not belong to this probe run.")
            require(report.get("status") in ("passed", "failed"),
                    f"Native worker exited before producing its receipt (exit code {completed.returncode}).")
            require((completed.returncode == 0) == (report["status"] == "passed"),
                    f"Native worker exit code {completed.returncode} disagrees with its receipt.")
        except Exception as error:
            report = {**initial, "status": "failed", "error": {
                "type": type(error).__name__, "message": str(error)[:MAX_ERROR_CHARACTERS],
            }}
            write_receipt(args.output, report)
        print(json.dumps({"status": report["status"], "receipt": str(args.output)}, ensure_ascii=False))
        return 0 if report["status"] == "passed" else 1
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)[:MAX_ERROR_CHARACTERS]}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
