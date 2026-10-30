#![cfg(not(target_arch = "wasm32"))]

use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn fixture() -> (TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("query source with spaces.vantage-db");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA application_id=1447120468; PRAGMA user_version=1;
        CREATE TABLE _vantage_objects(kind TEXT,name TEXT,definition TEXT);
        CREATE TABLE Sales(Customer TEXT, Amount REAL);
        INSERT INTO Sales VALUES ('Ada',5),('Lin',9);").unwrap();
    drop(connection);
    (directory, path)
}

fn digest(path: &Path) -> Vec<u8> {
    let mut file = File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    hash.finalize().to_vec()
}

fn start(path: &Path, sql: &str, parameters: Value, max_rows: usize, deadline: u64) -> (Child, ChildStdin) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_vantage-query-worker"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let request = json!({"protocol":1,"nonce":"12345678-1234-1234-1234-123456789abc",
        "path":path,"sql":sql,"parameters":parameters,"maxRows":max_rows,"deadlineMs":deadline});
    serde_json::to_writer(&mut input, &request).unwrap();
    input.write_all(b"\n").unwrap();
    input.flush().unwrap();
    (child, input)
}

fn run(path: &Path, sql: &str, parameters: Value, max_rows: usize) -> (Output, Value) {
    let (child, input) = start(path, sql, parameters, max_rows, 30_000);
    // Keep stdin open until the result; EOF is cancellation, not request framing.
    let output = child.wait_with_output().unwrap();
    drop(input);
    assert!(output.stdout.len() <= 2 * 1024 * 1024);
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["protocol"], 1);
    assert_eq!(value["nonce"], "12345678-1234-1234-1234-123456789abc");
    (output, value)
}

#[test]
fn reads_real_sqlite_and_binds_values_without_interpreting_them_as_sql() {
    let (_directory, path) = fixture();
    let before = digest(&path);
    let (output, result) = run(&path, "SELECT Customer,Amount FROM Sales WHERE Amount>? ORDER BY Amount", json!([0]), 1);
    assert!(output.status.success());
    assert_eq!(result["result"], json!({"columns":["Customer","Amount"],"rows":[{"Customer":"Ada","Amount":5.0}],"truncated":true}));
    let (_, result) = run(&path, "SELECT ? AS literal, ? AS nullable, typeof(?) AS numeric; -- permitted trailing comment", json!(["'; DROP TABLE Sales; --", null, 1]), 10);
    assert_eq!(result["result"]["rows"][0], json!({"literal":"'; DROP TABLE Sales; --","nullable":null,"numeric":"real"}));
    assert_eq!(digest(&path), before);
}

#[test]
fn refuses_multiple_statements_writes_and_wrong_parameter_counts_without_changing_source() {
    let (_directory, path) = fixture();
    let before = digest(&path);
    for (sql, parameters, code) in [
        ("SELECT 1; SELECT 2", json!([]), "QUERY_MULTIPLE_STATEMENTS"),
        ("SELECT 1; DELETE FROM Sales", json!([]), "QUERY_MULTIPLE_STATEMENTS"),
        ("WITH x AS (SELECT 1) DELETE FROM Sales", json!([]), "QUERY_READ_ONLY"),
        ("SELECT ?", json!([]), "QUERY_PARAMETERS"),
    ] {
        let (output, result) = run(&path, sql, parameters, 10);
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(result["error"]["code"], code, "{result}");
        assert_eq!(digest(&path), before);
    }
}

#[test]
fn actually_refuses_a_100mb_sqlite_allocation_with_nomem_not_a_deadline() {
    let (_directory, path) = fixture();
    let before = digest(&path);
    // Direct native child, generous 30-second deadline, no Node/V8 memory cap.
    // Timeout, empty output, signal death or truncation CANNOT satisfy this test.
    let (output, result) = run(&path, "SELECT randomblob(100000000) AS huge", json!([]), 10);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"]["code"], "QUERY_MEMORY_LIMIT");
    assert_eq!(result["error"]["sqliteCode"], 7);
    assert_eq!(result["limits"]["sqliteHeapBytes"], 67_108_864);
    let highwater = result["limits"]["sqliteHighwaterBytes"].as_u64().unwrap();
    assert!(highwater > 0 && highwater <= 67_108_864);
    assert_eq!(digest(&path), before);
}

