"""Source composition only; never runs/builds/tests the application.

Capture this overlay's current before/after Main hunks, apply them with exact
context to the final Native successor, then refresh only this private overlay.
All contexts must match once before either destination is written.
"""
from difflib import SequenceMatcher, unified_diff
from pathlib import Path

OVERLAY = Path(__file__).resolve().parent
EXPECTED = Path(r"D:\Codex-builds\vantage-next-validation\sheets-standalone-runtime-followup-20261030").resolve()
NATIVE = Path(r"D:\Codex-builds\vantage-next-validation\sheets-native-settlement-followup-20261030\after\apps\sheets\src\main\sheets-main.ts")
RELATIVE = Path("apps/sheets/src/main/sheets-main.ts")

if OVERLAY != EXPECTED:
    raise SystemExit("Refusing to compose outside the named Standalone overlay.")

before = OVERLAY / "before" / RELATIVE
after = OVERLAY / "after" / RELATIVE
for destination in (before, after):
    if not destination.resolve().is_relative_to(OVERLAY):
        raise SystemExit("A destination escaped the private Standalone overlay.")

old_lines = before.read_text(encoding="utf-8").splitlines(keepends=True)
new_lines = after.read_text(encoding="utf-8").splitlines(keepends=True)
native_bytes = NATIVE.read_bytes()
result = native_bytes.decode("utf-8").replace("\r\n", "\n")
groups = list(SequenceMatcher(a=old_lines, b=new_lines, autojunk=False).get_grouped_opcodes(3))
if not groups:
    raise SystemExit("No Standalone Main hunks were captured; refusing to replace the overlay.")

for number, group in enumerate(groups, 1):
    old = "".join(old_lines[group[0][1]:group[-1][2]])
    new = "".join(new_lines[group[0][3]:group[-1][4]])
    if not old or result.count(old) != 1:
        raise SystemExit(f"Standalone Main hunk {number} needs review: context did not match exactly once.")
    result = result.replace(old, new, 1)

patch = "".join(unified_diff(
    old_lines, new_lines,
    fromfile="a/apps/sheets/src/main/sheets-main.ts",
    tofile="b/apps/sheets/src/main/sheets-main.ts",
))
(OVERLAY / "Standalone-Main-hunks.patch").write_text(patch, encoding="utf-8", newline="\n")
before.write_bytes(native_bytes)
after.write_text(result, encoding="utf-8", newline="\n")
print(f"Composed {len(groups)} source-only Standalone Main hunks; Native source was read only.")
