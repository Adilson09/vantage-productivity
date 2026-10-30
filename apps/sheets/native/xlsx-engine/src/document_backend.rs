//! Source-bound transport adapter for complete typed document checkpoints.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Deserialize;

use crate::document::{CheckpointCommand, CheckpointResult, DocumentAuthority, DocumentInfo, DocumentOpen, DocumentSnapshot};
use crate::document_store::{DocumentStore, MemoryDocumentStore};
use crate::document_calculation::{MAX_DOCUMENT_CALC_EDITS, calculation_edits, requires_materialization};
use crate::edit_backend::{CalculationInput, CalculationStamp, source_fingerprint};
use crate::session::SessionError;
use crate::snapshot::SheetDescriptor;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenDocument {
    pub api_version: u32,
    pub document_id: String,
    pub source_path: PathBuf,
    pub sheets: Vec<SheetDescriptor>,
    pub store_path: Option<PathBuf>,
}

struct BoundDocument {
    authority: DocumentAuthority,
    source_path: PathBuf,
    store_path: Option<PathBuf>,
    revision: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct DocumentSessions {
    entries: HashMap<String, BoundDocument>,
}

fn error(code: &'static str, message: impl Into<String>) -> SessionError {
    SessionError::new(code, message)
}

impl DocumentSessions {
    pub fn open(&mut self, request: OpenDocument) -> Result<DocumentInfo, SessionError> {
        let source_path = crate::canonicalize(&request.source_path)
            .map_err(|e| error("io_error", format!("Cannot resolve document source: {e}")))?;
        if let Some(path) = &request.store_path {
            if !path.is_absolute() || path == &source_path || path == &request.source_path
                || crate::canonicalize(path).is_ok_and(|existing| existing == source_path)
            {
                return Err(error("invalid_request", "Document recovery store must be an absolute path separate from the source."));
            }
        }
        let open = DocumentOpen {
            api_version: request.api_version,
            document_id: request.document_id.clone(),
            source_fingerprint: source_fingerprint(&source_path)?,
            sheets: request.sheets,
        };
        if let Some(document) = self.entries.get_mut(&request.document_id) {
            if document.store_path != request.store_path {
                return Err(error("store_conflict", "An open document cannot switch recovery stores."));
            }
            let info = document.authority.open(open)?;
            document.source_path = source_path;
            return Ok(info);
        }
        let store: Box<dyn DocumentStore> = match request.store_path.as_deref() {
            None => Box::new(MemoryDocumentStore::default()),
            Some(path) => {
                #[cfg(not(target_arch = "wasm32"))]
                { Box::new(crate::document_store::SqliteDocumentStore::open(path)
                    .map_err(|e| error("storage_error", e.to_string()))?) }
                #[cfg(target_arch = "wasm32")]
                { let _ = path; return Err(error("unsupported_storage", "Durable document storage is unavailable on this target.")); }
            }
        };
        let mut authority = DocumentAuthority::new(store);
        let info = authority.open(open)?;
        self.entries.insert(request.document_id, BoundDocument {
            authority, source_path, store_path: request.store_path,
            revision: Arc::new(AtomicU64::new(info.revision)),
            alive: Arc::new(AtomicBool::new(true)),
        });
        Ok(info)
    }

    pub fn apply(&mut self, command: CheckpointCommand) -> Result<CheckpointResult, SessionError> {
        let document = self.entries.get_mut(&command.document_id)
            .ok_or_else(|| error("unknown_document", "Open the document authority before committing."))?;
        let id = command.document_id.clone();
        let result = document.authority.apply(command)?;
        // A retried command can return its original, older receipt. Fence with
        // the current durable head rather than rewinding to that old revision.
        let latest = document.authority.snapshot(&id, None)?;
        document.revision.store(latest.revision, Ordering::Release);
        Ok(result)
    }

    pub fn snapshot(&self, id: &str, revision: Option<u64>) -> Result<Arc<DocumentSnapshot>, SessionError> {
        self.entries.get(id).ok_or_else(|| error("unknown_document", "Unknown document authority."))?
            .authority.snapshot(id, revision)
    }

    pub fn command_result(&self, id: &str, command: &str) -> Result<Option<CheckpointResult>, SessionError> {
        self.entries.get(id).ok_or_else(|| error("unknown_document", "Unknown document authority."))?
            .authority.command_result(id, command)
    }

    pub fn calculation(&self, document_id: &str, revision: u64, materialized_path: Option<PathBuf>) -> Result<CalculationInput, SessionError> {
        let document = self.entries.get(document_id).ok_or_else(|| error("unknown_document", "Unknown document authority."))?;
        let current = document.revision.load(Ordering::Acquire);
        if current != revision {
            return Err(SessionError { code: "stale_revision", message: "The requested document calculation revision is no longer current.".into(), current_revision: Some(current) });
        }
        let snapshot = document.authority.snapshot(document_id, Some(revision))?;
        let (path, edits, fingerprint) = match materialized_path {
            Some(path) => {
                let path = crate::canonicalize(&path).map_err(|e| error("io_error", format!("Cannot resolve materialized document: {e}")))?;
                let fingerprint = source_fingerprint(&path)?;
                // The host has exported this exact checkpoint through the
                // preserving writer. Applying its cumulative overlay twice
                // would duplicate structure or overwrite already-moved cells.
                (path, Vec::new(), fingerprint)
            }
            None => {
                if requires_materialization(&snapshot) {
                    return Err(error("document_requires_materialization", "Export this checkpoint through the preserving writer before calculating its structure, styles or document metadata."));
                }
                (document.source_path.clone(), calculation_edits(&snapshot, MAX_DOCUMENT_CALC_EDITS)?, snapshot.source_fingerprint.clone())
            }
        };
        Ok(CalculationInput {
            path, edits,
            stamp: CalculationStamp::new(document_id.to_owned(), revision, fingerprint,
                Arc::clone(&document.revision), Arc::clone(&document.alive), MAX_DOCUMENT_CALC_EDITS),
        })
    }

    pub fn close(&mut self, id: &str) -> bool {
        self.entries.remove(id).is_some_and(|document| { document.alive.store(false, Ordering::Release); true })
    }
}

impl Drop for DocumentSessions {
    fn drop(&mut self) {
        for document in self.entries.values() { document.alive.store(false, Ordering::Release); }
    }
}
