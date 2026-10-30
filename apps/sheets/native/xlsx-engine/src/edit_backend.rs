//! Desktop/embedded boundary for the Rust edit authority. The existing OOXML
//! reader and package-preserving exporter remain independent of live edits.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::recalc::{MAX_RECALC_EDITS, RecalcEdit};
use crate::session::{MemorySessionStore, OpenSessionRequest, SessionAuthority, SessionError, SessionInfo};
use crate::snapshot::{SESSION_API_VERSION, SheetDescriptor, WorkbookSnapshot};
use crate::transaction::{TransactionCommand, TransactionResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenEditSession {
    pub api_version: u32,
    pub workbook_id: String,
    pub source_path: PathBuf,
    pub sheets: Vec<SheetDescriptor>,
    /// Omit for ephemeral or password-protected documents. The host owns this
    /// local database path; it must never point at an exported workbook.
    pub store_path: Option<PathBuf>,
}

struct EditSession {
    authority: SessionAuthority,
    source_path: PathBuf,
    store_path: Option<PathBuf>,
    revision: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct EditSessions {
    entries: HashMap<String, EditSession>,
}

/// An immutable calculation lease. Results carry their input revision; a
/// newer commit or a close invalidates publication of this lease's results.
#[derive(Clone)]
pub struct CalculationStamp {
    pub workbook_id: String,
    pub revision: u64,
    pub source_fingerprint: String,
    pub max_edits: usize,
    current_revision: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
}

impl CalculationStamp {
    pub fn new(
        workbook_id: String,
        revision: u64,
        source_fingerprint: String,
        current_revision: Arc<AtomicU64>,
        alive: Arc<AtomicBool>,
        max_edits: usize,
    ) -> Self {
        Self { workbook_id, revision, source_fingerprint, max_edits, current_revision, alive }
    }

    pub fn is_current(&self) -> bool {
        self.alive.load(Ordering::Acquire)
            && self.current_revision.load(Ordering::Acquire) == self.revision
    }
}

pub struct CalculationInput {
    pub path: PathBuf,
    pub edits: Vec<RecalcEdit>,
    pub stamp: CalculationStamp,
}

fn error(code: &'static str, message: impl Into<String>) -> SessionError {
    SessionError { code, message: message.into(), current_revision: None }
}

/// Hash the actual source bytes rather than a transient cache path or file
/// timestamp. Identical snapshots can safely reopen a durable edit session.
pub fn source_fingerprint(path: &Path) -> Result<String, SessionError> {
    let file = File::open(path).map_err(|e| error("io_error", format!("Cannot open workbook source: {e}")))?;
    let mut reader = BufReader::new(file);
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|e| error("io_error", format!("Cannot read workbook source: {e}")))?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

impl EditSessions {
    pub fn open(&mut self, request: OpenEditSession) -> Result<SessionInfo, SessionError> {
        if request.api_version != SESSION_API_VERSION {
            return Err(error("unsupported_api_version", "Unsupported spreadsheet edit API version."));
        }
        let source_path = crate::canonicalize(&request.source_path)
            .map_err(|e| error("io_error", format!("Cannot resolve workbook source: {e}")))?;
        let fingerprint = source_fingerprint(&source_path)?;
        let open = OpenSessionRequest {
            api_version: request.api_version,
            workbook_id: request.workbook_id.clone(),
            source_fingerprint: fingerprint,
            sheets: request.sheets,
        };
        if let Some(session) = self.entries.get_mut(&request.workbook_id) {
            if session.store_path != request.store_path {
                return Err(error("store_conflict", "An open workbook cannot switch recovery stores."));
            }
            let info = session.authority.open(open)?;
            session.source_path = source_path;
            return Ok(info);
        }
        let store: Box<dyn crate::session::SessionStore> = match request.store_path.as_deref() {
            None => Box::new(MemorySessionStore::default()),
            Some(path) => {
                if !path.is_absolute() || path == source_path || path == request.source_path {
                    return Err(error("invalid_request", "Recovery store must be an absolute path separate from the workbook."));
                }
                if let Ok(existing) = crate::canonicalize(path) {
                    if existing == source_path {
                        return Err(error("invalid_request", "The recovery store cannot be the source workbook."));
                    }
                }
                #[cfg(not(target_arch = "wasm32"))]
                {
                    Box::new(crate::store::SqliteSessionStore::open(path)
                        .map_err(|e| error("storage_error", e.to_string()))?)
                }
                #[cfg(target_arch = "wasm32")]
                {
                    return Err(error("unsupported_storage", "SQLite recovery is available in desktop builds. Omit storePath for an embedded session."));
                }
            }
        };
        let mut authority = SessionAuthority::new(store);
        let info = authority.open(open)?;
        self.entries.insert(request.workbook_id, EditSession {
            authority,
            source_path,
            store_path: request.store_path,
            revision: Arc::new(AtomicU64::new(info.revision)),
            alive: Arc::new(AtomicBool::new(true)),
        });
        Ok(info)
    }

    pub fn apply(&mut self, command: TransactionCommand) -> Result<TransactionResult, SessionError> {
        let session = self.entries.get_mut(&command.workbook_id)
            .ok_or_else(|| error("unknown_workbook", "Unknown edit workbook. Open an edit session first."))?;
        let id = command.workbook_id.clone();
        let result = session.authority.apply(command)?;
        // An idempotent retry can return an older original result; it must
        // never rewind the revision that invalidates pending calculations.
        let latest = session.authority.snapshot(&id, None)?;
        session.revision.store(latest.revision, Ordering::Release);
        Ok(result)
    }

    pub fn snapshot(&self, workbook_id: &str, revision: Option<u64>) -> Result<Arc<WorkbookSnapshot>, SessionError> {
        self.entries.get(workbook_id)
            .ok_or_else(|| error("unknown_workbook", "Unknown edit workbook."))?
            .authority.snapshot(workbook_id, revision)
    }

    pub fn command_result(&self, workbook_id: &str, command_id: &str) -> Result<Option<TransactionResult>, SessionError> {
        self.entries.get(workbook_id)
            .ok_or_else(|| error("unknown_workbook", "Unknown edit workbook."))?
            .authority.command_result(workbook_id, command_id)
    }

    pub fn calculation(&self, workbook_id: &str, revision: u64) -> Result<CalculationInput, SessionError> {
        let session = self.entries.get(workbook_id)
            .ok_or_else(|| error("unknown_workbook", "Unknown edit workbook."))?;
        let snapshot = session.authority.snapshot(workbook_id, Some(revision))?;
        let names: HashMap<&str, &str> = snapshot.sheets.iter()
            .map(|sheet| (sheet.id.as_str(), sheet.name.as_str())).collect();
        let edits = snapshot.inputs.iter().map(|cell| {
            Ok(RecalcEdit {
                sheet: names.get(cell.sheet_id.as_str())
                    .ok_or_else(|| error("invalid_sheet", "Snapshot refers to an unknown sheet."))?.to_string(),
                row: cell.row,
                column: cell.column,
                input: cell.input.clone(),
            })
        }).collect::<Result<Vec<_>, SessionError>>()?;
        Ok(CalculationInput {
            path: session.source_path.clone(),
            edits,
            stamp: CalculationStamp::new(
                workbook_id.to_owned(), revision, snapshot.source_fingerprint.clone(),
                Arc::clone(&session.revision), Arc::clone(&session.alive), MAX_RECALC_EDITS,
            ),
        })
    }

    pub fn close(&mut self, workbook_id: &str) -> Option<PathBuf> {
        self.entries.remove(workbook_id).map(|session| {
            session.alive.store(false, Ordering::Release);
            session.source_path
        })
    }
}

impl Drop for EditSessions {
    fn drop(&mut self) {
        for session in self.entries.values() {
            session.alive.store(false, Ordering::Release);
        }
    }
}
