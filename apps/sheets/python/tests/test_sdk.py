"""Stdlib-only process/contract tests. The fixture is not a spreadsheet engine."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aster import BackendError, Bounds, EngineDied, EngineSession, EngineTimeout, ProtocolError, StaleHandle, parse_range
from aster import cmds


FAKE_HOST = r'''
import copy, json, os, pathlib, sys, time
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
flags = dict(zip(sys.argv[1::2], sys.argv[2::2]))
root = pathlib.Path(flags["--data"])
root.mkdir(parents=True, exist_ok=True)
log = root / "requests.jsonl"
empty = {name: [] for name in (
    "edits", "structuralOps", "chartEdits", "visualEdits", "visualAdditions", "tableAdditions",
    "pivotAdditions", "sheetOps", "sheetOrder", "filterStates", "hyperlinkEdits", "cfStates", "dvStates",
    "pageSetupStates", "noteStates", "formulaValues", "pivotCacheRefreshPaths", "pivotRefreshUpdates", "sheetProtections"
)}
empty["definedNamesState"] = None
empty["themeState"] = None
docs = {}
receipts = {}
config = {}
next_id = 0
def make_book(path, sheet_id="sheet-1"):
    global next_id
    next_id += 1
    handle = {"id": "book-" + str(next_id), "revision": 0, "sourceFingerprint": "sha256:" + "a" * 64,
              "sheets": [{"id": sheet_id, "name": "Budget"}]}
    docs[handle["id"]] = {"handle": handle, "path": path, "payload": copy.deepcopy(empty)}
    return copy.deepcopy(handle)
try:
    for line in sys.stdin:
        request = json.loads(line)
        with log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(request, ensure_ascii=False) + "\n")
        rid = request["requestId"]
        command = request["command"]
        try:
            if command == "capabilities": result = {"authority": "Rust", "transport": "stdio"}
            elif command == "configure": config.update(request); result = {}
            elif command == "echo": result = request["value"]
            elif command == "sleep": time.sleep(0.25); result = {"finished": True}
            elif command == "die": os._exit(17)
            elif command == "bad": print("not-json", flush=True); continue
            elif command == "wrong_id": print(json.dumps({"requestId": "other", "ok": True, "result": {}}), flush=True); continue
            elif command == "open": result = make_book(request["path"])
            elif command == "snapshot":
                doc = docs[request["handle"]]
                handle = doc["handle"]
                if request.get("revision", handle["revision"]) != handle["revision"]:
                    raise ValueError("revision_conflict")
                result = {"apiVersion": 1, "documentId": handle["id"], "revision": handle["revision"],
                          "sourceFingerprint": handle["sourceFingerprint"], "sheets": handle["sheets"], "payload": doc["payload"]}
            elif command == "checkpoint":
                doc = docs[request["handle"]]
                key = (request["handle"], request["commandId"])
                stable = json.dumps({"payload": request["payload"], "expectedRevision": request["expectedRevision"]}, sort_keys=True)
                if key in receipts:
                    if receipts[key][0] != stable: raise ValueError("command_id_reused")
                    result = receipts[key][1]
                else:
                    if config.pop("failBeforeOnce", False): raise ValueError("revision_conflict")
                    if request["expectedRevision"] != doc["handle"]["revision"]: raise ValueError("revision_conflict")
                    doc["handle"]["revision"] += 1
                    doc["payload"] = copy.deepcopy(request["payload"])
                    result = {"apiVersion": 1, "documentId": request["handle"], "commandId": request["commandId"],
                              "revision": doc["handle"]["revision"], "durable": True, "candidateId": "candidate-1"}
                    receipts[key] = (stable, copy.deepcopy(result))
                    if config.pop("loseAckOnce", False): raise ValueError("checkpoint_outcome_unknown")
            elif command == "read":
                doc = docs[request["handle"]]
                area = request["range"]
                count = (area["endRow"] - area["startRow"] + 1) * (area["endColumn"] - area["startColumn"] + 1)
                if count > 20000: raise ValueError("viewport_too_large")
                cells = [{"row": edit["row"], "column": edit["column"], "value": edit["value"]}
                         for edit in doc["payload"]["edits"] if edit["sheetId"] == request["sheetId"] and edit["writeValue"] and
                         area["startRow"] <= edit["row"] <= area["endRow"] and area["startColumn"] <= edit["column"] <= area["endColumn"]]
                result = {"handleId": request["handle"], "revision": doc["handle"]["revision"], "result": {"cells": cells}}
            elif command == "recalculate":
                doc = docs[request["handle"]]
                if request["revision"] != doc["handle"]["revision"]: raise ValueError("revision_conflict")
                result = {"handleId": request["handle"], "workbookId": request["handle"], "revision": request["revision"], "cells": [],
                          "cacheWritebackAllowed": True, "calculationCompleteness": "complete", "cacheWritebackReasons": [], "cacheWriteback": "allowed"}
                if config.get("calculationResults"): result.update(config["calculationResults"].pop(0))
            elif command == "save":
                old = docs.pop(request["handle"])
                handle = make_book(request["targetPath"], "sheet-after-save")
                result = {"targetPath": request["targetPath"], "savedRevision": old["handle"]["revision"], "handle": handle,
                          "audit": {"preserved": True}, "mutation": {"touchedEntries": ["xl/worksheets/sheet1.xml"]}, "warnings": []}
            elif command == "close": docs.pop(request["handle"]); result = {"closed": True}
            elif command == "candidates": result = [{"id": "candidate-1", "originalPath": request.get("originalPath", "unused.xlsx")}]
            elif command == "recover": result = make_book(request["originalPath"])
            else: raise ValueError("unsupported_command")
            print(json.dumps({"requestId": rid, "ok": True, "result": result}, ensure_ascii=False), flush=True)
        except (ValueError, KeyError) as error:
            print(json.dumps({"requestId": rid, "ok": False, "error": {"code": str(error), "message": str(error)}}), flush=True)
finally:
    with (root / "shutdown.json").open("w", encoding="utf-8") as stream:
        json.dump({"preserved": docs}, stream, ensure_ascii=False)
'''


class SdkTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="aster-python-sdk-")
        self.root = Path(self.directory.name)
        self.host = self.root / "fake_host.py"
        self.host.write_text(FAKE_HOST, encoding="utf-8")
        self.sessions = []

    def tearDown(self):
        for engine in self.sessions:
            engine.close()
        self.directory.cleanup()

    def engine(self, **options):
        engine = EngineSession(node=Path(sys.executable).resolve(), host=self.host, binary=self.root / "owned-unused-binary",
            data=self.root / "data", temp=self.root / "temp", node_args=(), cwd=self.root,
            timeout=5, shutdown_timeout=1, **options)
        self.sessions.append(engine)
        # A measured cold Windows interpreter startup took 10.485s, while
        # subsequent RPCs took 0.015s. Separate readiness from request timing.
        engine.request("capabilities", timeout=30)
        return engine

    def requests(self, command=None):
        path = self.root / "data" / "requests.jsonl"
        values = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []
        return values if command is None else [item for item in values if item["command"] == command]

    def test_bulk_transaction_preserves_types_and_uses_one_commit(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx", password="")
        with wb.transaction(command_id="bulk-1") as tx:
            tx.range("Budget", "A1:D2").set_values([["12", 12, True, None], [False, 1.25, "ação\n世界", 0]])
            tx.range("sheet-1", "A1").set_style({"bold": True})
            tx.range("Budget", "A1").set_style({"italic": True})
            cmds.set_formula(tx, "Budget", "E1", "=SUM(B1:D1)")
            tx.set_metadata("noteStates", [{"sheetId": "sheet-1", "notes": []}])
        commits = self.requests("checkpoint")
        self.assertEqual(len(commits), 1)
        edits = commits[0]["payload"]["edits"]
        self.assertEqual(len(edits), 9)
        values = [edit["value"] for edit in edits[:8]]
        self.assertIs(type(values[0]), str)
        self.assertIs(type(values[1]), int)
        self.assertIs(type(values[2]), bool)
        self.assertIsNone(values[3])
        self.assertEqual(edits[0]["style"], {"bold": True, "italic": True})
        self.assertEqual(edits[-1]["formula"], "SUM(B1:D1)")
        self.assertEqual(wb.revision, 1)
        self.assertEqual(wb.read("Budget", "A1:D2"), [["12", 12, True, None], [False, 1.25, "ação\n世界", 0]])
        self.assertEqual(self.requests("open")[0]["password"], "")
        self.assertIsInstance(engine._process.args, list)

    def test_invalid_shape_and_scalar_do_not_send_or_partially_mutate(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        tx = wb.transaction()
        count = len(self.requests())
        for values in ([[1]], [[1, 2], [3]], [[1, 2], [3, float("nan")]], [[1, 2], [3, 2 ** 53]], [[1, 2], [3, {}]]):
            with self.assertRaises((ValueError, TypeError)):
                tx.range("Budget", "A1:B2").set_values(values)
        with self.assertRaises(ValueError):
            tx.set_metadata("targetPath", str(self.root / "not-a-document-field"))
        self.assertEqual(len(self.requests()), count)
        tx.range("Budget", "A1").set_values([[7]])
        tx.commit()
        self.assertEqual(len(self.requests("checkpoint")[0]["payload"]["edits"]), 1)

    def test_failed_commit_retries_same_id_revision_and_payload(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        tx = wb.transaction(expected_revision=0, command_id="stable-retry")
        tx.range("Budget", "A1").set_values([["pending"]])
        engine.request("configure", failBeforeOnce=True)
        with self.assertRaises(BackendError) as caught:
            tx.commit()
        self.assertEqual(caught.exception.code, "revision_conflict")
        with self.assertRaises(AttributeError):
            tx.command_id = "must-not-change"
        with self.assertRaises(AttributeError):
            tx.expected_revision = 10
        with self.assertRaises(StaleHandle):
            tx.range("Budget", "B1").set_values([["cannot change sealed retry"]])
        receipt = tx.commit()
        self.assertEqual(receipt, tx.commit())
        commits = self.requests("checkpoint")
        self.assertEqual(len(commits), 2)
        self.assertEqual({key: value for key, value in commits[0].items() if key != "requestId"},
                         {key: value for key, value in commits[1].items() if key != "requestId"})

    def test_unknown_ack_retry_reconciles_without_second_revision(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        tx = wb.transaction(command_id="lost-ack")
        tx.range("Budget", "A1").set_values([["once"]])
        engine.request("configure", loseAckOnce=True)
        with self.assertRaises(BackendError) as caught:
            tx.commit()
        self.assertEqual(caught.exception.code, "checkpoint_outcome_unknown")
        self.assertEqual(tx.commit()["revision"], 1)
        self.assertEqual(wb.snapshot()["payload"]["edits"][0]["value"], "once")

    def test_clear_preserves_style_and_prior_metadata_snapshot(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        with wb.transaction() as tx:
            tx.range("Budget", "A1:B1").set_values([[1, 2]]).set_style({"bold": True})
            tx.set_metadata("themeState", {"fonts": {"name": "Custom", "major": "Arial", "minor": "Arial"}})
        with wb.transaction() as tx:
            tx.range("Budget", "A1").clear()
            tx.range("Budget", "B1").clear(formats=True)
        payload = self.requests("checkpoint")[-1]["payload"]
        self.assertEqual(payload["themeState"]["fonts"]["name"], "Custom")
        self.assertEqual(payload["edits"][0]["style"], {"bold": True})
        self.assertIsNone(payload["edits"][0]["value"])
        self.assertTrue(payload["edits"][1]["styleReset"])
        self.assertNotIn("style", payload["edits"][1])

    def test_save_adopts_new_handle_and_invalidates_old_sheet_and_tx(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        old_sheet = wb.sheet("Budget")
        old_tx = wb.transaction()
        old_id = wb.id
        saved = wb.save(self.root / "saved.xlsx")
        self.assertEqual(saved["handle"]["id"], wb.id)
        self.assertNotEqual(old_id, wb.id)
        self.assertEqual(wb.revision, 0)
        for operation in (lambda: old_sheet.read("A1"), lambda: old_tx.commit()):
            with self.assertRaises(StaleHandle):
                operation()
        with wb.transaction() as tx:
            tx.range("Budget", "A1").set_values([["new base"]])
        self.assertEqual(self.requests("checkpoint")[-1]["payload"]["edits"][0]["sheetId"], "sheet-after-save")
        wb.close()
        wb.close()
        self.assertEqual(self.requests("close")[-1]["handle"], wb.id)
        self.assertFalse(self.requests("close")[-1]["discard"])

    def test_read_and_calculation_are_paged_below_viewport_limit(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        rows = wb.read("Budget", Bounds(0, 0, 20_001, 2))
        self.assertEqual(len(rows), 20_001)
        self.assertEqual(len(self.requests("read")), 3)
        calculated = wb.calculate_and_wait([("Budget", Bounds(0, 0, 20_001, 2))])
        self.assertEqual(calculated["calculationCompleteness"], "complete")
        self.assertTrue(calculated["cacheWritebackAllowed"])
        self.assertEqual(calculated["cacheWritebackReasons"], [])
        for request in self.requests("read"):
            area = request["range"]
            self.assertLessEqual((area["endRow"] - area["startRow"] + 1) * (area["endColumn"] - area["startColumn"] + 1), 20_000)
        self.assertEqual(len(self.requests("recalculate")), 3)

    def test_calculation_aggregates_uncertified_metadata_across_all_pages(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        engine.request("configure", calculationResults=[{}, {
            "cacheWritebackAllowed": False, "calculationCompleteness": "unverified",
            "cacheWritebackReasons": ["unsupported_function"], "cacheWriteback": "withheld",
        }, {}])
        calculated = wb.calculate_and_wait([("Budget", Bounds(0, 0, 20_001, 2))])
        self.assertEqual(len(self.requests("recalculate")), 3)
        self.assertFalse(calculated["cacheWritebackAllowed"])
        self.assertEqual(calculated["cacheWriteback"], "withheld")
        self.assertEqual(calculated["calculationCompleteness"], "unverified")
        self.assertEqual(calculated["cacheWritebackReasons"], ["unsupported_function"])

    def test_calculation_missing_or_incoherent_certification_is_withheld(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        engine.request("configure", calculationResults=[{
            "cacheWritebackAllowed": True, "calculationCompleteness": "unverified", "cacheWritebackReasons": [],
        }])
        calculated = wb.calculate_and_wait()
        self.assertFalse(calculated["cacheWritebackAllowed"])
        self.assertEqual(calculated["cacheWritebackReasons"], ["native_provenance_missing_or_invalid"])

    def test_utf8_multiline_and_concurrent_requests_remain_correlated(self):
        engine = self.engine()
        values = ["Olá\n世界\r\n" + str(index) for index in range(12)]
        results, failures = [], []
        def echo(value):
            try:
                results.append(engine.request("echo", value=value))
            except Exception as error:
                failures.append(error)
        threads = [threading.Thread(target=echo, args=(value,)) for value in values]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
            self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertCountEqual(values, results)
        self.assertEqual(len(self.requests("echo")), 12)

    def test_context_shutdown_preserves_pending_and_only_explicit_discard_discards(self):
        engine = self.engine()
        with engine:
            wb = engine.open_workbook(self.root / "book.xlsx")
            with wb.transaction() as tx:
                tx.range("Budget", "A1").set_values([["preserve on EOF"]])
        self.assertEqual(self.requests("close"), [])
        state = json.loads((self.root / "data" / "shutdown.json").read_text(encoding="utf-8"))
        self.assertEqual(state["preserved"][wb.id]["payload"]["edits"][0]["value"], "preserve on EOF")
        self.assertIsNotNone(engine._process.poll())

    def test_explicit_recovery_never_implicitly_saves_original(self):
        engine = self.engine()
        candidates = engine.candidates(self.root / "book.xlsx")
        wb = engine.recover(candidates[0]["id"], self.root / "book.xlsx")
        self.assertEqual(wb.sheet("Budget").name, "Budget")
        self.assertEqual(self.requests("save"), [])
        wb.close(discard=True)
        self.assertTrue(self.requests("close")[-1]["discard"])

    def test_timeout_poisons_transport_and_reaps_owned_child(self):
        engine = self.engine()
        engine.capabilities()  # Avoid making interpreter startup part of a short deadline.
        with self.assertRaises(EngineTimeout):
            engine.request("sleep", timeout=0.03)
        with self.assertRaises(EngineTimeout):
            engine.request("echo", value="must not consume late response")
        engine.close()
        self.assertEqual(len(self.requests("echo")), 0)
        self.assertIsNotNone(engine._process.poll())

    def test_helper_death_and_invalid_protocol_fail_without_hanging(self):
        engine = self.engine()
        with self.assertRaises(EngineDied):
            engine.request("die")
        engine.close()
        other = self.engine()
        with self.assertRaises(ProtocolError):
            other.request("wrong_id")
        with self.assertRaises(ProtocolError):
            other.request("capabilities")

    def test_a1_parser_is_zero_based_half_open_and_bounded(self):
        self.assertEqual(parse_range("$b$2:D4"), Bounds(1, 1, 4, 4))
        self.assertEqual(parse_range("XFD1048576"), Bounds(1_048_575, 16_383, 1_048_576, 16_384))
        self.assertEqual(parse_range((0, 0, 3, 2)), parse_range("A1:B3"))
        for invalid in ("A0", "B2:A1", "XFE1", "A1048577", "Sheet!A1", "A:A"):
            with self.assertRaises(ValueError):
                parse_range(invalid)

    def test_pending_added_and_renamed_sheets_are_addressable_before_save(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        before = wb.sheet("Budget")
        with wb.transaction() as tx:
            tx.set_metadata("sheetOps", [
                {"kind": "rename-sheet", "sheetId": "sheet-1", "newName": "Budget Next"},
                {"kind": "add-sheet", "sheetId": "added-stable-id", "name": "Analysis"},
            ])
            tx.set_metadata("sheetOrder", ["added-stable-id", "sheet-1"])
        self.assertEqual([(sheet.id, sheet.name) for sheet in wb.sheets],
                         [("added-stable-id", "Analysis"), ("sheet-1", "Budget Next")])
        self.assertEqual(wb.sheet("sheet-1").name, "Budget Next")
        with self.assertRaises(StaleHandle):
            before.read("A1")
        with wb.transaction() as tx:
            tx.range("Analysis", "A1").set_values([["new sheet value"]])
        self.assertEqual(wb.sheet("Analysis").read("A1"), [["new sheet value"]])
        wb.calculate_and_wait([("Budget Next", "A1"), ("Analysis", "A1")])
        self.assertEqual([read["sheet"] for read in self.requests("recalculate")[-1]["reads"]], ["Budget Next", "Analysis"])

    def test_snapshot_refresh_uses_native_base_and_complete_pending_sheet_operations(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        with wb.transaction() as tx:
            tx.set_metadata("sheetOps", [{"kind": "duplicate-sheet", "sheetId": "clone-id", "sourceSheetId": "sheet-1", "name": "Copy"}])
            tx.set_metadata("sheetOrder", ["sheet-1", "clone-id"])
        original = wb.sheet("Budget")
        native_snapshot = wb.snapshot()
        self.assertEqual(native_snapshot["sheets"], [{"id": "sheet-1", "name": "Budget"}])
        for _ in range(2):
            wb.snapshot()
            self.assertEqual([sheet.name for sheet in wb.sheets], ["Budget", "Copy"])
        changed = native_snapshot["payload"]
        changed["sheetOps"].extend([
            {"kind": "remove-sheet", "sheetId": "sheet-1"},
            {"kind": "rename-sheet", "sheetId": "clone-id", "newName": "Remaining"},
        ])
        changed["sheetOrder"] = ["clone-id"]
        engine.request("checkpoint", handle=wb.id, payload=changed, expectedRevision=1, commandId="external-sheet-change")
        wb.snapshot()
        self.assertEqual(wb.revision, 2)
        self.assertEqual([(sheet.id, sheet.name) for sheet in wb.sheets], [("clone-id", "Remaining")])
        with self.assertRaises(KeyError):
            wb.sheet("Budget")
        with self.assertRaises(StaleHandle):
            original.read("A1")

    def test_removed_or_renamed_sheet_ranges_fail_and_invalid_sheet_order_sends_no_commit(self):
        engine = self.engine()
        wb = engine.open_workbook(self.root / "book.xlsx")
        stale_tx = wb.transaction()
        stale_range = stale_tx.range("Budget", "A1")
        with wb.transaction() as tx:
            tx.set_metadata("sheetOps", [{"kind": "rename-sheet", "sheetId": "sheet-1", "newName": "Renamed"}])
            tx.set_metadata("sheetOrder", ["sheet-1"])
        count = len(self.requests("checkpoint"))
        with self.assertRaises(StaleHandle):
            stale_range.set_values([["must not mutate a stale range"]])
        invalid = wb.transaction()
        invalid.set_metadata("sheetOrder", ["missing-id"])
        with self.assertRaises(ValueError):
            invalid.commit()
        self.assertEqual(len(self.requests("checkpoint")), count)


if __name__ == "__main__":
    unittest.main()
