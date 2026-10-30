//! IronCalc-backed formula recalculation with a session-resident model cache.
//!
//! The first request for a workbook loads it into IronCalc's model; later
//! requests reuse that model and only apply the edits that changed, so a
//! debounced keystroke pays evaluate() instead of a full file import. The
//! cache invalidates itself when the file on disk changes (mtime+size) and
//! rebuilds when the edit set shrinks (an undo must restore file content the
//! model no longer has). The caller stays fail-soft: any load or evaluation
//! problem (including panics from IronCalc's strict importer) surfaces as a
//! normal sidecar error and the renderer keeps showing cached values.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ironcalc::base::Model;
use ironcalc::base::types::CellType;
use ironcalc::import::load_from_xlsx;
use serde::{Deserialize, Serialize};

use crate::{CellRange, SidecarError};

pub const MAX_RECALC_EDITS: usize = 10_000;
pub const MAX_SUPPORTED_RECALC_EDITS: usize = 1_000_000;
pub const MAX_RECALC_READ_CELLS: usize = 20_000;
/// Resident models are large (the whole workbook's cell graph); the sidecar
/// serves one document, so two covers the active file plus one recently
/// closed-and-reopened neighbour.
const MAX_RESIDENT_MODELS: usize = 2;
/// Source files above this size (compressed bytes) count as heavy for the
/// residency rule in `evict_beyond_cap`.
const HEAVY_SOURCE_BYTES: u64 = 8_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcEdit {
    pub sheet: String,
    /// 0-based coordinates on the wire (IronCalc itself is 1-based).
    pub row: u32,
    pub column: u32,
    /// User input: `=SUM(A1:A3)`, `42`, `text`; empty clears.
    pub input: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcRead {
    pub sheet: String,
    pub range: CellRange,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcCell {
    pub sheet: String,
    pub row: u32,
    pub column: u32,
    /// Display string after evaluation (number formats applied).
    pub formatted: String,
    /// Unformatted engine value. Text, booleans, numbers and blank retain
    /// their types; spreadsheet errors use {"error":"#DIV/0!"}.
    pub value: serde_json::Value,
    /// Raw numeric value when the cell evaluates to a number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<f64>,
    /// The engine typed the result as an error (`#DIV/0!`), as opposed to a
    /// formula whose text result merely spells one (`="#N/A"`).
    pub is_error: bool,
    pub is_formula: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcResult {
    pub cells: Vec<RecalcCell>,
    /// True when a resident model served this request (no file re-import).
    pub cached: bool,
    /// Whole-model provenance, independent of the requested viewport. A
    /// computed preview is not permission to overwrite imported caches.
    pub cache_writeback_allowed: bool,
    pub calculation_completeness: &'static str,
    pub cache_writeback_reasons: Vec<&'static str>,
}

type EditKey = (String, u32, u32);

struct ResidentModel {
    model: Model<'static>,
    mtime: SystemTime,
    size: u64,
    /// Edits already in the model, keyed by cell; a request whose edit set no
    /// longer covers these keys forces a rebuild (only the file knows the
    /// original content of a reverted cell).
    applied: HashMap<EditKey, String>,
    last_used: u64,
    /// Sticky for the resident source: pinning replaces formula AST nodes
    /// with cached constants, so later viewports cannot rediscover that gap.
    cache_writeback_reasons: BTreeSet<&'static str>,
}

#[derive(Default)]
pub struct RecalcCache {
    entries: HashMap<PathBuf, ResidentModel>,
    tick: u64,
}

impl RecalcCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop the model for a path whose bytes are about to change (save) or
    /// whose session closed.
    pub fn purge(&mut self, path: &Path) {
        self.entries.remove(&cache_key(path));
    }

    fn evict_beyond_cap(&mut self) {
        while self.entries.len() > MAX_RESIDENT_MODELS {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone())
            else {
                return;
            };
            self.entries.remove(&oldest);
        }
        // Heavy sources import into models that dwarf everything else in the
        // process (a 31MB workbook's model holds ~1.2GB resident); keep at
        // most one of those — the most recently used.
        loop {
            let mut heavy: Vec<(PathBuf, u64)> = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.size > HEAVY_SOURCE_BYTES)
                .map(|(path, entry)| (path.clone(), entry.last_used))
                .collect();
            if heavy.len() <= 1 {
                return;
            }
            heavy.sort_by_key(|(_, last_used)| *last_used);
            let Some((oldest, _)) = heavy.first() else {
                return;
            };
            self.entries.remove(&oldest.clone());
        }
    }
}

/// Cache keys are canonicalized: sessions store the canonical workbook path
/// (open() resolves it) while recalc requests carry the renderer's raw path,
/// and on macOS temp files those differ (/var vs /private/var) — a raw key
/// would make the close/save purge miss the resident model.
fn cache_key(path: &Path) -> PathBuf {
    crate::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn recalc_cells(
    cache: &mut RecalcCache,
    path: &Path,
    edits: &[RecalcEdit],
    reads: &[RecalcRead],
) -> Result<RecalcResult, SidecarError> {
    recalc_cells_with_limit(cache, path, edits, reads, MAX_RECALC_EDITS)
}

/// Explicit authority budget; legacy callers retain their 10k edit ceiling.
pub fn recalc_cells_with_limit(
    cache: &mut RecalcCache,
    path: &Path,
    edits: &[RecalcEdit],
    reads: &[RecalcRead],
    max_edits: usize,
) -> Result<RecalcResult, SidecarError> {
    if max_edits > MAX_SUPPORTED_RECALC_EDITS {
        return Err(SidecarError::InvalidRequest(format!("Recalc edit budget exceeds {MAX_SUPPORTED_RECALC_EDITS}.")));
    }
    if edits.len() > max_edits {
        return Err(SidecarError::InvalidRequest(format!(
            "Too many recalc edits (limit {max_edits})."
        )));
    }
    if edits.iter().any(|edit| edit.row >= crate::snapshot::MAX_SHEET_ROWS || edit.column >= crate::snapshot::MAX_SHEET_COLUMNS) {
        return Err(SidecarError::InvalidRequest("Recalc edit coordinates are outside the worksheet.".into()));
    }
    let mut read_cells = 0usize;
    for read in reads {
        let range = &read.range;
        if range.start_row > range.end_row || range.start_column > range.end_column
            || range.end_row >= crate::snapshot::MAX_SHEET_ROWS as usize
            || range.end_column >= crate::snapshot::MAX_SHEET_COLUMNS as usize
        {
            return Err(SidecarError::InvalidRequest("Recalc range is reversed or outside the worksheet.".into()));
        }
        let cells = (range.end_row - range.start_row + 1)
            .checked_mul(range.end_column - range.start_column + 1);
        read_cells = cells.and_then(|cells| read_cells.checked_add(cells))
            .filter(|cells| *cells <= MAX_RECALC_READ_CELLS)
            .ok_or_else(|| SidecarError::InvalidRequest(format!("Recalc read exceeds {MAX_RECALC_READ_CELLS} cells.")))?;
    }

    let metadata = std::fs::metadata(path).map_err(|error| SidecarError::Io(error.to_string()))?;
    let mtime = metadata
        .modified()
        .map_err(|error| SidecarError::Io(error.to_string()))?;
    let size = metadata.len();

    let key = cache_key(path);
    let edit_keys: HashSet<(&str, u32, u32)> = edits.iter()
        .map(|edit| (edit.sheet.as_str(), edit.row, edit.column)).collect();
    // Take the entry out while working on it: a panic or error mid-apply
    // leaves the model in an unknown state, and a removed entry can never be
    // reused by the next request.
    let resident = cache.entries.remove(&key).filter(|entry| {
        entry.mtime == mtime
            && entry.size == size
            && entry.applied.keys().all(|key| edit_keys.contains(&(key.0.as_str(), key.1, key.2)))
    });
    let cached = resident.is_some();

    // IronCalc's importer is strict and can panic on non-Excel producers
    // (missing cellStyles, whitespace nodes); contain that to this request.
    let (entry, cells) = catch_unwind(AssertUnwindSafe(|| {
        run(resident, path, mtime, size, edits, reads)
    }))
    .map_err(|_| {
        SidecarError::Workbook("The formula engine could not process this workbook.".into())
    })??;

    cache.tick += 1;
    let mut entry = entry;
    entry.last_used = cache.tick;
    let cache_writeback_reasons: Vec<_> = entry.cache_writeback_reasons.iter().copied().collect();
    let cache_writeback_allowed = cache_writeback_reasons.is_empty();
    cache.entries.insert(key, entry);
    cache.evict_beyond_cap();

    Ok(RecalcResult { cells, cached, cache_writeback_allowed,
        calculation_completeness: if cache_writeback_allowed { "complete" } else { "unverified" },
        cache_writeback_reasons })
}

/// IronCalc 0.7.1 counts all XML children in several structural lists. Valid
/// indentation/comments otherwise become phantom rows/styles or missing-r
/// errors. Normalize a private import package, never the document/save source.
fn load_calculation_model(path: &Path) -> Result<Model<'static>, SidecarError> {
    use std::fs::File;
    use zip::write::SimpleFileOptions;

    let filename = path.file_name().ok_or_else(|| SidecarError::InvalidRequest("Workbook path has no filename.".into()))?;
    let directory = crate::CacheDirectory::create(crate::temp_dir().join(format!("vantage-calc-import-{}", uuid::Uuid::new_v4())))?;
    let normalized = directory.path().join(filename);
    let mut source = zip::ZipArchive::new(File::open(path)?)?;
    crate::archive::validate_entries(&mut source)?;
    let mut output = zip::ZipWriter::new(File::create(&normalized)?);
    let mut remaining = 8 * 1024 * 1024 * 1024u64;
    for index in 0..source.len() {
        let raw = source.by_index_raw(index)?;
        let name = raw.name().to_owned();
        let compressed = raw.compressed_size();
        let canonical = crate::archive::canonical_entry_name(&name).unwrap_or_default().to_ascii_lowercase();
        let is_xml = !raw.is_dir() && (canonical.ends_with(".rels")
            || canonical == "xl/workbook.xml" || canonical == "xl/styles.xml"
            || canonical == "xl/sharedstrings.xml"
            || (canonical.starts_with("xl/worksheets/") && canonical.ends_with(".xml"))
            || (canonical.starts_with("xl/tables/") && canonical.ends_with(".xml"))
            || (canonical.starts_with("xl/comments") && canonical.ends_with(".xml")));
        drop(raw);
        if !is_xml {
            if compressed > remaining {
                return Err(SidecarError::Workbook("Formula import package exceeds its bounded copy budget.".into()));
            }
            output.raw_copy_file(source.by_index_raw(index)?)?;
            remaining -= compressed;
            continue;
        }
        let entry = source.by_index(index)?;
        let cap = if canonical.starts_with("xl/worksheets/") { crate::archive::MAX_EXTRACTED_ENTRY_BYTES }
            else { crate::xml_util::MAX_METADATA_PART_BYTES };
        let declared = entry.size();
        if declared > cap || declared > remaining {
            return Err(SidecarError::Workbook("Formula import XML exceeds its bounded processing budget.".into()));
        }
        output.start_file(&name, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))?;
        let consumed = normalize_calculation_xml(entry, &mut output, declared.min(cap).min(remaining))?;
        remaining -= consumed;
    }
    drop(output.finish()?);
    let path_text = normalized.to_str().ok_or_else(|| SidecarError::InvalidRequest("Workbook path is not valid UTF-8.".into()))?;
    let model = load_from_xlsx(path_text, "en", "UTC", "en").map_err(|error| {
        SidecarError::Workbook(format!("Formula engine import failed: {error}"))
    })?;
    // The directory guard also removes the private import on error or unwind.
    Ok(model)
}

