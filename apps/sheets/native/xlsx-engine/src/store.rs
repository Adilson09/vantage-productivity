//! Local durable storage for the native workbook session authority.
//!
//! SQLite owns crash recovery; the session publishes a candidate only after
//! this transaction commits. The snapshot and its immutable command receipts
//! share a transaction, and the head revision is a compare-and-swap fence for
//! independent sidecar processes. This file is deliberately not built for WASM.

use std::fs::{self, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::session::{CommandRecord, SessionStore, StoreError, StoredWorkbook};
use crate::snapshot::WorkbookSnapshot;

const APPLICATION_ID: i64 = 0x4153_5452; // ASTR
const SCHEMA_VERSION: i64 = 1;

pub struct SqliteSessionStore {
    connection: Connection,
}

fn storage(error: impl std::fmt::Display) -> StoreError {
    StoreError::Storage(error.to_string())
}

fn revision_number(revision: u64) -> Result<i64, StoreError> {
    i64::try_from(revision).map_err(|_| storage("Workbook revision exceeds the journal format."))
}

impl SqliteSessionStore {
    /// Opens an app-owned *local* database. Callers must never put a recovery
    /// database on a shared/network filesystem or inside the source workbook.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if path.as_os_str().is_empty() || path == Path::new(":memory:") {
            return Err(storage("A durable journal requires a local database file."));
        }
        if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            if !parent.exists() {
                let mut builder = fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                builder.mode(0o700);
                builder.create(parent).map_err(storage)?;
            }
        }
        // Create with private POSIX permissions before SQLite creates its WAL
        // companions. On Windows the app-data directory supplies its user ACL.
        // Existing permissions are never broadened by opening the journal.
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(path).map_err(storage)?;
        file.sync_all().map_err(storage)?;
        drop(file);

        let connection = Connection::open(path).map_err(storage)?;
        connection.busy_timeout(Duration::from_secs(5)).map_err(storage)?;
        let application_id: i64 = connection
            .pragma_query_value(None, "application_id", |row| row.get(0))
            .map_err(storage)?;
        let schema: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage)?;
        if (application_id != 0 && application_id != APPLICATION_ID)
            || (schema != 0 && schema != SCHEMA_VERSION)
        {
            return Err(storage("Unsupported workbook journal database format."));
        }
        if application_id == 0 {
            let tables: i64 = connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    [],
                    |row| row.get(0),
                )
                .map_err(storage)?;
            if tables != 0 {
                return Err(storage("The selected database is not an Vantage workbook journal."));
            }
        }
        let journal: String = connection
            .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))
            .map_err(storage)?;
        if !journal.eq_ignore_ascii_case("wal") {
            return Err(storage("The workbook journal could not enable WAL recovery."));
        }
        connection.pragma_update(None, "synchronous", "FULL").map_err(storage)?;
        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(storage)?;
        if synchronous != 2 {
            return Err(storage("The workbook journal could not enable durable commits."));
        }
        connection.pragma_update(None, "foreign_keys", "ON").map_err(storage)?;
        connection
            .execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS vantage_workbook_heads (
                     workbook_id TEXT PRIMARY KEY NOT NULL,
                     revision INTEGER NOT NULL CHECK (revision >= 0),
                     api_version INTEGER NOT NULL,
                     snapshot_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS vantage_command_receipts (
                     workbook_id TEXT NOT NULL,
                     command_id TEXT NOT NULL,
                     revision INTEGER NOT NULL CHECK (revision > 0),
                     request_hash TEXT NOT NULL,
                     result_json TEXT NOT NULL,
                     PRIMARY KEY (workbook_id, command_id),
                     UNIQUE (workbook_id, revision),
                     FOREIGN KEY (workbook_id) REFERENCES vantage_workbook_heads(workbook_id)
                 );
                 PRAGMA application_id = 1095980114;
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(storage)?;
        Ok(Self { connection })
    }
}

