//! Exercises the public JSON boundary against real workbook files. These tests
//! intentionally avoid asynchronous calculation so assertions cannot race the
//! process stdout worker; calculation publication leases are tested directly.

use std::path::{Path, PathBuf};

use ironcalc::base::Model;
use ironcalc::export::save_to_xlsx;
use serde_json::{Value, json};

use crate::edit_backend::{EditSessions, OpenEditSession};
use crate::protocol::Engine;
use crate::snapshot::SheetDescriptor;
use crate::transaction::{TransactionCommand, TransactionOperation};

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.xlsx");
    write_fixture(&path, "10");
    (directory, path)
}

fn write_fixture(path: &Path, input: &str) {
    let mut model = Model::new_empty("edit-backend-test", "en", "UTC", "en").unwrap();
    model.set_user_input(0, 1, 1, input.to_owned()).unwrap();
    model.set_user_input(0, 2, 1, "=A1*2".to_owned()).unwrap();
    model.evaluate();
    save_to_xlsx(&model, path.to_str().unwrap()).unwrap();
}

fn open(source: &Path, workbook_id: &str, store: Option<&Path>) -> Value {
    let mut request = json!({
        "command": "open_edit_session",
        "apiVersion": 1,
        "workbookId": workbook_id,
        "sourcePath": source,
        "sheets": [{"id": "sheet-stable", "name": "Sheet1"}],
    });
    if let Some(store) = store {
        request["storePath"] = json!(store);
    }
    request
}

fn transaction(workbook_id: &str, command_id: &str, revision: u64, operations: Value) -> Value {
    json!({
        "command": "apply_transaction",
        "apiVersion": 1,
        "workbookId": workbook_id,
        "commandId": command_id,
        "expectedRevision": revision,
        "actor": "integration-test",
        "operations": operations,
    })
}

fn set_cell(input: &str) -> Value {
    json!({"type": "set_cell", "sheetId": "sheet-stable", "row": 0, "column": 0, "input": input})
}

fn request(engine: &mut Engine, mut request: Value) -> Value {
    request["version"] = json!(1);
    request["requestId"] = json!("edit-backend-integration");
    let response = engine.handle_line(&request.to_string())
        .expect("non-calculation requests must respond synchronously");
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["version"], 1);
    response
}

fn success(engine: &mut Engine, request_value: Value) -> Value {
    let response = request(engine, request_value);
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

fn failure(engine: &mut Engine, request_value: Value, expected_code: &str) -> Value {
    let response = request(engine, request_value);
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], expected_code, "{response}");
    response["error"].clone()
}

fn snapshot(engine: &mut Engine, workbook_id: &str) -> Value {
    success(engine, json!({"command": "snapshot", "apiVersion": 1, "workbookId": workbook_id}))
}