#[derive(Clone)]
struct ImportXmlFrame {
    name: Vec<u8>,
    structural: bool,
    preserve: bool,
}

fn import_structural_child(parent: &[u8], child: &[u8]) -> bool {
    match parent {
        b"worksheet" => matches!(child, b"sheetPr" | b"sheetViews" | b"cols" | b"sheetData" | b"mergeCells" | b"hyperlinks" | b"tableParts" | b"rowBreaks" | b"colBreaks"),
        b"sheetData" => child == b"row",
        b"row" => child == b"c",
        b"c" => child == b"is",
        b"is" | b"si" | b"text" => child == b"r",
        b"r" => child == b"rPr",
        b"sst" => child == b"si",
        b"sheetViews" => child == b"sheetView",
        b"workbook" => matches!(child, b"sheets" | b"bookViews" | b"definedNames" | b"externalReferences" | b"pivotCaches"),
        b"styleSheet" => matches!(child, b"numFmts" | b"fonts" | b"fills" | b"borders" | b"cellStyleXfs" | b"cellXfs" | b"cellStyles" | b"dxfs" | b"colors" | b"tableStyles"),
        b"fonts" => child == b"font",
        b"fills" => child == b"fill",
        b"fill" => matches!(child, b"patternFill" | b"gradientFill"),
        b"borders" => child == b"border",
        b"cellStyleXfs" | b"cellXfs" => child == b"xf",
        b"dxfs" => child == b"dxf",
        b"comments" => matches!(child, b"authors" | b"commentList"),
        b"commentList" => child == b"comment",
        b"comment" => child == b"text",
        b"table" => matches!(child, b"autoFilter" | b"sortState" | b"tableColumns"),
        b"tableColumns" => child == b"tableColumn",
        b"autoFilter" => child == b"filterColumn",
        b"filterColumn" => matches!(child, b"filters" | b"customFilters"),
        _ => false,
    }
}

/// Strip only non-data children of schema-known structural containers. The
/// writer forwards every retained event verbatim: entities, CDATA, formula/value
/// text, whitespace-only strings and unknown extension subtrees are untouched.
fn normalize_calculation_xml<R: std::io::Read, W: std::io::Write>(
    input: R,
    output: W,
    limit: u64,
) -> Result<u64, SidecarError> {
    use quick_xml::events::Event;
    use quick_xml::name::ResolveResult;
    use std::io::BufReader;

    let mut reader = quick_xml::NsReader::from_reader(BufReader::new(input.take(limit.saturating_add(1))));
    reader.config_mut().trim_text(false);
    let mut writer = quick_xml::Writer::new(output);
    let mut buffer = Vec::new();
    let mut stack: Vec<ImportXmlFrame> = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buffer)?;
        if reader.buffer_position() > limit {
            return Err(SidecarError::Workbook("Formula import XML inflates past its declared or allowed size.".into()));
        }
        let strip_nondata = stack.last().is_none_or(|frame| frame.structural && !frame.preserve);
        match &event {
            Event::Start(element) | Event::Empty(element) => {
                if stack.len() >= 128 { return Err(SidecarError::Workbook("Formula import XML is nested too deeply.".into())); }
                let name = element.local_name().as_ref().to_vec();
                let (namespace, _) = reader.resolve_element(element.name());
                let spreadsheet = matches!(&namespace, ResolveResult::Bound(namespace) if namespace.as_ref() == b"http://schemas.openxmlformats.org/spreadsheetml/2006/main" || namespace.as_ref() == b"http://purl.oclc.org/ooxml/spreadsheetml/main");
                let relationships = matches!(&namespace, ResolveResult::Bound(namespace) if namespace.as_ref() == b"http://schemas.openxmlformats.org/package/2006/relationships");
                let structural = if let Some(parent) = stack.last() {
                    spreadsheet && parent.structural && import_structural_child(&parent.name, &name)
                } else {
                    (spreadsheet && matches!(name.as_slice(), b"worksheet" | b"workbook" | b"styleSheet" | b"sst" | b"comments" | b"table"))
                        || (relationships && name == b"Relationships")
                };
                let mut preserve = stack.last().is_some_and(|frame| frame.preserve);
                for attribute in element.attributes() {
                    let attribute = attribute.map_err(|error| SidecarError::Workbook(error.to_string()))?;
                    if attribute.key.as_ref() == b"xml:space" {
                        match attribute.decode_and_unescape_value(reader.decoder())?.as_ref() {
                            "preserve" => preserve = true,
                            "default" => preserve = false,
                            _ => {},
                        }
                    }
                }
                if matches!(&event, Event::Start(_)) { stack.push(ImportXmlFrame { name, structural, preserve }); }
                writer.write_event(event)?;
            }
            Event::End(_) => { stack.pop(); writer.write_event(event)?; },
            Event::Text(text) if strip_nondata && text.iter().all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n')) => {},
            Event::Comment(_) | Event::PI(_) if strip_nondata => {},
            Event::Eof => {
                if !stack.is_empty() { return Err(SidecarError::Workbook("Formula import XML ends inside an element.".into())); }
                return Ok(reader.buffer_position());
            },
            _ => writer.write_event(event)?,
        }
        buffer.clear();
    }
}

