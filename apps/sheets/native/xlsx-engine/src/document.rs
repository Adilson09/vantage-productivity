//! Complete, typed document checkpoints independent of formula calculation.
//!
//! The payload is the document portion of WorkbookSaveRequest. It preserves
//! types and every supported save family verbatim. UI destinations, passwords,
//! transport handles and save modes are deliberately outside this authority.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};
use std::sync::Arc;

use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::document_store::{DocumentStore, MemoryDocumentStore};
use crate::session::{SessionError, StoreError};
use crate::snapshot::{MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, SheetDescriptor};

pub type DocumentError = SessionError;
pub const DOCUMENT_API_VERSION: u32 = 1;
pub const MAX_CHECKPOINT_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_CHECKPOINT_CELLS: usize = 10_000_000;
pub const MAX_CHECKPOINT_DEPTH: usize = 64;
pub const MAX_DOCUMENT_SNAPSHOTS: usize = 16;

const ARRAY_FAMILIES: &[(&str, usize, bool)] = &[
    ("edits", MAX_CHECKPOINT_CELLS, true),
    ("bulkConstantFills", 1_000, false),
    ("structuralOps", 1_000, true),
    ("chartEdits", 100, true),
    ("visualEdits", 100, true),
    ("visualAdditions", 50, true),
    ("cellImageAdditions", 50, false),
    ("tableAdditions", 50, true),
    ("tableEdits", 100, false),
    ("pivotAdditions", 20, true),
    ("sheetOps", 100, true),
    ("sheetOrder", 1_000, true),
    ("filterStates", 1_000, true),
    ("hyperlinkEdits", 1_000, true),
    ("cfStates", 1_000, true),
    ("dvStates", 1_000, true),
    ("pageSetupStates", 1_000, true),
    ("noteStates", 1_000, true),
    ("formulaValues", MAX_CHECKPOINT_CELLS, true),
    ("pivotCacheRefreshPaths", 100, true),
    ("pivotRefreshUpdates", 100, true),
    ("sheetProtections", 1_000, true),
    ("sparklineAdditions", 50, false),
    ("protectedRangeStates", 1_000, false),
];
const NULLABLE_FAMILIES: &[&str] = &[
    "definedNamesState", "themeState", "workbookProtectionState", "redactionStates",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentOpen {
    pub api_version: u32,
    pub document_id: String,
    pub source_fingerprint: String,
    pub sheets: Vec<SheetDescriptor>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub api_version: u32,
    pub document_id: String,
    pub revision: u64,
    pub source_fingerprint: String,
    pub recovered: bool,
    pub durable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointCommand {
    pub api_version: u32,
    pub document_id: String,
    pub command_id: String,
    pub expected_revision: u64,
    pub actor: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointResult {
    pub api_version: u32,
    pub document_id: String,
    pub command_id: String,
    pub revision: u64,
    pub durable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSnapshot {
    pub api_version: u32,
    pub document_id: String,
    pub revision: u64,
    pub source_fingerprint: String,
    /// Imported identities remain immutable; current layout rides sheetOps.
    pub sheets: Vec<SheetDescriptor>,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentReceipt {
    pub command_id: String,
    pub request_hash: String,
    pub result: CheckpointResult,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredDocument {
    pub api_version: u32,
    pub snapshot: DocumentSnapshot,
    pub commands: Vec<DocumentReceipt>,
}

struct LiveDocument {
    stored: StoredDocument,
    command_index: BTreeMap<String, usize>,
    snapshots: BTreeMap<u64, Arc<DocumentSnapshot>>,
    recovered: bool,
}

impl LiveDocument {
    fn new(stored: StoredDocument, recovered: bool) -> Self {
        let command_index = stored.commands.iter().enumerate()
            .map(|(index, receipt)| (receipt.command_id.clone(), index)).collect();
        let snapshot = Arc::new(stored.snapshot.clone());
        Self { stored, command_index, snapshots: BTreeMap::from([(snapshot.revision, snapshot)]), recovered }
    }

    fn info(&self, durable: bool) -> DocumentInfo {
        DocumentInfo {
            api_version: DOCUMENT_API_VERSION,
            document_id: self.stored.snapshot.document_id.clone(),
            revision: self.stored.snapshot.revision,
            source_fingerprint: self.stored.snapshot.source_fingerprint.clone(),
            recovered: self.recovered,
            durable,
        }
    }
}

pub struct DocumentAuthority {
    store: Box<dyn DocumentStore>,
    documents: BTreeMap<String, LiveDocument>,
}

impl Default for DocumentAuthority {
    fn default() -> Self { Self::new(Box::<MemoryDocumentStore>::default()) }
}

impl DocumentAuthority {
    pub fn new(store: Box<dyn DocumentStore>) -> Self {
        Self { store, documents: BTreeMap::new() }
    }

    pub fn is_durable(&self) -> bool { self.store.is_durable() }

    pub fn open(&mut self, request: DocumentOpen) -> Result<DocumentInfo, DocumentError> {
        validate_open(&request)?;
        if let Some(document) = self.documents.get(&request.document_id) {
            validate_binding(&document.stored.snapshot, &request)?;
            return Ok(document.info(self.store.is_durable()));
        }
        let document = match self.store.load(&request.document_id).map_err(store_error)? {
            Some(stored) => {
                validate_stored(&stored)?;
                validate_binding(&stored.snapshot, &request)?;
                LiveDocument::new(stored, true)
            }
            None => {
                let stored = StoredDocument {
                    api_version: DOCUMENT_API_VERSION,
                    snapshot: DocumentSnapshot {
                        api_version: DOCUMENT_API_VERSION,
                        document_id: request.document_id.clone(),
                        revision: 0,
                        source_fingerprint: request.source_fingerprint,
                        sheets: request.sheets,
                        payload: empty_payload(),
                    },
                    commands: Vec::new(),
                };
                self.store.create(&stored).map_err(store_error)?;
                LiveDocument::new(stored, false)
            }
        };
        let info = document.info(self.store.is_durable());
        self.documents.insert(request.document_id, document);
        Ok(info)
    }

    pub fn apply(&mut self, command: CheckpointCommand) -> Result<CheckpointResult, DocumentError> {
        version(command.api_version)?;
        identifier(&command.document_id, "Document ID", 512)?;
        identifier(&command.command_id, "Command ID", 512)?;
        identifier(&command.actor, "Actor", 1_024)?;
        let document = self.documents.get(&command.document_id).ok_or_else(not_open)?;
        validate_payload(&command.payload, &document.stored.snapshot.sheets)?;
        let hash = checkpoint_hash(&command)?;
        if let Some(index) = document.command_index.get(&command.command_id) {
            let receipt = &document.stored.commands[*index];
            return if receipt.request_hash == hash { Ok(receipt.result.clone()) } else {
                Err(invalid("idempotency_conflict", "This checkpoint command ID was already used with a different request."))
            };
        }
        let current = document.stored.snapshot.revision;
        if command.expected_revision != current {
            return Err(DocumentError {
                code: "revision_conflict",
                message: "The document revision changed. Read the current checkpoint before retrying.".into(),
                current_revision: Some(current),
            });
        }
        let revision = current.checked_add(1)
            .ok_or_else(|| invalid("revision_exhausted", "The document revision limit has been reached."))?;
        let snapshot = DocumentSnapshot {
            api_version: DOCUMENT_API_VERSION,
            document_id: command.document_id.clone(),
            revision,
            source_fingerprint: document.stored.snapshot.source_fingerprint.clone(),
            sheets: document.stored.snapshot.sheets.clone(),
            payload: command.payload,
        };
        let result = CheckpointResult {
            api_version: DOCUMENT_API_VERSION, document_id: command.document_id.clone(),
            command_id: command.command_id.clone(), revision, durable: self.store.is_durable(),
        };
        let receipt = DocumentReceipt { command_id: command.command_id, request_hash: hash, result: result.clone() };
        let published = Arc::new(snapshot.clone());
        self.store.append(current, &snapshot, &receipt).map_err(store_error)?;
        let document = self.documents.get_mut(&command.document_id).ok_or_else(not_open)?;
        document.command_index.insert(receipt.command_id.clone(), document.stored.commands.len());
        document.stored.commands.push(receipt);
        document.stored.snapshot = snapshot;
        document.snapshots.insert(revision, published);
        while document.snapshots.len() > MAX_DOCUMENT_SNAPSHOTS { document.snapshots.pop_first(); }
        Ok(result)
    }

    pub fn snapshot(&self, document_id: &str, revision: Option<u64>) -> Result<Arc<DocumentSnapshot>, DocumentError> {
        let document = self.documents.get(document_id).ok_or_else(not_open)?;
        document.snapshots.get(&revision.unwrap_or(document.stored.snapshot.revision)).cloned()
            .ok_or_else(|| invalid("snapshot_not_found", "This document revision is not retained by the open authority."))
    }

    pub fn command_result(&self, document_id: &str, command_id: &str) -> Result<Option<CheckpointResult>, DocumentError> {
        let document = self.documents.get(document_id).ok_or_else(not_open)?;
        Ok(document.command_index.get(command_id).map(|index| document.stored.commands[*index].result.clone()))
    }

    pub fn close(&mut self, document_id: &str) -> bool { self.documents.remove(document_id).is_some() }
}

pub fn empty_payload() -> Value {
    let mut object = Map::new();
    for (name, _, _) in ARRAY_FAMILIES { object.insert((*name).into(), Value::Array(Vec::new())); }
    for name in NULLABLE_FAMILIES { object.insert((*name).into(), Value::Null); }
    Value::Object(object)
}

fn invalid(code: &'static str, message: impl Into<String>) -> DocumentError { DocumentError::new(code, message) }
fn payload_error(message: impl Into<String>) -> DocumentError { invalid("invalid_checkpoint", message) }
fn not_open() -> DocumentError { invalid("document_not_open", "The document authority is not open.") }
fn version(value: u32) -> Result<(), DocumentError> {
    if value == DOCUMENT_API_VERSION { Ok(()) } else { Err(invalid("unsupported_api_version", "Unsupported document checkpoint API version.")) }
}
fn identifier(value: &str, label: &str, max: usize) -> Result<(), DocumentError> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        Err(payload_error(format!("{label} is empty, too long, or contains a null character.")))
    } else { Ok(()) }
}
fn store_error(error: StoreError) -> DocumentError {
    match error {
        StoreError::Conflict => invalid("persistence_conflict", "Another authority changed the persisted document. Reopen before editing."),
        StoreError::Storage(message) => invalid("storage_error", message),
    }
}
fn validate_open(request: &DocumentOpen) -> Result<(), DocumentError> {
    version(request.api_version)?;
    identifier(&request.document_id, "Document ID", 512)?;
    identifier(&request.source_fingerprint, "Source fingerprint", 4_096)?;
    if request.sheets.is_empty() || request.sheets.len() > 16_384 { return Err(payload_error("Invalid imported worksheet count.")); }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for sheet in &request.sheets {
        identifier(&sheet.id, "Worksheet ID", 512)?;
        identifier(&sheet.name, "Worksheet name", 1_024)?;
        if !ids.insert(&sheet.id) || !names.insert(sheet.name.to_lowercase()) { return Err(payload_error("Imported worksheet identities must be unique.")); }
    }
    Ok(())
}
fn validate_binding(snapshot: &DocumentSnapshot, request: &DocumentOpen) -> Result<(), DocumentError> {
    if snapshot.document_id != request.document_id || snapshot.source_fingerprint != request.source_fingerprint || snapshot.sheets != request.sheets {
        Err(invalid("source_conflict", "This document identity belongs to another source or imported worksheet layout."))
    } else { Ok(()) }
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, DocumentError> {
    value.as_object().ok_or_else(|| payload_error(format!("{label} must be an object.")))
}
fn fields(value: &Map<String, Value>, allowed: &[&str], label: &str) -> Result<(), DocumentError> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) { Err(payload_error(format!("{label} contains an unsupported field."))) } else { Ok(()) }
}
fn string<'a>(value: &'a Map<String, Value>, key: &str) -> Result<&'a str, DocumentError> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| payload_error(format!("{key} must be a string.")))
}
fn boolean(value: &Map<String, Value>, key: &str) -> Result<bool, DocumentError> {
    value.get(key).and_then(Value::as_bool).ok_or_else(|| payload_error(format!("{key} must be a boolean.")))
}
fn integer(value: &Map<String, Value>, key: &str, maximum: u64) -> Result<u64, DocumentError> {
    value.get(key).and_then(Value::as_u64).filter(|number| *number <= maximum)
        .ok_or_else(|| payload_error(format!("{key} must be a bounded nonnegative integer.")))
}
fn scalar(value: Option<&Value>) -> Result<(), DocumentError> {
    if value.is_some_and(|value| matches!(value, Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_))) { Ok(()) }
    else { Err(payload_error("Cell values must be typed strings, numbers, booleans or null.")) }
}
fn array<'a>(value: &'a Map<String, Value>, key: &str) -> Result<&'a [Value], DocumentError> {
    value.get(key).and_then(Value::as_array).map(Vec::as_slice).ok_or_else(|| payload_error(format!("{key} must be an array.")))
}
fn array_or_empty<'a>(value: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn known_sheet<'a>(value: &'a Map<String, Value>, sheets: &BTreeMap<String, String>) -> Result<&'a str, DocumentError> {
    let id = string(value, "sheetId")?;
    if !sheets.contains_key(id) { return Err(payload_error("Checkpoint refers to an unknown or removed worksheet.")); }
    Ok(id)
}
fn cell_coordinates(value: &Map<String, Value>) -> Result<(u64, u64), DocumentError> {
    Ok((integer(value, "row", u64::from(MAX_SHEET_ROWS - 1))?, integer(value, "column", u64::from(MAX_SHEET_COLUMNS - 1))?))
}
fn range(value: &Value) -> Result<(), DocumentError> {
    let area = object(value, "Cell range")?;
    fields(area, &["startRow", "endRow", "startColumn", "endColumn"], "Cell range")?;
    let start_row = integer(area, "startRow", u64::from(MAX_SHEET_ROWS - 1))?;
    let end_row = integer(area, "endRow", u64::from(MAX_SHEET_ROWS - 1))?;
    let start_column = integer(area, "startColumn", u64::from(MAX_SHEET_COLUMNS - 1))?;
    let end_column = integer(area, "endColumn", u64::from(MAX_SHEET_COLUMNS - 1))?;
    if start_row > end_row || start_column > end_column { return Err(payload_error("Cell range boundaries are reversed.")); }
    Ok(())
}
fn new_sheet_name(value: &str) -> Result<(), DocumentError> {
    if value.is_empty() || value.encode_utf16().count() > 31 || value.chars().any(|character| matches!(character, '\\' | '/' | '?' | '*' | '[' | ']' | ':' | '\0')) || value.starts_with('\'') || value.ends_with('\'') {
        Err(payload_error("Invalid worksheet name."))
    } else { Ok(()) }
}

fn current_sheets(payload: &Map<String, Value>, original: &[SheetDescriptor]) -> Result<BTreeMap<String, String>, DocumentError> {
    let mut sheets: BTreeMap<String, String> = original.iter().map(|sheet| (sheet.id.clone(), sheet.name.clone())).collect();
    let mut all_ids: BTreeSet<String> = sheets.keys().cloned().collect();
    let operations = array(payload, "sheetOps")?;
    for operation in operations {
        let op = object(operation, "Worksheet operation")?;
        match string(op, "kind")? {
            "reorder-sheets" => fields(op, &["kind"], "Worksheet operation")?,
            "add-sheet" | "duplicate-sheet" => {
                let duplicate = string(op, "kind")? == "duplicate-sheet";
                fields(op, if duplicate { &["kind", "sheetId", "name", "sourceSheetId"] } else { &["kind", "sheetId", "name"] }, "Worksheet operation")?;
                let id = string(op, "sheetId")?;
                identifier(id, "Worksheet ID", 512)?;
                if !all_ids.insert(id.into()) { return Err(payload_error("A worksheet identity cannot be added twice or reused.")); }
                if duplicate && !sheets.contains_key(string(op, "sourceSheetId")?) { return Err(payload_error("Unknown worksheet duplication source.")); }
                let name = string(op, "name")?;
                new_sheet_name(name)?;
                sheets.insert(id.into(), name.into());
            }
            "rename-sheet" => {
                fields(op, &["kind", "sheetId", "newName"], "Worksheet operation")?;
                known_sheet(op, &sheets)?;
                let name = string(op, "newName")?;
                new_sheet_name(name)?;
                sheets.insert(string(op, "sheetId")?.into(), name.into());
            }
            "remove-sheet" => {
                fields(op, &["kind", "sheetId"], "Worksheet operation")?;
                known_sheet(op, &sheets)?;
                sheets.remove(string(op, "sheetId")?);
            }
            "set-sheet-hidden" => {
                fields(op, &["kind", "sheetId", "hidden"], "Worksheet operation")?;
                known_sheet(op, &sheets)?;
                boolean(op, "hidden")?;
            }
            "set-sheet-tab-color" => {
                fields(op, &["kind", "sheetId", "color"], "Worksheet operation")?;
                known_sheet(op, &sheets)?;
                let color = op.get("color").ok_or_else(|| payload_error("Missing worksheet tab color."))?;
                if !color.is_null() && !color.as_str().is_some_and(hex_color) { return Err(payload_error("Invalid worksheet tab color.")); }
            }
            _ => return Err(payload_error("Unknown worksheet operation.")),
        }
    }
    if sheets.is_empty() { return Err(payload_error("A document must retain at least one worksheet.")); }
    let mut names = BTreeSet::new();
    if sheets.values().any(|name| !names.insert(name.to_lowercase())) { return Err(payload_error("Final worksheet names must be unique.")); }
    let order = array(payload, "sheetOrder")?;
    if !order.is_empty() || !operations.is_empty() {
        let ids: BTreeSet<&str> = order.iter().map(|id| id.as_str().ok_or_else(|| payload_error("Worksheet order must contain IDs."))).collect::<Result<_, _>>()?;
        if ids.len() != order.len() || ids.len() != sheets.len() || ids.iter().any(|id| !sheets.contains_key(*id)) { return Err(payload_error("Worksheet order must list each final worksheet exactly once.")); }
    }
    Ok(sheets)
}
fn hex_color(value: &str) -> bool { value.len() == 7 && value.starts_with('#') && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit) }

