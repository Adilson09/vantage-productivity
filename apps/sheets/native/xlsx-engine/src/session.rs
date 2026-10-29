//! Single-authority transactions, durable acknowledgement and immutable inputs.
//!
//! The session API does not own renderer widgets or replace OOXML patch planning.
//! It owns the cumulative inputs sent to calculation. Storage must atomically
//! compare the prior revision, persist the next snapshot and its command result,
//! then return success. Publication always follows that persistence boundary.

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::snapshot::{SESSION_API_VERSION, SheetDescriptor, WorkbookSnapshot};
use crate::transaction::{
    TransactionCommand, TransactionResult, candidate_inputs, command_hash, validate_command,
    validate_identifier, validate_inputs,
};

/// The authority retains recent lookup history, while callers own any leased
/// older `Arc`s. Durable recovery restores only the latest stored snapshot.
pub const MAX_RETAINED_SNAPSHOTS: usize = 16;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<u64>,
}

impl SessionError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), current_revision: None }
    }

    fn revision_conflict(revision: u64) -> Self {
        Self {
            code: "revision_conflict",
            message: "The workbook revision has changed. Read the latest snapshot before retrying.".into(),
            current_revision: Some(revision),
        }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SessionError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoreError {
    /// A different authority created or advanced this workbook first.
    Conflict,
    Storage(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict => formatter.write_str("The persisted workbook revision changed."),
            Self::Storage(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for StoreError {}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandRecord {
    pub command_id: String,
    pub request_hash: String,
    pub result: TransactionResult,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredWorkbook {
    pub api_version: u32,
    pub snapshot: WorkbookSnapshot,
    pub commands: Vec<CommandRecord>,
}

/// A durable store must commit the entire value atomically. `None` means create
/// only if absent; `Some(r)` means replace only while its current revision is r.
/// Every new accepted command, including a no-op, consumes one revision, making
/// this compare-and-swap sufficient for independently running authorities.
pub trait SessionStore: Send {
    fn load(&mut self, workbook_id: &str) -> Result<Option<StoredWorkbook>, StoreError>;
    fn commit(
        &mut self,
        expected_revision: Option<u64>,
        workbook: &StoredWorkbook,
    ) -> Result<(), StoreError>;
    fn is_durable(&self) -> bool;
}

/// Portable store for WebAssembly/headless callers and deterministic tests.
/// Clones share state, but this store never claims durable acknowledgement.
#[derive(Clone, Default)]
pub struct MemorySessionStore {
    workbooks: Arc<Mutex<BTreeMap<String, StoredWorkbook>>>,
}

impl SessionStore for MemorySessionStore {
    fn load(&mut self, workbook_id: &str) -> Result<Option<StoredWorkbook>, StoreError> {
        let workbooks = self.workbooks.lock().map_err(|_| {
            StoreError::Storage("The memory session store is unavailable.".into())
        })?;
        Ok(workbooks.get(workbook_id).cloned())
    }

    fn commit(
        &mut self,
        expected_revision: Option<u64>,
        workbook: &StoredWorkbook,
    ) -> Result<(), StoreError> {
        let mut workbooks = self.workbooks.lock().map_err(|_| {
            StoreError::Storage("The memory session store is unavailable.".into())
        })?;
        let current = workbooks.get(&workbook.snapshot.workbook_id).map(|value| value.snapshot.revision);
        if current != expected_revision {
            return Err(StoreError::Conflict);
        }
        workbooks.insert(workbook.snapshot.workbook_id.clone(), workbook.clone());
        Ok(())
    }

    fn is_durable(&self) -> bool { false }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenSessionRequest {
    pub api_version: u32,
    pub workbook_id: String,
    pub source_fingerprint: String,
    pub sheets: Vec<SheetDescriptor>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub api_version: u32,
    pub workbook_id: String,
    pub revision: u64,
    pub source_fingerprint: String,
    pub recovered: bool,
}

struct LiveSession {
    stored: StoredWorkbook,
    snapshots: BTreeMap<u64, Arc<WorkbookSnapshot>>,
    recovered: bool,
}

impl LiveSession {
    fn from_stored(stored: StoredWorkbook, recovered: bool) -> Self {
        let snapshot = Arc::new(stored.snapshot.clone());
        let snapshots = BTreeMap::from([(snapshot.revision, snapshot)]);
        Self { stored, snapshots, recovered }
    }

    fn info(&self) -> SessionInfo {
        SessionInfo {
            api_version: SESSION_API_VERSION,
            workbook_id: self.stored.snapshot.workbook_id.clone(),
            revision: self.stored.snapshot.revision,
            source_fingerprint: self.stored.snapshot.source_fingerprint.clone(),
            recovered: self.recovered,
        }
    }
}

pub struct SessionAuthority {
    store: Box<dyn SessionStore>,
    sessions: BTreeMap<String, LiveSession>,
}

impl Default for SessionAuthority {
    fn default() -> Self { Self::new(Box::<MemorySessionStore>::default()) }
}

impl SessionAuthority {
    pub fn new(store: Box<dyn SessionStore>) -> Self {
        Self { store, sessions: BTreeMap::new() }
    }

    pub fn is_durable(&self) -> bool { self.store.is_durable() }

    pub fn open(&mut self, request: OpenSessionRequest) -> Result<SessionInfo, SessionError> {
        validate_open(&request)?;
        if let Some(existing) = self.sessions.get(&request.workbook_id) {
            ensure_source(&existing.stored.snapshot, &request)?;
            return Ok(existing.info());
        }
        let loaded = self.store.load(&request.workbook_id).map_err(store_error)?;
        let session = if let Some(stored) = loaded {
            validate_stored(&stored)?;
            ensure_source(&stored.snapshot, &request)?;
            LiveSession::from_stored(stored, true)
        } else {
            let stored = StoredWorkbook {
                api_version: SESSION_API_VERSION,
                snapshot: WorkbookSnapshot {
                    api_version: SESSION_API_VERSION,
                    workbook_id: request.workbook_id.clone(),
                    revision: 0,
                    source_fingerprint: request.source_fingerprint,
                    sheets: request.sheets,
                    inputs: Vec::new(),
                },
                commands: Vec::new(),
            };
            self.store.commit(None, &stored).map_err(store_error)?;
            LiveSession::from_stored(stored, false)
        };
        let info = session.info();
        self.sessions.insert(request.workbook_id, session);
        Ok(info)
    }

    pub fn apply(&mut self, command: TransactionCommand) -> Result<TransactionResult, SessionError> {
        validate_command(&command)?;
        let hash = command_hash(&command)?;
        let live = self.sessions.get(&command.workbook_id).ok_or_else(not_open)?;

        // Replays precede the expected-revision check: an acknowledged command
        // remains the same command after subsequent edits or process recovery.
        if let Some(record) = live.stored.commands.iter().find(|record| record.command_id == command.command_id) {
            return if record.request_hash == hash {
                Ok(record.result.clone())
            } else {
                Err(SessionError::new(
                    "idempotency_conflict",
                    "This command ID was already used with a different request.",
                ))
            };
        }
        let current = live.stored.snapshot.revision;
        if command.expected_revision != current {
            return Err(SessionError::revision_conflict(current));
        }
        let revision = current.checked_add(1).ok_or_else(|| {
            SessionError::new("revision_exhausted", "The workbook revision limit has been reached.")
        })?;
        let (inputs, changed) = candidate_inputs(&live.stored.snapshot, &command.operations)?;
        let result = TransactionResult {
            api_version: SESSION_API_VERSION,
            workbook_id: command.workbook_id.clone(),
            command_id: command.command_id.clone(),
            revision,
            changed,
            durable: self.store.is_durable(),
        };
        let mut candidate = live.stored.clone();
        candidate.snapshot.revision = revision;
        candidate.snapshot.inputs = inputs;
        candidate.commands.push(CommandRecord {
            command_id: command.command_id,
            request_hash: hash,
            result: result.clone(),
        });

        // The persisted snapshot, command ID and original response are a single
        // unit. A failed write cannot publish either inputs or a new revision.
        self.store.commit(Some(current), &candidate).map_err(store_error)?;
        let live = self.sessions.get_mut(&command.workbook_id).ok_or_else(not_open)?;
        live.snapshots.insert(revision, Arc::new(candidate.snapshot.clone()));
        while live.snapshots.len() > MAX_RETAINED_SNAPSHOTS {
            live.snapshots.pop_first();
        }
        live.stored = candidate;
        Ok(result)
    }

    /// Recent historical snapshots are retained up to MAX_RETAINED_SNAPSHOTS.
    /// A previously leased Arc remains valid when its lookup entry is evicted.
    /// Recovery loads the latest durable snapshot; it does not invent history
    /// that the configured store did not retain.
    pub fn snapshot(
        &self,
        workbook_id: &str,
        revision: Option<u64>,
    ) -> Result<Arc<WorkbookSnapshot>, SessionError> {
        let live = self.sessions.get(workbook_id).ok_or_else(not_open)?;
        let revision = revision.unwrap_or(live.stored.snapshot.revision);
        live.snapshots.get(&revision).cloned().ok_or_else(|| {
            SessionError::new("snapshot_not_found", "This workbook revision is not retained by the open session.")
        })
    }

    pub fn command_result(
        &self,
        workbook_id: &str,
        command_id: &str,
    ) -> Result<Option<TransactionResult>, SessionError> {
        let live = self.sessions.get(workbook_id).ok_or_else(not_open)?;
        Ok(live.stored.commands.iter().find(|record| record.command_id == command_id)
            .map(|record| record.result.clone()))
    }

    pub fn close(&mut self, workbook_id: &str) -> bool {
        self.sessions.remove(workbook_id).is_some()
    }
}

fn not_open() -> SessionError {
    SessionError::new("workbook_not_open", "The native editing session is not open.")
}

fn store_error(error: StoreError) -> SessionError {
    match error {
        StoreError::Conflict => SessionError::new(
            "persistence_conflict",
            "Another authority changed the persisted workbook. Close and reopen this editing session.",
        ),
        StoreError::Storage(message) => SessionError::new("storage_error", message),
    }
}

fn validate_open(request: &OpenSessionRequest) -> Result<(), SessionError> {
    if request.api_version != SESSION_API_VERSION {
        return Err(SessionError::new("unsupported_api_version", "The native editing API version is not supported."));
    }
    validate_identifier(&request.workbook_id, "Workbook ID", 512)?;
    validate_identifier(&request.source_fingerprint, "Source fingerprint", 4_096)?;
    if request.sheets.is_empty() || request.sheets.len() > 16_384 {
        return Err(SessionError::new("invalid_request", "A workbook must have a bounded, nonempty worksheet list."));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for sheet in &request.sheets {
        validate_identifier(&sheet.id, "Worksheet ID", 512)?;
        validate_identifier(&sheet.name, "Worksheet name", 1_024)?;
        if !ids.insert(&sheet.id) || !names.insert(sheet.name.to_lowercase()) {
            return Err(SessionError::new("invalid_request", "Worksheet IDs and names must be unique."));
        }
    }
    Ok(())
}

fn ensure_source(snapshot: &WorkbookSnapshot, request: &OpenSessionRequest) -> Result<(), SessionError> {
    if snapshot.workbook_id != request.workbook_id
        || snapshot.source_fingerprint != request.source_fingerprint
        || snapshot.sheets != request.sheets
    {
        return Err(SessionError::new(
            "source_conflict",
            "This workbook ID belongs to a different imported source or worksheet layout.",
        ));
    }
    Ok(())
}

fn validate_stored(stored: &StoredWorkbook) -> Result<(), SessionError> {
    let invalid = || SessionError::new("invalid_store", "The saved editing session is inconsistent or uses an unsupported schema.");
    if stored.api_version != SESSION_API_VERSION || stored.snapshot.api_version != SESSION_API_VERSION {
        return Err(invalid());
    }
    validate_open(&OpenSessionRequest {
        api_version: stored.snapshot.api_version,
        workbook_id: stored.snapshot.workbook_id.clone(),
        source_fingerprint: stored.snapshot.source_fingerprint.clone(),
        sheets: stored.snapshot.sheets.clone(),
    }).map_err(|_| invalid())?;
    validate_inputs(&stored.snapshot.inputs, &stored.snapshot).map_err(|_| invalid())?;
    if stored.commands.len() as u64 != stored.snapshot.revision {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    for (index, record) in stored.commands.iter().enumerate() {
        if !seen.insert(&record.command_id)
            || record.command_id.trim().is_empty()
            || record.request_hash.len() != 64
            || !record.request_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || record.result.api_version != SESSION_API_VERSION
            || record.result.workbook_id != stored.snapshot.workbook_id
            || record.result.command_id != record.command_id
            || record.result.revision != index as u64 + 1
        {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::snapshot::{CellInput, SdkRange};
    use crate::transaction::TransactionOperation;

    fn open_request() -> OpenSessionRequest {
        OpenSessionRequest {
            api_version: 1,
            workbook_id: "workbook".into(),
            source_fingerprint: "sha256:base".into(),
            sheets: vec![SheetDescriptor { id: "sheet".into(), name: "Sheet1".into() }],
        }
    }

    fn set(input: &str) -> TransactionOperation {
        TransactionOperation::SetCell { sheet_id: "sheet".into(), row: 0, column: 0, input: input.into() }
    }

    fn command(id: &str, revision: u64, operations: Vec<TransactionOperation>) -> TransactionCommand {
        TransactionCommand {
            api_version: 1, workbook_id: "workbook".into(), command_id: id.into(),
            expected_revision: revision, actor: "local-user".into(), operations,
        }
    }

    #[test]
    fn invalid_later_operation_does_not_publish_or_persist_a_partial_edit() {
        let shared = MemorySessionStore::default();
        let mut authority = SessionAuthority::new(Box::new(shared.clone()));
        authority.open(open_request()).unwrap();
        let invalid = TransactionOperation::SetCell {
            sheet_id: "missing".into(), row: 0, column: 0, input: "bad".into(),
        };
        assert!(authority.apply(command("invalid", 0, vec![set("1"), invalid])).is_err());
        assert_eq!(authority.snapshot("workbook", None).unwrap().revision, 0);
        assert!(authority.snapshot("workbook", None).unwrap().inputs.is_empty());
        let mut recovered = SessionAuthority::new(Box::new(shared));
        assert_eq!(recovered.open(open_request()).unwrap().revision, 0);
        assert!(recovered.command_result("workbook", "invalid").unwrap().is_none());
    }

    #[test]
    fn snapshots_remain_immutable_across_commits_and_close() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        authority.apply(command("one", 0, vec![set("1")])).unwrap();
        let pinned = authority.snapshot("workbook", Some(1)).unwrap();
        authority.apply(command("two", 1, vec![set("2")])).unwrap();
        assert_eq!(pinned.inputs[0].input, "1");
        assert_eq!(authority.snapshot("workbook", None).unwrap().inputs[0].input, "2");
        authority.close("workbook");
        assert_eq!(pinned.revision, 1);
        assert_eq!(pinned.inputs[0].input, "1");
    }

    #[test]
    fn old_snapshot_leases_survive_bounded_history_eviction() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        let pinned = authority.snapshot("workbook", Some(0)).unwrap();
        for revision in 0..MAX_RETAINED_SNAPSHOTS as u64 + 4 {
            authority.apply(command(&format!("command-{revision}"), revision, vec![set(&revision.to_string())])).unwrap();
        }
        assert_eq!(authority.sessions["workbook"].snapshots.len(), MAX_RETAINED_SNAPSHOTS);
        assert_eq!(authority.snapshot("workbook", Some(0)).unwrap_err().code, "snapshot_not_found");
        assert_eq!(pinned.revision, 0);
        assert!(pinned.inputs.is_empty());
        assert_eq!(authority.snapshot("workbook", None).unwrap().revision, MAX_RETAINED_SNAPSHOTS as u64 + 4);
    }

    #[test]
    fn repeated_commands_return_original_result_even_after_later_edits_and_recovery() {
        let shared = MemorySessionStore::default();
        let first = command("one", 0, vec![set("1")]);
        let original;
        {
            let mut authority = SessionAuthority::new(Box::new(shared.clone()));
            authority.open(open_request()).unwrap();
            original = authority.apply(first.clone()).unwrap();
            authority.apply(command("two", 1, vec![set("2")])).unwrap();
            assert_eq!(authority.apply(first.clone()).unwrap(), original);
            assert_eq!(authority.snapshot("workbook", None).unwrap().revision, 2);
        }
        let mut recovered = SessionAuthority::new(Box::new(shared));
        let info = recovered.open(open_request()).unwrap();
        assert!(info.recovered);
        assert_eq!(info.revision, 2);
        assert_eq!(recovered.apply(first).unwrap(), original);
        assert_eq!(recovered.command_result("workbook", "one").unwrap(), Some(original));
    }

    #[test]
    fn changed_payload_under_used_id_is_a_structured_conflict() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        authority.apply(command("one", 0, vec![set("1")])).unwrap();
        let error = authority.apply(command("one", 0, vec![set("2")])).unwrap_err();
        assert_eq!(error.code, "idempotency_conflict");
        assert_eq!(authority.snapshot("workbook", None).unwrap().inputs[0].input, "1");
    }

    #[test]
    fn stale_write_returns_current_revision_without_consuming_command_id() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        authority.apply(command("one", 0, vec![set("1")])).unwrap();
        let error = authority.apply(command("two", 0, vec![set("2")])).unwrap_err();
        assert_eq!(error.code, "revision_conflict");
        assert_eq!(error.current_revision, Some(1));
        assert!(authority.command_result("workbook", "two").unwrap().is_none());
        assert_eq!(authority.apply(command("two", 1, vec![set("2")])).unwrap().revision, 2);
    }

    #[test]
    fn source_identity_and_sheet_mapping_are_checked_on_reopen() {
        let shared = MemorySessionStore::default();
        let mut authority = SessionAuthority::new(Box::new(shared.clone()));
        authority.open(open_request()).unwrap();
        authority.close("workbook");
        let mut changed = open_request();
        changed.source_fingerprint = "different".into();
        assert_eq!(authority.open(changed).unwrap_err().code, "source_conflict");
        let mut changed = open_request();
        changed.sheets[0].name = "Renamed".into();
        assert_eq!(authority.open(changed).unwrap_err().code, "source_conflict");
    }

    #[test]
    fn replacement_supports_undo_by_dropping_inputs_but_clear_is_an_explicit_empty_input() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        authority.apply(command("one", 0, vec![set("1")])).unwrap();
        let cleared = authority.apply(command("clear", 1, vec![TransactionOperation::ClearRange {
            sheet_id: "sheet".into(),
            range: SdkRange { start_row: 0, end_row: 1, start_column: 0, end_column: 2 },
        }])).unwrap();
        assert_eq!(cleared.changed, 2);
        let snapshot = authority.snapshot("workbook", None).unwrap();
        assert_eq!(snapshot.inputs.len(), 2);
        assert!(snapshot.inputs.iter().all(|cell| cell.input.is_empty()));
        let undone = authority.apply(command("undo", 2, vec![TransactionOperation::ReplaceInputs { edits: Vec::new() }])).unwrap();
        assert_eq!(undone.changed, 2);
        assert!(authority.snapshot("workbook", None).unwrap().inputs.is_empty());
    }

    #[test]
    fn duplicate_replacement_addresses_and_unbounded_ranges_are_rejected() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        let cell = CellInput { sheet_id: "sheet".into(), row: 0, column: 0, input: "1".into() };
        assert!(authority.apply(command("duplicate", 0, vec![TransactionOperation::ReplaceInputs {
            edits: vec![cell.clone(), cell],
        }])).is_err());
        assert!(authority.apply(command("large", 0, vec![TransactionOperation::ClearRange {
            sheet_id: "sheet".into(),
            range: SdkRange { start_row: 0, end_row: 100_000, start_column: 0, end_column: 100_000 },
        }])).is_err());
        assert_eq!(authority.snapshot("workbook", None).unwrap().revision, 0);
    }

    #[test]
    fn oversized_intermediate_inputs_are_rejected_even_if_later_replaced() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        let mut operations: Vec<_> = (0..9).map(|column| TransactionOperation::SetCell {
            sheet_id: "sheet".into(), row: 0, column, input: "a".repeat(1_048_576),
        }).collect();
        operations.push(TransactionOperation::ReplaceInputs { edits: Vec::new() });
        assert_eq!(authority.apply(command("large", 0, operations)).unwrap_err().code, "invalid_request");
        assert_eq!(authority.snapshot("workbook", None).unwrap().revision, 0);
    }

    #[test]
    fn no_op_commands_consume_revisions_but_replays_do_not() {
        let mut authority = SessionAuthority::default();
        authority.open(open_request()).unwrap();
        let noop = command("noop", 0, Vec::new());
        let result = authority.apply(noop.clone()).unwrap();
        assert_eq!(result.changed, 0);
        assert_eq!(result.revision, 1);
        assert!(!result.durable);
        assert_eq!(authority.apply(noop).unwrap(), result);
        assert_eq!(authority.snapshot("workbook", None).unwrap().revision, 1);
    }

    struct FailingStore { inner: MemorySessionStore, fail: Arc<AtomicBool> }
    impl SessionStore for FailingStore {
        fn load(&mut self, id: &str) -> Result<Option<StoredWorkbook>, StoreError> { self.inner.load(id) }
        fn commit(&mut self, expected: Option<u64>, workbook: &StoredWorkbook) -> Result<(), StoreError> {
            if self.fail.load(Ordering::SeqCst) {
                Err(StoreError::Storage("injected disk-full failure".into()))
            } else { self.inner.commit(expected, workbook) }
        }
        fn is_durable(&self) -> bool { true }
    }

    #[test]
    fn persistence_failure_cannot_acknowledge_or_publish_and_can_be_retried() {
        let fail = Arc::new(AtomicBool::new(false));
        let shared = MemorySessionStore::default();
        let mut authority = SessionAuthority::new(Box::new(FailingStore { inner: shared.clone(), fail: fail.clone() }));
        authority.open(open_request()).unwrap();
        let edit = command("one", 0, vec![set("1")]);
        fail.store(true, Ordering::SeqCst);
        assert_eq!(authority.apply(edit.clone()).unwrap_err().code, "storage_error");
        assert_eq!(authority.snapshot("workbook", None).unwrap().revision, 0);
        assert!(authority.command_result("workbook", "one").unwrap().is_none());
        fail.store(false, Ordering::SeqCst);
        let result = authority.apply(edit).unwrap();
        assert!(result.durable);
        assert_eq!(result.revision, 1);
    }

    #[test]
    fn separate_authorities_cannot_overwrite_a_concurrent_commit() {
        let shared = MemorySessionStore::default();
        let mut first = SessionAuthority::new(Box::new(shared.clone()));
        let mut second = SessionAuthority::new(Box::new(shared.clone()));
        first.open(open_request()).unwrap();
        second.open(open_request()).unwrap();
        first.apply(command("first", 0, vec![set("1")])).unwrap();
        assert_eq!(second.apply(command("second", 0, vec![set("2")])).unwrap_err().code, "persistence_conflict");
        assert_eq!(second.snapshot("workbook", None).unwrap().revision, 0);
        let mut recovered = SessionAuthority::new(Box::new(shared));
        recovered.open(open_request()).unwrap();
        assert_eq!(recovered.snapshot("workbook", None).unwrap().inputs[0].input, "1");
        assert!(recovered.command_result("workbook", "second").unwrap().is_none());
    }

    #[test]
    fn corrupt_recovery_state_is_rejected_before_publication() {
        let shared = MemorySessionStore::default();
        let mut authority = SessionAuthority::new(Box::new(shared.clone()));
        authority.open(open_request()).unwrap();
        authority.apply(command("one", 0, vec![set("1")])).unwrap();
        shared.workbooks.lock().unwrap().get_mut("workbook").unwrap().commands.clear();
        let mut recovered = SessionAuthority::new(Box::new(shared));
        assert_eq!(recovered.open(open_request()).unwrap_err().code, "invalid_store");
        assert!(recovered.snapshot("workbook", None).is_err());
    }

    #[test]
    fn duplicate_sheet_names_are_rejected_without_creating_a_session() {
        let mut authority = SessionAuthority::default();
        let mut request = open_request();
        request.sheets.push(SheetDescriptor { id: "another".into(), name: "sheet1".into() });
        assert_eq!(authority.open(request).unwrap_err().code, "invalid_request");
        assert!(authority.snapshot("workbook", None).is_err());
    }
}
