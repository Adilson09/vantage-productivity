//! Immutable, revision-scoped workbook inputs for the native editing API.
//!
//! These coordinates are intentionally separate from the inclusive ranges used
//! by the original import protocol. SDK ranges use zero-based, half-open bounds.

use serde::{Deserialize, Serialize};

pub const SESSION_API_VERSION: u32 = 1;
pub const MAX_SHEET_ROWS: u32 = 1_048_576;
pub const MAX_SHEET_COLUMNS: u32 = 16_384;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetDescriptor {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellInput {
    pub sheet_id: String,
    pub row: u32,
    pub column: u32,
    pub input: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SdkRange {
    pub start_row: u32,
    pub end_row: u32,
    pub start_column: u32,
    pub end_column: u32,
}

impl SdkRange {
    pub fn cell_count(&self) -> Option<u64> {
        let rows = self.end_row.checked_sub(self.start_row)?;
        let columns = self.end_column.checked_sub(self.start_column)?;
        if rows == 0 || columns == 0 {
            return None;
        }
        Some(u64::from(rows) * u64::from(columns))
    }
}

/// A snapshot contains the complete pending input overlay on its imported base.
/// Removing an overlay entry reveals the imported input again; an entry whose
/// input is empty explicitly clears the imported cell.
///
/// The authority publishes this value through `Arc`. A caller may retain an old
/// snapshot during later commits without observing any subsequent mutation.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbookSnapshot {
    pub api_version: u32,
    pub workbook_id: String,
    pub revision: u64,
    pub source_fingerprint: String,
    pub sheets: Vec<SheetDescriptor>,
    /// Sorted by sheet ID, row and column; each address occurs once.
    pub inputs: Vec<CellInput>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_ranges_are_half_open_and_do_not_wrap() {
        let range = SdkRange {
            start_row: 2,
            end_row: 4,
            start_column: 3,
            end_column: 6,
        };
        assert_eq!(range.cell_count(), Some(6));
        assert_eq!(SdkRange { end_row: 2, ..range }.cell_count(), None);
        assert_eq!(SdkRange { end_row: 1, ..range }.cell_count(), None);
    }
}