fn run(
    resident: Option<ResidentModel>,
    path: &Path,
    mtime: SystemTime,
    size: u64,
    edits: &[RecalcEdit],
    reads: &[RecalcRead],
) -> Result<(ResidentModel, Vec<RecalcCell>), SidecarError> {
    let mut entry = match resident {
        Some(entry) => entry,
        None => {
            let mut model = load_calculation_model(path)?;
            requote_bare_sheet_names(&mut model);
            let mut cache_writeback_reasons = source_cache_provenance(path);
            inspect_model_provenance(&model, &mut cache_writeback_reasons);
            if pin_unparsable_formulas(&mut model) > 0 {
                cache_writeback_reasons.insert("cached_formula_precedents_pinned");
            }
            ResidentModel {
                model,
                mtime,
                size,
                applied: HashMap::new(),
                last_used: 0,
                cache_writeback_reasons,
            }
        }
    };

    let mut dirty = false;
    for edit in edits {
        let key = (edit.sheet.clone(), edit.row, edit.column);
        if entry.applied.get(&key) == Some(&edit.input) {
            continue;
        }
        let sheet = sheet_index(&entry.model, &edit.sheet)?;
        // IronCalc treats set_user_input("") as an empty text value, not a
        // blank cell. The wire uses empty input to clear and a single leading
        // apostrophe for literal empty text; preserve that distinction and
        // retain the source cell's formatting when clearing its contents.
        let applied = if edit.input.is_empty() {
            entry.model.cell_clear_contents(sheet, edit.row as i32 + 1, edit.column as i32 + 1)
        } else {
            entry.model.set_user_input(sheet, edit.row as i32 + 1, edit.column as i32 + 1, edit.input.clone())
        };
        applied.map_err(|error| {
                SidecarError::Workbook(format!("Formula engine rejected an edit: {error}"))
            })?;
        entry.applied.insert(key, edit.input.clone());
        dirty = true;
    }
    // Inspect every active formula after edits, not just cells requested by
    // this read. IFERROR can hide a failed precedent outside the viewport.
    inspect_model_provenance(&entry.model, &mut entry.cache_writeback_reasons);
    if dirty || entry.last_used == 0 {
        entry.model.evaluate();
    }
    inspect_engine_errors(&entry.model, &mut entry.cache_writeback_reasons);

    let mut cells = Vec::new();
    for read in reads {
        let sheet = sheet_index(&entry.model, &read.sheet)?;
        for row in read.range.start_row..=read.range.end_row {
            for column in read.range.start_column..=read.range.end_column {
                let row_1 = row as i32 + 1;
                let column_1 = column as i32 + 1;
                let formatted = entry
                    .model
                    .get_formatted_cell_value(sheet, row_1, column_1)
                    .unwrap_or_default();
                let formula = entry
                    .model
                    .get_cell_formula(sheet, row_1, column_1)
                    .ok()
                    .flatten();
                let is_formula = formula.is_some();
                if formatted.is_empty() && !is_formula {
                    continue;
                }
                // Known engine gaps where the file's cached value beats the
                // error: CELL("filename") is unimplemented (#175) and RATE's
                // Newton solver dies near -100% where Excel converges (#185).
                if formatted.starts_with('#') {
                    if let Some(text) = &formula {
                        let upper = text.to_uppercase();
                        if upper.contains("CELL(") && upper.contains("\"FILENAME\"") {
                            continue;
                        }
                        if formatted == "#NUM!" && upper.contains("RATE(") {
                            continue;
                        }
                    }
                }
                let is_error = matches!(
                    entry.model.get_cell_type(sheet, row_1, column_1),
                    Ok(CellType::ErrorValue)
                );
                let value = raw_value(&entry.model, sheet, row_1, column_1, is_error)?;
                let number = value.as_f64();
                cells.push(RecalcCell {
                    sheet: read.sheet.clone(),
                    row: row as u32,
                    column: column as u32,
                    formatted,
                    value,
                    number,
                    is_error,
                    is_formula,
                });
            }
        }
    }
    Ok((entry, cells))
}

/// IronCalc writes a sheet name that needs quoting without its quotes when it
/// converts an imported formula to R1C1: `name_needs_quoting`
/// (`expressions/utils`) lists only `()'$,;-+{}` and space, so a name holding
/// an `&` — `R&D`, `P&L` — slips through. The stored `R&D!R[-17]C[0]` never
/// parses again, and every reference to that sheet is lost along with
/// everything that depends on it.
///
/// Put the quotes back and re-parse. The text is the engine's own R1C1 and
/// the sheet is one of this workbook's, so this restores what the file said
/// rather than guessing at it: a formula is rewritten only when it already
/// failed to parse and only when the quoted form parses cleanly.
fn requote_bare_sheet_names(model: &mut Model) {
    use ironcalc::base::expressions::lexer::LexerMode;
    use ironcalc::base::expressions::parser::{Node, new_parser_english};
    use ironcalc::base::expressions::types::CellReferenceRC;

    let names: Vec<String> = model
        .workbook
        .worksheets
        .iter()
        .map(|worksheet| worksheet.name.clone())
        .collect();
    let mut parser = new_parser_english(
        names.clone(),
        model.workbook.get_defined_names_with_scope(),
        model.workbook.tables.clone(),
    );
    parser.set_lexer_mode(LexerMode::R1C1);

    for (sheet, worksheet) in model.workbook.worksheets.iter_mut().enumerate() {
        let Some(parsed) = model.parsed_formulas.get_mut(sheet) else {
            continue;
        };
        // Stored R1C1 is not tied to a cell, so the sheet is the whole
        // context — the same one `Model::parse_formulas` uses.
        let context = CellReferenceRC {
            sheet: worksheet.name.clone(),
            row: 1,
            column: 1,
        };
        for (index, formula) in worksheet.shared_formulas.iter_mut().enumerate() {
            if !matches!(parsed.get(index), Some(Node::ParseErrorKind { .. })) {
                continue;
            }
            let Some(quoted) = quote_bare_sheet_names(formula, &names) else {
                continue;
            };
            let node = parser.parse(&quoted, &context);
            if matches!(node, Node::ParseErrorKind { .. }) {
                continue;
            }
            parsed[index] = node;
            *formula = quoted;
        }
    }
}

/// Wraps every bare `Name!` reference to one of `names` in quotes, doubling
/// any `'` inside the name as Excel does. Returns None when there was nothing
/// to quote. Text literals and already-quoted names are copied through
/// untouched, so a formula that merely spells a sheet name inside a string is
/// left alone.
fn quote_bare_sheet_names(formula: &str, names: &[String]) -> Option<String> {
    let mut out = String::with_capacity(formula.len());
    let mut index = 0;
    let mut in_text = false;
    let mut in_quoted_name = false;
    let mut changed = false;
    while index < formula.len() {
        let Some(char) = formula[index..].chars().next() else {
            break;
        };
        if in_text || in_quoted_name {
            // A doubled quote toggles off and straight back on, which lands
            // in the same state an escape should leave us in.
            if char == '"' && in_text {
                in_text = false;
            } else if char == '\'' && in_quoted_name {
                in_quoted_name = false;
            }
            out.push(char);
            index += char.len_utf8();
            continue;
        }
        if char == '"' || char == '\'' {
            if char == '"' {
                in_text = true;
            } else {
                in_quoted_name = true;
            }
            out.push(char);
            index += char.len_utf8();
            continue;
        }
        // Longest wins: "R&D" must not shadow "R&D Notes".
        let matched = names
            .iter()
            .filter(|name| !name.is_empty() && formula[index..].starts_with(&format!("{name}!")))
            .max_by_key(|name| name.len());
        if let Some(name) = matched
            && !continues_a_sheet_name(&formula[..index])
        {
            out.push('\'');
            out.push_str(&name.replace('\'', "''"));
            out.push_str("'!");
            index += name.len() + 1;
            changed = true;
            continue;
        }
        out.push(char);
        index += char.len_utf8();
    }
    changed.then_some(out)
}

enum PinnedValue {
    Number(f64),
    Text(String),
    Bool(bool),
}

/// IronCalc cannot parse external-workbook references (`[1]Sheet1!A1`):
/// such a formula evaluates to #ERROR! and the error cascades through every
/// dependent. Excel keeps the cached values when the linked workbook is
/// unreachable, so pin those cells to the value the file carries and let the
/// dependents compute against it. The renderer never sees the cell as a
/// formula afterwards, so its own cached copy stays on screen.
///
/// A formula still naming a sheet of *this* workbook after
/// `requote_bare_sheet_names` has had its turn is excluded: the data is in
/// the file, so a parse failure there is an engine gap, not an unreachable
/// source, and the cached value is not an answer — a file written without
/// cached values (openpyxl writes an empty `<v/>`) imports as zero, which
/// would pin a number nobody computed. Those cells keep their #ERROR!,
/// which the renderer already declines to display.
fn pin_unparsable_formulas(model: &mut Model) -> usize {
    use ironcalc::base::expressions::parser::Node;
    use ironcalc::base::types::Cell;
    let names: Vec<String> = model
        .workbook
        .worksheets
        .iter()
        .map(|worksheet| worksheet.name.clone())
        .collect();
    let mut pins = Vec::new();
    for (sheet, worksheet) in model.workbook.worksheets.iter().enumerate() {
        let Some(parsed) = model.parsed_formulas.get(sheet) else {
            continue;
        };
        for (row, columns) in &worksheet.sheet_data {
            for (column, cell) in columns {
                let (formula, value) = match cell {
                    Cell::CellFormulaNumber { f, v, .. } => (*f, PinnedValue::Number(*v)),
                    Cell::CellFormulaString { f, v, .. } => (*f, PinnedValue::Text(v.clone())),
                    Cell::CellFormulaBoolean { f, v, .. } => (*f, PinnedValue::Bool(*v)),
                    _ => continue,
                };
                if !matches!(
                    parsed.get(formula as usize),
                    Some(Node::ParseErrorKind { .. })
                ) {
                    continue;
                }
                let text = worksheet
                    .shared_formulas
                    .get(formula as usize)
                    .map(String::as_str)
                    .unwrap_or_default();
                if references_a_sheet_of_this_workbook(text, &names) {
                    continue;
                }
                pins.push((sheet as u32, *row, *column, value));
            }
        }
    }
    let count = pins.len();
    for (sheet, row, column, value) in pins {
        // A pin that fails leaves the cell as it was: #ERROR! on that cell,
        // which the renderer already declines to display.
        let _ = match value {
            PinnedValue::Number(number) => {
                model.update_cell_with_number(sheet, row, column, number)
            }
            PinnedValue::Text(text) => model.update_cell_with_text(sheet, row, column, &text),
            PinnedValue::Bool(flag) => model.update_cell_with_bool(sheet, row, column, flag),
        };
    }
    count
}