fn validate_cell(value: &Value, sheets: &BTreeMap<String, String>) -> Result<(), DocumentError> {
    let cell = object(value, "Cell edit")?;
    fields(cell, &["sheetId", "row", "column", "writeValue", "value", "formula", "style", "rich", "styleReset"], "Cell edit")?;
    known_sheet(cell, sheets)?;
    cell_coordinates(cell)?;
    let writes = boolean(cell, "writeValue")?;
    scalar(cell.get("value"))?;
    if let Some(formula) = cell.get("formula") {
        if !formula.as_str().is_some_and(|text| !text.is_empty() && text.encode_utf16().count() <= 8_192) { return Err(payload_error("Invalid cell formula.")); }
    }
    if let Some(style) = cell.get("style") { object(style, "Cell style")?; }
    if let Some(reset) = cell.get("styleReset") { if !reset.is_boolean() { return Err(payload_error("styleReset must be a boolean.")); } }
    if !writes && !cell.contains_key("style") && cell.get("styleReset") != Some(&Value::Bool(true)) { return Err(payload_error("A style-only cell needs a style delta or reset.")); }
    if let Some(rich) = cell.get("rich") {
        let runs = rich.as_array().filter(|runs| runs.len() <= 1_000).ok_or_else(|| payload_error("Invalid rich-text runs."))?;
        for run in runs {
            let run = object(run, "Rich-text run")?;
            string(run, "text")?;
        }
    }
    Ok(())
}

