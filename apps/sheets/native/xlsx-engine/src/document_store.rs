//! Atomic persistence for complete document checkpoints. This is a separate
//! schema from the compatibility calculation-overlay journal.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::document::{DocumentReceipt, DocumentSnapshot, StoredDocument, validate_append, validate_stored};
pub use crate::session::StoreError;

pub trait DocumentStore: Send {
    fn load(&mut self, document_id: &str) -> Result<Option<StoredDocument>, StoreError>;
    fn create(&mut self, document: &StoredDocument) -> Result<(), StoreError>;
    /// Compare the persisted revision, append one immutable receipt and replace
    /// the current snapshot in one atomic transaction before returning success.
    fn append(&mut self, expected_revision: u64, snapshot: &DocumentSnapshot, receipt: &DocumentReceipt) -> Result<(), StoreError>;
    fn is_durable(&self) -> bool;
}

struct MemoryDocument {
    stored: StoredDocument,
    command_index: BTreeMap<String, usize>,
}

#[derive(Clone, Default)]
pub struct MemoryDocumentStore {
    documents: Arc<Mutex<BTreeMap<String, MemoryDocument>>>,
}

fn storage(error: impl std::fmt::Display) -> StoreError { StoreError::Storage(error.to_string()) }

fn initial(document: &StoredDocument) -> Result<(), StoreError> {
    validate_stored(document).map_err(storage)?;
    if document.snapshot.revision != 0 || !document.commands.is_empty() {
        return Err(storage("A document journal must start at revision zero."));
    }
    Ok(())
}

impl DocumentStore for MemoryDocumentStore {
    fn load(&mut self, document_id: &str) -> Result<Option<StoredDocument>, StoreError> {
        let documents = self.documents.lock().map_err(|_| storage("The memory document store is unavailable."))?;
        Ok(documents.get(document_id).map(|document| document.stored.clone()))
    }

    fn create(&mut self, document: &StoredDocument) -> Result<(), StoreError> {
        initial(document)?;
        let mut documents = self.documents.lock().map_err(|_| storage("The memory document store is unavailable."))?;
        if documents.contains_key(&document.snapshot.document_id) { return Err(StoreError::Conflict); }
        documents.insert(document.snapshot.document_id.clone(), MemoryDocument { stored: document.clone(), command_index: BTreeMap::new() });
        Ok(())
    }

    fn append(&mut self, expected: u64, snapshot: &DocumentSnapshot, receipt: &DocumentReceipt) -> Result<(), StoreError> {
        let mut documents = self.documents.lock().map_err(|_| storage("The memory document store is unavailable."))?;
        let document = documents.get_mut(&snapshot.document_id).ok_or(StoreError::Conflict)?;
        validate_append(expected, &document.stored.snapshot, snapshot, receipt)?;
        if receipt.result.durable { return Err(storage("A memory document cannot acknowledge a durable checkpoint.")); }
        if document.command_index.contains_key(&receipt.command_id) { return Err(StoreError::Conflict); }
        let snapshot = snapshot.clone();
        let receipt = receipt.clone();
        document.command_index.insert(receipt.command_id.clone(), document.stored.commands.len());
        document.stored.commands.push(receipt);
        document.stored.snapshot = snapshot;
        Ok(())
    }

    fn is_durable(&self) -> bool { false }
}

#[cfg(not(target_arch = "wasm32"))]
mod sqlite {
    use std::fs::{self, OpenOptions};
    #[cfg(unix)]
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::path::Path;
    use std::time::Duration;

    use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

    use super::*;
    use crate::document::{CheckpointResult, DOCUMENT_API_VERSION};

    const APPLICATION_ID: i64 = 0x4144_4f43; // ADOC: independent checkpoint schema.
    const SCHEMA_VERSION: i64 = 1;

    pub struct SqliteDocumentStore { connection: Connection }

    fn revision_number(revision: u64) -> Result<i64, StoreError> {
        i64::try_from(revision).map_err(|_| storage("Document revision exceeds the journal format."))
    }

