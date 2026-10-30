//! Calculation projections of revision-pinned, fully typed checkpoints.
//! This module never reconstructs saved document values from input strings.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::document::{DocumentSnapshot, validate_payload};
use crate::recalc::{MAX_SUPPORTED_RECALC_EDITS, RecalcEdit};
use crate::session::SessionError;

pub const MAX_DOCUMENT_CALC_EDITS: usize = MAX_SUPPORTED_RECALC_EDITS;
pub const MAX_DOCUMENT_CALC_INPUT_BYTES: usize = 256 * 1024 * 1024;
const MAX_SCAN_MULTIPLIER: usize = 10;

/// Raw values alone cannot represent updated names, tables, visibility,
/// structure or formatting. Such revisions are calculated from an exported
/// checkpoint, rather than silently reusing their imported metadata.
pub fn requires_materialization(snapshot: &DocumentSnapshot) -> bool {
    let Some(payload) = snapshot.payload.as_object() else { return true; };
    for (key, value) in payload {
        match key.as_str() {
            "bulkConstantFills" | "formulaValues" => {},
            "edits" => {
                if value.as_array().is_none_or(|edits| edits.iter().any(|edit| {
                    edit.get("style").is_some() || edit.get("rich").is_some()
                        || edit.get("styleReset") == Some(&Value::Bool(true))
                })) { return true; }
            }
            "sheetOrder" => {
                let Some(order) = value.as_array() else { return true; };
                if !order.is_empty() && (order.len() != snapshot.sheets.len()
                    || order.iter().zip(&snapshot.sheets).any(|(id, sheet)| id.as_str() != Some(sheet.id.as_str())))
                { return true; }
            }
            _ => {
                if !value.is_null() && !value.as_array().is_some_and(Vec::is_empty) { return true; }
            }
        }
    }
    false
}

fn error(message: impl Into<String>) -> SessionError { SessionError::new("invalid_checkpoint", message) }
fn budget(message: impl Into<String>) -> SessionError { SessionError::new("calculation_budget_exceeded", message) }

fn typed_input(value: &Value) -> Result<String, SessionError> {
    match value {
        Value::Null => Ok(String::new()),
        Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.into()),
        Value::Number(value) => Ok(value.to_string()),
        // Always quote text: "12", "TRUE", "=A1", a literal apostrophe and
        // an empty string must not turn into numbers, booleans, formulas or
        // blank cells in the formula engine.
        Value::String(value) => Ok(format!("'{value}")),
        _ => Err(error("Calculation input must be a typed scalar.")),
    }
}

fn coordinate(value: &Map<String, Value>, key: &str) -> Result<u32, SessionError> {
    value.get(key).and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| error(format!("Invalid checkpoint coordinate {key}.")))
}
fn sheet_index(value: &Map<String, Value>, sheets: &BTreeMap<&str, usize>) -> Result<usize, SessionError> {
    value.get("sheetId").and_then(Value::as_str).and_then(|id| sheets.get(id)).copied()
        .ok_or_else(|| error("Calculation refers to an unknown imported worksheet. Materialize structural changes first."))
}

type Address = (usize, u32, u32);

fn insert(
    values: &mut BTreeMap<Address, Arc<str>>,
    address: Address,
    input: &Arc<str>,
    max_edits: usize,
    input_bytes: &mut usize,
) -> Result<(), SessionError> {
    if values.contains_key(&address) { return Ok(()); }
    if values.len() >= max_edits { return Err(budget("The checkpoint contains more unique calculation inputs than the declared budget. Materialize it before calculating.")); }
    let bytes = input_bytes.checked_add(input.len()).filter(|bytes| *bytes <= MAX_DOCUMENT_CALC_INPUT_BYTES)
        .ok_or_else(|| budget("Expanded calculation inputs exceed the byte budget. Materialize the checkpoint before calculating."))?;
    values.insert(address, Arc::clone(input));
    *input_bytes = bytes;
    Ok(())
}