/// True when the formula text carries a bare `Name!` reference to one of the
/// workbook's own sheets. The prefix test rejects the external-workbook forms
/// (`[1]Sheet1!A1`, `'[1]Sheet1'!A1`) and any longer name that merely ends in
/// this one.
fn references_a_sheet_of_this_workbook(formula: &str, names: &[String]) -> bool {
    let code = blank_text_literals(formula);
    names.iter().any(|name| {
        !name.is_empty()
            && code
                .match_indices(&format!("{name}!"))
                .any(|(at, _)| at == 0 || !continues_a_sheet_name(&code[..at]))
    })
}

/// The formula with every `"..."` literal replaced by spaces of the same byte
/// length, so a sheet name mentioned inside text does not count as a reference
/// and byte offsets still line up with the original.
fn blank_text_literals(formula: &str) -> String {
    let mut out = String::with_capacity(formula.len());
    let mut in_text = false;
    for char in formula.chars() {
        if char == '"' {
            in_text = !in_text;
            out.push(char);
        } else if in_text {
            out.extend(std::iter::repeat_n(' ', char.len_utf8()));
        } else {
            out.push(char);
        }
    }
    out
}

fn continues_a_sheet_name(before: &str) -> bool {
    match before.chars().next_back() {
        // ']' closes an external-workbook index, '\'' closes a quoted name
        // (which parses fine and never reaches here), '!' a 3-D range.
        Some(']') | Some('\'') | Some('!') => true,
        Some(char) => char.is_alphanumeric() || char == '_' || char == '.',
        None => false,
    }
}

fn sheet_index(model: &Model, name: &str) -> Result<u32, SidecarError> {
    model
        .workbook
        .worksheets
        .iter()
        .position(|worksheet| worksheet.name == name)
        .map(|index| index as u32)
        .ok_or_else(|| SidecarError::InvalidRequest(format!("Unknown sheet: {name}")))
}

fn raw_value(model: &Model, sheet: u32, row: i32, column: i32, is_error: bool) -> Result<serde_json::Value, SidecarError> {
    use ironcalc::base::cell::CellValue;
    let value = model.get_cell_value_by_index(sheet, row, column)
        .map_err(|error| SidecarError::Workbook(format!("Formula engine could not read a result: {error}")))?;
    if is_error {
        return match value {
            CellValue::String(error) if error.len() <= 32 => Ok(serde_json::json!({"error":error})),
            _ => Err(SidecarError::Workbook("Formula engine returned an invalid spreadsheet error.".into())),
        };
    }
    Ok(match value {
        CellValue::None => serde_json::Value::Null,
        CellValue::String(value) => serde_json::Value::String(value),
        CellValue::Boolean(value) => serde_json::Value::Bool(value),
        CellValue::Number(value) => serde_json::Value::Number(serde_json::Number::from_f64(value)
            .ok_or_else(|| SidecarError::Workbook("Formula engine returned a non-finite number.".into()))?),
    })
}

/// Cache certification deliberately covers a smaller set than IronCalc's
/// registered functions. Registration alone does not prove scalar/array,
/// locale or named-reference compatibility. Uncertified models still return
/// typed previews, with an explicit prohibition on derived-cache writeback.
fn inspect_model_provenance(model: &Model, reasons: &mut BTreeSet<&'static str>) {
    let mut remaining = 1_000_000usize;
    for (sheet, worksheet) in model.workbook.worksheets.iter().enumerate() {
        let mut inspected = HashSet::new();
        for columns in worksheet.sheet_data.values() {
            for cell in columns.values() {
                let Some(index) = cell.get_formula() else { continue; };
                if !inspected.insert(index) { continue; }
                let node = usize::try_from(index).ok().and_then(|index| model.parsed_formulas.get(sheet)?.get(index));
                match node {
                    Some(node) => inspect_formula_node(node, false, 0, &mut remaining, reasons),
                    None => { reasons.insert("unparsed_formula"); },
                }
                if remaining == 0 { reasons.insert("provenance_analysis_budget"); return; }
            }
        }
    }
}

fn inspect_formula_node(
    node: &ironcalc::base::expressions::parser::Node,
    range_argument: bool,
    depth: usize,
    remaining: &mut usize,
    reasons: &mut BTreeSet<&'static str>,
) {
    use ironcalc::base::expressions::parser::Node;
    use ironcalc::base::expressions::token::Error;
    if *remaining == 0 || depth > 128 { reasons.insert("provenance_analysis_budget"); *remaining = 0; return; }
    *remaining -= 1;
    let scalar_children = |left: &Node, right: &Node, remaining: &mut usize, reasons: &mut BTreeSet<&'static str>| {
        inspect_formula_node(left, false, depth + 1, remaining, reasons);
        inspect_formula_node(right, false, depth + 1, remaining, reasons);
    };
    match node {
        Node::NumberKind(value) => { if !value.is_finite() { reasons.insert("nonfinite_formula_literal"); } },
        Node::BooleanKind(_) | Node::StringKind(_) | Node::ReferenceKind { .. } | Node::EmptyArgKind => {},
        Node::ErrorKind(error) => {
            if matches!(error, Error::ERROR | Error::NIMPL | Error::CIRC | Error::NAME) { reasons.insert("unverified_error_literal"); }
        },
        Node::RangeKind { .. } => { if !range_argument { reasons.insert("uncertified_range_context"); } },
        Node::OpSumKind { left, right, .. } | Node::OpProductKind { left, right, .. }
        | Node::OpPowerKind { left, right } | Node::OpConcatenateKind { left, right }
        | Node::CompareKind { left, right, .. } => scalar_children(left, right, remaining, reasons),
        Node::UnaryKind { right, .. } => inspect_formula_node(right, false, depth + 1, remaining, reasons),
        Node::FunctionKind { kind, args } => {
            let name = kind.to_xlsx_string().trim_start_matches("_xlfn.").to_uppercase();
            let ranges = name == "SUM";
            match name.as_str() {
                "SUM" | "IF" | "IFERROR" | "IFNA" | "AND" | "OR" | "NOT" | "XOR"
                | "TRUE" | "FALSE" | "ISBLANK" | "ISNUMBER" | "ISTEXT" | "ISLOGICAL"
                | "ISERROR" | "ISERR" | "ISNA" => {},
                "CELL" | "INFO" | "RATE" => { reasons.insert("known_engine_gap"); },
                "DOLLAR" | "NUMBERSTRING" => { reasons.insert("locale_dependent_function"); },
                "INDIRECT" | "OFFSET" => { reasons.insert("dynamic_reference"); },
                _ => { reasons.insert("uncertified_function"); },
            }
            for argument in args { inspect_formula_node(argument, ranges, depth + 1, remaining, reasons); }
        },
        Node::InvalidFunctionKind { args, .. } => {
            reasons.insert("unsupported_function");
            for argument in args { inspect_formula_node(argument, false, depth + 1, remaining, reasons); }
        },
        Node::ParseErrorKind { .. } => { reasons.insert("formula_parse_failure"); },
        Node::DefinedNameKind(_) | Node::WrongVariableKind(_) => { reasons.insert("unresolved_name"); },
        Node::TableNameKind(_) => { reasons.insert("uncertified_table_reference"); },
        Node::ArrayKind(_) | Node::ImplicitIntersection { .. } => { reasons.insert("array_or_intersection_context"); },
        Node::WrongReferenceKind { .. } | Node::WrongRangeKind { .. } => { reasons.insert("unresolved_reference"); },
        Node::OpRangeKind { .. } => { reasons.insert("uncertified_range_expression"); },
    }
}

fn inspect_engine_errors(model: &Model, reasons: &mut BTreeSet<&'static str>) {
    use ironcalc::base::expressions::token::Error;
    use ironcalc::base::types::Cell;
    for worksheet in &model.workbook.worksheets {
        for columns in worksheet.sheet_data.values() {
            for cell in columns.values() {
                if let Cell::CellFormulaError { ei, .. } = cell
                    && matches!(ei, Error::ERROR | Error::NIMPL | Error::CIRC | Error::NAME)
                {
                    reasons.insert("internal_or_unresolved_engine_error");
                }
            }
        }
    }
}