impl SessionStore for SqliteSessionStore {
    fn load(&mut self, workbook_id: &str) -> Result<Option<StoredWorkbook>, StoreError> {
        // A read transaction pins snapshot + receipts to the same committed
        // generation while a different process may be committing a revision.
        let transaction = self.connection.transaction().map_err(storage)?;
        let head: Option<(i64, u32, String)> = transaction
            .query_row(
                "SELECT revision, api_version, snapshot_json FROM vantage_workbook_heads WHERE workbook_id = ?1",
                [workbook_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(storage)?;
        let Some((revision, api_version, snapshot_json)) = head else {
            transaction.commit().map_err(storage)?;
            return Ok(None);
        };
        let snapshot: WorkbookSnapshot = serde_json::from_str(&snapshot_json)
            .map_err(|_| storage("Workbook journal snapshot is invalid."))?;
        if snapshot.workbook_id != workbook_id || revision_number(snapshot.revision)? != revision {
            return Err(storage("Workbook journal snapshot does not match its committed revision."));
        }
        let commands = {
            let mut statement = transaction
                .prepare(
                    "SELECT command_id, request_hash, result_json, revision FROM vantage_command_receipts WHERE workbook_id = ?1 ORDER BY revision",
                )
                .map_err(storage)?;
            let rows = statement
                .query_map([workbook_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })
                .map_err(storage)?;
            let mut commands = Vec::new();
            for row in rows {
                let (command_id, request_hash, result_json, receipt_revision) = row.map_err(storage)?;
                let result: crate::transaction::TransactionResult = serde_json::from_str(&result_json)
                    .map_err(|_| storage("Workbook journal command receipt is invalid."))?;
                if result.command_id != command_id
                    || result.workbook_id != workbook_id
                    || revision_number(result.revision)? != receipt_revision
                    || receipt_revision != commands.len() as i64 + 1
                    || receipt_revision > revision
                {
                    return Err(storage("Workbook journal command sequence is invalid."));
                }
                commands.push(CommandRecord { command_id, request_hash, result });
            }
            commands
        };
        if commands.len() as u64 != snapshot.revision {
            return Err(storage("Workbook journal is missing a committed command receipt."));
        }
        transaction.commit().map_err(storage)?;
        Ok(Some(StoredWorkbook { api_version, snapshot, commands }))
    }

    fn commit(
        &mut self,
        expected_revision: Option<u64>,
        workbook: &StoredWorkbook,
    ) -> Result<(), StoreError> {
        let revision = revision_number(workbook.snapshot.revision)?;
        if workbook.commands.len() as u64 != workbook.snapshot.revision {
            return Err(storage("A journal revision requires its ordered command receipts."));
        }
        let new_receipt = match expected_revision {
            None => {
                if revision != 0 || !workbook.commands.is_empty() {
                    return Err(storage("A new workbook journal must start at revision zero."));
                }
                None
            }
            Some(expected) => {
                if expected.checked_add(1) != Some(workbook.snapshot.revision) {
                    return Err(storage("A journal commit must advance exactly one revision."));
                }
                let receipt = workbook.commands.last().ok_or_else(|| storage("Missing command receipt."))?;
                if receipt.result.command_id != receipt.command_id
                    || receipt.result.workbook_id != workbook.snapshot.workbook_id
                    || receipt.result.revision != workbook.snapshot.revision
                    || !receipt.result.durable
                {
                    return Err(storage("The command receipt does not match its durable revision."));
                }
                Some(receipt)
            }
        };
        let snapshot_json = serde_json::to_string(&workbook.snapshot).map_err(storage)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let changed = match expected_revision {
            None => transaction.execute(
                "INSERT INTO vantage_workbook_heads (workbook_id, revision, api_version, snapshot_json) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workbook_id) DO NOTHING",
                params![workbook.snapshot.workbook_id, revision, workbook.api_version, snapshot_json],
            ),
            Some(expected) => transaction.execute(
                "UPDATE vantage_workbook_heads SET revision = ?2, api_version = ?3, snapshot_json = ?4 WHERE workbook_id = ?1 AND revision = ?5",
                params![workbook.snapshot.workbook_id, revision, workbook.api_version, snapshot_json, revision_number(expected)?],
            ),
        }.map_err(storage)?;
        if changed != 1 {
            return Err(StoreError::Conflict);
        }
        // The trait accepts a full candidate, but already committed receipts
        // are immutable. Reject accidental history rewrites by a caller rather
        // than publishing an in-memory state the next restart cannot recover.
        if let Some(expected) = expected_revision {
            let mut statement = transaction.prepare(
                "SELECT command_id, request_hash, result_json FROM vantage_command_receipts WHERE workbook_id = ?1 ORDER BY revision",
            ).map_err(storage)?;
            let rows = statement.query_map([&workbook.snapshot.workbook_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            }).map_err(storage)?;
            let mut count = 0usize;
            for row in rows {
                let (command_id, request_hash, result_json) = row.map_err(storage)?;
                let candidate = workbook.commands.get(count).ok_or_else(|| storage("The command journal prefix is missing."))?;
                if candidate.command_id != command_id
                    || candidate.request_hash != request_hash
                    || serde_json::to_string(&candidate.result).map_err(storage)? != result_json
                {
                    return Err(storage("Committed command receipts cannot be rewritten."));
                }
                count += 1;
            }
            if count as u64 != expected {
                return Err(storage("The command journal prefix is inconsistent."));
            }
        }
        if let Some(receipt) = new_receipt {
            let result_json = serde_json::to_string(&receipt.result).map_err(storage)?;
            transaction.execute(
                "INSERT INTO vantage_command_receipts (workbook_id, command_id, revision, request_hash, result_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![workbook.snapshot.workbook_id, receipt.command_id, revision, receipt.request_hash, result_json],
            ).map_err(storage)?;
        }
        // FULL synchronous WAL commit is the durability boundary. Neither the
        // revision nor its receipt becomes visible in the session before here.
        transaction.commit().map_err(storage)
    }

    fn is_durable(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{OpenSessionRequest, SessionAuthority};
    use crate::snapshot::{CellInput, SheetDescriptor};
    use crate::transaction::{TransactionCommand, TransactionOperation, TransactionResult};

    fn initial() -> StoredWorkbook {
        StoredWorkbook {
            api_version: 1,
            snapshot: WorkbookSnapshot {
                api_version: 1,
                workbook_id: "durable-test-workbook".into(),
                revision: 0,
                source_fingerprint: "test-source-sha256".into(),
                sheets: vec![SheetDescriptor { id: "sheet-1".into(), name: "Budget".into() }],
                inputs: vec![],
            },
            commands: vec![],
        }
    }

    fn edited(mut prior: StoredWorkbook, input: &str, command_id: &str) -> StoredWorkbook {
        prior.snapshot.revision += 1;
        prior.snapshot.inputs = vec![CellInput { sheet_id: "sheet-1".into(), row: 0, column: 0, input: input.into() }];
        prior.commands.push(CommandRecord {
            command_id: command_id.into(),
            request_hash: "ab".repeat(32),
            result: TransactionResult {
                api_version: 1,
                workbook_id: prior.snapshot.workbook_id.clone(),
                command_id: command_id.into(),
                revision: prior.snapshot.revision,
                changed: 1,
                durable: true,
            },
        });
        prior
    }

    #[test]
    fn journal_reopens_snapshot_and_original_command_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/session.sqlite");
        let original = initial();
        let next = edited(original.clone(), "=SUM(B1:B4)", "command-1");
        {
            let mut store = SqliteSessionStore::open(&path).unwrap();
            assert!(store.is_durable());
            assert!(store.load(&original.snapshot.workbook_id).unwrap().is_none());
            store.commit(None, &original).unwrap();
            store.commit(Some(0), &next).unwrap();
        }
        let mut reopened = SqliteSessionStore::open(&path).unwrap();
        let recovered = reopened.load(&original.snapshot.workbook_id).unwrap().unwrap();
        assert_eq!(serde_json::to_value(recovered).unwrap(), serde_json::to_value(next).unwrap());
        assert_eq!(reopened.connection.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0)).unwrap(), "wal");
        assert_eq!(reopened.connection.pragma_query_value(None, "synchronous", |row| row.get::<_, i64>(0)).unwrap(), 2);
    }