    impl SqliteDocumentStore {
        pub fn open(path: &Path) -> Result<Self, StoreError> {
            if path.as_os_str().is_empty() || path == Path::new(":memory:") { return Err(storage("A durable document journal requires a local file.")); }
            if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
                if !parent.exists() {
                    let mut builder = fs::DirBuilder::new();
                    builder.recursive(true);
                    #[cfg(unix)]
                    builder.mode(0o700);
                    builder.create(parent).map_err(storage)?;
                }
            }
            let mut options = OpenOptions::new();
            options.create(true).read(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            let file = options.open(path).map_err(storage)?;
            file.sync_all().map_err(storage)?;
            drop(file);
            let mut connection = Connection::open(path).map_err(storage)?;
            connection.busy_timeout(Duration::from_secs(5)).map_err(storage)?;
            let application: i64 = connection.pragma_query_value(None, "application_id", |row| row.get(0)).map_err(storage)?;
            let schema: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(storage)?;
            if (application != 0 && application != APPLICATION_ID) || (schema != 0 && schema != SCHEMA_VERSION) {
                return Err(storage("Unsupported document checkpoint database format."));
            }
            if application == 0 {
                let tables: i64 = connection.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0)).map_err(storage)?;
                if tables != 0 { return Err(storage("The selected database is not a document checkpoint journal.")); }
            }
            let journal: String = connection.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0)).map_err(storage)?;
            if !journal.eq_ignore_ascii_case("wal") { return Err(storage("Cannot enable document WAL recovery.")); }
            connection.pragma_update(None, "synchronous", "FULL").map_err(storage)?;
            let synchronous: i64 = connection.pragma_query_value(None, "synchronous", |row| row.get(0)).map_err(storage)?;
            if synchronous != 2 { return Err(storage("Cannot enable durable document commits.")); }
            connection.pragma_update(None, "foreign_keys", "ON").map_err(storage)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS office_document_heads (
                    document_id TEXT PRIMARY KEY NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision >= 0),
                    api_version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS office_document_receipts (
                    document_id TEXT NOT NULL,
                    command_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision > 0),
                    request_hash TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY(document_id, command_id),
                    UNIQUE(document_id, revision),
                    FOREIGN KEY(document_id) REFERENCES office_document_heads(document_id)
                );"
            ).map_err(storage)?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID).map_err(storage)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION).map_err(storage)?;
            transaction.commit().map_err(storage)?;
            Ok(Self { connection })
        }
    }

    impl DocumentStore for SqliteDocumentStore {
        fn load(&mut self, document_id: &str) -> Result<Option<StoredDocument>, StoreError> {
            let transaction = self.connection.transaction().map_err(storage)?;
            let head: Option<(i64, u32, String)> = transaction.query_row(
                "SELECT revision, api_version, snapshot_json FROM office_document_heads WHERE document_id=?1", [document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional().map_err(storage)?;
            let Some((revision, api_version, json)) = head else { transaction.commit().map_err(storage)?; return Ok(None); };
            let snapshot: DocumentSnapshot = serde_json::from_str(&json).map_err(|_| storage("Invalid saved document snapshot."))?;
            if snapshot.document_id != document_id || revision_number(snapshot.revision)? != revision || snapshot.api_version != api_version {
                return Err(storage("Document snapshot does not match its committed head."));
            }
            let commands = {
                let mut statement = transaction.prepare("SELECT command_id, revision, request_hash, result_json FROM office_document_receipts WHERE document_id=?1 ORDER BY revision").map_err(storage)?;
                let rows = statement.query_map([document_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))).map_err(storage)?;
                let mut commands = Vec::new();
                for row in rows {
                    let (command_id, receipt_revision, request_hash, result_json) = row.map_err(storage)?;
                    let result: CheckpointResult = serde_json::from_str(&result_json).map_err(|_| storage("Invalid saved document receipt."))?;
                    if !result.durable || result.command_id != command_id || result.document_id != document_id || revision_number(result.revision)? != receipt_revision {
                        return Err(storage("Document receipt does not match its committed row."));
                    }
                    commands.push(DocumentReceipt { command_id, request_hash, result });
                }
                commands
            };
            let stored = StoredDocument { api_version, snapshot, commands };
            validate_stored(&stored).map_err(storage)?;
            transaction.commit().map_err(storage)?;
            Ok(Some(stored))
        }

        fn create(&mut self, document: &StoredDocument) -> Result<(), StoreError> {
            initial(document)?;
            let json = serde_json::to_string(&document.snapshot).map_err(storage)?;
            let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
            let changed = transaction.execute(
                "INSERT INTO office_document_heads(document_id, revision, api_version, snapshot_json) VALUES(?1,0,?2,?3) ON CONFLICT(document_id) DO NOTHING",
                params![document.snapshot.document_id, document.api_version, json],
            ).map_err(storage)?;
            if changed != 1 { return Err(StoreError::Conflict); }
            transaction.commit().map_err(storage)
        }

        fn append(&mut self, expected: u64, snapshot: &DocumentSnapshot, receipt: &DocumentReceipt) -> Result<(), StoreError> {
            let expected_number = revision_number(expected)?;
            let revision = revision_number(snapshot.revision)?;
            if !receipt.result.durable { return Err(storage("A SQLite document receipt must acknowledge durability.")); }
            let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(storage)?;
            let head: Option<(i64, u32, String)> = transaction.query_row(
                "SELECT revision, api_version, snapshot_json FROM office_document_heads WHERE document_id=?1", [&snapshot.document_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).optional().map_err(storage)?;
            let Some((current, api_version, previous_json)) = head else { return Err(StoreError::Conflict); };
            if current != expected_number { return Err(StoreError::Conflict); }
            let previous: DocumentSnapshot = serde_json::from_str(&previous_json).map_err(|_| storage("Invalid document checkpoint head."))?;
            if previous.document_id != snapshot.document_id || previous.api_version != api_version || revision_number(previous.revision)? != current || api_version != DOCUMENT_API_VERSION {
                return Err(storage("Document checkpoint does not match its committed head."));
            }
            validate_append(expected, &previous, snapshot, receipt)?;
            let json = serde_json::to_string(snapshot).map_err(storage)?;
            let result = serde_json::to_string(&receipt.result).map_err(storage)?;
            let changed = transaction.execute(
                "UPDATE office_document_heads SET revision=?2,snapshot_json=?3 WHERE document_id=?1 AND revision=?4",
                params![snapshot.document_id, revision, json, expected_number],
            ).map_err(storage)?;
            if changed != 1 { return Err(StoreError::Conflict); }
            transaction.execute(
                "INSERT INTO office_document_receipts(document_id,command_id,revision,request_hash,result_json) VALUES(?1,?2,?3,?4,?5)",
                params![snapshot.document_id, receipt.command_id, revision, receipt.request_hash, result],
            ).map_err(storage)?;
            transaction.commit().map_err(storage)
        }

        fn is_durable(&self) -> bool { true }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::document::{CheckpointCommand, DocumentAuthority, DocumentOpen, empty_payload};
        use crate::snapshot::SheetDescriptor;
        use serde_json::json;

        fn open() -> DocumentOpen {
            DocumentOpen { api_version: 1, document_id: "document".into(), source_fingerprint: "base".into(), sheets: vec![SheetDescriptor { id: "s".into(), name: "Sheet1".into() }] }
        }
        fn command(id: &str, revision: u64) -> CheckpointCommand {
            let mut payload = empty_payload();
            payload["edits"] = json!([{"sheetId":"s","row":0,"column":0,"writeValue":true,"value":"12","rich":[{"text":"12","bold":true}]}]);
            CheckpointCommand { api_version: 1, document_id: "document".into(), command_id: id.into(), expected_revision: revision, actor: "desktop".into(), payload }
        }

        #[test]
        fn sqlite_reopens_typed_checkpoint_and_original_receipt() {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("document.sqlite");
            let original;
            {
                let mut authority = DocumentAuthority::new(Box::new(SqliteDocumentStore::open(&path).unwrap()));
                authority.open(open()).unwrap();
                original = authority.apply(command("one", 0)).unwrap();
                assert!(original.durable);
                authority.apply(command("two", 1)).unwrap();
            }
            let mut recovered = DocumentAuthority::new(Box::new(SqliteDocumentStore::open(&path).unwrap()));
            assert!(recovered.open(open()).unwrap().recovered);
            assert_eq!(recovered.snapshot("document", None).unwrap().payload["edits"][0]["value"], json!("12"));
            assert_eq!(recovered.apply(command("one", 0)).unwrap(), original);
            assert_eq!(recovered.snapshot("document", None).unwrap().revision, 2);
        }

        #[test]
        fn sqlite_fences_stale_authorities_and_rolls_back_failed_receipt_insert() {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("document.sqlite");
            let mut first = DocumentAuthority::new(Box::new(SqliteDocumentStore::open(&path).unwrap()));
            let mut second = DocumentAuthority::new(Box::new(SqliteDocumentStore::open(&path).unwrap()));
            first.open(open()).unwrap(); second.open(open()).unwrap();
            first.apply(command("one", 0)).unwrap();
            assert_eq!(second.apply(command("stale", 0)).unwrap_err().code, "persistence_conflict");
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TRIGGER reject_document_receipt BEFORE INSERT ON office_document_receipts BEGIN SELECT RAISE(ABORT, 'injected full disk'); END;").unwrap();
            assert_eq!(first.apply(command("two", 1)).unwrap_err().code, "storage_error");
            assert_eq!(first.snapshot("document", None).unwrap().revision, 1);
            let mut reader = SqliteDocumentStore::open(&path).unwrap();
            assert_eq!(reader.load("document").unwrap().unwrap().snapshot.revision, 1);
            connection.execute_batch("DROP TRIGGER reject_document_receipt;").unwrap();
            assert_eq!(first.apply(command("two", 1)).unwrap().revision, 2);
        }

        #[test]
        fn sqlite_recovery_rejects_missing_receipts_and_foreign_database_formats() {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("document.sqlite");
            {
                let mut authority = DocumentAuthority::new(Box::new(SqliteDocumentStore::open(&path).unwrap()));
                authority.open(open()).unwrap(); authority.apply(command("one", 0)).unwrap();
            }
            let connection = Connection::open(&path).unwrap();
            connection.execute("DELETE FROM office_document_receipts", []).unwrap();
            let mut store = SqliteDocumentStore::open(&path).unwrap();
            assert!(store.load("document").is_err());
            let foreign = directory.path().join("foreign.sqlite");
            Connection::open(&foreign).unwrap().execute_batch("CREATE TABLE user_data(value TEXT);").unwrap();
            assert!(SqliteDocumentStore::open(&foreign).is_err());
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use sqlite::SqliteDocumentStore;