fn source_cache_provenance(path: &Path) -> BTreeSet<&'static str> {
    inspect_source_formula_metadata(path).unwrap_or_else(|_| BTreeSet::from(["source_metadata_unverified"]))
}

/// IronCalc's imported Worksheet does not retain CSE/dynamic-array flags.
/// Inspect the original XML before those distinctions disappear. Only a
/// bounded amount is read; an incomplete audit withholds cache permission.
fn inspect_source_formula_metadata(path: &Path) -> Result<BTreeSet<&'static str>, SidecarError> {
    use std::fs::File;
    use std::io::{BufReader, Read};
    use quick_xml::events::Event;
    use zip::ZipArchive;
    const MAX_XML_AUDIT_BYTES: u64 = 64 * 1024 * 1024;
    let mut archive = ZipArchive::new(File::open(path)?)?;
    crate::archive::validate_entries(&mut archive)?;
    let mut remaining = MAX_XML_AUDIT_BYTES;
    let mut reasons = BTreeSet::new();
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let name = archive.name_for_index(index).and_then(crate::archive::canonical_entry_name)
            .ok_or_else(|| SidecarError::Workbook("Invalid formula provenance package path.".into()))?;
        if !seen.insert(name.clone()) { reasons.insert("ambiguous_package_entries"); }
        if !name.to_lowercase().ends_with(".xml") { continue; }
        let entry = archive.by_index(index)?;
        if entry.size() > remaining { reasons.insert("source_metadata_budget"); return Ok(reasons); }
        let mut reader = quick_xml::Reader::from_reader(BufReader::new(entry.take(remaining + 1)));
        let mut buffer = Vec::new();
        loop {
            let event = reader.read_event_into(&mut buffer)
                .map_err(|error| SidecarError::Workbook(error.to_string()))?;
            if reader.buffer_position() > remaining { reasons.insert("source_metadata_budget"); return Ok(reasons); }
            match event {
                Event::Start(element) | Event::Empty(element) => {
                    let local_name = element.local_name();
                    let local = local_name.as_ref();
                    if local == b"dynamicArrayProperties" { reasons.insert("array_formula_metadata"); }
                    if local == b"f" || local == b"c" {
                        for attribute in element.attributes() {
                            let attribute = attribute.map_err(|error| SidecarError::Workbook(error.to_string()))?;
                            let key = attribute.key.as_ref().rsplit(|byte| *byte == b':').next().unwrap_or_default();
                            let value = attribute.decode_and_unescape_value(reader.decoder())
                                .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                            if local == b"f" && key == b"t" && value != "normal" && value != "shared" {
                                reasons.insert("array_or_special_formula_metadata");
                            }
                            if local == b"c" && (key == b"cm" || key == b"vm") && value != "0" {
                                reasons.insert("cell_value_metadata");
                            }
                        }
                    }
                },
                Event::DocType(_) => { reasons.insert("source_metadata_unverified"); },
                Event::Eof => { remaining -= reader.buffer_position(); break; },
                _ => {},
            }
            buffer.clear();
        }
    }
    Ok(reasons)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironcalc::export::save_to_xlsx;

    fn fixture(path: &Path) {
        write_fixture(path, &[("A1", "10"), ("A2", "20"), ("A3", "=SUM(A1:A2)")]);
    }

    fn write_fixture(path: &Path, cells: &[(&str, &str)]) {
        let mut model = Model::new_empty("fixture", "en", "UTC", "en").unwrap();
        for (address, input) in cells {
            let column = (address.as_bytes()[0] - b'A' + 1) as i32;
            let row: i32 = address[1..].parse().unwrap();
            model
                .set_user_input(0, row, column, (*input).to_string())
                .unwrap();
        }
        model.evaluate();
        if path.exists() {
            std::fs::remove_file(path).unwrap();
        }
        save_to_xlsx(&model, path.to_str().unwrap()).unwrap();
    }

    fn replace_fixture_a1_xml(path: &Path, replacement: &str) {
        use std::io::{Read, Write};
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        let mut entries = Vec::new();
        let mut replaced = false;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if entry.is_dir() { continue; }
            let name = entry.name().to_owned();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                let mut xml = String::from_utf8(data).unwrap();
                let start = xml.find("<c r=\"A1\"").unwrap();
                let end = start + xml[start..].find("</c>").unwrap() + "</c>".len();
                xml.replace_range(start..end, replacement);
                data = xml.into_bytes();
                replaced = true;
            }
            entries.push((name, data));
        }
        drop(archive);
        assert!(replaced);
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries { writer.start_file(name, options).unwrap(); writer.write_all(&data).unwrap(); }
        writer.finish().unwrap();
    }

    fn edit(address: &str, input: &str) -> RecalcEdit {
        RecalcEdit {
            sheet: "Sheet1".into(),
            row: address[1..].parse::<u32>().unwrap() - 1,
            column: (address.as_bytes()[0] - b'A') as u32,
            input: input.into(),
        }
    }

    fn read_a1_a3() -> RecalcRead {
        RecalcRead {
            sheet: "Sheet1".into(),
            range: CellRange {
                start_row: 0,
                end_row: 2,
                start_column: 0,
                end_column: 0,
            },
        }
    }

    fn sum_value(result: &RecalcResult) -> String {
        result
            .cells
            .iter()
            .find(|cell| cell.row == 2)
            .unwrap()
            .formatted
            .clone()
    }

    #[test]
    fn keeps_at_most_one_heavy_model_resident() {
        let mut cache = RecalcCache::new();
        for (name, size) in [
            ("heavy-old", HEAVY_SOURCE_BYTES + 1),
            ("heavy-new", HEAVY_SOURCE_BYTES + 2),
            ("light", 1),
        ] {
            cache.tick += 1;
            cache.entries.insert(
                PathBuf::from(name),
                ResidentModel {
                    model: Model::new_empty("fixture", "en", "UTC", "en").unwrap(),
                    mtime: SystemTime::now(),
                    size,
                    applied: HashMap::new(),
                    last_used: cache.tick,
                    cache_writeback_reasons: BTreeSet::new(),
                },
            );
            cache.evict_beyond_cap();
        }
        assert!(!cache.entries.contains_key(Path::new("heavy-old")));
        assert!(cache.entries.contains_key(Path::new("heavy-new")));
        assert!(cache.entries.contains_key(Path::new("light")));
    }

    #[test]
    fn recalculates_after_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        let result =
            recalc_cells(&mut cache, &path, &[edit("A1", "100")], &[read_a1_a3()]).unwrap();
        let sum = result.cells.iter().find(|cell| cell.row == 2).unwrap();
        assert_eq!(sum.formatted, "120");
        assert_eq!(sum.number, Some(120.0));
        assert!(sum.is_formula);
        assert!(!result.cached);
    }

    #[test]
    fn imports_pretty_ooxml_without_losing_inline_shared_or_whitespace_only_text() {
        use std::io::{Read, Write};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pretty-calculation.xlsx");
        write_fixture(&path, &[("A1", "10"), ("B1", "=A1*2"), ("G1", "'shared \n text")]);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "xl/worksheets/sheet1.xml" {
                bytes = br#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:G1"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>
    <!-- A legal non-row child that the importer must ignore. -->
    <row r="1">
      <c r="A1"><v>10</v></c>
      <!-- A legal non-cell child. -->
      <c r="B1"><f>A1*2</f><v>20</v></c>
      <c r="C1" t="inlineStr"><is><t xml:space="preserve"> &#9;
 </t></is></c>
      <c r="D1" t="inlineStr"><is><t xml:space="preserve"> premi&#232;re
&#31532;&#20108;&#34892;&#9;&amp; </t></is></c>
      <c r="E1" t="inlineStr"><is><t>12</t></is></c>
      <c r="F1" t="b"><f>ISTEXT(E1)</f><v>1</v></c>
      <c r="G1" t="s"><v>0</v></c>
    </row>
  </sheetData>
</worksheet>"#.to_vec();
            } else if name.ends_with(".xml") || name.ends_with(".rels") {
                // The generated fixture has no empty literal-text elements.
                // Indent all structural parts, including every style list.
                bytes = String::from_utf8(bytes).unwrap().replace("><", ">\n  <").into_bytes();
            }
            entries.push((name, bytes));
        }
        drop(archive);
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (name, bytes) in entries {
            writer.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.start_file("customXml/opaque.bin", zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(&[0, 255, 10, 13, 128]).unwrap();
        writer.finish().unwrap();
        let original = std::fs::read(&path).unwrap();
        let reads = [RecalcRead { sheet: "Sheet1".into(), range: CellRange {
            start_row: 0, end_row: 0, start_column: 0, end_column: 6,
        }}];
        let mut cache = RecalcCache::new();
        let result = recalc_cells(&mut cache, &path, &[edit("A1", "21")], &reads).unwrap();
        let at = |column| &result.cells.iter().find(|cell| cell.column == column).unwrap().value;
        assert_eq!(at(1), &serde_json::json!(42.0));
        assert_eq!(at(2), &serde_json::json!(" \t\n "));
        assert_eq!(at(3), &serde_json::json!(" première\n第二行\t& "));
        assert_eq!(at(4), &serde_json::json!("12"));
        assert_eq!(at(5), &serde_json::json!(true));
        assert_eq!(at(6), &serde_json::json!("shared \n text"));
        assert!(result.cache_writeback_allowed, "{:?}", result.cache_writeback_reasons);
        let cached = recalc_cells(&mut cache, &path, &[edit("A1", "22")], &reads).unwrap();
        assert!(cached.cached);
        assert_eq!(cached.cells.iter().find(|cell| cell.column == 1).unwrap().value, serde_json::json!(44.0));
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }

    #[test]
    fn import_xml_normalization_preserves_literal_unknown_cdata_and_xml_space_scopes() {
        let xml = br#"<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x="urn:unknown">
 <sheetData>
  <!-- ignorable --><?ignore value?>
  <row r="1">
   <c r="A1"><is><t xml:space="preserve"> &#32;
 </t></is><f> "  " &amp; "x" </f><v> 12 </v></c>
   <c r="B1"><is><t><![CDATA[ 
 <literal>&amp; ]]></t></is></c>
  </row>
 </sheetData>
 <sheetData xml:space="preserve">
  <!-- preserve this scope -->
  <row r="2"> 
  </row>
 </sheetData>
 <x:sheetData>
  <!-- retain unknown namespace -->
  <x:row> 
  </x:row>
 </x:sheetData>
 <extension><row> 
 </row></extension>
</worksheet>"#;
        let mut output = Vec::new();
        normalize_calculation_xml(&xml[..], &mut output, xml.len() as u64).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(!text.contains("<!-- ignorable -->"));
        assert!(!text.contains("<?ignore value?>"));
        assert!(text.contains("<sheetData><row r=\"1\"><c"));
        for literal in [
            "<t xml:space=\"preserve\"> &#32;\n </t>",
            "<f> \"  \" &amp; \"x\" </f><v> 12 </v>",
            "<![CDATA[ \n <literal>&amp; ]]>",
            "<sheetData xml:space=\"preserve\">\n  <!-- preserve this scope -->\n  <row r=\"2\"> \n  </row>\n </sheetData>",
            "<x:sheetData>\n  <!-- retain unknown namespace -->\n  <x:row> \n  </x:row>\n </x:sheetData>",
            "<extension><row> \n </row></extension>",
        ] { assert!(text.contains(literal), "Missing literal {literal:?} in {text}"); }
        assert!(normalize_calculation_xml(&xml[..], Vec::new(), 20).is_err());
    }

    #[test]
    fn cache_provenance_certifies_basic_scalar_and_static_sum_formulas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("certified.xlsx");
        fixture(&path);
        let result = recalc_cells(&mut RecalcCache::new(), &path, &[edit("A1", "21")], &[read_a1_a3()]).unwrap();
        assert_eq!(sum_value(&result), "41");
        assert!(result.cache_writeback_allowed);
        assert_eq!(result.calculation_completeness, "complete");
        assert!(result.cache_writeback_reasons.is_empty());
        let serialized = serde_json::to_value(&result).unwrap();
        assert_eq!(serialized["cacheWritebackAllowed"], true);
        assert_eq!(serialized["calculationCompleteness"], "complete");
    }

    #[test]
    fn unsupported_precedent_outside_viewport_blocks_hidden_iferror_fallback_writeback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unsupported-precedent.xlsx");
        write_fixture(&path, &[("A1", "=UNSUPPORTED_NATIVE_FUNCTION(1)"), ("B1", "=IFERROR(A1,0)")]);
        let reads = [RecalcRead { sheet: "Sheet1".into(), range: CellRange {
            start_row: 0, end_row: 0, start_column: 1, end_column: 1,
        } }];
        let result = recalc_cells(&mut RecalcCache::new(), &path, &[], &reads).unwrap();
        assert_eq!(result.cells.len(), 1);
        assert_eq!(result.cells[0].value.as_f64(), Some(0.0));
        assert!(!result.cells[0].is_error);
        assert!(result.cells[0].is_formula);
        assert!(!result.cache_writeback_allowed);
        assert_eq!(result.calculation_completeness, "unverified");
        assert!(result.cache_writeback_reasons.contains(&"unsupported_function"));
    }

    #[test]
    fn unsupported_edits_taint_the_resident_source_before_evaluation_and_remain_sticky() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edited-precedent.xlsx");
        write_fixture(&path, &[("A1", "10"), ("B1", "=IFERROR(A1,0)")]);
        let reads = [RecalcRead { sheet: "Sheet1".into(), range: CellRange {
            start_row: 0, end_row: 0, start_column: 1, end_column: 1,
        } }];
        let mut cache = RecalcCache::new();
        assert!(recalc_cells(&mut cache, &path, &[], &reads).unwrap().cache_writeback_allowed);
        let unsafe_result = recalc_cells(&mut cache, &path, &[edit("A1", "=UNSUPPORTED_NATIVE_FUNCTION(1)")], &reads).unwrap();
        assert!(unsafe_result.cached);
        assert_eq!(unsafe_result.cells[0].value.as_f64(), Some(0.0));
        assert!(!unsafe_result.cache_writeback_allowed);
        let later = recalc_cells(&mut cache, &path, &[edit("A1", "21")], &reads).unwrap();
        assert!(later.cached);
        assert_eq!(later.cells[0].value.as_f64(), Some(21.0));
        assert!(!later.cache_writeback_allowed);
        assert!(later.cache_writeback_reasons.contains(&"unsupported_function"));
        // A fresh model can independently certify the now-safe overlay.
        assert!(recalc_cells(&mut RecalcCache::new(), &path, &[edit("A1", "21")], &reads).unwrap().cache_writeback_allowed);
    }

    #[test]
    fn cached_external_formula_pins_keep_provenance_when_the_formula_disappears_from_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pinned-precedent.xlsx");
        write_fixture(&path, &[("A1", "7"), ("B1", "=IFERROR(A1,0)")]);
        replace_fixture_a1_xml(&path, "<c r=\"A1\"><f>[1]Remote!A1</f><v>7</v></c>");
        let reads = [RecalcRead { sheet: "Sheet1".into(), range: CellRange {
            start_row: 0, end_row: 0, start_column: 1, end_column: 1,
        } }];
        let mut cache = RecalcCache::new();
        let result = recalc_cells(&mut cache, &path, &[], &reads).unwrap();
        assert_eq!(result.cells[0].value.as_f64(), Some(7.0));
        assert!(!result.cache_writeback_allowed);
        assert!(result.cache_writeback_reasons.contains(&"cached_formula_precedents_pinned"));
        let later = recalc_cells(&mut cache, &path, &[], &reads).unwrap();
        assert!(later.cached);
        assert!(!later.cache_writeback_allowed);
        assert!(later.cache_writeback_reasons.contains(&"cached_formula_precedents_pinned"));
    }

    #[test]
    fn original_dynamic_array_metadata_blocks_writeback_even_for_a_scalar_looking_ast() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("array-metadata.xlsx");
        write_fixture(&path, &[("A1", "21")]);
        replace_fixture_a1_xml(&path, "<c r=\"A1\" cm=\"1\"><f t=\"array\" ref=\"A1:A1\">21</f><v>21</v></c>");
        let result = recalc_cells(&mut RecalcCache::new(), &path, &[], &[RecalcRead {
            sheet: "Sheet1".into(), range: CellRange { start_row: 0, end_row: 0, start_column: 0, end_column: 0 },
        }]).unwrap();
        assert_eq!(result.cells[0].value.as_f64(), Some(21.0));
        assert!(!result.cache_writeback_allowed);
        assert!(result.cache_writeback_reasons.contains(&"array_or_special_formula_metadata"));
        assert!(result.cache_writeback_reasons.contains(&"cell_value_metadata"));
    }

    #[test]
    fn recognized_functions_and_clean_results_are_not_automatically_cache_certification() {
        let dir = tempfile::tempdir().unwrap();
        for (name, formula, reason) in [
            ("round", "=ROUND(1.234,2)", "uncertified_function"),
            ("cell", "=IFERROR(CELL(\"filename\"),0)", "known_engine_gap"),
        ] {
            let path = dir.path().join(format!("{name}.xlsx"));
            write_fixture(&path, &[("A1", formula)]);
            let result = recalc_cells(&mut RecalcCache::new(), &path, &[], &[RecalcRead {
                sheet: "Sheet1".into(), range: CellRange { start_row: 0, end_row: 0, start_column: 0, end_column: 0 },
            }]).unwrap();
            assert!(!result.cache_writeback_allowed);
            assert!(result.cache_writeback_reasons.contains(&reason));
        }
    }

    #[test]
    fn types_error_results_but_not_error_looking_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        let result = recalc_cells(
            &mut cache,
            &path,
            &[edit("A1", "=1/0"), edit("A2", "=\"#N/A\"")],
            &[read_a1_a3()],
        )
        .unwrap();
        let at = |row: u32| result.cells.iter().find(|cell| cell.row == row).unwrap();
        assert_eq!(at(0).formatted, "#DIV/0!");
        assert!(at(0).is_error);
        assert_eq!(at(1).formatted, "#N/A");
        assert!(!at(1).is_error);
    }

    #[test]
    fn exposes_unformatted_values_without_coercing_boolean_numeric_or_error_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("typed-results.xlsx");
        write_fixture(&path, &[
            ("B1", "25%"), ("A1", "=12"), ("A2", "=\"12\""), ("A3", "=TRUE"),
            ("A4", "=\"TRUE\""), ("A5", "=\"\""), ("A6", "=1/0"),
            ("A7", "=\"#DIV/0!\""), ("A8", "=B1"),
        ]);
        let reads = [RecalcRead { sheet: "Sheet1".into(), range: CellRange {
            start_row: 0, end_row: 7, start_column: 0, end_column: 0,
        } }];
        let result = recalc_cells(&mut RecalcCache::new(), &path, &[], &reads).unwrap();
        let values: Vec<_> = result.cells.iter().map(|cell| cell.value.clone()).collect();
        assert_eq!(values, vec![
            serde_json::json!(12.0), serde_json::json!("12"), serde_json::json!(true),
            serde_json::json!("TRUE"), serde_json::json!(""), serde_json::json!({"error":"#DIV/0!"}),
            serde_json::json!("#DIV/0!"), serde_json::json!(0.25),
        ]);
        assert!(result.cells.iter().all(|cell| cell.is_formula));
        assert!(result.cells[5].is_error);
        assert!(!result.cells[6].is_error);
        assert_eq!(result.cells[7].formatted, "25%");
        assert_eq!(result.cells[7].number, Some(0.25));
        let encoded = serde_json::to_value(&result).unwrap();
        assert_eq!(encoded["cells"][2]["value"], serde_json::json!(true));
        assert_eq!(encoded["cells"][3]["value"], serde_json::json!("TRUE"));
        let mut model = Model::new_empty("blank", "en", "UTC", "en").unwrap();
        assert_eq!(raw_value(&model, 0, 1, 1, false).unwrap(), serde_json::Value::Null);
        model.set_user_input(0, 1, 1, "'".into()).unwrap();
        assert_eq!(raw_value(&model, 0, 1, 1, false).unwrap(), serde_json::json!(""));
    }

    #[test]
    fn clear_and_empty_text_remain_distinct_in_a_resident_model_and_keep_style() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clear.xlsx");
        write_fixture(&path, &[("A1", "$100"), ("A2", "=ISBLANK(A1)"), ("A3", "=ISTEXT(A1)")]);
        let mut cache = RecalcCache::new();
        let cleared = recalc_cells(&mut cache, &path, &[edit("A1", "")], &[read_a1_a3()]).unwrap();
        assert_eq!(cleared.cells.iter().find(|cell| cell.row == 1).unwrap().formatted, "TRUE");
        assert_eq!(sum_value(&cleared), "FALSE");
        let model = &cache.entries.get(&cache_key(&path)).unwrap().model;
        let original_style = model.get_cell_style_index(0, 1, 1).unwrap();
        assert!(model.is_empty_cell(0, 1, 1).unwrap());
        assert_eq!(model.get_cell_formula(0, 1, 1).unwrap(), None);

        let empty_text = recalc_cells(&mut cache, &path, &[edit("A1", "'")], &[read_a1_a3()]).unwrap();
        assert!(empty_text.cached);
        assert_eq!(empty_text.cells.iter().find(|cell| cell.row == 1).unwrap().formatted, "FALSE");
        assert_eq!(sum_value(&empty_text), "TRUE");
        assert_eq!(cache.entries.get(&cache_key(&path)).unwrap().model.get_cell_formula(0, 1, 1).unwrap(), None);

        let cleared_again = recalc_cells(&mut cache, &path, &[edit("A1", "")], &[read_a1_a3()]).unwrap();
        assert!(cleared_again.cached);
        assert_eq!(cleared_again.cells.iter().find(|cell| cell.row == 1).unwrap().formatted, "TRUE");
        assert_eq!(sum_value(&cleared_again), "FALSE");
        let model = &cache.entries.get(&cache_key(&path)).unwrap().model;
        assert!(model.is_empty_cell(0, 1, 1).unwrap());
        assert_eq!(model.get_cell_style_index(0, 1, 1).unwrap(), original_style);
        // Restore a number after the clear: the currency format must remain.
        let restored = recalc_cells(&mut cache, &path, &[edit("A1", "25")], &[read_a1_a3()]).unwrap();
        assert_eq!(restored.cells.iter().find(|cell| cell.row == 0).unwrap().formatted, "$25");
    }

    #[test]
    fn reuses_the_resident_model_and_applies_edits_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        let first = recalc_cells(&mut cache, &path, &[edit("A1", "100")], &[read_a1_a3()]).unwrap();
        assert!(!first.cached);
        assert_eq!(sum_value(&first), "120");
        // same edit again: reused model, nothing re-applied
        let second =
            recalc_cells(&mut cache, &path, &[edit("A1", "100")], &[read_a1_a3()]).unwrap();
        assert!(second.cached);
        assert_eq!(sum_value(&second), "120");
        // changed edit: reused model, incremental set_user_input
        let third = recalc_cells(&mut cache, &path, &[edit("A1", "200")], &[read_a1_a3()]).unwrap();
        assert!(third.cached);
        assert_eq!(sum_value(&third), "220");
    }

    #[test]
    fn rebuilds_when_an_edit_is_reverted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        let first = recalc_cells(&mut cache, &path, &[edit("A1", "100")], &[read_a1_a3()]).unwrap();
        assert_eq!(sum_value(&first), "120");
        // undo removed the A1 edit: only the file knows A1's original value
        let second = recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        assert!(!second.cached);
        assert_eq!(sum_value(&second), "30");
    }

    #[test]
    fn rebuilds_when_the_file_changes_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        let first = recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        assert!(!first.cached);
        assert_eq!(sum_value(&first), "30");
        write_fixture(
            &path,
            &[("A1", "11"), ("A2", "20"), ("A3", "=SUM(A1:A2)+1000")],
        );
        let second = recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        assert!(!second.cached);
        assert_eq!(sum_value(&second), "1031");
    }

    #[test]
    fn purge_drops_the_resident_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        cache.purge(&path);
        let result = recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        assert!(!result.cached);
    }

    #[test]
    fn an_errored_request_does_not_poison_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        let error = recalc_cells(
            &mut cache,
            &path,
            &[],
            &[RecalcRead {
                sheet: "Nope".into(),
                range: CellRange {
                    start_row: 0,
                    end_row: 0,
                    start_column: 0,
                    end_column: 0,
                },
            }],
        )
        .unwrap_err();
        assert!(matches!(error, SidecarError::InvalidRequest(_)));
        // the entry was taken out and not re-inserted; next call reloads cleanly
        let after = recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        assert!(!after.cached);
        assert_eq!(sum_value(&after), "30");
    }

    #[test]
    fn caps_resident_models() {
        let dir = tempfile::tempdir().unwrap();
        let mut cache = RecalcCache::new();
        let mut paths = Vec::new();
        for index in 0..3 {
            let path = dir.path().join(format!("recalc-{index}.xlsx"));
            fixture(&path);
            recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
            paths.push(path);
        }
        assert_eq!(cache.entries.len(), MAX_RESIDENT_MODELS);
        // the oldest was evicted, the newest survives (entries key by
        // canonical path)
        assert!(!cache.entries.contains_key(&cache_key(&paths[0])));
        assert!(cache.entries.contains_key(&cache_key(&paths[2])));
    }

    #[test]
    fn purge_hits_regardless_of_path_spelling() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let mut cache = RecalcCache::new();
        recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        assert_eq!(cache.entries.len(), 1);
        // The raw and canonical spellings differ on macOS temp dirs
        // (/var vs /private/var); the close/save purge may hold either.
        cache.purge(&path);
        assert!(cache.entries.is_empty());
        recalc_cells(&mut cache, &path, &[], &[read_a1_a3()]).unwrap();
        cache.purge(&cache_key(&path));
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn rejects_unknown_sheets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recalc.xlsx");
        fixture(&path);
        let error = recalc_cells(
            &mut RecalcCache::new(),
            &path,
            &[],
            &[RecalcRead {
                sheet: "Nope".into(),
                range: CellRange {
                    start_row: 0,
                    end_row: 0,
                    start_column: 0,
                    end_column: 0,
                },
            }],
        )
        .unwrap_err();
        assert!(matches!(error, SidecarError::InvalidRequest(_)));
    }

    #[test]
    fn caps_read_volume() {
        let error = recalc_cells(
            &mut RecalcCache::new(),
            Path::new("/nonexistent.xlsx"),
            &[],
            &[RecalcRead {
                sheet: "Sheet1".into(),
                range: CellRange {
                    start_row: 0,
                    end_row: 999,
                    start_column: 0,
                    end_column: 999,
                },
            }],
        )
        .unwrap_err();
        assert!(matches!(error, SidecarError::InvalidRequest(_)));
    }

    /// Two sheets, one named `R&D`, and a Summary formula written the way
    /// every other producer writes it: quoted name, no cached value.
    fn write_ampersand_sheet_fixture(path: &Path, formula: &str) {
        use std::io::Write;
        let sheet1 = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A1"/><sheetData><row r="1"><c r="A1"><f>{formula}</f><v /></c></row></sheetData></worksheet>"#
        );
        let entries: [(&str, &str); 7] = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="R&amp;D" sheetId="2" r:id="rId2"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#,
            ),
            (
                "xl/styles.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#,
            ),
            ("xl/worksheets/sheet1.xml", &sheet1),
            (
                "xl/worksheets/sheet2.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A2"/><sheetData><row r="1"><c r="A1"><v>59.5</v></c></row><row r="2"><c r="A2"><v>10</v></c></row></sheetData></worksheet>"#,
            ),
        ];
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    fn read_summary_a1(path: &Path) -> RecalcCell {
        let mut cache = RecalcCache::new();
        let result = recalc_cells(
            &mut cache,
            path,
            &[],
            &[RecalcRead {
                sheet: "Summary".into(),
                range: CellRange {
                    start_row: 0,
                    end_row: 0,
                    start_column: 0,
                    end_column: 0,
                },
            }],
        )
        .unwrap();
        result.cells.into_iter().next().unwrap()
    }

    /// IronCalc 0.7.1 drops the quotes around a sheet name containing `&`
    /// when it converts an imported formula to R1C1 (`name_needs_quoting` in
    /// `expressions/utils` omits `&`), so the file's `'R&D'!A1` is stored as
    /// the unparsable `R&D!A1`. The sidecar puts the quotes back, and the
    /// value matches what Excel and the app's grid show.
    #[test]
    fn ampersand_sheet_references_resolve_across_sheets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ampersand.xlsx");
        write_ampersand_sheet_fixture(&path, "'R&amp;D'!A1");
        let cell = read_summary_a1(&path);
        assert_eq!(cell.formatted, "59.5");
        assert_eq!(cell.number, Some(59.5));
        assert!(!cell.is_error);
    }

    /// One formula, several references to the same broken name: the repair
    /// walks the whole text, not just the first match.
    #[test]
    fn every_reference_in_one_formula_is_requoted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ampersand-twice.xlsx");
        write_ampersand_sheet_fixture(&path, "'R&amp;D'!A1+'R&amp;D'!A2");
        let cell = read_summary_a1(&path);
        assert_eq!(cell.number, Some(69.5));
        assert!(!cell.is_error);
    }

    /// A formula naming a sheet of this workbook that still will not parse
    /// after the repair keeps its #ERROR!. The pin exists for
    /// external-workbook references whose source is unreachable; here the
    /// data is in the file, and a producer that writes no cached value
    /// (openpyxl writes a bare `<v />`) imports as zero — pinning that would
    /// report a number nobody computed.
    #[test]
    fn an_irreparable_local_reference_is_not_pinned_to_an_invented_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("malformed.xlsx");
        write_ampersand_sheet_fixture(&path, "R&amp;D!A1++");
        let cell = read_summary_a1(&path);
        assert_eq!(cell.formatted, "#ERROR!");
        assert!(cell.is_error);
        assert_eq!(cell.number, None);
    }

    #[test]
    fn quoting_covers_every_bare_reference_and_leaves_the_rest_alone() {
        let names = vec![
            "Sheet1".to_string(),
            "R&D".to_string(),
            "R&D Notes".to_string(),
        ];
        assert_eq!(
            quote_bare_sheet_names("R&D!R[-17]C[0]", &names).unwrap(),
            "'R&D'!R[-17]C[0]"
        );
        assert_eq!(
            quote_bare_sheet_names("R&D!R[1]C[1]+R&D!R[2]C[1]", &names).unwrap(),
            "'R&D'!R[1]C[1]+'R&D'!R[2]C[1]"
        );
        // longest name wins, so the shorter one does not truncate it
        assert_eq!(
            quote_bare_sheet_names("R&D Notes!R[1]C[1]", &names).unwrap(),
            "'R&D Notes'!R[1]C[1]"
        );
        // a sheet name inside a text literal is not a reference
        assert_eq!(quote_bare_sheet_names(r#""R&D!""#, &names), None);
        // external workbooks and already-quoted names are left as they are
        assert_eq!(quote_bare_sheet_names("[1]Sheet1!R[0]C[0]*2", &names), None);
        assert_eq!(quote_bare_sheet_names("'R&D'!R[1]C[1]", &names), None);
        assert_eq!(
            quote_bare_sheet_names("SUM(R[1]C[1]:R[2]C[1])", &names),
            None
        );
    }

    #[test]
    fn a_sheet_name_is_recognised_only_as_a_bare_reference() {
        let names = vec!["Sheet1".to_string(), "R&D".to_string()];
        assert!(references_a_sheet_of_this_workbook(
            "R&D!R[-17]C[0]",
            &names
        ));
        assert!(references_a_sheet_of_this_workbook(
            "SUM(R&D!R[1]C[1])",
            &names
        ));
        // external workbooks keep their pin
        assert!(!references_a_sheet_of_this_workbook(
            "[1]Sheet1!R[0]C[0]*2",
            &names
        ));
        assert!(!references_a_sheet_of_this_workbook(
            r#"'[1]Sheet1'!R[0]C[0]&" units""#,
            &names
        ));
        // a longer name that merely ends in one of ours
        assert!(!references_a_sheet_of_this_workbook(
            "OldSheet1!R[0]C[0]",
            &names
        ));
        // a sheet name inside a text literal is not a reference
        assert!(!references_a_sheet_of_this_workbook(
            r#"[1]Sheet1!R[0]C[0]&" from Sheet1! ""#,
            &names
        ));
        assert!(references_a_sheet_of_this_workbook(
            r#""see Sheet1!"&Sheet1!R[0]C[0]"#,
            &names
        ));
    }

    fn write_external_link_fixture(path: &Path) {
        use std::io::Write;
        let entries: [(&str, &str); 8] = [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><externalReferences><externalReference r:id="rId3"/></externalReferences></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>"#,
            ),
            (
                "xl/styles.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#,
            ),
            (
                "xl/externalLinks/externalLink1.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><externalBook r:id="rId1"><sheetNames><sheetName val="Sheet1"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="1"><cell r="A1"><v>42</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>"#,
            ),
            (
                "xl/externalLinks/_rels/externalLink1.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLinkPath" Target="file:///C:/data/source.xlsx" TargetMode="External"/></Relationships>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C2"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="1"><c r="A1"><f>[1]Sheet1!A1*2</f><v>84</v></c><c r="B1"><f>A1+1</f><v>85</v></c><c r="C1" t="str"><f>'[1]Sheet1'!A1&amp;" units"</f><v>42 units</v></c></row><row r="2"><c r="A2"><v>5</v></c><c r="B2"><f>SUM(A1:A2)</f><v>89</v></c></row></sheetData></worksheet>"#,
            ),
        ];
        let mut writer = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    /// External-workbook references never parse in IronCalc; the file's
    /// cached values must stand in for them so dependents keep computing
    /// instead of cascading #ERROR! (public issue 235).
    #[test]
    fn external_link_formulas_keep_their_cached_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("external.xlsx");
        write_external_link_fixture(&path);
        let mut cache = RecalcCache::new();
        let result = recalc_cells(
            &mut cache,
            &path,
            &[edit("A2", "10")],
            &[RecalcRead {
                sheet: "Sheet1".into(),
                range: CellRange {
                    start_row: 0,
                    end_row: 1,
                    start_column: 0,
                    end_column: 2,
                },
            }],
        )
        .unwrap();
        let at = |row: u32, column: u32| {
            result
                .cells
                .iter()
                .find(|cell| cell.row == row && cell.column == column)
                .unwrap()
        };
        assert!(result.cells.iter().all(|cell| cell.formatted != "#ERROR!"));
        // pinned to the cache and no longer reported as formulas
        assert_eq!(
            (at(0, 0).formatted.as_str(), at(0, 0).is_formula),
            ("84", false)
        );
        assert_eq!(
            (at(0, 2).formatted.as_str(), at(0, 2).is_formula),
            ("42 units", false)
        );
        // dependents compute against the pinned values
        assert_eq!(
            (at(0, 1).formatted.as_str(), at(0, 1).is_formula),
            ("85", true)
        );
        assert_eq!(
            (at(1, 1).formatted.as_str(), at(1, 1).is_formula),
            ("94", true)
        );
    }
}