fn validate_structure(value: &Value, sheets: &BTreeMap<String, String>) -> Result<(), DocumentError> {
    let op = object(value, "Structural operation")?;
    known_sheet(op, sheets)?;
    let kind = string(op, "kind")?;
    match kind {
        "insert-rows" | "remove-rows" | "insert-cols" | "remove-cols" | "move-rows" => {
            fields(op, if kind == "move-rows" { &["sheetId", "kind", "index", "count", "before"] } else { &["sheetId", "kind", "index", "count"] }, "Structural operation")?;
            let bound = u64::from(if kind.ends_with("cols") { MAX_SHEET_COLUMNS } else { MAX_SHEET_ROWS });
            let index = integer(op, "index", bound - 1)?;
            let count = integer(op, "count", 10_000)?;
            if count == 0 || index + count > bound { return Err(payload_error("Structural operation exceeds worksheet limits.")); }
            if kind == "move-rows" {
                let before = integer(op, "before", bound)?;
                if before >= index && before <= index + count { return Err(payload_error("Row move target overlaps the moved block.")); }
            }
        }
        "merge-cells" | "unmerge-cells" => {
            fields(op, &["sheetId", "kind", "range"], "Structural operation")?;
            range(op.get("range").ok_or_else(|| payload_error("Missing merge range."))?)?;
        }
        "set-outline-pr" => {
            fields(op, &["sheetId", "kind", "summaryBelow", "summaryRight"], "Structural operation")?;
            boolean(op, "summaryBelow")?; boolean(op, "summaryRight")?;
        }
        "set-row-size" | "set-col-size" | "set-col-style" | "set-rows-hidden" | "set-cols-hidden" | "set-rows-outline" | "set-cols-outline" => {
            let columns = kind.contains("col");
            let bound = u64::from(if columns { MAX_SHEET_COLUMNS } else { MAX_SHEET_ROWS });
            let start = integer(op, "start", bound - 1)?;
            let end = integer(op, "end", bound - 1)?;
            if end < start || end - start >= 100_000 { return Err(payload_error("Invalid structural axis span.")); }
            if kind.ends_with("size") {
                fields(op, &["sheetId", "kind", "start", "end", "size"], "Structural operation")?;
                let size = op.get("size").ok_or_else(|| payload_error("Missing axis size."))?;
                if !size.is_null() && !size.as_f64().is_some_and(|number| number > 0.0 && number <= 500.0) { return Err(payload_error("Invalid axis size.")); }
            } else if kind.ends_with("style") {
                fields(op, &["sheetId", "kind", "start", "end", "style"], "Structural operation")?;
                object(op.get("style").ok_or_else(|| payload_error("Missing column style."))?, "Column style")?;
            } else if kind.ends_with("hidden") {
                fields(op, &["sheetId", "kind", "start", "end", "hidden"], "Structural operation")?;
                boolean(op, "hidden")?;
            } else {
                fields(op, &["sheetId", "kind", "start", "end", "level", "collapsed"], "Structural operation")?;
                integer(op, "level", 7)?;
                if op.contains_key("collapsed") { boolean(op, "collapsed")?; }
            }
        }
        _ => return Err(payload_error("Unknown structural operation.")),
    }
    Ok(())
}

