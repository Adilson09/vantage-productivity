"""Explicit real-host acceptance run using only an owned synthetic workbook.

This is a command-line acceptance script, not a unittest-discovery test. It
requires a bundled JavaScript host and matching native sidecar, and never runs
unless explicitly invoked. All workbook mutations target its private work dir.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import traceback
import uuid
import xml.etree.ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aster import Bounds, EngineSession, StaleHandle


NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
FIXTURE_NAME = "ffi-fixture.xlsx"
OWNERSHIP_MARKER = ".aster-native-sdk-smoke.json"


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def absolute_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError("Use an absolute path.")
    return path


def prepare_owned_directory(path: Path) -> None:
    if path.is_symlink():
        raise ValueError("The smoke work directory cannot be a symbolic link.")
    marker = path / OWNERSHIP_MARKER
    if path.exists():
        if not path.is_dir():
            raise ValueError("The smoke work path must be a directory.")
        if marker.exists():
            record = json.loads(marker.read_text(encoding="utf-8"))
            if record.get("kind") != "aster-native-sdk-smoke" or record.get("version") != 1:
                raise ValueError("The work directory does not have this script's ownership marker.")
            return
        if any(path.iterdir()):
            raise ValueError("Choose a new or empty smoke work directory; existing unrelated files are never replaced.")
    else:
        path.mkdir(parents=True, mode=0o700)
    with marker.open("x", encoding="utf-8") as stream:
        json.dump({"kind": "aster-native-sdk-smoke", "version": 1, "createdAt": timestamp()}, stream)


def make_fixture(path: Path) -> None:
    """A compact valid OOXML package, including complete standard style records."""
    if path.exists():
        # The script never mutates this retained C-ABI fixture. Reuse only the
        # fixture already created inside its marked, owned work directory.
        verify_formula_package(path, 10, 20)
        return
    parts = {
        "[Content_Types].xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>''',
        "_rels/.rels": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''',
        "xl/workbook.xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>''',
        "xl/_rels/workbook.xml.rels": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>''',
        "xl/styles.xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="0"/>
<fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>''',
        "xl/worksheets/sheet1.xml": '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:G1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>
<sheetData><row r="1">
<c r="A1"><v>10</v></c><c r="B1"><f>A1*2</f><v>20</v></c>
<c r="C1" t="inlineStr"><is><t>12</t></is></c><c r="D1" t="b"><v>1</v></c>
<c r="E1" t="inlineStr"><is><t xml:space="preserve"></t></is></c><c r="F1"/>
<c r="G1" t="inlineStr"><is><t>synthetic fixture</t></is></c>
</row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>''',
    }
    with ZipFile(path, "x", compression=ZIP_DEFLATED) as archive:
        for name, text in parts.items():
            # Stable bytes make the retained fixture repeatable for the ABI probe.
            info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, text.encode("utf-8"))


def verify_formula_package(path: Path, input_value: int, cached_value: int, *, styled: bool = False) -> None:
    with ZipFile(path) as archive:
        require(archive.testzip() is None, "The saved ZIP failed its CRC check.")
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        cells = {cell.attrib["r"]: cell for cell in sheet.findall(".//s:sheetData/s:row/s:c", NS)}
        require(float(cells["A1"].findtext("s:v", namespaces=NS)) == input_value, "A1 in the actual OOXML bytes has the wrong numeric value.")
        formula = cells["B1"].findtext("s:f", namespaces=NS)
        require(formula is not None and formula.lstrip("=") == "A1*2", "The saved B1 formula was not preserved.")
        require(float(cells["B1"].findtext("s:v", namespaces=NS)) == cached_value, "B1's persisted formula cache is stale.")
        if styled:
            require(int(cells["A1"].attrib.get("s", "0")) > 0, "A1's requested style was not written.")


def verify_row(row: list[object], input_value: int, formula_value: int, note: str) -> None:
    require(len(row) == 7, "The native range read returned an unexpected width.")
    require(type(row[0]) in (int, float) and row[0] == input_value, "A1 did not remain numeric.")
    require(type(row[1]) in (int, float) and row[1] == formula_value, "B1 does not expose the matching calculated cache.")
    require(type(row[2]) is str and row[2] == "12", "Numeric-looking text was coerced.")
    require(type(row[3]) is bool and row[3] is False, "The boolean cell was coerced.")
    require(type(row[4]) is str and row[4] == "", "Empty text did not remain distinct from a blank cell.")
    require(row[5] is None, "The blank cell did not remain null.")
    require(type(row[6]) is str and row[6] == note, "The UTF-8 multiline string changed.")


def acceptance(args: argparse.Namespace, receipt: dict[str, object]) -> None:
    for name in ("node", "host", "binary"):
        require(getattr(args, name).is_file(), f"The explicit {name} path is not a file.")
    prepare_owned_directory(args.work_dir)
    fixture = args.work_dir / FIXTURE_NAME
    make_fixture(fixture)
    fixture_digest = sha256(fixture)
    run_id = str(uuid.uuid4())
    run_dir = args.work_dir / ("run-" + run_id)
    run_dir.mkdir(mode=0o700)
    data, temp = run_dir / "data", run_dir / "temp"
    saved_path, recovered_path = run_dir / "calculated.xlsx", run_dir / "recovered-copy.xlsx"
    receipt.update({"runId": run_id, "fixturePath": str(fixture), "fixtureSha256": fixture_digest,
                    "runDirectory": str(run_dir), "savedPath": str(saved_path), "recoveredPath": str(recovered_path)})

    def engine() -> EngineSession:
        return EngineSession(node=args.node, host=args.host, binary=args.binary, data=data, temp=temp,
                             node_args=(), cwd=args.host.parent, timeout=args.timeout, shutdown_timeout=10)

    first_note = "ação\n世界 — synthetic data"
    pending_note = "recover this\nOlá 世界"
    with engine() as sh:
        capabilities = sh.capabilities()
        require(capabilities.get("authority") == "Rust", "The host did not identify its Rust document authority.")
        wb = sh.open_workbook(fixture)
        require(wb.revision == 0, "A fresh native document must start at revision zero.")
        require(wb.sheet("Budget").read("A1:D1") == [[10, 20, "12", True]], "The synthetic source was not read correctly.")
        old_sheet = wb.sheet("Budget")
        tx = wb.transaction(expected_revision=0, stable_command_id=run_id + ":bulk")
        tx.range("Budget", "A1").set_values([[21]]).set_style({"bold": True, "numberFormat": "0.00"})
        tx.range("Budget", "C1:G1").set_values([["12", False, "", None, first_note]])
        committed = tx.commit()
        require(committed.get("durable") is True and committed.get("revision") == 1, "The bulk transaction was not durably acknowledged once.")
        snapshot = wb.snapshot()
        require(snapshot["revision"] == 1 and len(snapshot["payload"]["edits"]) == 6, "The complete typed bulk payload was not retained in one revision.")
        calculated = wb.calculate_and_wait([("Budget", "B1")])
        result_cells = calculated.get("cells", [])
        require(any(cell.get("isFormula") is True and cell.get("row") == 0 and cell.get("column") == 1 and
                    type(cell.get("value")) in (int, float) and cell.get("value") == 42 for cell in result_cells),
                "The real calculator did not return B1's typed numeric result 42.")
        require(wb.revision == 1 and wb.snapshot()["revision"] == 1, "Derived calculation unexpectedly created an input revision.")
        verify_row(wb.read("Budget", "A1:G1")[0], 21, 42, first_note)
        pages = list(wb.iter_read_pages("Budget", Bounds(0, 0, 10_001, 2)))
        require(len(pages) == 2, "A 20,002-cell rectangle must use two bounded viewport requests.")
        require(all(page["bounds"].rows * page["bounds"].columns <= 20_000 for page in pages), "A read page exceeds the native viewport limit.")
        saved = wb.save(saved_path)
        require(saved.get("handle") is not None and wb.revision == 0, "Save did not return a clean replacement handle.")
        require(saved.get("audit", {}).get("preserved") is True, "The real save did not pass native package preservation auditing.")
        verify_formula_package(saved_path, 21, 42, styled=True)
        verify_row(wb.read("Budget", "A1:G1")[0], 21, 42, first_note)
        try:
            old_sheet.read("A1")
        except StaleHandle:
            pass
        else:
            raise AssertionError("A worksheet from the old handle remained usable after save rebasing.")
        saved_digest = sha256(saved_path)
        pending = wb.transaction(stable_command_id=run_id + ":recover")
        pending.range("Budget", "A1").set_values([[77]])
        pending.range("Budget", "G1").set_values([[pending_note]])
        pending_receipt = pending.commit()
        candidate_id = pending_receipt.get("candidateId")
        require(isinstance(candidate_id, str), "The unencrypted acknowledged checkpoint has no recovery candidate.")
        receipt.update({"capabilities": capabilities, "bulkReceipt": committed, "calculation": calculated,
                        "saveReceipt": saved, "pageCount": len(pages), "pendingReceipt": pending_receipt})
        # Deliberately leave the pending workbook open: EngineSession EOF must
        # preserve its acknowledged checkpoint, rather than implicitly discard.

    require(sha256(fixture) == fixture_digest and sha256(saved_path) == saved_digest,
            "Closing a pending engine changed a user-visible source package.")
    with engine() as restarted:
        candidates = restarted.candidates(saved_path)
        matches = [candidate for candidate in candidates if candidate.get("id") == candidate_id]
        require(len(matches) == 1 and matches[0].get("sourceConflict") is False, "The acknowledged checkpoint was not discoverable after process restart.")
        recovered = restarted.recover(candidate_id, saved_path)
        require(recovered.read("Budget", "A1")[0][0] == 77, "Recovery did not restore the acknowledged numeric input.")
        recovered.calculate_and_wait([("Budget", "B1")])
        verify_row(recovered.read("Budget", "A1:G1")[0], 77, 154, pending_note)
        recovered_save = recovered.save(recovered_path)
        require(recovered_save.get("handle") is not None, "The recovered Save As did not rebase to a clean handle.")
        verify_formula_package(recovered_path, 77, 154, styled=True)
        verify_row(recovered.read("Budget", "A1:G1")[0], 77, 154, pending_note)
        require(sha256(saved_path) == saved_digest, "Recovered Save As modified its original instead of only the chosen copy.")
        recovered.close(discard=True)
        require(not any(item.get("id") == candidate_id for item in restarted.candidates(saved_path)), "Successful recovered Save As did not retire its inherited checkpoint.")
        discarded = restarted.open_workbook(fixture)
        discard_tx = discarded.transaction(stable_command_id=run_id + ":discard")
        discard_tx.range("Budget", "A1").set_values([[99]])
        discard_receipt = discard_tx.commit()
        discarded.close(discard=True)
        require(not any(item.get("id") == discard_receipt.get("candidateId") for item in restarted.candidates(fixture)),
                "Explicit discard left its recovery checkpoint discoverable.")
        receipt.update({"recoveryCandidate": matches[0], "recoveredSaveReceipt": recovered_save,
                        "discardReceipt": discard_receipt})
    require(sha256(fixture) == fixture_digest, "The retained C-ABI fixture was modified.")
    verify_formula_package(fixture, 10, 20)
    receipt.update({"fixturePreserved": True, "originalSavedCopyPreserved": sha256(saved_path) == saved_digest,
                    "checks": ["typed-bulk-checkpoint", "native-calculation", "derived-cache-read-save-reopen", "bounded-paged-reads",
                               "stale-sheet-rejected", "process-restart-recovery", "recovery-save-as", "explicit-discard"]})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("node", "host", "binary", "work-dir", "output"):
        parser.add_argument("--" + name, required=True, type=absolute_path)
    parser.add_argument("--timeout", type=float, default=120, help="Per-RPC deadline in seconds (default: 120).")
    args = parser.parse_args()
    reserved = [args.node, args.host, args.binary, args.work_dir / FIXTURE_NAME, args.work_dir / OWNERSHIP_MARKER]
    if args.output.is_symlink() or any(args.output.resolve() == path.resolve() for path in reserved):
        parser.error("The receipt path must be separate from the fixture, ownership marker and runtime files.")
    receipt: dict[str, object] = {"apiVersion": 1, "kind": "aster-python-native-acceptance", "startedAt": timestamp(), "ok": False}
    code = 0
    try:
        acceptance(args, receipt)
        receipt["ok"] = True
    except Exception as error:
        code = 1
        receipt["error"] = {"type": type(error).__name__, "message": str(error),
                            "code": getattr(error, "code", None), "traceback": traceback.format_exc()}
    receipt["completedAt"] = timestamp()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"ok": receipt["ok"], "receipt": str(args.output), "fixture": receipt.get("fixturePath")}, ensure_ascii=True), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
