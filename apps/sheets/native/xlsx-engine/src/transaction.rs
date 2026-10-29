//! Typed, bounded transactions over a complete pending-input overlay.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::session::SessionError;
use crate::snapshot::{
    CellInput, MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, SESSION_API_VERSION, SdkRange,
    WorkbookSnapshot,
};

pub const MAX_TRANSACTION_OPERATIONS: usize = 10_000;
/// Matches the existing formula worker's edit cap.
pub const MAX_SESSION_INPUTS: usize = 10_000;
pub const MAX_INPUT_BYTES: usize = 1_048_576;
pub const MAX_OVERLAY_BYTES: usize = 8 * 1_048_576;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum TransactionOperation {
    SetCell {
        #[serde(rename = "sheetId")]
        sheet_id: String,
        row: u32,
        column: u32,
        input: String,
    },
    ClearRange {
        #[serde(rename = "sheetId")]
        sheet_id: String,
        range: SdkRange,
    },
    /// Replace the entire cumulative overlay. Unlike clearing, dropping a key
    /// here restores its base input and supports undo without rebuilding files.
    ReplaceInputs { edits: Vec<CellInput> },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionCommand {
    pub api_version: u32,
    pub workbook_id: String,
    pub command_id: String,
    pub expected_revision: u64,
    pub actor: String,
    pub operations: Vec<TransactionOperation>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionResult {
    pub api_version: u32,
    pub workbook_id: String,
    pub command_id: String,
    pub revision: u64,
    pub changed: usize,
    pub durable: bool,
}

type Address = (String, u32, u32);
type Inputs = BTreeMap<Address, String>;

/// Serializing a typed struct and tagged enums gives a canonical field order
/// independent of the original JSON object's property order or whitespace.
/// Transport request IDs are not part of this type and therefore never hashed.
pub fn command_hash(command: &TransactionCommand) -> Result<String, SessionError> {
    let bytes = serde_json::to_vec(command).map_err(|error| {
        SessionError::new("invalid_request", format!("Cannot encode transaction: {error}"))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub(crate) fn validate_command(command: &TransactionCommand) -> Result<(), SessionError> {
    if command.api_version != SESSION_API_VERSION {
        return Err(SessionError::new(
            "unsupported_api_version",
            "The native editing API version is not supported.",
        ));
    }
    validate_identifier(&command.workbook_id, "Workbook ID", 512)?;
    validate_identifier(&command.command_id, "Command ID", 512)?;
    validate_identifier(&command.actor, "Actor", 1_024)?;
    if command.operations.len() > MAX_TRANSACTION_OPERATIONS {
        return Err(SessionError::new(
            "invalid_request",
            "The transaction has too many operations.",
        ));
    }
    // Bound the encoded request before hashing or constructing any candidate.
    // A later replacement is not permission for an earlier operation to allocate
    // an arbitrarily large temporary overlay.
    let mut input_bytes = 0usize;
    let mut expanded_cells = 0u64;
    for operation in &command.operations {
        let mut add_input = |sheet_id: &str, input: &str| -> Result<(), SessionError> {
            validate_identifier(sheet_id, "Worksheet ID", 512)?;
            if input.len() > MAX_INPUT_BYTES {
                return Err(SessionError::new("invalid_request", "A cell input is too large."));
            }
            input_bytes = input_bytes.checked_add(input.len()).ok_or_else(|| {
                SessionError::new("invalid_request", "The transaction is too large.")
            })?;
            if input_bytes > MAX_OVERLAY_BYTES {
                return Err(SessionError::new("invalid_request", "The transaction inputs are too large."));
            }
            Ok(())
        };
        let count = match operation {
            TransactionOperation::SetCell { sheet_id, input, .. } => {
                add_input(sheet_id, input)?;
                1
            }
            TransactionOperation::ClearRange { sheet_id, range } => {
                validate_identifier(sheet_id, "Worksheet ID", 512)?;
                range.cell_count().ok_or_else(|| {
                    SessionError::new("invalid_request", "The clear range is empty or reversed.")
                })?
            }
            TransactionOperation::ReplaceInputs { edits } => {
                if edits.len() > MAX_SESSION_INPUTS {
                    return Err(SessionError::new("invalid_request", "The input overlay is too large."));
                }
                for edit in edits {
                    add_input(&edit.sheet_id, &edit.input)?;
                }
                edits.len() as u64
            }
        };
        expanded_cells = expanded_cells.checked_add(count).ok_or_else(|| {
            SessionError::new("invalid_request", "The transaction is too large.")
        })?;
        if expanded_cells > MAX_SESSION_INPUTS as u64 {
            return Err(SessionError::new("invalid_request", "The transaction edits too many cells."));
        }
    }
    Ok(())
}

pub(crate) fn validate_identifier(
    value: &str,
    label: &str,
    max_bytes: usize,
) -> Result<(), SessionError> {
    if value.trim().is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err(SessionError::new(
            "invalid_request",
            format!("{label} is empty, too long, or contains a null character."),
        ));
    }
    Ok(())
}

fn validate_cell(cell: &CellInput, sheets: &HashSet<&str>) -> Result<(), SessionError> {
    validate_address(&cell.sheet_id, cell.row, cell.column, sheets)?;
    if cell.input.len() > MAX_INPUT_BYTES {
        return Err(SessionError::new("invalid_request", "A cell input is too large."));
    }
    Ok(())
}

fn validate_address(
    sheet_id: &str,
    row: u32,
    column: u32,
    sheets: &HashSet<&str>,
) -> Result<(), SessionError> {
    if !sheets.contains(sheet_id) {
        return Err(SessionError::new("invalid_request", "Unknown worksheet ID."));
    }
    if row >= MAX_SHEET_ROWS || column >= MAX_SHEET_COLUMNS {
        return Err(SessionError::new(
            "invalid_request",
            "Cell coordinates are outside the worksheet limits.",
        ));
    }
    Ok(())
}

pub(crate) fn validate_inputs(
    cells: &[CellInput],
    snapshot: &WorkbookSnapshot,
) -> Result<(), SessionError> {
    if cells.len() > MAX_SESSION_INPUTS {
        return Err(SessionError::new("invalid_request", "The input overlay is too large."));
    }
    let sheets: HashSet<&str> = snapshot.sheets.iter().map(|sheet| sheet.id.as_str()).collect();
    let mut seen = HashSet::with_capacity(cells.len());
    let mut bytes = 0usize;
    for cell in cells {
        validate_cell(cell, &sheets)?;
        if !seen.insert((&cell.sheet_id, cell.row, cell.column)) {
            return Err(SessionError::new(
                "invalid_request",
                "The input overlay repeats a cell address.",
            ));
        }
        bytes = bytes.checked_add(cell.input.len()).ok_or_else(|| {
            SessionError::new("invalid_request", "The input overlay is too large.")
        })?;
        if bytes > MAX_OVERLAY_BYTES {
            return Err(SessionError::new("invalid_request", "The input overlay is too large."));
        }
    }
    Ok(())
}

fn as_map(cells: &[CellInput]) -> Inputs {
    cells.iter().map(|cell| {
        ((cell.sheet_id.clone(), cell.row, cell.column), cell.input.clone())
    }).collect()
}

/// Validate the whole batch before deriving a candidate. The published snapshot
/// is never modified, including if a later operation or resulting size is invalid.
pub(crate) fn candidate_inputs(
    snapshot: &WorkbookSnapshot,
    operations: &[TransactionOperation],
) -> Result<(Vec<CellInput>, usize), SessionError> {
    let sheets: HashSet<&str> = snapshot.sheets.iter().map(|sheet| sheet.id.as_str()).collect();
    let mut expanded_cells = 0u64;
    for operation in operations {
        match operation {
            TransactionOperation::SetCell { sheet_id, row, column, input } => {
                validate_address(sheet_id, *row, *column, &sheets)?;
                if input.len() > MAX_INPUT_BYTES {
                    return Err(SessionError::new("invalid_request", "A cell input is too large."));
                }
                expanded_cells += 1;
            }
            TransactionOperation::ClearRange { sheet_id, range } => {
                if !sheets.contains(sheet_id.as_str())
                    || range.end_row > MAX_SHEET_ROWS
                    || range.end_column > MAX_SHEET_COLUMNS
                {
                    return Err(SessionError::new("invalid_request", "The clear range is outside the worksheet."));
                }
                let count = range.cell_count().ok_or_else(|| {
                    SessionError::new("invalid_request", "The clear range is empty or reversed.")
                })?;
                expanded_cells = expanded_cells.checked_add(count).ok_or_else(|| {
                    SessionError::new("invalid_request", "The transaction is too large.")
                })?;
            }
            TransactionOperation::ReplaceInputs { edits } => {
                validate_inputs(edits, snapshot)?;
                expanded_cells += edits.len() as u64;
            }
        }
        if expanded_cells > MAX_SESSION_INPUTS as u64 {
            return Err(SessionError::new("invalid_request", "The transaction edits too many cells."));
        }
    }

    let before = as_map(&snapshot.inputs);
    let mut candidate = before.clone();
    for operation in operations {
        match operation {
            TransactionOperation::SetCell { sheet_id, row, column, input } => {
                candidate.insert((sheet_id.clone(), *row, *column), input.clone());
            }
            TransactionOperation::ClearRange { sheet_id, range } => {
                for row in range.start_row..range.end_row {
                    for column in range.start_column..range.end_column {
                        candidate.insert((sheet_id.clone(), row, column), String::new());
                    }
                }
            }
            TransactionOperation::ReplaceInputs { edits } => candidate = as_map(edits),
        }
    }
    let changed = before.iter().filter(|(key, value)| candidate.get(*key) != Some(*value)).count()
        + candidate.keys().filter(|key| !before.contains_key(*key)).count();
    let inputs: Vec<_> = candidate.into_iter().map(|((sheet_id, row, column), input)| {
        CellInput { sheet_id, row, column, input }
    }).collect();
    validate_inputs(&inputs, snapshot)?;
    Ok((inputs, changed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_hash_ignores_json_object_order_but_covers_actor_and_revision() {
        let a: TransactionCommand = serde_json::from_str(r#"{"apiVersion":1,"workbookId":"w","commandId":"c","expectedRevision":0,"actor":"user","operations":[{"type":"set_cell","sheetId":"s","row":0,"column":0,"input":"1"}]}"#).unwrap();
        let b: TransactionCommand = serde_json::from_str(r#"{"operations":[{"input":"1","column":0,"row":0,"sheetId":"s","type":"set_cell"}],"actor":"user","expectedRevision":0,"commandId":"c","workbookId":"w","apiVersion":1}"#).unwrap();
        assert_eq!(command_hash(&a).unwrap(), command_hash(&b).unwrap());
        let mut changed = a.clone();
        changed.actor = "other".into();
        assert_ne!(command_hash(&a).unwrap(), command_hash(&changed).unwrap());
        changed = a.clone();
        changed.expected_revision = 1;
        assert_ne!(command_hash(&a).unwrap(), command_hash(&changed).unwrap());
    }

    #[test]
    fn unknown_command_fields_are_not_silently_ignored() {
        let command = r#"{"apiVersion":1,"workbookId":"w","commandId":"c","expectedRevision":0,"actor":"user","operations":[],"permission":"admin"}"#;
        assert!(serde_json::from_str::<TransactionCommand>(command).is_err());
    }
}