#[test]
fn detects_a_lazy_100mb_cell_before_copying_or_base64_encoding_it() {
    let (_directory, path) = fixture();
    let (output, result) = run(&path, "SELECT zeroblob(100000000) AS huge", json!([]), 10);
    assert!(output.status.success(), "{result}");
    assert_eq!(result["result"], json!({"columns":["huge"],"rows":[],"truncated":true}));
    assert!(result["limits"]["sqliteHighwaterBytes"].as_u64().unwrap() < 16 * 1024 * 1024);
}

#[test]
fn bounds_whole_result_bytes_and_preserves_small_blob_and_large_integer_values() {
    let (_directory, path) = fixture();
    let (output, result) = run(&path, "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT printf('%0300d',x) AS text FROM n", json!([]), 10000);
    assert!(output.status.success());
    assert_eq!(result["result"]["truncated"], true);
    assert!(result["result"]["rows"].as_array().unwrap().len() < 10000);
    let (_, result) = run(&path, "SELECT x'0001ff' AS blob,9223372036854775807 AS big", json!([]), 10);
    assert_eq!(result["result"]["rows"][0], json!({"blob":"base64:AAH/","big":"9223372036854775807"}));
}

#[test]
fn keeps_large_database_paging_instead_of_imposing_a_file_size_limit() {
    let (_directory, path) = fixture();
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE Payload(data BLOB); BEGIN").unwrap();
    for _ in 0..36 { connection.execute("INSERT INTO Payload VALUES(zeroblob(2097152))", []).unwrap(); }
    connection.execute_batch("COMMIT").unwrap();
    drop(connection);
    assert!(path.metadata().unwrap().len() > 64 * 1024 * 1024);
    let before = digest(&path);
    let (output, result) = run(&path, "SELECT count(*) AS n FROM Payload", json!([]), 10);
    assert!(output.status.success(), "{result}");
    assert_eq!(result["result"]["rows"][0]["n"], 36);
    assert_eq!(digest(&path), before);
}

#[test]
fn disables_extensions_and_double_quoted_string_literals() {
    let (_directory, path) = fixture();
    let (_, result) = run(&path, "SELECT load_extension(?)", json!(["not-a-library"]), 10);
    assert_eq!(result["ok"], false);
    assert!(result["error"]["message"].as_str().unwrap().contains("not authorized"));
    let (_, result) = run(&path, "SELECT \"not_a_column\"", json!([]), 10);
    assert_eq!(result["ok"], false);
    assert!(result["error"]["message"].as_str().unwrap().contains("no such column"));
}

#[test]
fn rejects_other_database_formats() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("other.db");
    drop(Connection::open(&path).unwrap());
    let before = digest(&path);
    let (_, result) = run(&path, "SELECT 1", json!([]), 10);
    assert_eq!(result["error"]["code"], "QUERY_DATABASE_FORMAT");
    assert_eq!(digest(&path), before);
}

#[test]
fn native_progress_deadline_is_distinct_from_allocation_refusal() {
    let (_directory, path) = fixture();
    let (child, input) = start(&path, "WITH RECURSIVE forever(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM forever) SELECT sum(x) FROM forever", json!([]), 10, 100);
    let output = child.wait_with_output().unwrap();
    drop(input);
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(result["error"]["code"], "QUERY_TIMEOUT");
    assert_eq!(result["error"]["sqliteCode"], 9);
}

#[test]
fn parent_eof_cancels_even_when_stdout_is_not_being_drained() {
    let (_directory, path) = fixture();
    let before = digest(&path);
    let (mut child, input) = start(&path, "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT printf('%0200d',x) AS text FROM n", json!([]), 10000, 30000);
    // Observe that output has begun, then leave the bounded result undrained.
    let mut first = [0_u8; 1];
    child.stdout.as_mut().unwrap().read_exact(&mut first).unwrap();
    assert_eq!(first[0], b'{');
    assert!(child.try_wait().unwrap().is_none());
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(125));
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("owned native process did not terminate on parent EOF while stdout was blocked");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(digest(&path), before);
}
