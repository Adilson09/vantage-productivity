#!/usr/bin/env python3
"""Rename an existing Gothic KR subset without changing decoded font data.

Uses the build generator's names and checks every decoded table before publishing.
Requires FontTools with WOFF2 support. No upstream font or OS installation is used.
Usage: python tools/repair-gothic-kr-metadata.py font.woff2 [--output copy.woff2]
       [--report evidence.json]
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

import fontTools
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import WOFF2FlavorData

sys.dont_write_bytecode = True
STYLE_IDS = {2, 17, 22}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def json_digest(value: object) -> str:
    return digest(json.dumps(value, sort_keys=True, ensure_ascii=True).encode("utf-8"))


def paths_alias(left: Path, right: Path) -> bool:
    if os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve())):
        return True
    return left.exists() and right.exists() and left.samefile(right)


def report_target(path: Path | None, source: Path, output: Path) -> Path | None:
    if path is None:
        return None
    resolved = path.resolve()
    require(not paths_alias(resolved, source) and not paths_alias(resolved, output),
            "Report must not alias the source or output font")
    require(resolved.parent.is_dir(), "Report parent directory does not exist")
    require(not resolved.exists() or resolved.is_file(), "Report target must be a file")
    return resolved


def builder_module():
    path = Path(__file__).with_name("build-gothic-kr-font.py")
    spec = importlib.util.spec_from_file_location("gothic_kr_builder", path)
    require(spec is not None and spec.loader is not None, "Font generator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(path: Path, primary_ids: set[int]) -> dict:
    with TTFont(path, lazy=True, recalcTimestamp=False, recalcBBoxes=False) as font:
        require(font.flavor == "woff2", "Expected an existing WOFF2 subset")
        tables = {str(tag): bytes(font.reader[tag]) for tag in font.reader.keys()}
        records = sorted(
            (
                record.nameID,
                record.platformID,
                record.platEncID,
                record.langID,
                record.string.hex(),
                record.toUnicode(),
            )
            for record in font["name"].names
        )
        cmap = font.getBestCmap()
        metrics = font["hmtx"].metrics
        upm = font["head"].unitsPerEm
        samples = {}
        for codepoint in [0x20, *range(0x30, 0x3A), 0x41, 0xAC00, 0xAE00, 0xD55C]:
            glyph = cmap.get(codepoint)
            require(glyph in metrics, f"Required glyph U+{codepoint:04X} is missing")
            advance, bearing = metrics[glyph]
            samples[f"U+{codepoint:04X}"] = {
                "advance": advance, "leftSideBearing": bearing, "em": advance / upm
            }
        return {
            "tables": tables,
            "records": records,
            "protectedRecords": [r for r in records if r[0] not in primary_ids],
            "styleRecords": [r for r in records if r[0] in STYLE_IDS],
            "primaryNames": [
                {"nameId": r[0], "platform": r[1], "encoding": r[2],
                 "language": r[3], "value": r[5]}
                for r in records if r[0] in primary_ids
            ],
            "glyphOrderSha256": json_digest(font.getGlyphOrder()),
            "cmapSha256": json_digest(cmap),
            "horizontalMetricsSha256": json_digest(metrics),
            "glyphCount": font["maxp"].numGlyphs,
            "unitsPerEm": upm,
            "samples": samples,
        }


def verify(before: dict, after: dict, builder) -> list[str]:
    require(before["tables"].keys() == after["tables"].keys(), "Font table set changed")
    changed = []
    for tag, original in before["tables"].items():
        updated = after["tables"][tag]
        if original != updated:
            changed.append(tag)
        if tag == "name":
            continue
        if tag == "head":
            require(
                original[:8] + original[12:] == updated[:8] + updated[12:],
                "Head fields other than checkSumAdjustment changed",
            )
        else:
            require(original == updated, f"Decoded table {tag} changed")
    require(before["protectedRecords"] == after["protectedRecords"],
            "Copyright, license or another non-primary name changed")
    require(before["styleRecords"] == after["styleRecords"], "Style names changed")
    for key in ["glyphOrderSha256", "cmapSha256", "horizontalMetricsSha256",
                "glyphCount", "unitsPerEm", "samples"]:
        require(before[key] == after[key], f"Font geometry or metrics changed: {key}")
    expected = {
        1: builder.FAMILY, 3: f"{builder.FAMILY} Regular", 4: f"{builder.FAMILY} Regular",
        6: builder.PS_NAME, 16: builder.FAMILY, 18: f"{builder.FAMILY} Regular",
        20: builder.PS_NAME, 21: builder.FAMILY, 25: builder.PS_PREFIX,
    }
    for record in after["primaryNames"]:
        value = record["value"]
        require("nanum" not in value.casefold(), "Reserved Font Name remains in a primary name")
        require("genoffice" not in value.casefold(), "Old primary identity remains")
        if record["nameId"] in expected:
            require(value == expected[record["nameId"]], "Primary name differs from generator")
    for name_id in (1, 6):
        require(any(r["nameId"] == name_id for r in after["primaryNames"]),
                f"Primary name ID {name_id} is missing")
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("font", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    source = args.font.resolve(strict=True)
    output = (args.output or source).resolve()
    require(source.is_file() and output.suffix.lower() == ".woff2", "Expected WOFF2 file paths")
    report_path = report_target(args.report, source, output)
    builder = builder_module()
    original_bytes = source.read_bytes()
    before = snapshot(source, builder.PRIMARY_NAME_IDS)
    descriptor, pending_name = tempfile.mkstemp(prefix=output.name + ".", suffix=".tmp",
                                               dir=output.parent)
    os.close(descriptor)
    pending = Path(pending_name)
    report_pending = None
    try:
        if report_path:
            descriptor, report_name = tempfile.mkstemp(prefix=report_path.name + ".",
                                                       suffix=".tmp", dir=report_path.parent)
            os.close(descriptor)
            report_pending = Path(report_name)
        with TTFont(source, lazy=True, recalcTimestamp=False, recalcBBoxes=False) as font:
            builder.rename_primary_names(font)
            builder.assert_primary_names(font)
            font.flavorData = WOFF2FlavorData(transformedTables=())
            font.save(pending)
        after = snapshot(pending, builder.PRIMARY_NAME_IDS)
        changed = verify(before, after, builder)
        updated_bytes = pending.read_bytes()
        report = {
            "source": str(source), "output": str(output),
            "python": sys.version.split()[0], "fontTools": fontTools.__version__,
            "beforeSha256": digest(original_bytes), "afterSha256": digest(updated_bytes),
            "beforeBytes": len(original_bytes), "afterBytes": len(updated_bytes),
            "changedDecodedTables": changed,
            "allOtherDecodedTablesUnchanged": True, "headOnlyChecksumMayChange": True,
            "copyrightLicenseAndOtherNamesUnchanged": True, "styleNamesUnchanged": True,
            "beforePrimaryNames": before["primaryNames"], "afterPrimaryNames": after["primaryNames"],
            "glyphCount": after["glyphCount"], "unitsPerEm": after["unitsPerEm"],
            "glyphOrderSha256": after["glyphOrderSha256"], "cmapSha256": after["cmapSha256"],
            "horizontalMetricsSha256": after["horizontalMetricsSha256"], "samples": after["samples"],
            "decodedTables": {
                tag: {"beforeSha256": digest(before["tables"][tag]),
                      "afterSha256": digest(after["tables"][tag]),
                      "beforeBytes": len(before["tables"][tag]),
                      "afterBytes": len(after["tables"][tag])}
                for tag in before["tables"]
            },
        }
        if report_pending:
            report_pending.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n",
                                      encoding="utf-8")
        require(source.read_bytes() == original_bytes, "Source changed during metadata repair")
        report_target(report_path, source, output)
        os.replace(pending, output)
        if report_pending:
            os.replace(report_pending, report_path)
        print(json.dumps({"beforeSha256": report["beforeSha256"], "afterSha256": report["afterSha256"],
                          "changedDecodedTables": changed, "glyphCount": report["glyphCount"]}))
    finally:
        pending.unlink(missing_ok=True)
        if report_pending:
            report_pending.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
