"""Bulk document RPC, with no spreadsheet engine or code execution embedded here."""

from __future__ import annotations

import copy
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Iterator, Mapping, Sequence


MAX_ROWS = 1_048_576
MAX_COLUMNS = 16_384
PAGE_CELLS = 20_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
_EOF = object()


class AsterError(Exception):
    """Base SDK failure."""


class BackendError(AsterError):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code, self.details = code, details


class EngineTimeout(AsterError):
    """Outcome may be unknown; acknowledged durable checkpoints remain on disk."""


class EngineDied(AsterError):
    pass


class ProtocolError(AsterError):
    pass


class StaleHandle(AsterError):
    pass


def _json_copy(value: Any) -> Any:
    """Detach data and reject non-JSON values rather than silently stringify them."""
    def check(item: Any) -> None:
        if item is None or type(item) in (str, bool):
            return
        if type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                raise ValueError("Integers must fit JavaScript's exact integer range.")
            return
        if type(item) is float:
            if not math.isfinite(item):
                raise ValueError("Numbers must be finite.")
            return
        if type(item) is list:
            for element in item:
                check(element)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for element in item.values():
                check(element)
            return
        raise TypeError("Only JSON objects, arrays, strings, finite numbers, booleans and null are supported.")
    check(value)
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def _revision(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ValueError("A revision must be a nonnegative safe integer.")
    return value


def _scalar(value: Any) -> Any:
    if value is None or type(value) in (str, bool):
        return value
    if type(value) in (int, float):
        _json_copy(value)
        return value
    raise TypeError("A cell value must be a string, finite number, boolean or None.")


def _pending_sheets(base: Any, payload: Mapping[str, Any]) -> list[dict[str, str]]:
    """Derive the visible sheet list from native base IDs, never a prior overlay."""
    if not isinstance(base, list) or not base:
        raise ProtocolError("The native snapshot has no base worksheet metadata.")
    sheets: dict[str, dict[str, str]] = {}
    for item in base:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("name"), str):
            raise ProtocolError("The native snapshot has invalid base worksheet metadata.")
        if item["id"] in sheets:
            raise ProtocolError("The native snapshot contains duplicate worksheet IDs.")
        sheets[item["id"]] = {"id": item["id"], "name": item["name"]}
    known_ids = set(sheets)
    operations, order = payload.get("sheetOps", []), payload.get("sheetOrder", [])
    if not isinstance(operations, list) or not isinstance(order, list):
        raise ValueError("sheetOps and sheetOrder must be arrays.")
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("A sheet operation must use the existing document DTO.")
        kind, sheet_id = operation.get("kind"), operation.get("sheetId")
        if kind == "reorder-sheets":
            continue
        if not isinstance(sheet_id, str) or not sheet_id:
            raise ValueError("A sheet operation requires a stable worksheet ID.")
        if kind in ("add-sheet", "duplicate-sheet"):
            name = operation.get("name")
            if sheet_id in known_ids or not isinstance(name, str) or not name:
                raise ValueError("A new worksheet needs a new stable ID and a name.")
            if kind == "duplicate-sheet" and operation.get("sourceSheetId") not in known_ids:
                raise ValueError("A duplicated worksheet needs a known source ID.")
            sheets[sheet_id] = {"id": sheet_id, "name": name}
            known_ids.add(sheet_id)
        elif kind in ("rename-sheet", "remove-sheet", "set-sheet-hidden", "set-sheet-tab-color"):
            if sheet_id not in sheets:
                raise ValueError("A sheet operation addresses an unknown or removed worksheet.")
            if kind == "rename-sheet":
                name = operation.get("newName")
                if not isinstance(name, str) or not name:
                    raise ValueError("A renamed worksheet needs a name.")
                sheets[sheet_id] = {"id": sheet_id, "name": name}
            elif kind == "remove-sheet":
                del sheets[sheet_id]
        else:
            raise ValueError("Unknown worksheet operation.")
    if not sheets or len({item["name"].casefold() for item in sheets.values()}) != len(sheets):
        raise ValueError("The final workbook must have uniquely named worksheets.")
    if operations or order:
        if (any(not isinstance(item, str) for item in order) or len(order) != len(sheets) or
                set(order) != set(sheets)):
            raise ValueError("sheetOrder must contain every final worksheet ID exactly once.")
        return [sheets[sheet_id] for sheet_id in order]
    return list(sheets.values())