    #[test]
    fn independent_stale_writer_cannot_replace_a_committed_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.sqlite");
        let mut first = SqliteSessionStore::open(&path).unwrap();
        let mut second = SqliteSessionStore::open(&path).unwrap();
        let original = initial();
        first.commit(None, &original).unwrap();
        let winner = edited(original.clone(), "winning input", "winner");
        first.commit(Some(0), &winner).unwrap();
        let stale = edited(original.clone(), "stale input", "stale");
        assert!(matches!(second.commit(Some(0), &stale), Err(StoreError::Conflict)));
        assert!(matches!(second.commit(None, &original), Err(StoreError::Conflict)));
        let recovered = second.load(&original.snapshot.workbook_id).unwrap().unwrap();
        assert_eq!(recovered.snapshot.inputs[0].input, "winning input");
        assert_eq!(recovered.commands.len(), 1);
        assert_eq!(recovered.commands[0].command_id, "winner");
    }

    #[test]
    fn failed_receipt_write_rolls_back_snapshot_and_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.sqlite");
        let mut store = SqliteSessionStore::open(&path).unwrap();
        let original = initial();
        store.commit(None, &original).unwrap();
        store.connection.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON vantage_command_receipts BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;").unwrap();
        assert!(matches!(store.commit(Some(0), &edited(original.clone(), "must roll back", "failed")), Err(StoreError::Storage(_))));
        drop(store);
        let mut reopened = SqliteSessionStore::open(&path).unwrap();
        let recovered = reopened.load(&original.snapshot.workbook_id).unwrap().unwrap();
        assert_eq!(recovered.snapshot.revision, 0);
        assert!(recovered.snapshot.inputs.is_empty());
        assert!(recovered.commands.is_empty());
    }

    #[test]
    fn committed_receipts_cannot_be_rewritten_in_a_later_candidate() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.sqlite");
        let mut store = SqliteSessionStore::open(&path).unwrap();
        let original = initial();
        store.commit(None, &original).unwrap();
        let first = edited(original.clone(), "first", "one");
        store.commit(Some(0), &first).unwrap();
        let mut tampered = edited(first.clone(), "second", "two");
        tampered.commands[0].request_hash = "cd".repeat(32);
        assert!(matches!(store.commit(Some(1), &tampered), Err(StoreError::Storage(_))));
        let recovered = store.load(&original.snapshot.workbook_id).unwrap().unwrap();
        assert_eq!(recovered.snapshot.revision, 1);
        assert_eq!(recovered.commands, first.commands);
    }

    #[test]
    fn durable_authority_replays_original_result_after_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.sqlite");
        let source = initial().snapshot;
        let open = OpenSessionRequest {
            api_version: 1,
            workbook_id: source.workbook_id.clone(),
            source_fingerprint: source.source_fingerprint,
            sheets: source.sheets,
        };
        let command = TransactionCommand {
            api_version: 1,
            workbook_id: source.workbook_id.clone(),
            command_id: "one-stable-command-id".into(),
            expected_revision: 0,
            actor: "store-integration-test".into(),
            operations: vec![TransactionOperation::SetCell {
                sheet_id: "sheet-1".into(), row: 1, column: 2, input: "=A1*2".into(),
            }],
        };
        let result = {
            let mut authority = SessionAuthority::new(Box::new(SqliteSessionStore::open(&path).unwrap()));
            authority.open(open.clone()).unwrap();
            authority.apply(command.clone()).unwrap()
        };
        assert!(result.durable);
        let mut authority = SessionAuthority::new(Box::new(SqliteSessionStore::open(&path).unwrap()));
        assert!(authority.open(open).unwrap().recovered);
        assert_eq!(authority.apply(command.clone()).unwrap(), result);
        let mut different = command;
        different.actor = "different-payload".into();
        assert_eq!(authority.apply(different).unwrap_err().code, "idempotency_conflict");
        let snapshot = authority.snapshot(&source.workbook_id, None).unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.inputs[0].input, "=A1*2");
    }

    #[test]
    fn dropped_uncommitted_sql_transaction_does_not_publish_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.sqlite");
        let mut store = SqliteSessionStore::open(&path).unwrap();
        let original = initial();
        store.commit(None, &original).unwrap();
        {
            let transaction = store.connection.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            transaction.execute("UPDATE vantage_workbook_heads SET revision = 99", []).unwrap();
            // Simulates abandonment before the explicit durability boundary.
        }
        drop(store);
        let mut reopened = SqliteSessionStore::open(&path).unwrap();
        assert_eq!(reopened.load(&original.snapshot.workbook_id).unwrap().unwrap().snapshot.revision, 0);
    }

    #[test]
    fn unknown_or_newer_database_formats_are_not_modified() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unrelated.sqlite");
        let unrelated = Connection::open(&path).unwrap();
        unrelated.execute_batch("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');").unwrap();
        drop(unrelated);
        assert!(SqliteSessionStore::open(&path).is_err());
        let unrelated = Connection::open(&path).unwrap();
        assert_eq!(unrelated.query_row("SELECT value FROM unrelated", [], |row| row.get::<_, String>(0)).unwrap(), "keep");
        unrelated.pragma_update(None, "user_version", 99).unwrap();
        drop(unrelated);
        assert!(SqliteSessionStore::open(&path).is_err());
    }

    #[test]
    fn corrupted_snapshot_is_rejected_instead_of_opening_empty() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.sqlite");
        let mut store = SqliteSessionStore::open(&path).unwrap();
        let original = initial();
        store.commit(None, &original).unwrap();
        store.connection.execute("UPDATE vantage_workbook_heads SET snapshot_json = 'broken'", []).unwrap();
        assert!(matches!(store.load(&original.snapshot.workbook_id), Err(StoreError::Storage(_))));
    }

    #[cfg(unix)]
    #[test]
    fn new_journal_and_directory_have_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private/session.sqlite");
        let _store = SqliteSessionStore::open(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
