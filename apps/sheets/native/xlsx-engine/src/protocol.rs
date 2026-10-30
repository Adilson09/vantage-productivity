//! The sidecar's request protocol: one JSON request per line in, one JSON
//! response per line out. `main.rs` serves it over stdin/stdout; [`Engine`]
//! serves it one call at a time, for hosts without stdin or threads.

use std::collections::VecDeque;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::archive::{
    EntryContent, archive_manifest, read_entries_to_dir, save_archive, scan_entries_for_text,
};
use crate::find::FindCellsRequest;
use crate::edit_backend::{CalculationStamp, OpenEditSession, source_fingerprint};
use crate::document::{CheckpointCommand, DOCUMENT_API_VERSION};
use crate::document_backend::OpenDocument;
use crate::session::SessionError;
use crate::transaction::TransactionCommand;
use crate::recalc::{RecalcCache, RecalcEdit, RecalcRead, recalc_cells_with_limit};
use crate::{CellRange, SidecarError, THREADS, WorkbookSessions};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;

fn default_locale() -> String {
    "zh".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Command {
    Open {
        path: PathBuf,
        #[serde(default = "default_locale")]
        locale: String,
        #[serde(default, rename = "shortDateFormat")]
        short_date_format: Option<String>,
    },
    ReadRange {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
        range: CellRange,
    },
    Close {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    ReadMedia {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "visualId")]
        visual_id: String,
    },
    ReadFormulaCells {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
    },
    FindCells(FindCellsRequest),
    ReadRowOutline {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
    },
    Cancel {
        #[serde(rename = "targetRequestId")]
        target_request_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ArchiveManifest {
        path: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    ReadEntries {
        path: PathBuf,
        entries: Vec<String>,
        output_dir: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    ScanEntries {
        path: PathBuf,
        entries: Vec<String>,
        needle: String,
    },
    #[serde(rename_all = "camelCase")]
    ConvertWorkbook {
        path: PathBuf,
        target_path: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    SaveArchive {
        source_path: PathBuf,
        target_path: PathBuf,
        replacements: Vec<EntryContent>,
        removals: Vec<String>,
        additions: Vec<EntryContent>,
    },
    #[serde(rename_all = "camelCase")]
    RecalcCells {
        path: PathBuf,
        edits: Vec<RecalcEdit>,
        reads: Vec<RecalcRead>,
    },
    OpenEditSession(OpenEditSession),
    ApplyTransaction(TransactionCommand),
    Snapshot(SnapshotRequest),
    CommandResult(CommandResultRequest),
    RecalcSnapshot(RecalcSnapshotRequest),
    CloseEditSession(CloseEditSessionRequest),
    OpenDocument(OpenDocument),
    CheckpointDocument(CheckpointCommand),
    DocumentSnapshot(DocumentSnapshotRequest),
    DocumentCommandResult(DocumentCommandResultRequest),
    CloseDocument(CloseDocumentRequest),
    Capabilities,
    AuditPreservation(AuditPreservationRequest),
    RecalcDocument(RecalcDocumentRequest),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditPreservationRequest {
    source_path: PathBuf,
    target_path: PathBuf,
    allowed_changed_entries: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecalcDocumentRequest {
    api_version: u32,
    document_id: String,
    revision: u64,
    reads: Vec<RecalcRead>,
    materialized_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSnapshotRequest {
    api_version: u32,
    document_id: String,
    revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentCommandResultRequest {
    api_version: u32,
    document_id: String,
    command_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseDocumentRequest {
    api_version: u32,
    document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRequest {
    api_version: u32,
    workbook_id: String,
    revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResultRequest {
    api_version: u32,
    workbook_id: String,
    command_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecalcSnapshotRequest {
    api_version: u32,
    workbook_id: String,
    revision: u64,
    reads: Vec<RecalcRead>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseEditSessionRequest {
    api_version: u32,
    workbook_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub version: u8,
    pub request_id: String,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    version: u8,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Serialize)]
pub struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(rename = "currentRevision", skip_serializing_if = "Option::is_none")]
    current_revision: Option<u64>,
}

pub type SharedOutput = Arc<Mutex<BufWriter<io::Stdout>>>;

pub fn write_response(output: &SharedOutput, response: &Response) -> Result<(), ()> {
    let mut output = output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if serde_json::to_writer(&mut *output, response).is_err()
        || output.write_all(b"\n").is_err()
        || output.flush().is_err()
    {
        return Err(());
    }
    Ok(())
}

/// Owns the formula-engine state so recalc_cells can run off the request
/// loop: a cold IronCalc import of a formula-heavy workbook takes minutes,
/// and running it inline starved every interactive read_range behind it
/// (each timing out client-side while the sheet rendered blank).
pub struct RecalcWorker {
    cache: Arc<Mutex<RecalcCache>>,
    /// Purges arrive from the request loop while a recalc may hold the cache
    /// lock for minutes; they queue here and apply at the next recalc. Safe
    /// to defer: recalc_cells re-imports on mtime+size mismatch anyway.
    pending_purges: Arc<Mutex<Vec<PathBuf>>>,
    busy: Arc<AtomicBool>,
}

/// Clears the busy flag even when recalc_cells panics mid-import.
struct BusyReset(Arc<AtomicBool>);

impl Drop for BusyReset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Default for RecalcWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl RecalcWorker {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(RecalcCache::new())),
            pending_purges: Arc::new(Mutex::new(Vec::new())),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    fn queue_purge(&self, path: &PathBuf) {
        self.pending_purges
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(path.clone());
    }

    /// Close must reclaim the resident model right away when it can: a queued
    /// purge only applies at the next recalc, and a closed workbook may never
    /// be recalced again. Falls back to the queue while a recalc holds the
    /// cache lock.
    fn purge_now_or_queue(&self, path: &PathBuf) {
        match self.cache.try_lock() {
            Ok(mut cache) => cache.purge(path),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner().purge(path),
            Err(std::sync::TryLockError::WouldBlock) => self.queue_purge(path),
        }
    }

    fn drain_purges(&self, cache: &mut RecalcCache) {
        let purges: Vec<PathBuf> = self
            .pending_purges
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
            .collect();
        for purge in &purges {
            cache.purge(purge);
        }
    }

    /// The synchronous recalc body (also the unit-test entry point).
    #[cfg(test)]
    fn run(
        &self,
        request_id: String,
        path: &PathBuf,
        edits: &[RecalcEdit],
        reads: &[RecalcRead],
    ) -> Response {
        self.run_stamped(request_id, path, edits, reads, None)
    }

    fn run_stamped(
        &self,
        request_id: String,
        path: &PathBuf,
        edits: &[RecalcEdit],
        reads: &[RecalcRead],
        stamp: Option<&CalculationStamp>,
    ) -> Response {
        if let Some(stamp) = stamp {
            if !stamp.is_current() {
                return Response::failure(request_id, "stale_revision", "Calculation snapshot is no longer current.".into());
            }
            match source_fingerprint(path) {
                Ok(fingerprint) if fingerprint == stamp.source_fingerprint => {},
                Ok(_) => return Response::failure(request_id, "source_changed", "The workbook source changed after its edit session opened.".into()),
                Err(error) => return Response::from_session_error(request_id, error),
            }
        }
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.drain_purges(&mut cache);
        let response = match recalc_cells_with_limit(&mut cache, path, edits, reads,
            stamp.map_or(10_000, |stamp| stamp.max_edits)).and_then(to_json_value) {
            Ok(mut value) => {
                if let Some(stamp) = stamp {
                    // Native API callers may supply a source outside the
                    // host's immutable snapshot store. Detect changes during
                    // import/evaluation too; never publish such values as the
                    // acknowledged input revision or retain that model.
                    match source_fingerprint(path) {
                        Ok(fingerprint) if fingerprint == stamp.source_fingerprint => {},
                        other => {
                            cache.purge(path);
                            self.drain_purges(&mut cache);
                            return match other {
                                Err(error) => Response::from_session_error(request_id, error),
                                Ok(_) => Response::failure(request_id, "source_changed", "The workbook source changed during calculation.".into()),
                            };
                        }
                    }
                    if !stamp.is_current() {
                        self.drain_purges(&mut cache);
                        return Response::failure(request_id, "stale_revision", "Workbook changed while this calculation was running.".into());
                    }
                    value["workbookId"] = serde_json::json!(stamp.workbook_id);
                    value["revision"] = serde_json::json!(stamp.revision);
                }
                Response::success(request_id, value)
            },
            Err(error) => Response::from_error(request_id, error),
        };
        // A Close racing this recalc queued its purge after the drain above;
        // apply it before releasing the lock so the just-inserted model does
        // not outlive its session.
        self.drain_purges(&mut cache);
        response
    }

    /// Runs the recalc on a worker thread, writing the response when done.
    /// Returns an immediate failure response when one is already in flight —
    /// callers fail soft to cached values and retry later. Without threads
    /// the recalc answers inline, before the next request is read.
    fn dispatch(
        &self,
        request_id: String,
        path: PathBuf,
        edits: Vec<RecalcEdit>,
        reads: Vec<RecalcRead>,
        output: &SharedOutput,
    ) -> Option<Response> {
        self.dispatch_stamped(request_id, path, edits, reads, None, output)
    }

    fn dispatch_stamped(
        &self,
        request_id: String,
        path: PathBuf,
        edits: Vec<RecalcEdit>,
        reads: Vec<RecalcRead>,
        stamp: Option<CalculationStamp>,
        output: &SharedOutput,
    ) -> Option<Response> {
        if !THREADS {
            return Some(self.run_stamped(request_id, &path, &edits, &reads, stamp.as_ref()));
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Some(Response::failure(
                request_id,
                "recalc_busy",
                "Formula engine is busy with another recalculation.".into(),
            ));
        }
        let worker = Self {
            cache: Arc::clone(&self.cache),
            pending_purges: Arc::clone(&self.pending_purges),
            busy: Arc::clone(&self.busy),
        };
        let output = Arc::clone(output);
        let reply_id = request_id.clone();
        let spawned = thread::Builder::new()
            .name("xlsx-recalc".into())
            .spawn(move || {
                let reset = BusyReset(Arc::clone(&worker.busy));
                let response = worker.run_stamped(request_id, &path, &edits, &reads, stamp.as_ref());
                // Clear busy before replying: a sequential caller issues its
                // next recalc the moment the response lands, and hitting the
                // still-set flag bounced it with recalc_busy.
                drop(reset);
                let _ = write_response(&output, &response);
            });
        match spawned {
            Ok(_) => None,
            Err(error) => {
                self.busy.store(false, Ordering::Release);
                Some(Response::failure(
                    reply_id,
                    "io_error",
                    format!("Unable to start the recalc worker: {error}"),
                ))
            }
        }
    }
}

/// Request ids cancelled out of band by the reader thread, awaiting their
/// turn in the request queue. A cancel that lands after its target already
/// replied would pin the id here forever (ids are never reused), so the list
/// is capped — forgetting an id merely lets that request run as before.
#[derive(Clone)]
pub struct CancelledRequests(Arc<Mutex<VecDeque<String>>>);

const MAX_CANCELLED_REQUESTS: usize = 256;

impl Default for CancelledRequests {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelledRequests {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(VecDeque::new())))
    }

    pub fn insert(&self, request_id: String) {
        let mut ids = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if ids.len() >= MAX_CANCELLED_REQUESTS {
            ids.pop_front();
        }
        ids.push_back(request_id);
    }

    fn take(&self, request_id: &str) -> bool {
        let mut ids = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match ids.iter().position(|id| id == request_id) {
            Some(index) => {
                ids.remove(index);
                true
            }
            None => false,
        }
    }
}

/// The request the loop is currently executing, plus the flag a cancel sets
/// to reach it. `CancelledRequests` only covers requests still waiting their
/// turn: once the loop dequeues one, its queue entry is never consulted
/// again, so an in-flight open would run to completion — creating a cache
/// directory and registering a session for a host that already discarded the
/// snapshot it was going to open.
#[derive(Clone)]
pub struct InFlightRequest(Arc<InFlightState>);

struct InFlightState {
    id: Mutex<String>,
    cancelled: Arc<AtomicBool>,
}

impl Default for InFlightRequest {
    fn default() -> Self {
        Self::new()
    }
}

impl InFlightRequest {
    pub fn new() -> Self {
        Self(Arc::new(InFlightState {
            id: Mutex::new(String::new()),
            cancelled: Arc::new(AtomicBool::new(false)),
        }))
    }

    /// Registers the request about to run and clears the flag the previous
    /// request may have left set. Called before the queue check, so the two
    /// cover opposite sides of the dequeue: a cancel naming a still-queued
    /// request is caught by the queue, one naming the request now running is
    /// caught by the flag.
    pub fn begin(&self, request_id: &str) {
        *self
            .0
            .id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = request_id.to_owned();
        self.0.cancelled.store(false, Ordering::Release);
    }

    /// The reader thread's half of a cancel that names the running request. A
    /// target that is not the one running is left entirely to
    /// `CancelledRequests`, whose cap and forget-on-overflow semantics are
    /// unchanged.
    pub fn cancel(&self, target_request_id: &str) {
        let id = self
            .0
            .id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *id == target_request_id {
            self.0.cancelled.store(true, Ordering::Release);
        }
    }

    /// The live flag an in-flight request polls.
    fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.0.cancelled)
    }
}

/// The sidecar as a single value: each call handles one request line and
/// returns its response line. For hosts that cannot hand the binary a stdin,
/// such as a WebAssembly build driven from JavaScript. A cancel only reaches
/// requests not yet handled, since requests are handled one at a time.
pub struct Engine {
    sessions: WorkbookSessions,
    recalc: RecalcWorker,
    cancelled: CancelledRequests,
    in_flight: InFlightRequest,
    output: SharedOutput,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            sessions: WorkbookSessions::new(),
            recalc: RecalcWorker::new(),
            cancelled: CancelledRequests::new(),
            in_flight: InFlightRequest::new(),
            output: Arc::new(Mutex::new(BufWriter::new(io::stdout()))),
        }
    }

    /// `None` only when threads are available and a recalc will write its
    /// response to stdout later.
    pub fn handle_line(&mut self, line: &str) -> Option<String> {
        let response = match serde_json::from_str::<Request>(line) {
            Ok(request) => {
                self.in_flight.begin(&request.request_id);
                handle_request(
                    request,
                    &mut self.sessions,
                    &self.recalc,
                    &self.cancelled,
                    &self.in_flight,
                    &self.output,
                )?
            }
            Err(error) => Response::failure(
                String::new(),
                "invalid_json",
                format!("Invalid sidecar request: {error}"),
            ),
        };
        Some(serde_json::to_string(&response).unwrap_or_default())
    }

    /// Blocking host call: calculation completes on the calling thread and
    /// every response is returned to the caller rather than written to stdout.
    #[cfg(feature = "native-ffi")]
    pub fn handle_line_blocking(&mut self, line: &str) -> String {
        let request = match serde_json::from_str::<Request>(line) {
            Ok(request) => request,
            Err(error) => return serde_json::to_string(&Response::failure(String::new(),
                "invalid_json", format!("Invalid sidecar request: {error}"))).unwrap_or_default(),
        };
        let request_id = request.request_id;
        self.in_flight.begin(&request_id);
        let response = if request.version != PROTOCOL_VERSION {
            Response::failure(request_id, "unsupported_version", "Unsupported sidecar protocol version.".into())
        } else if self.cancelled.take(&request_id) {
            Response::failure(request_id, "cancelled", "Request was cancelled by the client.".into())
        } else {
            match request.command {
                Command::RecalcCells { path, edits, reads } =>
                    self.recalc.run_stamped(request_id, &path, &edits, &reads, None),
                Command::RecalcSnapshot(RecalcSnapshotRequest { api_version, workbook_id, revision, reads }) => {
                    match require_edit_version(api_version).and_then(|()| self.sessions.edits.calculation(&workbook_id, revision)) {
                        Ok(input) => self.recalc.run_stamped(request_id, &input.path, &input.edits, &reads, Some(&input.stamp)),
                        Err(error) => Response::from_session_error(request_id, error),
                    }
                }
                Command::RecalcDocument(RecalcDocumentRequest { api_version, document_id, revision, reads, materialized_path }) => {
                    match require_edit_version(api_version).and_then(|()| self.sessions.documents.calculation(&document_id, revision, materialized_path)) {
                        Ok(input) => self.recalc.run_stamped(request_id, &input.path, &input.edits, &reads, Some(&input.stamp)),
                        Err(error) => Response::from_session_error(request_id, error),
                    }
                }
                command => handle_request(Request { version: request.version, request_id, command },
                    &mut self.sessions, &self.recalc, &self.cancelled, &self.in_flight, &self.output)
                    .expect("Non-calculation requests always return an immediate response"),
            }
        };
        serde_json::to_string(&response).unwrap_or_default()
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
fn handle_line(
    line: &str,
    sessions: &mut WorkbookSessions,
    recalc: &RecalcWorker,
    cancelled: &CancelledRequests,
    in_flight: &InFlightRequest,
    output: &SharedOutput,
) -> Option<Response> {
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            return Some(Response::failure(
                String::new(),
                "invalid_json",
                format!("Invalid sidecar request: {error}"),
            ));
        }
    };
    handle_request(request, sessions, recalc, cancelled, in_flight, output)
}

pub fn handle_request(
    request: Request,
    sessions: &mut WorkbookSessions,
    recalc: &RecalcWorker,
    cancelled: &CancelledRequests,
    in_flight: &InFlightRequest,
    output: &SharedOutput,
) -> Option<Response> {
    if cancelled.take(&request.request_id) {
        return Some(Response::failure(
            request.request_id,
            "cancelled",
            "Request was cancelled by the client.".into(),
        ));
    }
    if request.version != PROTOCOL_VERSION {
        return Some(Response::failure(
            request.request_id,
            "unsupported_version",
            "Unsupported sidecar protocol version.".into(),
        ));
    }

    let request_id = request.request_id;
    let result = match request.command {
        Command::Capabilities => {
            return Some(edit_response(request_id, Ok(serde_json::json!({
                "transportVersion": PROTOCOL_VERSION,
                "editApiVersion": 1,
                "documentApiVersion": DOCUMENT_API_VERSION,
                "typedDocumentCheckpoints": true,
                "revisionPinnedDocumentCalculation": true,
                "packagePreservationAudit": true,
                "durableDocuments": cfg!(not(target_arch = "wasm32")),
                "pythonExecution": false,
                "vbaExecution": false,
                "comAutomation": false,
                "savePlanner": "preserving-host-adapter",
                "coordinates": "zero-based-half-open-sdk"
            }))));
        }
        Command::OpenDocument(request) => {
            return Some(edit_response(request_id, sessions.documents.open(request)));
        }
        Command::AuditPreservation(AuditPreservationRequest { source_path, target_path, allowed_changed_entries }) => {
            crate::preservation::audit_preservation(&source_path, &target_path, &allowed_changed_entries)
                .and_then(to_json_value)
        }
        Command::RecalcDocument(RecalcDocumentRequest { api_version, document_id, revision, reads, materialized_path }) => {
            let prepared = require_edit_version(api_version)
                .and_then(|()| sessions.documents.calculation(&document_id, revision, materialized_path));
            return match prepared {
                Ok(input) => recalc.dispatch_stamped(request_id, input.path, input.edits, reads, Some(input.stamp), output),
                Err(error) => Some(Response::from_session_error(request_id, error)),
            };
        }
        Command::CheckpointDocument(command) => {
            return Some(edit_response(request_id, sessions.documents.apply(command)));
        }
        Command::DocumentSnapshot(DocumentSnapshotRequest { api_version, document_id, revision }) => {
            return Some(edit_response(request_id, require_edit_version(api_version).and_then(|()| {
                sessions.documents.snapshot(&document_id, revision)
                    .and_then(|snapshot| serde_json::to_value(&*snapshot).map_err(edit_json_error))
            })));
        }
        Command::DocumentCommandResult(DocumentCommandResultRequest { api_version, document_id, command_id }) => {
            return Some(edit_response(request_id, require_edit_version(api_version)
                .and_then(|()| sessions.documents.command_result(&document_id, &command_id))));
        }
        Command::CloseDocument(CloseDocumentRequest { api_version, document_id }) => {
            return Some(edit_response(request_id, require_edit_version(api_version)
                .map(|()| serde_json::json!({"closed": sessions.documents.close(&document_id)}))));
        }
        Command::OpenEditSession(request) => {
            return Some(edit_response(request_id, sessions.edits.open(request)));
        }
        Command::ApplyTransaction(command) => {
            return Some(edit_response(request_id, sessions.edits.apply(command)));
        }
        Command::Snapshot(SnapshotRequest { api_version, workbook_id, revision }) => {
            let result = require_edit_version(api_version).and_then(|()| {
                sessions.edits.snapshot(&workbook_id, revision)
                    .and_then(|snapshot| serde_json::to_value(&*snapshot).map_err(edit_json_error))
            });
            return Some(edit_response(request_id, result));
        }
        Command::CommandResult(CommandResultRequest { api_version, workbook_id, command_id }) => {
            return Some(edit_response(request_id, require_edit_version(api_version)
                .and_then(|()| sessions.edits.command_result(&workbook_id, &command_id))));
        }
        Command::CloseEditSession(CloseEditSessionRequest { api_version, workbook_id }) => {
            let result = require_edit_version(api_version).map(|()| {
                let path = sessions.edits.close(&workbook_id);
                if let Some(path) = &path { recalc.purge_now_or_queue(path); }
                serde_json::json!({"closed": path.is_some()})
            });
            return Some(edit_response(request_id, result));
        }
        Command::RecalcSnapshot(RecalcSnapshotRequest { api_version, workbook_id, revision, reads }) => {
            let prepared = require_edit_version(api_version)
                .and_then(|()| sessions.edits.calculation(&workbook_id, revision));
            return match prepared {
                Ok(input) => recalc.dispatch_stamped(request_id, input.path, input.edits, reads, Some(input.stamp), output),
                Err(error) => Some(Response::from_session_error(request_id, error)),
            };
        }
        Command::Open {
            path,
            locale,
            short_date_format,
        } => {
            // The flag the open polls: a cancel that landed after this
            // request was dequeued reaches it here, where the queue no
            // longer can.
            let in_flight_cancelled = in_flight.flag();
            sessions
                .open_with_locale(&path, &locale, short_date_format.as_deref(), &in_flight_cancelled)
                .and_then(to_json_value)
        }
        Command::ReadRange {
            session_id,
            sheet_id,
            range,
        } => sessions
            .read_range(&session_id, &sheet_id, &range)
            .and_then(to_json_value),
        Command::Close { session_id } => {
            // A resident recalc model can dwarf the session itself (an
            // 8.8M-cell workbook's model holds ~1.2GB) — it must not outlive
            // the tab that needed it.
            if let Some(path) = sessions.session_path(&session_id) {
                recalc.purge_now_or_queue(&path);
            }
            sessions
                .close(&session_id)
                .and_then(|()| to_json_value(serde_json::json!({ "closed": true })))
        }
        Command::ReadMedia {
            session_id,
            visual_id,
        } => sessions
            .read_media(&session_id, &visual_id)
            .and_then(to_json_value),
        Command::ReadFormulaCells {
            session_id,
            sheet_id,
        } => sessions
            .read_formula_cells(&session_id, &sheet_id)
            .and_then(to_json_value),
        Command::FindCells(request) => sessions
            .find_cells(&request, &in_flight.flag())
            .and_then(to_json_value),
        Command::ReadRowOutline {
            session_id,
            sheet_id,
        } => sessions
            .read_row_outline(&session_id, &sheet_id)
            .and_then(to_json_value),
        // Normally intercepted out of band by the reader thread; through this
        // path (tests) it still marks the target for the skip check above.
        Command::Cancel { target_request_id } => {
            cancelled.insert(target_request_id);
            to_json_value(serde_json::json!({ "cancelled": true }))
        }
        Command::ConvertWorkbook { path, target_path } => {
            crate::convert::convert_to_xlsx(&path, &target_path).and_then(|result| {
                to_json_value(serde_json::json!({
                    "sheets": result.sheets,
                    "cells": result.cells,
                }))
            })
        }
        Command::ArchiveManifest { path } => archive_manifest(&path)
            .and_then(|entries| to_json_value(serde_json::json!({ "entries": entries }))),
        Command::ReadEntries {
            path,
            entries,
            output_dir,
        } => read_entries_to_dir(&path, &entries, &output_dir)
            .and_then(|extracted| to_json_value(serde_json::json!({ "entries": extracted }))),
        Command::ScanEntries {
            path,
            entries,
            needle,
        } => scan_entries_for_text(&path, &entries, &needle)
            .and_then(|matches| to_json_value(serde_json::json!({ "matches": matches }))),
        Command::SaveArchive {
            source_path,
            target_path,
            replacements,
            removals,
            additions,
        } => {
            // The saved bytes supersede any resident formula model for the
            // target. The source is only read, so its warm model stays valid;
            // purging it would make every 30s crash-recovery copy of the open
            // workbook force a cold re-import on the next recalc. If the file
            // behind the source path changes later (e.g. the target is renamed
            // over it), the mtime+size guard in recalc_cells rebuilds anyway.
            recalc.queue_purge(&target_path);
            save_archive(
                &source_path,
                &target_path,
                &replacements,
                &removals,
                &additions,
            )
            .and_then(to_json_value)
        }
        Command::RecalcCells { path, edits, reads } => {
            return recalc.dispatch(request_id, path, edits, reads, output);
        }
    };
    Some(match result {
        Ok(value) => Response::success(request_id, value),
        Err(error) => Response::from_error(request_id, error),
    })
}

fn to_json_value<T: Serialize>(value: T) -> Result<Value, SidecarError> {
    serde_json::to_value(value).map_err(SidecarError::from)
}

fn require_edit_version(version: u32) -> Result<(), SessionError> {
    if version == 1 { return Ok(()); }
    Err(SessionError { code: "unsupported_api_version", message: "Unsupported spreadsheet edit API version.".into(), current_revision: None })
}

fn edit_json_error(error: serde_json::Error) -> SessionError {
    SessionError { code: "serialization_error", message: error.to_string(), current_revision: None }
}

fn edit_response<T: Serialize>(request_id: String, result: Result<T, SessionError>) -> Response {
    match result {
        Ok(value) => match serde_json::to_value(value) {
            Ok(value) => Response::success(request_id, value),
            Err(error) => Response::from_session_error(request_id, edit_json_error(error)),
        },
        Err(error) => Response::from_session_error(request_id, error),
    }
}

impl Response {
    pub fn from_session_error(request_id: String, error: SessionError) -> Self {
        let mut response = Self::failure(request_id, error.code, error.to_string());
        response.error.as_mut().unwrap().current_revision = error.current_revision;
        response
    }
    pub fn success(request_id: String, result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn from_error(request_id: String, error: SidecarError) -> Self {
        let code = match error {
            SidecarError::InvalidRequest(_) => "invalid_request",
            SidecarError::Io(_) => "io_error",
            SidecarError::Workbook(_) => "workbook_error",
            SidecarError::Cancelled => "cancelled",
        };
        Self::failure(request_id, code, error.to_string())
    }

    pub fn failure(request_id: String, code: &'static str, message: String) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody { code, message, current_revision: None }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironcalc::base::Model;
    use ironcalc::export::save_to_xlsx;
    use std::path::Path;

    fn write_workbook(path: &Path) {
        let mut model = Model::new_empty("fixture", "en", "UTC", "en").unwrap();
        model.set_user_input(0, 1, 1, "10".to_string()).unwrap();
        model.set_user_input(0, 2, 1, "=A1*2".to_string()).unwrap();
        model.evaluate();
        save_to_xlsx(&model, path.to_str().unwrap()).unwrap();
    }

    fn expect_ok(response: Response) -> Value {
        assert!(
            response.ok,
            "{:?}",
            response.error.map(|error| error.message)
        );
        response.result.unwrap()
    }

    fn recalc_reads() -> Vec<RecalcRead> {
        serde_json::from_value(serde_json::json!([{
            "sheet": "Sheet1",
            "range": { "startRow": 0, "endRow": 1, "startColumn": 0, "endColumn": 0 },
        }]))
        .unwrap()
    }

    /// Crash-recovery copies save every 30s with the open workbook as the
    /// (unchanged) source; that must not evict its warm formula model even
    /// though save_archive queues a purge for the target path.
    #[test]
    fn save_archive_keeps_the_source_resident_model_warm() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("open.xlsx");
        let target = dir.path().join("recovery.xlsx");
        write_workbook(&source);
        let mut sessions = WorkbookSessions::new();
        let recalc = RecalcWorker::new();
        let in_flight = InFlightRequest::new();
        let output: SharedOutput = Arc::new(Mutex::new(BufWriter::new(io::stdout())));

        let first = expect_ok(recalc.run("r".into(), &source, &[], &recalc_reads()));
        assert_eq!(first["cached"], serde_json::json!(false));

        let save = serde_json::json!({
            "version": 1,
            "requestId": "s",
            "command": "save_archive",
            "sourcePath": source,
            "targetPath": target,
            "replacements": [],
            "removals": [],
            "additions": [],
        });
        expect_ok(
            handle_line(
                &save.to_string(),
                &mut sessions,
                &recalc,
                &CancelledRequests::new(),
                &in_flight,
                &output,
            )
            .unwrap(),
        );

        let second = expect_ok(recalc.run("r2".into(), &source, &[], &recalc_reads()));
        assert_eq!(second["cached"], serde_json::json!(true));
    }

    /// A cancel marks its target; the target is then skipped unexecuted, and
    /// the mark is consumed (a later request reusing the id would run).
    #[test]
    fn cancelled_requests_are_skipped_once() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("open.xlsx");
        write_workbook(&source);
        let mut sessions = WorkbookSessions::new();
        let recalc = RecalcWorker::new();
        let cancelled = CancelledRequests::new();
        let in_flight = InFlightRequest::new();
        let output: SharedOutput = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
        let cancel = serde_json::json!({
            "version": 1,
            "requestId": "c",
            "command": "cancel",
            "targetRequestId": "victim",
        });
        expect_ok(
            handle_line(
                &cancel.to_string(),
                &mut sessions,
                &recalc,
                &cancelled,
                &in_flight,
                &output,
            )
            .unwrap(),
        );

        let open = serde_json::json!({
            "version": 1,
            "requestId": "victim",
            "command": "open",
            "path": source,
        });
        let skipped = handle_line(
            &open.to_string(),
            &mut sessions,
            &recalc,
            &cancelled,
            &in_flight,
            &output,
        )
        .unwrap();
        assert!(!skipped.ok);
        assert_eq!(skipped.error.unwrap().code, "cancelled");

        expect_ok(
            handle_line(
                &open.to_string(),
                &mut sessions,
                &recalc,
                &cancelled,
                &in_flight,
                &output,
            )
            .unwrap(),
        );
    }

    /// The window `CancelledRequests` cannot cover: the loop has dequeued
    /// the request, so its queue entry would never be read again, and the
    /// cancel arrives with the queue deliberately untouched. The open must
    /// still be abandoned — the queue check in handle_request finds
    /// nothing, so only the in-flight flag can stop it.
    #[test]
    fn cancel_during_an_in_flight_open_abandons_it() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("open.xlsx");
        write_workbook(&source);
        let mut sessions = WorkbookSessions::new();
        let recalc = RecalcWorker::new();
        let cancelled = CancelledRequests::new();
        let in_flight = InFlightRequest::new();
        let output: SharedOutput = Arc::new(Mutex::new(BufWriter::new(io::stdout())));

        // main()'s order: register the dequeued request, then dispatch. The
        // reader's cancel lands in between.
        in_flight.begin("victim");
        in_flight.cancel("victim");
        // The queue never saw the id, so this open was stopped by the
        // in-flight flag alone rather than by the pre-dispatch skip.
        assert!(!cancelled.take("victim"));

        let open = serde_json::json!({
            "version": 1,
            "requestId": "victim",
            "command": "open",
            "path": source,
        });
        let response = handle_line(
            &open.to_string(),
            &mut sessions,
            &recalc,
            &cancelled,
            &in_flight,
            &output,
        )
        .unwrap();
        assert!(
            !response.ok,
            "the in-flight open ran after its cancel landed"
        );
        assert_eq!(response.error.unwrap().code, "cancelled");
        // Nothing to clean up: no metadata means no session id, so the host
        // can neither read-range nor close what the open would have left.
        assert!(response.result.is_none());

        // A cancel naming a request that is not running is left to the
        // queue, which still skips it once its turn comes.
        in_flight.begin("other");
        in_flight.cancel("other");
        in_flight.begin("later");
        in_flight.cancel("other");
        let queued = handle_line(
            &serde_json::json!({
                "version": 1,
                "requestId": "queued",
                "command": "open",
                "path": source,
            })
            .to_string(),
            &mut sessions,
            &recalc,
            &cancelled,
            &in_flight,
            &output,
        )
        .unwrap();
        assert!(
            queued.ok,
            "a cancel for an id that already replied must not skip it"
        );
    }

    /// A queued purge for a path evicts its resident model at the next run.
    #[test]
    fn queued_purge_applies_before_the_next_recalc() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("open.xlsx");
        write_workbook(&source);
        let recalc = RecalcWorker::new();

        expect_ok(recalc.run("r".into(), &source, &[], &recalc_reads()));
        recalc.queue_purge(&source);
        let second = expect_ok(recalc.run("r2".into(), &source, &[], &recalc_reads()));
        assert_eq!(second["cached"], serde_json::json!(false));
    }

    /// Close purges the resident model on the spot when no recalc holds the
    /// cache — a queued purge would wait for a recalc that may never come.
    #[test]
    fn close_purge_applies_immediately_when_cache_is_free() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("open.xlsx");
        write_workbook(&source);
        let recalc = RecalcWorker::new();

        expect_ok(recalc.run("r".into(), &source, &[], &recalc_reads()));
        recalc.purge_now_or_queue(&source);
        assert!(recalc.pending_purges.lock().unwrap().is_empty());
        let second = expect_ok(recalc.run("r2".into(), &source, &[], &recalc_reads()));
        assert_eq!(second["cached"], serde_json::json!(false));
    }

    /// While a recalc holds the cache lock, Close falls back to the queue
    /// instead of blocking the request loop.
    #[test]
    fn close_purge_queues_while_cache_is_locked() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("open.xlsx");
        write_workbook(&source);
        let recalc = RecalcWorker::new();

        let guard = recalc.cache.lock().unwrap();
        recalc.purge_now_or_queue(&source);
        drop(guard);
        assert_eq!(recalc.pending_purges.lock().unwrap().len(), 1);
    }

    /// While one recalculation is in flight, a second request short-circuits
    /// with recalc_busy instead of queueing behind the import.
    #[test]
    fn concurrent_recalc_reports_busy() {
        // Without threads two recalcs never overlap, so there is no busy state.
        if !THREADS {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("open.xlsx");
        write_workbook(&source);
        let recalc = RecalcWorker::new();
        let output: SharedOutput = Arc::new(Mutex::new(BufWriter::new(io::stdout())));

        recalc.busy.store(true, Ordering::Release);
        let response = recalc
            .dispatch("r".into(), source, Vec::new(), recalc_reads(), &output)
            .unwrap();
        assert!(!response.ok);
        assert_eq!(response.error.unwrap().code, "recalc_busy");
    }
}