fn validate_tree(value: &Value, depth: usize) -> Result<(), DocumentError> {
    if depth > MAX_CHECKPOINT_DEPTH { return Err(payload_error("Checkpoint JSON is nested too deeply.")); }
    match value {
        Value::Object(map) => for child in map.values() { validate_tree(child, depth + 1)?; },
        Value::Array(array) => for child in array { validate_tree(child, depth + 1)?; },
        _ => {},
    }
    Ok(())
}
struct LimitedWriter(usize);
impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_CHECKPOINT_BYTES.saturating_sub(self.0) { return Err(io::Error::other("Checkpoint exceeds its byte limit.")); }
        self.0 += bytes.len(); Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

/// Native defense in depth. Specialized supported metadata remains verbatim;
/// the host applies the complete feature-specific Zod schema before this call.
pub fn validate_payload(value: &Value, original_sheets: &[SheetDescriptor]) -> Result<(), DocumentError> {
    validate_tree(value, 0)?;
    serde_json::to_writer(LimitedWriter(0), value).map_err(|_| payload_error("Checkpoint exceeds the 256 MiB JSON limit."))?;
    let payload = object(value, "Document checkpoint")?;
    for key in payload.keys() {
        if !ARRAY_FAMILIES.iter().any(|(name, _, _)| key.as_str() == *name) && !NULLABLE_FAMILIES.contains(&key.as_str()) {
            return Err(payload_error(format!("Unsupported or operational checkpoint field: {key}.")));
        }
    }
    for (name, maximum, required) in ARRAY_FAMILIES {
        match payload.get(*name) {
            Some(Value::Array(array)) if array.len() <= *maximum => {},
            None if !*required => {},
            _ => return Err(payload_error(format!("Invalid checkpoint collection: {name}."))),
        }
    }
    if !payload.contains_key("definedNamesState") { return Err(payload_error("Missing definedNamesState checkpoint field.")); }
    for name in NULLABLE_FAMILIES {
        if let Some(value) = payload.get(*name) {
            if !value.is_null() && !(if *name == "redactionStates" { value.is_array() } else { value.is_object() }) { return Err(payload_error(format!("Invalid checkpoint metadata: {name}."))); }
        }
    }
    let sheets = current_sheets(payload, original_sheets)?;
    let mut addresses = BTreeSet::new();
    for edit in array(payload, "edits")? {
        validate_cell(edit, &sheets)?;
        let edit = object(edit, "Cell edit")?;
        let (row, column) = cell_coordinates(edit)?;
        if !addresses.insert((string(edit, "sheetId")?, row, column)) { return Err(payload_error("Checkpoint repeats a cell edit address.")); }
    }
    for fill in array_or_empty(payload, "bulkConstantFills") {
        let fill = object(fill, "Bulk constant fill")?;
        fields(fill, &["sheetId", "startRow", "endRow", "startColumn", "endColumn", "value"], "Bulk constant fill")?;
        known_sheet(fill, &sheets)?; scalar(fill.get("value"))?;
        let area: Map<String, Value> = fill.iter().filter(|(key, _)| ["startRow", "endRow", "startColumn", "endColumn"].contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect();
        range(&Value::Object(area))?;
    }
    for op in array(payload, "structuralOps")? { validate_structure(op, &sheets)?; }
    for (family, _, _) in ARRAY_FAMILIES {
        if ["edits", "bulkConstantFills", "structuralOps", "sheetOps", "sheetOrder", "pivotCacheRefreshPaths"].contains(family) { continue; }
        for item in array_or_empty(payload, family) {
            let item = object(item, family)?;
            if !["chartEdits", "visualEdits"].contains(family) || item.contains_key("sheetId") { known_sheet(item, &sheets)?; }
            if let Some(source) = item.get("sourceSheetId") {
                if !source.as_str().is_some_and(|id| sheets.contains_key(id)) { return Err(payload_error("Unknown pivot source worksheet.")); }
            }
            if item.contains_key("row") || item.contains_key("column") { cell_coordinates(item)?; }
            if let Some(area) = item.get("visibilityRange") { range(area)?; }
            if let Some(filter) = item.get("filter").and_then(Value::as_object) {
                if let Some(area) = filter.get("range") { range(area)?; }
            }
            if let Some(rules) = item.get("rules").and_then(Value::as_array) {
                for rule in rules {
                    if let Some(ranges) = rule.get("ranges").and_then(Value::as_array) { for area in ranges { range(area)?; } }
                }
            }
            if let Some(notes) = item.get("notes").and_then(Value::as_array) {
                for note in notes { cell_coordinates(object(note, "Note")?)?; }
            }
        }
    }
    for value in array(payload, "formulaValues")? {
        let cell = object(value, "Formula result")?;
        fields(cell, &["sheetId", "row", "column", "value"], "Formula result")?;
        known_sheet(cell, &sheets)?; cell_coordinates(cell)?;
        match cell.get("value") {
            Some(Value::Object(error)) if error.len() == 1 && error.get("error").and_then(Value::as_str).is_some_and(|text| text.len() <= 32) => {},
            value => scalar(value)?,
        }
    }
    for path in array(payload, "pivotCacheRefreshPaths")? {
        let path = path.as_str().ok_or_else(|| payload_error("Pivot cache path must be a string."))?;
        if !path.starts_with("xl/") || !path.ends_with(".xml") || path.contains("..") || !path.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/._-".contains(&byte)) { return Err(payload_error("Invalid pivot cache part path.")); }
    }
    Ok(())
}

/// Serialize all JSON object keys in lexical order, regardless of whether
/// serde_json's preserve_order feature was enabled by another dependency.
struct Canonical<'a>(&'a Value);
impl Serialize for Canonical<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Object(object) => {
                let ordered: BTreeMap<&str, &Value> = object.iter().map(|(key, value)| (key.as_str(), value)).collect();
                let mut map = serializer.serialize_map(Some(ordered.len()))?;
                for (key, value) in ordered { map.serialize_entry(key, &Canonical(value))?; }
                map.end()
            }
            Value::Array(array) => {
                let mut sequence = serializer.serialize_seq(Some(array.len()))?;
                for value in array { sequence.serialize_element(&Canonical(value))?; }
                sequence.end()
            }
            value => value.serialize(serializer),
        }
    }
}
struct CanonicalCommand<'a>(&'a CheckpointCommand);
impl Serialize for CanonicalCommand<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let command = self.0;
        let mut map = serializer.serialize_map(Some(6))?;
        map.serialize_entry("actor", &command.actor)?;
        map.serialize_entry("apiVersion", &command.api_version)?;
        map.serialize_entry("commandId", &command.command_id)?;
        map.serialize_entry("documentId", &command.document_id)?;
        map.serialize_entry("expectedRevision", &command.expected_revision)?;
        map.serialize_entry("payload", &Canonical(&command.payload))?;
        map.end()
    }
}
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.0.update(bytes); Ok(bytes.len()) }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
pub fn checkpoint_hash(command: &CheckpointCommand) -> Result<String, DocumentError> {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, &CanonicalCommand(command)).map_err(|error| payload_error(format!("Cannot encode checkpoint: {error}")))?;
    Ok(format!("{:x}", writer.0.finalize()))
}