@dataclass(frozen=True)
class Bounds:
    """Zero-based rectangle; end_row and end_column are exclusive."""

    start_row: int
    start_column: int
    end_row: int
    end_column: int

    def __post_init__(self) -> None:
        if any(type(value) is not int for value in (
            self.start_row, self.start_column, self.end_row, self.end_column
        )):
            raise TypeError("Range coordinates must be integers.")
        if not (0 <= self.start_row < self.end_row <= MAX_ROWS and
                0 <= self.start_column < self.end_column <= MAX_COLUMNS):
            raise ValueError("The range must be nonempty and inside XLSX worksheet limits.")

    @property
    def rows(self) -> int:
        return self.end_row - self.start_row

    @property
    def columns(self) -> int:
        return self.end_column - self.start_column

    def wire(self) -> dict[str, int]:
        # The existing host's read DTO has inclusive ends.
        return {"startRow": self.start_row, "startColumn": self.start_column,
                "endRow": self.end_row - 1, "endColumn": self.end_column - 1}

    def pages(self) -> Iterator[Bounds]:
        # XLSX width <= 16,384, so even one full-width row fits a viewport.
        rows_per_page = max(1, PAGE_CELLS // self.columns)
        for row in range(self.start_row, self.end_row, rows_per_page):
            yield Bounds(row, self.start_column, min(row + rows_per_page, self.end_row), self.end_column)


_A1 = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?$")


def parse_range(value: str | Bounds | Sequence[int]) -> Bounds:
    """Parse A1:B3, Bounds, or (row0, column0, row1, column1)."""
    if isinstance(value, Bounds):
        return value
    if isinstance(value, str):
        match = _A1.fullmatch(value)
        if match is None:
            raise ValueError("Use a cell or rectangle such as A1 or A1:B3; select the sheet separately.")
        def column(text: str) -> int:
            result = 0
            for char in text.upper():
                result = result * 26 + ord(char) - ord("A") + 1
            return result - 1
        c0, r0, c1, r1 = match.groups()
        return Bounds(int(r0) - 1, column(c0), int(r1 or r0), column(c1 or c0) + 1)
    if isinstance(value, (list, tuple)) and len(value) == 4:
        return Bounds(*value)
    raise TypeError("A range must be A1 notation or four zero-based, half-open coordinates.")


class EngineSession:
    """Own one explicit local Node host and its Rust worker. No shell is used."""

    def __init__(self, *, node: str | os.PathLike[str], host: str | os.PathLike[str],
                 binary: str | os.PathLike[str], data: str | os.PathLike[str],
                 temp: str | os.PathLike[str], node_args: Sequence[str] = ("--import", "tsx"),
                 cwd: str | os.PathLike[str] | None = None, timeout: float = 120.0,
                 shutdown_timeout: float = 5.0):
        if not math.isfinite(timeout) or timeout <= 0 or not math.isfinite(shutdown_timeout) or shutdown_timeout <= 0:
            raise ValueError("Timeouts must be positive finite seconds.")
        paths = {key: Path(value) for key, value in
                 {"node": node, "host": host, "binary": binary, "data": data, "temp": temp}.items()}
        if any(not path.is_absolute() for path in paths.values()):
            raise ValueError("Node, host, binary, data and temp must use absolute paths.")
        if isinstance(node_args, str) or any(not isinstance(arg, str) for arg in node_args):
            raise TypeError("node_args must be a sequence of individual arguments.")
        self.timeout, self.shutdown_timeout = timeout, shutdown_timeout
        self._lock = threading.RLock()
        self._responses: queue.Queue[Any] = queue.Queue()
        self._stderr: deque[str] = deque(maxlen=64)
        self._closed = False
        self._broken: AsterError | None = None
        argv = [str(paths["node"]), *node_args, str(paths["host"]), "--binary", str(paths["binary"]),
                "--data", str(paths["data"]), "--temp", str(paths["temp"])]
        self._process = subprocess.Popen(
            argv, shell=False, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="strict", bufsize=1,
            cwd=str(cwd) if cwd is not None else str(paths["host"].parent.parent),
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self._reader = threading.Thread(target=self._read_stdout, daemon=True, name="aster-rpc-stdout")
        self._errors = threading.Thread(target=self._read_stderr, daemon=True, name="aster-rpc-stderr")
        self._reader.start()
        self._errors.start()

    def _read_stdout(self) -> None:
        try:
            assert self._process.stdout is not None
            for line in self._process.stdout:
                try:
                    self._responses.put(json.loads(line))
                except (ValueError, TypeError) as error:
                    self._responses.put(ProtocolError(f"The host emitted invalid JSON: {error}"))
                    return
        except (UnicodeError, OSError, ValueError) as error:
            self._responses.put(ProtocolError(f"The host output could not be read: {error}"))
        finally:
            self._responses.put(_EOF)

    def _read_stderr(self) -> None:
        try:
            assert self._process.stderr is not None
            for line in self._process.stderr:
                self._stderr.append(line.rstrip())
        except (UnicodeError, OSError, ValueError):
            pass

    @property
    def diagnostics(self) -> tuple[str, ...]:
        return tuple(self._stderr)

    def _poison(self, error: AsterError) -> None:
        self._broken = error
        # EOF lets a still-running checkpoint finish and the host preserve recovery.
        try:
            if self._process.stdin is not None:
                self._process.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    def request(self, command: str, *, timeout: float | None = None, **fields: Any) -> Any:
        """One correlated bulk RPC. After timeout, create a new session and recover explicitly."""
        seconds = self.timeout if timeout is None else timeout
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError("A request timeout must be positive finite seconds.")
        with self._lock:
            if self._closed:
                raise EngineDied("The engine session is closed.")
            if self._broken is not None:
                raise self._broken
            if "requestId" in fields:
                raise ValueError("Request correlation IDs are owned by the transport.")
            request_id = str(uuid.uuid4())
            request = _json_copy({"requestId": request_id, "command": command, **fields})
            try:
                assert self._process.stdin is not None
                self._process.stdin.write(json.dumps(request, ensure_ascii=False, allow_nan=False) + "\n")
                self._process.stdin.flush()
            except (BrokenPipeError, OSError, ValueError) as error:
                failure = EngineDied(f"The spreadsheet host stopped accepting requests (exit {self._process.poll()}).")
                self._poison(failure)
                raise failure from error
            try:
                response = self._responses.get(timeout=seconds)
            except queue.Empty as error:
                failure = EngineTimeout(f"The {command} request exceeded {seconds:g} seconds; its outcome may be unknown.")
                self._poison(failure)
                raise failure from error
            if response is _EOF:
                failure = EngineDied(f"The spreadsheet host exited (exit {self._process.poll()}).")
                self._poison(failure)
                raise failure
            if isinstance(response, AsterError):
                self._poison(response)
                raise response
            if not isinstance(response, dict) or response.get("requestId") != request_id or type(response.get("ok")) is not bool:
                failure = ProtocolError("The spreadsheet host returned an uncorrelated response.")
                self._poison(failure)
                raise failure
            if not response["ok"]:
                error = response.get("error", {})
                if not isinstance(error, dict):
                    raise ProtocolError("The host returned an invalid error response.")
                raise BackendError(str(error.get("code", "operation_failed")), str(error.get("message", "Backend request failed.")), error.get("details"))
            return response.get("result")

    def open_workbook(self, path: str | os.PathLike[str], *, password: str | None = None) -> Workbook:
        return Workbook.open(self, path, password=password)

    def recover(self, candidate_id: str, original_path: str | os.PathLike[str]) -> Workbook:
        return Workbook.recover(self, candidate_id, original_path)

    def candidates(self, original_path: str | os.PathLike[str] | None = None) -> list[dict[str, Any]]:
        result = self.request("candidates", **({} if original_path is None else {"originalPath": os.fspath(original_path)}))
        if not isinstance(result, list):
            raise ProtocolError("The backend returned an invalid recovery inventory.")
        return result

    def capabilities(self) -> dict[str, Any]:
        return self.request("capabilities")

    def close(self) -> None:
        """Send EOF, retain recovery, then reap only the host this object owns."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                if self._process.stdin is not None:
                    self._process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            try:
                self._process.wait(timeout=self.shutdown_timeout)
            except subprocess.TimeoutExpired:
                self._process.terminate()
                try:
                    self._process.wait(timeout=self.shutdown_timeout)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait()
            self._reader.join(timeout=self.shutdown_timeout)
            self._errors.join(timeout=self.shutdown_timeout)
            for stream in (self._process.stdout, self._process.stderr):
                if stream is not None:
                    stream.close()

    def __enter__(self) -> EngineSession:
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()


class Workbook:
    def __init__(self, engine: EngineSession, handle: Mapping[str, Any], path: str):
        self.engine, self.path = engine, path
        self._lock = threading.RLock()
        self._generation = 0
        self._closed = False
        self._adopt(handle)

    @classmethod
    def open(cls, engine: EngineSession, path: str | os.PathLike[str], *, password: str | None = None) -> Workbook:
        if password is not None and not isinstance(password, str):
            raise TypeError("A password must be a string, including an empty string if needed.")
        result = engine.request("open", path=os.fspath(path), **({} if password is None else {"password": password}))
        return cls(engine, result, os.fspath(path))

    @classmethod
    def recover(cls, engine: EngineSession, candidate_id: str, original_path: str | os.PathLike[str]) -> Workbook:
        result = engine.request("recover", candidateId=candidate_id, originalPath=os.fspath(original_path))
        return cls(engine, result, os.fspath(original_path))

    def candidates(self) -> list[dict[str, Any]]:
        return self.engine.candidates(self.path)

    def _adopt(self, handle: Mapping[str, Any]) -> None:
        if (not isinstance(handle, dict) or not isinstance(handle.get("id"), str) or not handle["id"] or
                not isinstance(handle.get("sourceFingerprint"), str) or not isinstance(handle.get("sheets"), list)):
            raise ProtocolError("The backend returned an invalid workbook handle.")
        _revision(handle.get("revision"))
        if any(not isinstance(sheet, dict) or not isinstance(sheet.get("id"), str) or not isinstance(sheet.get("name"), str) for sheet in handle["sheets"]):
            raise ProtocolError("The backend returned invalid worksheet metadata.")
        self._handle = copy.deepcopy(handle)
        self._base_sheets = copy.deepcopy(handle["sheets"])

    def _active(self, generation: int | None = None) -> None:
        if self._closed or (generation is not None and generation != self._generation):
            raise StaleHandle("This workbook or worksheet handle was closed or replaced by a successful save.")

    @property
    def id(self) -> str:
        return self._handle["id"]

    @property
    def revision(self) -> int:
        return self._handle["revision"]

    @property
    def source_fingerprint(self) -> str:
        return self._handle["sourceFingerprint"]

    @property
    def sheets(self) -> tuple[Sheet, ...]:
        with self._lock:
            self._active()
            return tuple(Sheet(self, sheet["id"], sheet["name"], self._generation) for sheet in self._handle["sheets"])

    def sheet(self, name_or_id: str | Sheet) -> Sheet:
        with self._lock:
            self._active()
            if isinstance(name_or_id, Sheet):
                if name_or_id.workbook is not self:
                    raise ValueError("The worksheet belongs to another workbook.")
                self._active(name_or_id._generation)
                current = next((sheet for sheet in self._handle["sheets"] if sheet["id"] == name_or_id.id), None)
                if current is None or current["name"] != name_or_id.name:
                    raise StaleHandle("This worksheet was removed or renamed; select it again by its current name or stable ID.")
                return name_or_id
            sheets = self.sheets
            by_id = [sheet for sheet in sheets if sheet.id == name_or_id]
            matches = by_id or [sheet for sheet in sheets if sheet.name == name_or_id]
            if len(matches) != 1:
                raise KeyError(f"Unknown or ambiguous worksheet: {name_or_id!r}")
            return matches[0]

    def snapshot(self, revision: int | None = None) -> dict[str, Any]:
        with self._lock:
            self._active()
            result = self.engine.request("snapshot", handle=self.id, **({} if revision is None else {"revision": _revision(revision)}))
            if not isinstance(result, dict) or result.get("documentId") != self.id or not isinstance(result.get("payload"), dict):
                raise ProtocolError("The snapshot does not belong to this workbook.")
            actual = _revision(result.get("revision"))
            if revision is not None and actual != revision:
                raise ProtocolError("The backend returned a different snapshot revision.")
            if revision is None or actual == self.revision:
                derived = _pending_sheets(result.get("sheets"), result["payload"])
                self._handle["revision"] = actual
                self._handle["sheets"] = derived
                self._base_sheets = copy.deepcopy(result["sheets"])
            return result

    def transaction(self, *, expected_revision: int | None = None, command_id: str | None = None,
                    stable_command_id: str | None = None) -> Transaction:
        with self._lock:
            self._active()
            if command_id is not None and stable_command_id is not None:
                raise ValueError("Supply command_id or stable_command_id, not both.")
            expected = self.revision if expected_revision is None else _revision(expected_revision)
            return Transaction(self, self.snapshot(expected), command_id=command_id if command_id is not None else stable_command_id)

    def iter_read_pages(self, sheet: str | Sheet, area: str | Bounds | Sequence[int]) -> Iterator[dict[str, Any]]:
        bounds = parse_range(area)
        with self._lock:
            selected = self.sheet(sheet)
            generation, revision = self._generation, self.revision
        for page in bounds.pages():
            with self._lock:
                self._active(generation)
                if self.revision != revision:
                    raise StaleHandle("The workbook changed while reading pages.")
                result = self.engine.request("read", handle=self.id, sheetId=selected.id, range=page.wire())
                if not isinstance(result, dict) or result.get("handleId") != self.id or result.get("revision") != revision:
                    raise ProtocolError("A read returned another workbook revision.")
            yield {"bounds": page, **result}

    def read(self, sheet: str | Sheet, area: str | Bounds | Sequence[int]) -> list[list[Any]]:
        bounds = parse_range(area)
        rows = [[None] * bounds.columns for _ in range(bounds.rows)]
        for page in self.iter_read_pages(sheet, bounds):
            native = page.get("result")
            if not isinstance(native, dict) or not isinstance(native.get("cells"), list):
                raise ProtocolError("The backend returned an invalid cell page.")
            for cell in native["cells"]:
                row, column = cell.get("row"), cell.get("column")
                if type(row) is not int or type(column) is not int or not (bounds.start_row <= row < bounds.end_row and bounds.start_column <= column < bounds.end_column):
                    raise ProtocolError("A cell lies outside the requested rectangle.")
                rows[row - bounds.start_row][column - bounds.start_column] = cell.get("value")
        return rows

    def calculate_and_wait(self, reads: Sequence[tuple[str | Sheet, str | Bounds | Sequence[int]]] = (), *, revision: int | None = None) -> dict[str, Any]:
        with self._lock:
            self._active()
            expected = self.revision if revision is None else _revision(revision)
            if expected != self.revision:
                raise StaleHandle("Calculation must target this handle's current revision.")
            requested = [(self.sheet(sheet), page) for sheet, area in reads for page in parse_range(area).pages()]
            batches: list[list[dict[str, Any]]] = []
            count = 0
            for sheet, page in requested:
                cells = page.rows * page.columns
                if not batches or count + cells > PAGE_CELLS:
                    batches.append([])
                    count = 0
                batches[-1].append({"sheet": sheet.name, "range": page.wire()})
                count += cells
            results = []
            for batch in batches or [[]]:
                result = self.engine.request("recalculate", handle=self.id, reads=batch, revision=expected)
                if not isinstance(result, dict) or result.get("workbookId") != self.id or result.get("revision") != expected or not isinstance(result.get("cells"), list):
                    raise ProtocolError("Calculation returned another workbook revision.")
                results.append(result)
            reasons: list[str] = []
            permitted = True
            for result in results:
                native_reasons = result.get("cacheWritebackReasons")
                valid_reasons = (isinstance(native_reasons, list) and len(native_reasons) <= 32 and
                                 all(isinstance(reason, str) and 0 < len(reason) <= 64 for reason in native_reasons))
                certified = (result.get("cacheWritebackAllowed") is True and
                             result.get("calculationCompleteness") == "complete" and
                             result.get("cacheWriteback") == "allowed" and valid_reasons and not native_reasons)
                if not certified:
                    permitted = False
                    incoming = native_reasons if valid_reasons and native_reasons else ["native_provenance_missing_or_invalid"]
                    for reason in incoming:
                        if reason not in reasons:
                            reasons.append(reason)
            return {"workbookId": self.id, "revision": expected,
                    "cells": [cell for result in results for cell in result["cells"]],
                    "calculationCompleteness": "complete" if permitted else "unverified",
                    "cacheWritebackAllowed": permitted, "cacheWriteback": "allowed" if permitted else "withheld",
                    "cacheWritebackReasons": reasons}

    def save(self, target: str | os.PathLike[str] | None = None, *, overwrite: bool = False) -> dict[str, Any]:
        with self._lock:
            self._active()
            result = self.engine.request("save", handle=self.id, targetPath=os.fspath(target) if target is not None else self.path, overwrite=overwrite)
            if not isinstance(result, dict) or "handle" not in result:
                raise ProtocolError("The backend returned an invalid save receipt.")
            self._generation += 1
            # Publication has succeeded. An invalid reopen receipt must never leave
            # the old pending payload usable against its superseded document.
            self._closed = True
            if result["handle"] is None:
                return result
            else:
                self._adopt(result["handle"])
                self.path = result["targetPath"]
                self._closed = False
            return result

    def close(self, *, discard: bool = False) -> None:
        with self._lock:
            if self._closed:
                return
            self.engine.request("close", handle=self.id, discard=discard)
            self._closed = True
            self._generation += 1

    def __enter__(self) -> Workbook:
        self._active()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if exc_type is None:
            self.close()
        else:
            try:
                self.close()
            except AsterError:
                # Preserve the primary caller failure; EOF still retains recovery.
                pass


@dataclass(frozen=True)
class Sheet:
    workbook: Workbook
    id: str
    name: str
    _generation: int

    def read(self, area: str | Bounds | Sequence[int]) -> list[list[Any]]:
        return self.workbook.read(self, area)

    def iter_read_pages(self, area: str | Bounds | Sequence[int]) -> Iterator[dict[str, Any]]:
        return self.workbook.iter_read_pages(self, area)


_ARRAY_FIELDS = frozenset({
    "bulkConstantFills", "structuralOps", "chartEdits", "visualEdits", "visualAdditions",
    "cellImageAdditions", "tableAdditions", "tableEdits", "pivotAdditions", "sheetOps",
    "sheetOrder", "filterStates", "hyperlinkEdits", "cfStates", "dvStates", "pageSetupStates",
    "noteStates", "formulaValues", "pivotCacheRefreshPaths", "pivotRefreshUpdates",
    "sheetProtections", "sparklineAdditions", "protectedRangeStates", "redactionStates",
})
_OBJECT_FIELDS = frozenset({"definedNamesState", "themeState", "workbookProtectionState"})


class Transaction:
    """One detached complete payload, one stable idempotency key, one commit RPC."""

    def __init__(self, workbook: Workbook, snapshot: Mapping[str, Any], *, command_id: str | None):
        self.workbook = workbook
        self._expected_revision = _revision(snapshot["revision"])
        self._command_id = str(uuid.uuid4()) if command_id is None else command_id
        if not isinstance(self.command_id, str) or not 1 <= len(self.command_id) <= 512 or "\x00" in self.command_id:
            raise ValueError("A command ID must be a nonempty string of at most 512 characters.")
        self._generation = workbook._generation
        self._payload = _json_copy(snapshot["payload"])
        self._base_sheets = copy.deepcopy(snapshot["sheets"])
        edits = self._payload.get("edits")
        if not isinstance(edits, list):
            raise ProtocolError("The native payload has no typed cell-edit array.")
        self._edits: dict[tuple[str, int, int], dict[str, Any]] = {}
        for edit in edits:
            key = (edit["sheetId"], edit["row"], edit["column"])
            self._edits[key] = edit
        self._sealed: dict[str, Any] | None = None
        self._committed_sheets: list[dict[str, str]] | None = None
        self._receipt: dict[str, Any] | None = None
        self._aborted = False

    @property
    def command_id(self) -> str:
        return self._command_id

    @property
    def expected_revision(self) -> int:
        return self._expected_revision

    def _mutable(self) -> None:
        self.workbook._active(self._generation)
        if self._aborted or self._sealed is not None:
            raise StaleHandle("This transaction is aborted or sealed for a stable retry.")

    def range(self, sheet: str | Sheet, area: str | Bounds | Sequence[int]) -> TransactionRange:
        self._mutable()
        return TransactionRange(self, self.workbook.sheet(sheet), parse_range(area))

    def set_metadata(self, field: str, value: Any) -> Transaction:
        """Replace one existing document DTO family; validation stays in the host/kernel."""
        self._mutable()
        if field in _ARRAY_FIELDS:
            if type(value) is not list and not (field == "redactionStates" and value is None):
                raise TypeError("A metadata array must be a list.")
        elif field in _OBJECT_FIELDS:
            if value is not None and type(value) is not dict:
                raise TypeError("A metadata state must be a dictionary or None.")
        else:
            raise ValueError("Unknown metadata family; file paths and transport fields are not document contents.")
        self._payload[field] = _json_copy(value)
        return self

    def commit(self) -> dict[str, Any]:
        with self.workbook._lock:
            self.workbook._active(self._generation)
            if self._aborted:
                raise StaleHandle("The transaction was aborted.")
            if self._receipt is not None:
                return copy.deepcopy(self._receipt)
            if self._sealed is None:
                self._payload["edits"] = list(self._edits.values())
                self._committed_sheets = _pending_sheets(self._base_sheets, self._payload)
                self._sealed = _json_copy(self._payload)
            # Do not regenerate IDs/payloads after conflicts or unknown acknowledgements.
            receipt = self.workbook.engine.request("checkpoint", handle=self.workbook.id, payload=self._sealed,
                expectedRevision=self.expected_revision, commandId=self.command_id)
            if not isinstance(receipt, dict) or receipt.get("documentId") != self.workbook.id or receipt.get("commandId") != self.command_id:
                raise ProtocolError("The checkpoint receipt does not match this transaction.")
            actual = _revision(receipt.get("revision"))
            if actual != self.expected_revision + 1:
                raise ProtocolError("The checkpoint receipt has an unexpected revision.")
            self.workbook._handle["revision"] = actual
            self.workbook._handle["sheets"] = copy.deepcopy(self._committed_sheets)
            self.workbook._base_sheets = copy.deepcopy(self._base_sheets)
            self._receipt = copy.deepcopy(receipt)
            return receipt

    def abort(self) -> None:
        if self._sealed is not None:
            raise StaleHandle("A submitted transaction may already be committed; reconcile its stable ID first.")
        self._aborted = True

    def __enter__(self) -> Transaction:
        self._mutable()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if exc_type is None:
            self.commit()
        elif self._sealed is None:
            self.abort()


class TransactionRange:
    def __init__(self, transaction: Transaction, sheet: Sheet, bounds: Bounds):
        self.transaction, self.sheet, self.bounds = transaction, sheet, bounds

    def _edit(self, row: int, column: int) -> dict[str, Any]:
        key = (self.sheet.id, row, column)
        return self.transaction._edits.setdefault(key, {
            "sheetId": self.sheet.id, "row": row, "column": column, "writeValue": False, "value": None,
        })

    def _mutable(self) -> None:
        self.transaction._mutable()
        self.transaction.workbook.sheet(self.sheet)

    def set_values(self, values: Sequence[Sequence[Any]]) -> TransactionRange:
        self._mutable()
        if not isinstance(values, (list, tuple)) or len(values) != self.bounds.rows:
            raise ValueError("Values must have exactly the range's row count.")
        validated = []
        for row in values:
            if not isinstance(row, (list, tuple)) or len(row) != self.bounds.columns:
                raise ValueError("Values must be rectangular and exactly match the range's column count.")
            validated.append([_scalar(value) for value in row])
        for ri, row in enumerate(validated, self.bounds.start_row):
            for ci, value in enumerate(row, self.bounds.start_column):
                edit = self._edit(ri, ci)
                edit.update(writeValue=True, value=value)
                edit.pop("formula", None)
                edit.pop("rich", None)
        return self

    def set_formula(self, formula: str) -> TransactionRange:
        self._mutable()
        if not isinstance(formula, str):
            raise TypeError("A formula must be a string.")
        text = formula[1:] if formula.startswith("=") else formula
        if not 1 <= len(text) <= 8_192:
            raise ValueError("A formula must contain 1 to 8,192 characters.")
        for row in range(self.bounds.start_row, self.bounds.end_row):
            for column in range(self.bounds.start_column, self.bounds.end_column):
                edit = self._edit(row, column)
                edit.update(writeValue=True, value=None, formula=text)
                edit.pop("rich", None)
        return self

    def set_style(self, style: Mapping[str, Any]) -> TransactionRange:
        self._mutable()
        if not isinstance(style, dict) or not style:
            raise ValueError("A style must be a nonempty dictionary using the existing style DTO.")
        delta = _json_copy(style)
        for row in range(self.bounds.start_row, self.bounds.end_row):
            for column in range(self.bounds.start_column, self.bounds.end_column):
                edit = self._edit(row, column)
                edit["style"] = {**edit.get("style", {}), **copy.deepcopy(delta)}
        return self

    def clear(self, *, formats: bool = False) -> TransactionRange:
        self._mutable()
        if type(formats) is not bool:
            raise TypeError("formats must be a boolean.")
        for row in range(self.bounds.start_row, self.bounds.end_row):
            for column in range(self.bounds.start_column, self.bounds.end_column):
                edit = self._edit(row, column)
                edit.update(writeValue=True, value=None)
                edit.pop("formula", None)
                edit.pop("rich", None)
                if formats:
                    edit.pop("style", None)
                    edit["styleReset"] = True
        return self