/// Build a deterministic full overlay. The writer applies ordered fills first,
/// then explicit cell edits. Reading fills in reverse and skipping already
/// occupied cells produces that same last-write-wins state without temporary
/// expansion of superseded values. Style-only entries never override a fill.
pub fn calculation_edits(snapshot: &DocumentSnapshot, max_edits: usize) -> Result<Vec<RecalcEdit>, SessionError> {
    if max_edits > MAX_DOCUMENT_CALC_EDITS { return Err(budget("The requested calculation input budget exceeds the native limit.")); }
    validate_payload(&snapshot.payload, &snapshot.sheets)?;
    let payload = snapshot.payload.as_object().ok_or_else(|| error("Invalid checkpoint object."))?;
    let edits = payload.get("edits").and_then(Value::as_array).ok_or_else(|| error("Missing typed calculation edits."))?;
    let fills = payload.get("bulkConstantFills").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let sheets: BTreeMap<&str, usize> = snapshot.sheets.iter().enumerate().map(|(index, sheet)| (sheet.id.as_str(), index)).collect();

    // Bound work as well as output size. Thousands of overlapping million-cell
    // rectangles must not trigger a billion map probes in one request.
    let mut scan_cells = edits.iter().filter(|edit| edit.get("writeValue") == Some(&Value::Bool(true))).count();
    let scan_limit = max_edits.saturating_mul(MAX_SCAN_MULTIPLIER);
    for fill in fills {
        let fill = fill.as_object().ok_or_else(|| error("Invalid bulk calculation fill."))?;
        let rows = u64::from(coordinate(fill, "endRow")?) - u64::from(coordinate(fill, "startRow")?) + 1;
        let columns = u64::from(coordinate(fill, "endColumn")?) - u64::from(coordinate(fill, "startColumn")?) + 1;
        let area = rows.checked_mul(columns).and_then(|area| usize::try_from(area).ok()).ok_or_else(|| budget("Bulk calculation range is too large."))?;
        if area > max_edits { return Err(budget("A bulk fill exceeds the unique calculation input budget. Materialize this checkpoint first.")); }
        scan_cells = scan_cells.checked_add(area).filter(|cells| *cells <= scan_limit)
            .ok_or_else(|| budget("Overlapping bulk fills exceed the bounded calculation expansion work. Materialize this checkpoint first."))?;
    }
    if scan_cells > scan_limit { return Err(budget("Calculation expansion exceeds the declared work budget.")); }
    let mut values = BTreeMap::new();
    let mut input_bytes = 0usize;
    for edit in edits {
        let edit = edit.as_object().ok_or_else(|| error("Invalid typed cell edit."))?;
        if edit.get("writeValue") != Some(&Value::Bool(true)) { continue; }
        let input = match edit.get("formula").and_then(Value::as_str) {
            Some(formula) => formula.to_owned(),
            None => typed_input(edit.get("value").ok_or_else(|| error("Missing typed cell value."))?)?,
        };
        let input: Arc<str> = input.into();
        insert(&mut values, (sheet_index(edit, &sheets)?, coordinate(edit, "row")?, coordinate(edit, "column")?), &input, max_edits, &mut input_bytes)?;
    }
    for fill in fills.iter().rev() {
        let fill = fill.as_object().ok_or_else(|| error("Invalid bulk calculation fill."))?;
        let sheet = sheet_index(fill, &sheets)?;
        let input: Arc<str> = typed_input(fill.get("value").ok_or_else(|| error("Missing typed bulk value."))?)?.into();
        for row in coordinate(fill, "startRow")?..=coordinate(fill, "endRow")? {
            for column in coordinate(fill, "startColumn")?..=coordinate(fill, "endColumn")? {
                insert(&mut values, (sheet, row, column), &input, max_edits, &mut input_bytes)?;
            }
        }
    }
    Ok(values.into_iter().map(|((sheet, row, column), input)| RecalcEdit {
        sheet: snapshot.sheets[sheet].name.clone(), row, column, input: input.to_string(),
    }).collect())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;
    use crate::document::{CheckpointCommand, empty_payload};
    use crate::document_backend::{DocumentSessions, OpenDocument};
    use crate::edit_backend::source_fingerprint;
    use crate::snapshot::SheetDescriptor;

    fn snapshot(payload: Value) -> DocumentSnapshot {
        DocumentSnapshot { api_version: 1, document_id: "document".into(), revision: 1, source_fingerprint: "base".into(), sheets: vec![SheetDescriptor { id: "s".into(), name: "Sheet1".into() }], payload }
    }
    fn input_payload() -> Value {
        let mut payload = empty_payload();
        payload["edits"] = json!([
            {"sheetId":"s","row":0,"column":0,"writeValue":true,"value":12},
            {"sheetId":"s","row":0,"column":1,"writeValue":true,"value":"12"},
            {"sheetId":"s","row":0,"column":2,"writeValue":true,"value":true},
            {"sheetId":"s","row":0,"column":3,"writeValue":true,"value":"TRUE"},
            {"sheetId":"s","row":0,"column":4,"writeValue":true,"value":null},
            {"sheetId":"s","row":0,"column":5,"writeValue":true,"value":""},
            {"sheetId":"s","row":0,"column":6,"writeValue":true,"value":"=A1"},
            {"sheetId":"s","row":0,"column":7,"writeValue":true,"value":"'text"},
            {"sheetId":"s","row":0,"column":8,"writeValue":true,"value":99,"formula":"=A1+1"}
        ]);
        payload
    }

    #[test]
    fn calculation_preserves_numeric_text_boolean_blank_empty_and_formula_types() {
        let edits = calculation_edits(&snapshot(input_payload()), 20).unwrap();
        let inputs: Vec<_> = edits.iter().map(|edit| edit.input.as_str()).collect();
        assert_eq!(inputs, vec!["12", "'12", "TRUE", "'TRUE", "", "'", "'=A1", "''text", "=A1+1"]);
    }

    #[test]
    fn ironcalc_observes_text_number_boolean_and_empty_text_distinctions() {
        use ironcalc::base::Model;
        use ironcalc::export::save_to_xlsx;
        use crate::recalc::{RecalcCache, RecalcRead, recalc_cells_with_limit};

        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("typed.xlsx");
        let mut model = Model::new_empty("typed", "en", "UTC", "en").unwrap();
        let formulas = ["=ISNUMBER(A1)", "=ISTEXT(B1)", "=ISLOGICAL(C1)", "=ISTEXT(D1)", "=ISBLANK(E1)", "=ISTEXT(F1)", "=ISBLANK(F1)"];
        for (column, formula) in formulas.iter().enumerate() { model.set_user_input(0, 2, column as i32 + 1, (*formula).into()).unwrap(); }
        model.evaluate(); save_to_xlsx(&model, path.to_str().unwrap()).unwrap();
        let edits = calculation_edits(&snapshot(input_payload()), 20).unwrap();
        let reads = [RecalcRead { sheet: "Sheet1".into(), range: crate::CellRange { start_row: 1, end_row: 1, start_column: 0, end_column: 6 } }];
        let result = recalc_cells_with_limit(&mut RecalcCache::new(), &path, &edits, &reads, 20).unwrap();
        let values: Vec<_> = result.cells.iter().map(|cell| cell.formatted.as_str()).collect();
        assert_eq!(values, vec!["TRUE", "TRUE", "TRUE", "TRUE", "TRUE", "TRUE", "FALSE"]);
    }

    #[test]
    fn ordered_fills_and_explicit_overrides_match_writer_and_style_only_does_not_clear() {
        let mut payload = empty_payload();
        payload["bulkConstantFills"] = json!([
            {"sheetId":"s","startRow":0,"endRow":0,"startColumn":0,"endColumn":2,"value":1},
            {"sheetId":"s","startRow":0,"endRow":0,"startColumn":1,"endColumn":2,"value":2}
        ]);
        payload["edits"] = json!([
            {"sheetId":"s","row":0,"column":1,"writeValue":false,"value":null,"style":{"numFmt":"0.00"}},
            {"sheetId":"s","row":0,"column":2,"writeValue":true,"value":"override"}
        ]);
        let edits = calculation_edits(&snapshot(payload), 3).unwrap();
        let inputs: Vec<_> = edits.iter().map(|edit| (edit.column, edit.input.as_str())).collect();
        assert_eq!(inputs, vec![(0,"1"),(1,"2"),(2,"'override")]);
    }

    #[test]
    fn unique_input_and_expansion_budgets_fail_instead_of_truncating() {
        let mut payload = empty_payload();
        payload["bulkConstantFills"] = json!([{"sheetId":"s","startRow":0,"endRow":0,"startColumn":0,"endColumn":3,"value":1}]);
        assert_eq!(calculation_edits(&snapshot(payload.clone()), 3).unwrap_err().code, "calculation_budget_exceeded");
        payload["bulkConstantFills"] = json!([{"sheetId":"s","startRow":0,"endRow":1048575,"startColumn":0,"endColumn":0,"value":1}]);
        assert_eq!(calculation_edits(&snapshot(payload), MAX_DOCUMENT_CALC_EDITS).unwrap_err().code, "calculation_budget_exceeded");
        let mut payload = empty_payload();
        let fill = json!({"sheetId":"s","startRow":0,"endRow":0,"startColumn":0,"endColumn":0,"value":1});
        payload["bulkConstantFills"] = Value::Array(vec![fill; MAX_SCAN_MULTIPLIER + 1]);
        assert_eq!(calculation_edits(&snapshot(payload), 1).unwrap_err().code, "calculation_budget_exceeded");
    }

    #[test]
    fn metadata_and_format_changes_require_materialization_but_plain_inputs_do_not() {
        assert!(!requires_materialization(&snapshot(input_payload())));
        for (key, value) in [
            ("structuralOps", json!([{"sheetId":"s","kind":"insert-rows","index":0,"count":1}])),
            ("sheetOps", json!([{"kind":"rename-sheet","sheetId":"s","newName":"Renamed"}])),
            ("definedNamesState", json!({"names":[],"preserveNames":[]})),
            ("filterStates", json!([{"sheetId":"s","filter":null}])),
            ("tableEdits", json!([{"sheetId":"s","name":"Table1"}])),
        ] {
            let mut payload = empty_payload(); payload[key] = value;
            assert!(requires_materialization(&snapshot(payload)), "Expected materialization for {key}");
        }
        let mut payload = input_payload(); payload["edits"][0]["style"] = json!({"numFmt":"0.00"});
        assert!(requires_materialization(&snapshot(payload)));
    }

    fn open_sessions(path: &std::path::Path) -> DocumentSessions {
        let mut sessions = DocumentSessions::default();
        sessions.open(OpenDocument { api_version: 1, document_id: "document".into(), source_path: path.into(), sheets: snapshot(empty_payload()).sheets, store_path: None }).unwrap();
        sessions
    }
    fn command(id: &str, revision: u64, payload: Value) -> CheckpointCommand {
        CheckpointCommand { api_version: 1, document_id: "document".into(), command_id: id.into(), expected_revision: revision, actor: "desktop".into(), payload }
    }

    #[test]
    fn document_calculation_leases_are_fenced_after_commit_replay_close_and_drop() {
        let directory = tempfile::tempdir().unwrap(); let path = directory.path().join("source.xlsx"); fs::write(&path, b"base").unwrap();
        let mut sessions = open_sessions(&path);
        let first = command("one", 0, input_payload()); sessions.apply(first.clone()).unwrap();
        let lease = sessions.calculation("document", 1, None).unwrap();
        assert!(lease.stamp.is_current()); assert_eq!(lease.stamp.max_edits, MAX_DOCUMENT_CALC_EDITS);
        sessions.apply(command("two", 1, empty_payload())).unwrap();
        assert!(!lease.stamp.is_current());
        let current = sessions.calculation("document", 2, None).unwrap();
        sessions.apply(first).unwrap(); assert!(current.stamp.is_current());
        assert_eq!(sessions.calculation("document", 1, None).err().unwrap().code, "stale_revision");
        sessions.close("document"); assert!(!current.stamp.is_current());
        let sessions = open_sessions(&path); let lease = sessions.calculation("document", 0, None).unwrap();
        drop(sessions); assert!(!lease.stamp.is_current());
    }

    #[test]
    fn structural_checkpoint_uses_verified_materialized_bytes_without_double_applying_overlay() {
        let directory = tempfile::tempdir().unwrap(); let source = directory.path().join("source.xlsx"); let materialized = directory.path().join("revision.xlsx");
        fs::write(&source, b"base archive bytes").unwrap(); fs::write(&materialized, b"materialized archive bytes").unwrap();
        let mut sessions = open_sessions(&source);
        let mut payload = input_payload(); payload["structuralOps"] = json!([{"sheetId":"s","kind":"insert-rows","index":0,"count":1}]);
        sessions.apply(command("one", 0, payload)).unwrap();
        assert_eq!(sessions.calculation("document", 1, None).err().unwrap().code, "document_requires_materialization");
        let lease = sessions.calculation("document", 1, Some(materialized.clone())).unwrap();
        assert!(lease.edits.is_empty()); assert_eq!(lease.path, crate::canonicalize(&materialized).unwrap());
        assert_eq!(lease.stamp.source_fingerprint, source_fingerprint(&materialized).unwrap());
        assert_ne!(lease.stamp.source_fingerprint, source_fingerprint(&source).unwrap());
        fs::write(&materialized, b"changed during calculation").unwrap();
        assert_ne!(lease.stamp.source_fingerprint, source_fingerprint(&materialized).unwrap());
        assert_eq!(sessions.calculation("document", 1, Some(directory.path().join("missing.xlsx"))).err().unwrap().code, "io_error");
    }

    #[test]
    fn large_budget_does_not_silently_weaken_legacy_recalc_or_accept_invalid_ranges() {
        use crate::recalc::{MAX_RECALC_EDITS, RecalcCache, RecalcRead, recalc_cells, recalc_cells_with_limit};
        let path = std::path::Path::new("not-opened-for-invalid-request.xlsx");
        let edits: Vec<_> = (0..MAX_RECALC_EDITS + 1).map(|row| RecalcEdit { sheet: "Sheet1".into(), row: row as u32, column: 0, input: "1".into() }).collect();
        let mut cache = RecalcCache::new();
        assert!(matches!(recalc_cells(&mut cache, path, &edits, &[]), Err(crate::SidecarError::InvalidRequest(_))));
        // The explicitly larger budget passes validation and reaches the
        // deliberately missing source; no expensive workbook import occurs.
        assert!(matches!(recalc_cells_with_limit(&mut cache, path, &edits, &[], MAX_DOCUMENT_CALC_EDITS), Err(crate::SidecarError::Io(_))));
        let reads = vec![RecalcRead { sheet: "Sheet1".into(), range: crate::CellRange { start_row: 0, end_row: usize::MAX, start_column: 0, end_column: 0 } }];
        assert!(matches!(recalc_cells_with_limit(&mut cache, path, &[], &reads, MAX_DOCUMENT_CALC_EDITS), Err(crate::SidecarError::InvalidRequest(_))));
    }
}