pub(crate) fn validate_stored(stored: &StoredDocument) -> Result<(), DocumentError> {
    let corrupt = || invalid("invalid_store", "The stored document checkpoint or receipt sequence is inconsistent.");
    version(stored.api_version).map_err(|_| corrupt())?;
    version(stored.snapshot.api_version).map_err(|_| corrupt())?;
    validate_open(&DocumentOpen { api_version: stored.api_version, document_id: stored.snapshot.document_id.clone(), source_fingerprint: stored.snapshot.source_fingerprint.clone(), sheets: stored.snapshot.sheets.clone() }).map_err(|_| corrupt())?;
    validate_payload(&stored.snapshot.payload, &stored.snapshot.sheets).map_err(|_| corrupt())?;
    if stored.commands.len() as u64 != stored.snapshot.revision { return Err(corrupt()); }
    let mut ids = BTreeSet::new();
    for (index, receipt) in stored.commands.iter().enumerate() {
        if !ids.insert(&receipt.command_id) || validate_receipt(receipt, &stored.snapshot.document_id, index as u64 + 1).is_err() { return Err(corrupt()); }
    }
    Ok(())
}
fn validate_receipt(receipt: &DocumentReceipt, document_id: &str, revision: u64) -> Result<(), StoreError> {
    if identifier(&receipt.command_id, "Command ID", 512).is_err() || receipt.request_hash.len() != 64 || !receipt.request_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || receipt.result.api_version != DOCUMENT_API_VERSION || receipt.result.command_id != receipt.command_id || receipt.result.document_id != document_id || receipt.result.revision != revision
    { return Err(StoreError::Storage("Invalid document checkpoint receipt.".into())); }
    Ok(())
}
pub(crate) fn validate_append(expected: u64, previous: &DocumentSnapshot, next: &DocumentSnapshot, receipt: &DocumentReceipt) -> Result<(), StoreError> {
    if previous.revision != expected { return Err(StoreError::Conflict); }
    if previous.api_version != DOCUMENT_API_VERSION || next.api_version != DOCUMENT_API_VERSION || expected.checked_add(1) != Some(next.revision)
        || previous.document_id != next.document_id || previous.source_fingerprint != next.source_fingerprint || previous.sheets != next.sheets
    { return Err(StoreError::Storage("Document checkpoint source or revision binding changed.".into())); }
    validate_payload(&next.payload, &next.sheets).map_err(|error| StoreError::Storage(error.to_string()))?;
    validate_receipt(receipt, &next.document_id, next.revision)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;
    use super::*;

    fn open() -> DocumentOpen {
        DocumentOpen { api_version: 1, document_id: "document".into(), source_fingerprint: "sha256:base".into(), sheets: vec![SheetDescriptor { id: "s".into(), name: "Sheet1".into() }] }
    }
    fn command(id: &str, revision: u64, payload: Value) -> CheckpointCommand {
        CheckpointCommand { api_version: 1, document_id: "document".into(), command_id: id.into(), expected_revision: revision, actor: "desktop".into(), payload }
    }
    fn typed_payload() -> Value {
        let mut payload = empty_payload();
        payload["edits"] = json!([
            {"sheetId":"s","row":0,"column":0,"writeValue":true,"value":"12"},
            {"sheetId":"s","row":0,"column":1,"writeValue":true,"value":12},
            {"sheetId":"s","row":0,"column":2,"writeValue":true,"value":true},
            {"sheetId":"s","row":0,"column":3,"writeValue":true,"value":null},
            {"sheetId":"s","row":0,"column":4,"writeValue":true,"value":"rich","rich":[{"text":"ri","bold":true},{"text":"ch","italic":true}],"style":{"numFmt":"@"}},
            {"sheetId":"s","row":0,"column":5,"writeValue":true,"value":null,"formula":"=SUM(B1:C1)"},
            {"sheetId":"s","row":1,"column":0,"writeValue":false,"value":null,"styleReset":true}
        ]);
        payload
    }

    #[test]
    fn typed_values_formula_rich_text_and_style_survive_checkpoint_reopen_and_reset() {
        let shared = MemoryDocumentStore::default();
        let payload = typed_payload();
        {
            let mut authority = DocumentAuthority::new(Box::new(shared.clone()));
            authority.open(open()).unwrap();
            authority.apply(command("typed", 0, payload.clone())).unwrap();
            assert_eq!(authority.snapshot("document", None).unwrap().payload, payload);
        }
        let mut recovered = DocumentAuthority::new(Box::new(shared));
        assert!(recovered.open(open()).unwrap().recovered);
        let snapshot = recovered.snapshot("document", None).unwrap();
        assert!(snapshot.payload["edits"][0]["value"].is_string());
        assert!(snapshot.payload["edits"][1]["value"].is_number());
        assert!(snapshot.payload["edits"][2]["value"].is_boolean());
        assert!(snapshot.payload["edits"][3]["value"].is_null());
        assert_eq!(snapshot.payload, payload);
        recovered.apply(command("reset", 1, empty_payload())).unwrap();
        assert_eq!(recovered.snapshot("document", None).unwrap().payload, empty_payload());
        assert_eq!(snapshot.payload, payload);
    }

    #[test]
    fn every_save_family_is_retained_with_metadata_only_and_compact_bulk_changes() {
        let mut payload = empty_payload();
        payload["bulkConstantFills"] = json!([{"sheetId":"s","startRow":0,"endRow":1048575,"startColumn":0,"endColumn":0,"value":false}]);
        payload["structuralOps"] = json!([
            {"sheetId":"s","kind":"insert-rows","index":2,"count":3},
            {"sheetId":"s","kind":"merge-cells","range":{"startRow":0,"endRow":1,"startColumn":0,"endColumn":1}},
            {"sheetId":"s","kind":"set-col-style","start":0,"end":2,"style":{"numFmt":"0.00"}}
        ]);
        payload["filterStates"] = json!([{"sheetId":"s","filter":null,"hiddenRows":[],"visibilityRange":{"startRow":0,"endRow":5,"startColumn":0,"endColumn":2}}]);
        payload["cfStates"] = json!([{"sheetId":"s","rules":[{"ranges":[{"startRow":0,"endRow":1,"startColumn":0,"endColumn":1}],"stopIfTrue":false,"rule":{"type":"colorScale","config":{"futureSupportedMetadata":{"stops":[1,2,3]}}}}]}]);
        payload["dvStates"] = json!([{"sheetId":"s","rules":[]}]);
        payload["pageSetupStates"] = json!([{"sheetId":"s","orientation":"landscape","header":{"left":"&A"}}]);
        payload["noteStates"] = json!([{"sheetId":"s","notes":[{"row":0,"column":0,"author":"Reader","text":"Note"}]}]);
        payload["sheetProtections"] = json!([{"sheetId":"s","protected":true}]);
        payload["definedNamesState"] = json!({"names":[{"name":"Input","formula":"Sheet1!$A$1"}],"preserveNames":["UnsupportedName"]});
        payload["themeState"] = json!({"fonts":{"name":"Document fonts","major":"Aptos Display","minor":"Aptos"}});
        payload["workbookProtectionState"] = json!({"lockStructure":true});
        payload["protectedRangeStates"] = json!([{"sheetId":"s","ranges":[{"name":"Input","sqref":"A1"}]}]);
        payload["pivotCacheRefreshPaths"] = json!(["xl/pivotCache/pivotCacheDefinition1.xml"]);
        payload["formulaValues"] = json!([{"sheetId":"s","row":4,"column":0,"value":{"error":"#DIV/0!"}}]);
        let mut authority = DocumentAuthority::default();
        authority.open(open()).unwrap();
        authority.apply(command("all-families", 0, payload.clone())).unwrap();
        let saved = authority.snapshot("document", None).unwrap();
        assert_eq!(saved.payload, payload);
        for (name, _, _) in ARRAY_FAMILIES { assert!(saved.payload.get(*name).is_some(), "Missing family {name}"); }
        assert_eq!(saved.payload["bulkConstantFills"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn sheet_operations_validate_final_layout_and_allow_edits_to_new_sheets() {
        let mut payload = empty_payload();
        payload["sheetOps"] = json!([{"kind":"rename-sheet","sheetId":"s","newName":"Original"},{"kind":"add-sheet","sheetId":"new","name":"Added"}]);
        payload["sheetOrder"] = json!(["new","s"]);
        payload["edits"] = json!([{"sheetId":"new","row":0,"column":0,"writeValue":true,"value":"created"}]);
        validate_payload(&payload, &open().sheets).unwrap();
        let mut invalid = payload.clone();
        invalid["sheetOrder"] = json!(["new","new"]);
        assert!(validate_payload(&invalid, &open().sheets).is_err());
        invalid = payload.clone();
        invalid["sheetOps"][1]["name"] = json!("original");
        assert!(validate_payload(&invalid, &open().sheets).is_err());
        invalid = payload;
        invalid["edits"][0]["sheetId"] = json!("unknown");
        assert!(validate_payload(&invalid, &open().sheets).is_err());
    }

    #[test]
    fn malformed_cells_ranges_structure_and_operational_fields_are_rejected_atomically() {
        let mut authority = DocumentAuthority::default();
        authority.open(open()).unwrap();
        for key in ["sessionId","mode","targetPath","overwrite","restoreWriteBack","quiet","defaultName","csvContent","editsTransferId","unknown"] {
            let mut payload = typed_payload(); payload[key] = json!("not document data");
            assert!(authority.apply(command(key, 0, payload)).is_err());
        }
        let mut payload = typed_payload(); payload["edits"][1]["value"] = json!({"unsafe":"value"});
        assert!(authority.apply(command("bad-type", 0, payload)).is_err());
        let mut payload = typed_payload(); payload["structuralOps"] = json!([{"sheetId":"s","kind":"remove-cols","index":16383,"count":2}]);
        assert!(authority.apply(command("bad-structure", 0, payload)).is_err());
        let mut payload = typed_payload(); payload["structuralOps"] = json!([{"sheetId":"s","kind":"merge-cells","range":{"startRow":2,"endRow":1,"startColumn":0,"endColumn":1}}]);
        assert!(authority.apply(command("bad-range", 0, payload)).is_err());
        assert_eq!(authority.snapshot("document", None).unwrap().revision, 0);
        assert!(authority.command_result("document", "bad-range").unwrap().is_none());
    }

    #[test]
    fn canonical_receipts_cover_actor_revision_and_all_nested_fields() {
        let first = command("one", 0, typed_payload());
        let mut reordered = first.clone();
        let object = reordered.payload.as_object_mut().unwrap();
        let value = object.remove("edits").unwrap(); object.insert("edits".into(), value);
        assert_eq!(checkpoint_hash(&first).unwrap(), checkpoint_hash(&reordered).unwrap());
        reordered.actor = "another actor".into();
        assert_ne!(checkpoint_hash(&first).unwrap(), checkpoint_hash(&reordered).unwrap());
        reordered = first.clone(); reordered.expected_revision = 1;
        assert_ne!(checkpoint_hash(&first).unwrap(), checkpoint_hash(&reordered).unwrap());
        reordered = first.clone(); reordered.payload["edits"][0]["value"] = json!(12);
        assert_ne!(checkpoint_hash(&first).unwrap(), checkpoint_hash(&reordered).unwrap());
    }

    #[test]
    fn idempotency_replays_original_result_after_recovery_and_stale_writes_report_head() {
        let shared = MemoryDocumentStore::default();
        let first = command("one", 0, typed_payload());
        let original;
        {
            let mut authority = DocumentAuthority::new(Box::new(shared.clone())); authority.open(open()).unwrap();
            original = authority.apply(first.clone()).unwrap();
            authority.apply(command("two", 1, empty_payload())).unwrap();
            assert_eq!(authority.apply(first.clone()).unwrap(), original);
            let stale = authority.apply(command("stale", 0, empty_payload())).unwrap_err();
            assert_eq!(stale.code, "revision_conflict"); assert_eq!(stale.current_revision, Some(2));
        }
        let mut authority = DocumentAuthority::new(Box::new(shared)); authority.open(open()).unwrap();
        assert_eq!(authority.apply(first.clone()).unwrap(), original);
        assert_eq!(authority.command_result("document", "one").unwrap(), Some(original));
        let mut conflict = first; conflict.payload = empty_payload();
        assert_eq!(authority.apply(conflict).unwrap_err().code, "idempotency_conflict");
        assert_eq!(authority.snapshot("document", None).unwrap().revision, 2);
    }

    struct FailingStore { inner: MemoryDocumentStore, fail: Arc<AtomicBool> }
    impl DocumentStore for FailingStore {
        fn load(&mut self, id: &str) -> Result<Option<StoredDocument>, StoreError> { self.inner.load(id) }
        fn create(&mut self, document: &StoredDocument) -> Result<(), StoreError> { self.inner.create(document) }
        fn append(&mut self, expected: u64, snapshot: &DocumentSnapshot, receipt: &DocumentReceipt) -> Result<(), StoreError> {
            if self.fail.load(Ordering::SeqCst) { Err(StoreError::Storage("injected full disk".into())) } else { self.inner.append(expected, snapshot, receipt) }
        }
        fn is_durable(&self) -> bool { false }
    }

    #[test]
    fn storage_failure_never_publishes_receipt_index_or_candidate_and_retry_is_safe() {
        let shared = MemoryDocumentStore::default(); let fail = Arc::new(AtomicBool::new(false));
        let mut authority = DocumentAuthority::new(Box::new(FailingStore { inner: shared.clone(), fail: fail.clone() }));
        authority.open(open()).unwrap(); authority.apply(command("one", 0, typed_payload())).unwrap();
        let before = authority.snapshot("document", None).unwrap();
        fail.store(true, Ordering::SeqCst);
        assert_eq!(authority.apply(command("two", 1, empty_payload())).unwrap_err().code, "storage_error");
        assert_eq!(authority.snapshot("document", None).unwrap(), before);
        assert!(authority.command_result("document", "two").unwrap().is_none());
        let mut reader = shared; assert_eq!(reader.load("document").unwrap().unwrap().snapshot.revision, 1);
        fail.store(false, Ordering::SeqCst);
        assert_eq!(authority.apply(command("two", 1, empty_payload())).unwrap().revision, 2);
    }

    #[test]
    fn source_conflicts_concurrent_writers_and_evicted_snapshot_leases_are_safe() {
        let shared = MemoryDocumentStore::default();
        let mut authority = DocumentAuthority::new(Box::new(shared.clone())); authority.open(open()).unwrap();
        let mut stale = DocumentAuthority::new(Box::new(shared)); stale.open(open()).unwrap();
        let pinned = authority.snapshot("document", None).unwrap();
        for revision in 0..20 { authority.apply(command(&format!("command-{revision}"), revision, empty_payload())).unwrap(); }
        assert_eq!(authority.documents["document"].snapshots.len(), MAX_DOCUMENT_SNAPSHOTS);
        assert_eq!(authority.snapshot("document", Some(0)).unwrap_err().code, "snapshot_not_found");
        assert_eq!(pinned.revision, 0); assert_eq!(pinned.payload, empty_payload());
        assert_eq!(stale.apply(command("stale", 0, empty_payload())).unwrap_err().code, "persistence_conflict");
        let mut changed = open(); changed.source_fingerprint = "another-source".into();
        assert_eq!(authority.open(changed).unwrap_err().code, "source_conflict");
        let mut changed = open(); changed.sheets[0].name = "Another name".into();
        assert_eq!(authority.open(changed).unwrap_err().code, "source_conflict");
    }

    struct CorruptStore(StoredDocument);
    impl DocumentStore for CorruptStore {
        fn load(&mut self, _: &str) -> Result<Option<StoredDocument>, StoreError> { Ok(Some(self.0.clone())) }
        fn create(&mut self, _: &StoredDocument) -> Result<(), StoreError> { Err(StoreError::Storage("Unexpected create".into())) }
        fn append(&mut self, _: u64, _: &DocumentSnapshot, _: &DocumentReceipt) -> Result<(), StoreError> { Err(StoreError::Storage("Unexpected append".into())) }
        fn is_durable(&self) -> bool { false }
    }

    #[test]
    fn recovery_rejects_corrupt_receipt_sequence_before_opening() {
        let mut shared = MemoryDocumentStore::default();
        let mut source = DocumentAuthority::new(Box::new(shared.clone())); source.open(open()).unwrap();
        source.apply(command("one", 0, typed_payload())).unwrap();
        let mut stored = shared.load("document").unwrap().unwrap(); stored.commands.clear();
        let mut authority = DocumentAuthority::new(Box::new(CorruptStore(stored)));
        assert_eq!(authority.open(open()).unwrap_err().code, "invalid_store");
        assert!(authority.snapshot("document", None).is_err());
    }

    #[test]
    fn depth_and_encoded_byte_limits_are_bounded_without_materializing_large_fills() {
        let mut payload = empty_payload();
        let mut nested = json!(true);
        for _ in 0..MAX_CHECKPOINT_DEPTH + 2 { nested = json!({"child":nested}); }
        payload["themeState"] = nested;
        assert!(validate_payload(&payload, &open().sheets).is_err());
        let mut writer = LimitedWriter(MAX_CHECKPOINT_BYTES - 2);
        assert_eq!(writer.write(b"12").unwrap(), 2);
        assert!(writer.write(b"3").is_err());
    }
}