#[test]
fn protocol_batch_validation_and_conflicts_leave_previous_snapshot_authoritative() {
    let (_directory, source) = fixture();
    let mut engine = Engine::new();
    success(&mut engine, open(&source, "atomic-workbook", None));
    success(&mut engine, transaction("atomic-workbook", "first", 0, json!([set_cell("15")])));
    let before = snapshot(&mut engine, "atomic-workbook");
    failure(&mut engine, transaction("atomic-workbook", "failed-batch", 1, json!([
        set_cell("must not publish"),
        {"type": "set_cell", "sheetId": "missing", "row": 0, "column": 1, "input": "invalid sheet"},
    ])), "invalid_request");
    assert_eq!(snapshot(&mut engine, "atomic-workbook"), before);
    assert_eq!(success(&mut engine, json!({
        "command": "command_result", "apiVersion": 1, "workbookId": "atomic-workbook", "commandId": "failed-batch",
    })), Value::Null);
    let stale = failure(&mut engine, transaction("atomic-workbook", "stale", 0, json!([set_cell("stale")])), "revision_conflict");
    assert_eq!(stale["currentRevision"], 1);
    failure(&mut engine, transaction("atomic-workbook", "first", 0, json!([set_cell("different payload")])), "idempotency_conflict");
    assert_eq!(snapshot(&mut engine, "atomic-workbook"), before);
    // A rejected batch did not reserve its command ID or consume a revision.
    let corrected = success(&mut engine, transaction("atomic-workbook", "failed-batch", 1, json!([set_cell("corrected")])));
    assert_eq!(corrected["revision"], 2);
    assert_eq!(snapshot(&mut engine, "atomic-workbook")["inputs"][0]["input"], "corrected");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn protocol_restart_recovers_receipt_and_accepts_identical_source_at_a_new_cache_path() {
    let (directory, source) = fixture();
    let store = directory.path().join("recovery/session.sqlite");
    let command = transaction("recover-workbook", "stable-retry-id", 0, json!([set_cell("42")]));
    let receipt = {
        let mut first = Engine::new();
        assert_eq!(success(&mut first, open(&source, "recover-workbook", Some(&store)))["recovered"], false);
        success(&mut first, command.clone())
    };
    assert_eq!(receipt["durable"], true);
    let copied_source = directory.path().join("new-cache-snapshot.xlsx");
    std::fs::copy(&source, &copied_source).unwrap();
    let mut restarted = Engine::new();
    let recovered = success(&mut restarted, open(&copied_source, "recover-workbook", Some(&store)));
    assert_eq!(recovered["recovered"], true);
    assert_eq!(recovered["revision"], 1);
    assert_eq!(success(&mut restarted, command), receipt);
    assert_eq!(success(&mut restarted, json!({
        "command": "command_result", "apiVersion": 1, "workbookId": "recover-workbook", "commandId": "stable-retry-id",
    })), receipt);
    let recovered_snapshot = snapshot(&mut restarted, "recover-workbook");
    assert_eq!(recovered_snapshot["revision"], 1);
    assert_eq!(recovered_snapshot["inputs"][0]["input"], "42");
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn recovered_workbook_rejects_a_different_source_or_sheet_identity() {
    let (directory, source) = fixture();
    let store = directory.path().join("session.sqlite");
    {
        let mut engine = Engine::new();
        success(&mut engine, open(&source, "source-guard", Some(&store)));
        success(&mut engine, transaction("source-guard", "saved", 0, json!([set_cell("pending input")])));
    }
    let changed_source = directory.path().join("different.xlsx");
    write_fixture(&changed_source, "999");
    let source_bytes = std::fs::read(&source).unwrap();
    let mut restarted = Engine::new();
    failure(&mut restarted, open(&changed_source, "source-guard", Some(&store)), "source_conflict");
    let mut wrong_sheet = open(&source, "source-guard", Some(&store));
    wrong_sheet["sheets"][0]["id"] = json!("replacement-sheet-id");
    failure(&mut restarted, wrong_sheet, "source_conflict");
    success(&mut restarted, open(&source, "source-guard", Some(&store)));
    assert_eq!(snapshot(&mut restarted, "source-guard")["inputs"][0]["input"], "pending input");
    assert_eq!(std::fs::read(source).unwrap(), source_bytes);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn protocol_distinguishes_ephemeral_and_durable_acknowledgements() {
    let (directory, source) = fixture();
    let store = directory.path().join("session.sqlite");
    let mut engine = Engine::new();
    success(&mut engine, open(&source, "ephemeral", None));
    success(&mut engine, open(&source, "durable", Some(&store)));
    assert_eq!(success(&mut engine, transaction("ephemeral", "memory-edit", 0, json!([set_cell("1")])))["durable"], false);
    assert_eq!(success(&mut engine, transaction("durable", "disk-edit", 0, json!([set_cell("2")])))["durable"], true);
    for workbook_id in ["ephemeral", "durable"] {
        assert_eq!(success(&mut engine, json!({"command": "close_edit_session", "apiVersion": 1, "workbookId": workbook_id}))["closed"], true);
    }
    assert_eq!(success(&mut engine, open(&source, "ephemeral", None))["revision"], 0);
    assert_eq!(success(&mut engine, open(&source, "durable", Some(&store)))["revision"], 1);
}

#[test]
fn calculation_leases_are_invalidated_by_commit_close_and_reopen() {
    let (_directory, source) = fixture();
    let mut sessions = EditSessions::default();
    let open_request = || OpenEditSession {
        api_version: 1,
        workbook_id: "calculation-workbook".into(),
        source_path: source.clone(),
        sheets: vec![SheetDescriptor { id: "sheet-stable".into(), name: "Sheet1".into() }],
        store_path: None,
    };
    sessions.open(open_request()).unwrap();
    let baseline = sessions.calculation("calculation-workbook", 0).unwrap();
    assert!(baseline.stamp.is_current());
    let first = TransactionCommand {
        api_version: 1,
        workbook_id: "calculation-workbook".into(),
        command_id: "first".into(),
        expected_revision: 0,
        actor: "lease-test".into(),
        operations: vec![TransactionOperation::SetCell { sheet_id: "sheet-stable".into(), row: 0, column: 0, input: "20".into() }],
    };
    sessions.apply(first.clone()).unwrap();
    assert!(!baseline.stamp.is_current());
    let revision_one = sessions.calculation("calculation-workbook", 1).unwrap();
    assert!(revision_one.stamp.is_current());
    assert_eq!(revision_one.edits[0].sheet, "Sheet1");
    assert_eq!(revision_one.edits[0].input, "20");
    sessions.apply(TransactionCommand { command_id: "second".into(), expected_revision: 1, operations: vec![], ..first.clone() }).unwrap();
    let revision_two = sessions.calculation("calculation-workbook", 2).unwrap();
    assert!(!revision_one.stamp.is_current());
    assert!(revision_two.stamp.is_current());
    // Replaying an older receipt must not rewind the current publication fence.
    sessions.apply(first).unwrap();
    assert!(revision_two.stamp.is_current());
    assert!(!revision_one.stamp.is_current());
    sessions.close("calculation-workbook").unwrap();
    assert!(!revision_two.stamp.is_current());
    sessions.open(open_request()).unwrap();
    assert!(sessions.calculation("calculation-workbook", 0).unwrap().stamp.is_current());
    assert!(!baseline.stamp.is_current());
    assert!(!revision_two.stamp.is_current());
}

#[test]
fn protocol_rejects_unknown_fields_and_api_versions_without_mutation() {
    let (_directory, source) = fixture();
    let mut engine = Engine::new();
    success(&mut engine, open(&source, "strict-workbook", None));
    let before = snapshot(&mut engine, "strict-workbook");
    let mut unknown_open = open(&source, "unknown-workbook", None);
    unknown_open["grantAllPermissions"] = json!(true);
    failure(&mut engine, unknown_open, "invalid_json");
    let mut unknown_command = transaction("strict-workbook", "unknown", 0, json!([set_cell("must not publish")]));
    unknown_command["bypassValidation"] = json!(true);
    failure(&mut engine, unknown_command, "invalid_json");
    let mut unknown_operation = set_cell("must not publish");
    unknown_operation["unsafe"] = json!(true);
    failure(&mut engine, transaction("strict-workbook", "unknown-operation", 0, json!([unknown_operation])), "invalid_json");
    for command in ["snapshot", "command_result", "close_edit_session"] {
        let mut unsupported = json!({"command": command, "apiVersion": 2, "workbookId": "strict-workbook"});
        if command == "command_result" { unsupported["commandId"] = json!("any"); }
        failure(&mut engine, unsupported, "unsupported_api_version");
    }
    let mut unsupported = transaction("strict-workbook", "future", 0, json!([set_cell("must not publish")]));
    unsupported["apiVersion"] = json!(2);
    failure(&mut engine, unsupported, "unsupported_api_version");
    let mut unsupported_open = open(&source, "future-open", None);
    unsupported_open["apiVersion"] = json!(2);
    failure(&mut engine, unsupported_open, "unsupported_api_version");
    assert_eq!(snapshot(&mut engine, "strict-workbook"), before);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn source_workbook_cannot_be_used_as_its_own_recovery_database_through_a_path_alias() {
    let (directory, source) = fixture();
    let before = std::fs::read(&source).unwrap();
    let aliased_source = directory.path().join(".").join("source.xlsx");
    let mut engine = Engine::new();
    failure(&mut engine, open(&source, "alias-workbook", Some(&aliased_source)), "invalid_request");
    assert_eq!(std::fs::read(&source).unwrap(), before);
    assert!(!directory.path().join("source.xlsx-wal").exists());
    assert!(!directory.path().join("source.xlsx-shm").exists());
    success(&mut engine, open(&source, "alias-workbook", None));
    assert_eq!(snapshot(&mut engine, "alias-workbook")["revision"], 0);
}
