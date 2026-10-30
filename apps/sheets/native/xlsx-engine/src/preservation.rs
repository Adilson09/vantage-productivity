//! Read-only package preservation gate. Digests prove byte preservation, not
//! the validity of XML/VBA signatures or executable content. No external target
//! is opened, and macros, controls and embedded objects are never executed.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

use roxmltree::Document;
use serde::Serialize;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::SidecarError;
use crate::archive::{canonical_entry_name, resolve_relationship_target, validate_entries};
use crate::xml_util::{copy_entry_bounded, decode_uri_path, read_zip_string};

/// Hashing is streaming, so a large preserved worksheet need not fit in RAM.
/// The total still has a finite work budget independent of forged ZIP claims.
const MAX_AUDIT_PACKAGE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreservationDiagnostic {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpaquePartKind {
    VbaProject,
    VbaSignature,
    PackageSignature,
    ActiveX,
    Control,
    CustomXml,
    CustomUi,
    Embedding,
    UnknownOpaque,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpaquePartReport {
    pub name: String,
    pub kind: OpaquePartKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_sha256: Option<String>,
    pub bytes_preserved: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageSignatureStatus { Absent, PresentUnverified, InvalidatedByEdit }
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VbaSignatureStatus { Absent, PreservedUnverified, ChangedOrRemoved }

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignatureStatus {
    pub package_signatures: PackageSignatureStatus,
    pub vba_signatures: VbaSignatureStatus,
    pub package_signature_parts: Vec<String>,
    pub vba_signature_parts: Vec<String>,
    pub cryptographically_verified: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreservedEntry {
    pub name: String,
    /// The same digest was independently streamed from source and target.
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreservationReport {
    pub preserved: bool,
    pub preserved_entries: Vec<PreservedEntry>,
    pub opaque_parts: Vec<OpaquePartReport>,
    pub changed_entries: Vec<String>,
    pub added_entries: Vec<String>,
    pub removed_entries: Vec<String>,
    pub violations: Vec<PreservationDiagnostic>,
    pub warnings: Vec<PreservationDiagnostic>,
    pub signature_status: SignatureStatus,
    pub relationship_count: usize,
    pub external_relationships: usize,
}

struct Part { sha256: String, kind: Option<OpaquePartKind> }
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Edge { owner: String, id: String, relationship_type: String, target: String, external: bool }
struct Package {
    parts: BTreeMap<String, Part>,
    edges: BTreeSet<Edge>,
    issues: BTreeMap<String, PreservationDiagnostic>,
    content_types: BTreeMap<String, String>,
    relationship_count: usize,
    external_relationships: usize,
}

fn diagnostic(code: &str, entry: &str, message: impl Into<String>) -> PreservationDiagnostic {
    PreservationDiagnostic { code: code.into(), entry: Some(entry.into()), message: message.into() }
}
fn issue(package: &mut Package, key: String, code: &str, entry: &str, message: impl Into<String>) {
    package.issues.insert(key, diagnostic(code, entry, message));
}

struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.0.update(bytes); Ok(bytes.len()) }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

fn known_editable_part(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if name == "[content_types].xml" || name == "_rels/.rels" || name.ends_with(".rels") { return true; }
    if ["xl/workbook.xml", "xl/styles.xml", "xl/sharedstrings.xml", "xl/calcchain.xml", "xl/metadata.xml", "xl/gxredactions.json", "xl/comments.xml"].contains(&name.as_str()) { return true; }
    if name.starts_with("xl/comments") && name.ends_with(".xml") { return true; }
    if name.starts_with("docprops/") && name.ends_with(".xml") { return true; }
    if ["xl/worksheets/", "xl/chartsheets/", "xl/dialogsheets/", "xl/charts/", "xl/drawings/", "xl/tables/", "xl/pivottables/", "xl/pivotcache/", "xl/theme/", "xl/richdata/", "xl/threadedcomments/", "xl/persons/"].iter().any(|prefix| name.starts_with(*prefix)) && name.ends_with(".xml") { return true; }
    if name.starts_with("xl/media/") {
        return matches!(name.rsplit_once('.').map(|(_, extension)| extension), Some("png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "tif" | "tiff" | "svg" | "emf" | "wmf"));
    }
    false
}

fn classify(name: &str, archive: &mut ZipArchive<File>) -> Option<OpaquePartKind> {
    let lower = name.to_ascii_lowercase();
    if lower.contains("vbaprojectsignature") { return Some(OpaquePartKind::VbaSignature); }
    if lower.contains("vbaproject") { return Some(OpaquePartKind::VbaProject); }
    if lower.starts_with("_xmlsignatures/") { return Some(OpaquePartKind::PackageSignature); }
    if lower.starts_with("xl/activex/") { return Some(OpaquePartKind::ActiveX); }
    if lower.starts_with("xl/ctrlprops/") || lower.starts_with("xl/controls/") || lower.starts_with("xl/macrosheets/") { return Some(OpaquePartKind::Control); }
    if lower.starts_with("customxml/") { return Some(OpaquePartKind::CustomXml); }
    if lower.starts_with("customui/") { return Some(OpaquePartKind::CustomUi); }
    if lower.contains("/embeddings/") { return Some(OpaquePartKind::Embedding); }
    if lower.ends_with(".vml") {
        // The editor models note VML. Other VML may contain form controls,
        // macro bindings or unmodelled host metadata and is kept opaque.
        let pure_notes = read_zip_string(archive, name).ok().is_some_and(|xml| {
            Document::parse(&xml).ok().is_some_and(|document| {
                let clients: Vec<_> = document.descendants().filter(|node| node.is_element() && node.tag_name().name() == "ClientData").collect();
                !clients.is_empty() && clients.iter().all(|node| node.attribute("ObjectType") == Some("Note"))
            })
        });
        return if pure_notes { None } else { Some(OpaquePartKind::Control) };
    }
    if known_editable_part(name) { None } else { Some(OpaquePartKind::UnknownOpaque) }
}

/// Lookup follows the importer: exact names, then canonical separators and
/// ASCII case drift, then percent-decoded URI spelling. No Unicode case folding
/// or network/filesystem target resolution is performed.
fn find_part<'a>(parts: &'a BTreeMap<String, Part>, target: &str) -> Option<&'a str> {
    if let Some((name, _)) = parts.get_key_value(target) { return Some(name); }
    let canonical = canonical_entry_name(target)?;
    for candidate in [Some(canonical.clone()), decode_uri_path(&canonical).ok()].into_iter().flatten() {
        if let Some((name, _)) = parts.iter().find(|(name, _)| name.eq_ignore_ascii_case(&candidate)) { return Some(name); }
    }
    None
}

fn relationship_owner(name: &str) -> Option<String> {
    if name.eq_ignore_ascii_case("_rels/.rels") { return Some(String::new()); }
    let (parent, file) = name.rsplit_once('/')?;
    let (grandparent, directory) = parent.rsplit_once('/').unwrap_or(("", parent));
    if !directory.eq_ignore_ascii_case("_rels") || !file.to_ascii_lowercase().ends_with(".rels") { return None; }
    let file = &file[..file.len() - 5];
    Some(if grandparent.is_empty() { file.into() } else { format!("{grandparent}/{file}") })
}

fn read_relationships(package: &mut Package, archive: &mut ZipArchive<File>, name: &str) {
    let Some(owner) = relationship_owner(name) else {
        issue(package, format!("relationship_path|{name}"), "invalid_relationship_path", name, "Relationship part has no canonical package owner."); return;
    };
    if !owner.is_empty() && find_part(&package.parts, &owner).is_none() {
        issue(package, format!("orphan_relationships|{name}"), "orphan_relationships", name, "Relationship part refers to an absent owner part.");
    }
    let xml = match read_zip_string(archive, name) {
        Ok(xml) => xml,
        Err(error) => { let hash = package.parts[name].sha256.clone(); issue(package, format!("relationship_xml|{name}|{hash}"), "invalid_relationship_xml", name, error.to_string()); return; }
    };
    let document = match Document::parse(&xml) {
        Ok(document) => document,
        Err(error) => { let hash = package.parts[name].sha256.clone(); issue(package, format!("relationship_xml|{name}|{hash}"), "invalid_relationship_xml", name, format!("Relationship XML is invalid: {error}")); return; }
    };
    let mut ids: BTreeMap<&str, usize> = BTreeMap::new();
    for node in document.descendants().filter(|node| node.is_element() && node.tag_name().name() == "Relationship") {
        package.relationship_count += 1;
        let id = node.attribute("Id").unwrap_or("");
        let target = node.attribute("Target").unwrap_or("");
        let relationship_type = node.attribute("Type").unwrap_or("");
        let occurrence = ids.entry(id).or_default(); *occurrence += 1;
        if *occurrence > 1 { issue(package, format!("duplicate_relationship|{name}|{id}|{occurrence}"), "duplicate_relationship_id", name, format!("Relationship ID {id} occurs more than once.")); }
        if id.is_empty() || target.is_empty() || relationship_type.is_empty() {
            issue(package, format!("incomplete_relationship|{name}|{id}|{target}|{relationship_type}"), "incomplete_relationship", name, "Relationship is missing an ID, target or type."); continue;
        }
        let mode = node.attribute("TargetMode").unwrap_or("Internal");
        let external = mode.eq_ignore_ascii_case("External");
        if !external && !mode.eq_ignore_ascii_case("Internal") {
            issue(package, format!("relationship_mode|{name}|{id}|{mode}"), "invalid_relationship_mode", name, format!("Relationship {id} has an unknown target mode.")); continue;
        }
        let resolved = if external {
            package.external_relationships += 1;
            target.to_owned()
        } else {
            match resolve_relationship_target(&owner, target) {
                Ok(target_path) => match find_part(&package.parts, &target_path) {
                    Some(part) => part.to_owned(),
                    None => {
                        issue(package, format!("dangling_relationship|{name}|{id}|{target_path}"), "dangling_relationship", name, format!("Relationship {id} targets missing part {target_path}."));
                        target_path
                    }
                },
                Err(error) => {
                    issue(package, format!("unsafe_relationship|{name}|{id}|{target}"), "unsafe_relationship", name, format!("Relationship {id}: {error}")); target.to_owned()
                }
            }
        };
        package.edges.insert(Edge { owner: owner.clone(), id: id.into(), relationship_type: relationship_type.into(), target: resolved, external });
    }
}

fn read_content_types(package: &mut Package, archive: &mut ZipArchive<File>) {
    let Some(name) = find_part(&package.parts, "[Content_Types].xml").map(str::to_owned) else {
        issue(package, "missing_content_types".into(), "missing_content_types", "[Content_Types].xml", "Package has no content-type manifest."); return;
    };
    let xml = match read_zip_string(archive, &name) {
        Ok(xml) => xml,
        Err(error) => { let hash = package.parts[&name].sha256.clone(); issue(package, format!("content_types_xml|{hash}"), "invalid_content_types", &name, error.to_string()); return; }
    };
    let document = match Document::parse(&xml) {
        Ok(document) => document,
        Err(error) => { let hash = package.parts[&name].sha256.clone(); issue(package, format!("content_types_xml|{hash}"), "invalid_content_types", &name, error.to_string()); return; }
    };
    let mut defaults = BTreeMap::new();
    let mut overrides = BTreeMap::new();
    for node in document.descendants().filter(|node| node.is_element()) {
        if node.tag_name().name() == "Default" {
            if let (Some(extension), Some(kind)) = (node.attribute("Extension"), node.attribute("ContentType")) { defaults.insert(extension.to_ascii_lowercase(), kind.to_owned()); }
        } else if node.tag_name().name() == "Override" {
            if let (Some(part), Some(kind)) = (node.attribute("PartName"), node.attribute("ContentType")) {
                let resolved = canonical_entry_name(part).and_then(|part| find_part(&package.parts, &part).map(str::to_owned));
                if let Some(part) = resolved { overrides.insert(part, kind.to_owned()); }
                else { issue(package, format!("dangling_content_type|{part}|{kind}"), "dangling_content_type", &name, format!("Content-type override targets missing part {part}.")); }
            }
        }
    }
    for part in package.parts.keys() {
        if let Some(kind) = overrides.get(part).cloned().or_else(|| part.rsplit_once('.').and_then(|(_, extension)| defaults.get(&extension.to_ascii_lowercase()).cloned())) { package.content_types.insert(part.clone(), kind); }
    }
}

fn semantic_kind(value: &str) -> Option<OpaquePartKind> {
    let value = value.to_ascii_lowercase();
    if value.contains("vbaprojectsignature") { Some(OpaquePartKind::VbaSignature) }
    else if value.contains("vbaproject") { Some(OpaquePartKind::VbaProject) }
    else if value.contains("digital-signature") { Some(OpaquePartKind::PackageSignature) }
    else if value.contains("activex") { Some(OpaquePartKind::ActiveX) }
    else if value.ends_with("/control") || value.contains("ctrlprop") || value.contains("xlmacrosheet") { Some(OpaquePartKind::Control) }
    else if value.ends_with("/oleobject") || value.ends_with(".oleobject") { Some(OpaquePartKind::Embedding) }
    else { None }
}

fn inspect(path: &Path) -> Result<Package, SidecarError> {
    let mut archive = ZipArchive::new(File::open(path)?)?;
    validate_entries(&mut archive)?;
    let mut package = Package { parts: BTreeMap::new(), edges: BTreeSet::new(), issues: BTreeMap::new(), content_types: BTreeMap::new(), relationship_count: 0, external_relationships: 0 };
    let mut total = 0u64;
    let mut duplicate_counts: BTreeMap<String, usize> = BTreeMap::new();
    for index in 0..archive.len() {
        let (name, declared) = {
            let entry = archive.by_index_raw(index)?;
            (canonical_entry_name(entry.name()).ok_or_else(|| SidecarError::Workbook("Unsafe ZIP entry path.".into()))?, entry.size())
        };
        if name.is_empty() || name.ends_with('/') { continue; }
        if package.parts.contains_key(&name) {
            let occurrence = duplicate_counts.entry(name.clone()).or_default(); *occurrence += 1;
            issue(&mut package, format!("duplicate_entry|{name}|{occurrence}"), "duplicate_entry_alias", &name, "Multiple ZIP entries resolve to this canonical part; the importer's first occurrence is authoritative."); continue;
        }
        total = total.checked_add(declared).filter(|total| *total <= MAX_AUDIT_PACKAGE_BYTES).ok_or_else(|| SidecarError::Workbook("Package exceeds the 8 GiB preservation-audit byte budget.".into()))?;
        let mut entry = archive.by_index(index)?;
        let mut writer = HashWriter(Sha256::new());
        let copied = copy_entry_bounded(&mut entry, declared, MAX_AUDIT_PACKAGE_BYTES, &mut writer)?;
        if copied != declared { return Err(SidecarError::Workbook(format!("ZIP part {name} does not match its declared size."))); }
        drop(entry);
        let sha256 = format!("{:x}", writer.0.finalize());
        let kind = classify(&name, &mut archive);
        package.parts.insert(name, Part { sha256, kind });
    }
    let relationships: Vec<String> = package.parts.keys().filter(|name| name.to_ascii_lowercase().ends_with(".rels")).cloned().collect();
    for name in relationships { read_relationships(&mut package, &mut archive, &name); }
    read_content_types(&mut package, &mut archive);
    // OPC permits producer-specific filenames. Relationship/content types,
    // not only familiar filenames, identify executable and signature parts.
    let semantic: Vec<_> = package.content_types.iter().filter_map(|(name, kind)| semantic_kind(kind).map(|kind| (name.clone(), kind)))
        .chain(package.edges.iter().filter(|edge| !edge.external).filter_map(|edge| semantic_kind(&edge.relationship_type).map(|kind| (edge.target.clone(), kind)))).collect();
    for (name, kind) in semantic { if let Some(part) = package.parts.get_mut(&name) { part.kind = Some(kind); } }
    let inherited: Vec<_> = package.parts.keys().filter_map(|name| {
        let owner = relationship_owner(name)?;
        let owner = find_part(&package.parts, &owner)?;
        package.parts.get(owner)?.kind.map(|kind| (name.clone(), kind))
    }).collect();
    for (name, kind) in inherited { if let Some(part) = package.parts.get_mut(&name) { part.kind = Some(kind); } }
    Ok(package)
}

fn protected_edge(edge: &Edge, package: &Package) -> bool {
    let kind = edge.relationship_type.to_ascii_lowercase();
    ["vbaproject", "activex", "control", "oleobject", "xlmacrosheet", "ui/extensibility", "digital-signature"].iter().any(|fragment| kind.contains(*fragment))
        || (!edge.external && package.parts.get(&edge.target).is_some_and(|part| part.kind.is_some()))
        || package.parts.get(&edge.owner).is_some_and(|part| part.kind.is_some())
}

/// Compare canonical package parts before a staged save is published. The
/// allowlist authorizes known document mutations, never opaque content loss.
/// Graph checks cover package relationship targets and protected bindings, not
/// XML schema conformance or every inline r:id reference inside document XML.
pub fn audit_preservation(source_path: &Path, target_path: &Path, allowed_changed_entries: &[String]) -> Result<PreservationReport, SidecarError> {
    if allowed_changed_entries.len() > 10_000 { return Err(SidecarError::InvalidRequest("Too many allowed package changes.".into())); }
    let mut allowed = BTreeSet::new();
    for name in allowed_changed_entries {
        if canonical_entry_name(name).as_deref() != Some(name.as_str()) || name.is_empty() || name.ends_with('/') { return Err(SidecarError::InvalidRequest("Allowed package changes must use canonical part names.".into())); }
        allowed.insert(name.as_str());
    }
    let before = inspect(source_path)?;
    let after = inspect(target_path)?;
    let mut violations = Vec::new();
    let mut warnings: Vec<_> = before.issues.values().cloned().map(|mut issue| { issue.code = format!("baseline_{}", issue.code); issue }).collect();
    for (key, issue) in &after.issues { if !before.issues.contains_key(key) { violations.push(issue.clone()); } }
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut added = Vec::new();
    let mut opaque = Vec::new();
    let mut preserved_entries = Vec::new();
    for (name, part) in &before.parts {
        let target = after.parts.get(name);
        let same = target.is_some_and(|target| target.sha256 == part.sha256);
        if same { preserved_entries.push(PreservedEntry { name: name.clone(), sha256: part.sha256.clone() }); }
        if target.is_none() { removed.push(name.clone()); }
        else if !same { changed.push(name.clone()); }
        if let Some(kind) = part.kind.as_ref().or_else(|| target.and_then(|target| target.kind.as_ref())) {
            opaque.push(OpaquePartReport { name: name.clone(), kind: kind.clone(), source_sha256: Some(part.sha256.clone()), target_sha256: target.map(|target| target.sha256.clone()), bytes_preserved: same });
            if !same { violations.push(diagnostic("protected_opaque_changed", name, "Opaque macro, signature, control, custom or unsupported content was changed or removed.")); }
            if before.content_types.get(name) != after.content_types.get(name) { violations.push(diagnostic("protected_content_type_changed", name, "The content-type binding of a preserved opaque part changed.")); }
        } else if !same && !allowed.contains(name.as_str()) {
            violations.push(diagnostic(if target.is_none() { "unexpected_removal" } else { "unexpected_change" }, name, "A package part changed outside the authorized mutation plan."));
        }
    }
    for (name, part) in &after.parts {
        if before.parts.contains_key(name) { continue; }
        added.push(name.clone());
        if let Some(kind) = &part.kind {
            opaque.push(OpaquePartReport { name: name.clone(), kind: kind.clone(), source_sha256: None, target_sha256: Some(part.sha256.clone()), bytes_preserved: false });
            violations.push(diagnostic("protected_opaque_added", name, "The save introduced opaque macro, control, embedded or unsupported content."));
        } else if !allowed.contains(name.as_str()) { violations.push(diagnostic("unexpected_addition", name, "A package part was added outside the authorized mutation plan.")); }
    }
    for edge in &before.edges {
        if protected_edge(edge, &before) && !after.edges.contains(edge) { violations.push(diagnostic("protected_relationship_changed", &edge.owner, format!("Preserved relationship {} was removed or rebound.", edge.id))); }
    }
    for edge in &after.edges {
        if protected_edge(edge, &after) && !before.edges.contains(edge) { violations.push(diagnostic("protected_relationship_added", &edge.owner, format!("The save introduced a macro, control or opaque-part relationship {}.", edge.id))); }
    }
    let has_vba = before.parts.values().any(|part| matches!(part.kind, Some(OpaquePartKind::VbaProject)));
    if has_vba {
        for (name, content_type) in &before.content_types {
            if content_type.to_ascii_lowercase().contains("macroenabled") && after.content_types.get(name) != Some(content_type) { violations.push(diagnostic("macro_content_type_changed", name, "The macro-enabled host content type changed.")); }
        }
    }
    let package_signature_parts: Vec<_> = before.parts.iter().chain(after.parts.iter()).filter(|(_, part)| matches!(part.kind, Some(OpaquePartKind::PackageSignature))).map(|(name, _)| name.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    let vba_signature_parts: Vec<_> = before.parts.iter().chain(after.parts.iter()).filter(|(_, part)| matches!(part.kind, Some(OpaquePartKind::VbaSignature))).map(|(name, _)| name.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    let edited = !changed.is_empty() || !added.is_empty() || !removed.is_empty();
    let package_signed = !package_signature_parts.is_empty() || before.edges.iter().chain(after.edges.iter()).any(|edge| edge.relationship_type.to_ascii_lowercase().contains("digital-signature"));
    let package_signatures = if !package_signed { PackageSignatureStatus::Absent } else if edited { warnings.push(diagnostic("package_signatures_invalidated", "_xmlsignatures/", "Package edits invalidate the prior signing assumptions; signatures were not cryptographically verified.")); PackageSignatureStatus::InvalidatedByEdit } else { PackageSignatureStatus::PresentUnverified };
    let vba_signatures = if vba_signature_parts.is_empty() { VbaSignatureStatus::Absent } else if vba_signature_parts.iter().all(|name| before.parts.get(name).zip(after.parts.get(name)).is_some_and(|(before, after)| before.sha256 == after.sha256)) { VbaSignatureStatus::PreservedUnverified } else { VbaSignatureStatus::ChangedOrRemoved };
    opaque.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(PreservationReport {
        preserved: violations.is_empty(), preserved_entries, opaque_parts: opaque, changed_entries: changed, added_entries: added, removed_entries: removed,
        violations, warnings, signature_status: SignatureStatus { package_signatures, vba_signatures, package_signature_parts, vba_signature_parts, cryptographically_verified: false },
        relationship_count: after.relationship_count, external_relationships: after.external_relationships,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    type Parts = BTreeMap<String, Vec<u8>>;
    const SHEET: &str = "xl/worksheets/sheet1.xml";
    const WORKBOOK_RELS: &str = "xl/_rels/workbook.xml.rels";

    fn base() -> Parts {
        [
            ("[Content_Types].xml", r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/><Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>"#),
            ("_rels/.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#),
            ("xl/workbook.xml", "<workbook/>"),
            (WORKBOOK_RELS, r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>"#),
            (SHEET, "<worksheet><sheetData/></worksheet>"),
            ("xl/vbaProject.bin", "synthetic VBA bytes, never executed"),
            ("xl/vbaProjectSignature.bin", "synthetic signature, not cryptographically verified"),
            ("xl/activeX/activeX1.bin", "synthetic ActiveX bytes"),
            ("xl/ctrlProps/ctrlProp1.xml", "<formControlPr/>"),
            ("xl/embeddings/oleObject1.bin", "synthetic OLE bytes"),
            ("customXml/item1.xml", "<applicationData><value>opaque</value></applicationData>"),
            ("customUI/customUI.xml", "<customUI/>"),
            ("vendor/private.dat", "unmodelled producer data"),
        ].into_iter().map(|(name, bytes)| (name.to_owned(), bytes.as_bytes().to_vec())).collect()
    }

    fn write(path: &Path, parts: &Parts, leading_slashes: bool) {
        let mut archive = ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, bytes) in parts {
            archive.start_file(if leading_slashes { format!("/{name}") } else { name.clone() }, options).unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap().sync_all().unwrap();
    }

    fn audit(source: &Parts, target: &Parts, allowed: &[&str]) -> PreservationReport {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source.xlsm");
        let target_path = directory.path().join("target.xlsm");
        write(&source_path, source, false); write(&target_path, target, false);
        audit_preservation(&source_path, &target_path, &allowed.iter().map(|name| (*name).into()).collect::<Vec<_>>()).unwrap()
    }

    fn append_relationship(parts: &mut Parts, path: &str, relationship: &str) {
        let xml = String::from_utf8(parts[path].clone()).unwrap();
        parts.insert(path.into(), xml.replace("</Relationships>", &format!("{relationship}</Relationships>")).into_bytes());
    }

    #[test]
    fn allowed_sheet_change_preserves_opaque_bytes_and_reports_every_untouched_digest() {
        let source = base(); let mut target = source.clone();
        target.insert(SHEET.into(), b"<worksheet><sheetData><row r=\"1\"/></sheetData></worksheet>".to_vec());
        let report = audit(&source, &target, &[SHEET]);
        assert!(report.preserved, "{:?}", report.violations);
        assert_eq!(report.changed_entries, vec![SHEET]);
        assert_eq!(report.preserved_entries.len(), source.len() - 1);
        assert!(report.preserved_entries.iter().all(|part| part.sha256.len() == 64));
        assert!(report.opaque_parts.iter().all(|part| part.bytes_preserved && part.source_sha256 == part.target_sha256));
        assert!(report.opaque_parts.iter().any(|part| part.kind == OpaquePartKind::VbaProject));
        assert!(report.opaque_parts.iter().any(|part| part.kind == OpaquePartKind::CustomXml));
        assert_eq!(report.signature_status.vba_signatures, VbaSignatureStatus::PreservedUnverified);
        assert!(!report.signature_status.cryptographically_verified);
    }

    #[test]
    fn allowlist_cannot_authorize_protected_content_changes_or_removals() {
        let source = base();
        for name in ["xl/vbaProject.bin", "xl/vbaProjectSignature.bin", "xl/activeX/activeX1.bin", "xl/embeddings/oleObject1.bin", "customXml/item1.xml", "vendor/private.dat"] {
            let mut target = source.clone(); target.insert(name.into(), b"changed opaque bytes".to_vec());
            let report = audit(&source, &target, &[name]);
            assert!(!report.preserved, "Protected part unexpectedly changed: {name}");
            assert!(report.violations.iter().any(|issue| issue.code == "protected_opaque_changed" && issue.entry.as_deref() == Some(name)));
        }
        let mut target = source.clone(); target.remove("xl/embeddings/oleObject1.bin");
        assert!(!audit(&source, &target, &["xl/embeddings/oleObject1.bin"]).preserved);
    }

    #[test]
    fn changed_protected_relationship_or_content_type_fails_even_when_bytes_survive() {
        let source = base(); let mut target = source.clone();
        target.insert(WORKBOOK_RELS.into(), br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_vec());
        let report = audit(&source, &target, &[WORKBOOK_RELS]);
        assert!(report.opaque_parts.iter().all(|part| part.bytes_preserved));
        assert!(report.violations.iter().any(|issue| issue.code == "protected_relationship_changed"));
        let mut target = source.clone();
        let types = String::from_utf8(target["[Content_Types].xml"].clone()).unwrap();
        target.insert("[Content_Types].xml".into(), types.replace("application/vnd.ms-excel.sheet.macroEnabled.main+xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml").into_bytes());
        let report = audit(&source, &target, &["[Content_Types].xml"]);
        assert!(report.violations.iter().any(|issue| issue.code == "macro_content_type_changed"));
    }

    #[test]
    fn new_dangling_relationship_fails_while_existing_source_defect_is_a_warning() {
        let mut source = base();
        let dangling = r#"<Relationship Id="rMissing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/missing.xml"/>"#;
        let mut target = source.clone(); append_relationship(&mut target, WORKBOOK_RELS, dangling);
        let report = audit(&source, &target, &[WORKBOOK_RELS]);
        assert!(!report.preserved);
        assert!(report.violations.iter().any(|issue| issue.code == "dangling_relationship"));
        append_relationship(&mut source, WORKBOOK_RELS, dangling);
        let mut target = source.clone(); target.insert(SHEET.into(), b"<worksheet/>".to_vec());
        let report = audit(&source, &target, &[SHEET]);
        assert!(report.preserved, "{:?}", report.violations);
        assert!(report.warnings.iter().any(|issue| issue.code == "baseline_dangling_relationship"));
    }

    #[test]
    fn canonical_leading_slashes_case_uri_unicode_and_external_links_follow_import_rules() {
        let mut parts = base();
        let sheet = parts.remove(SHEET).unwrap(); parts.insert("xl/worksheets/测试 One.xml".into(), sheet);
        let xml = String::from_utf8(parts[WORKBOOK_RELS].clone()).unwrap();
        parts.insert(WORKBOOK_RELS.into(), xml.replace("worksheets/sheet1.xml", "worksheets/%E6%B5%8B%E8%AF%95%20One.xml").into_bytes());
        let xml = String::from_utf8(parts["_rels/.rels"].clone()).unwrap();
        parts.insert("_rels/.rels".into(), xml.replace("xl/workbook.xml", "/XL/WORKBOOK.XML").into_bytes());
        append_relationship(&mut parts, WORKBOOK_RELS, r#"<Relationship Id="rExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/never-fetched" TargetMode="External"/>"#);
        let directory = tempfile::tempdir().unwrap(); let source = directory.path().join("source.xlsx"); let target = directory.path().join("target.xlsx");
        write(&source, &parts, true); write(&target, &parts, false);
        let report = audit_preservation(&source, &target, &[]).unwrap();
        assert!(report.preserved, "{:?}", report.violations);
        assert!(report.changed_entries.is_empty()); assert!(report.added_entries.is_empty()); assert!(report.removed_entries.is_empty());
        assert_eq!(report.external_relationships, 1);
    }

    #[test]
    fn package_signatures_are_unverified_and_edits_explicitly_invalidate_signing_assumptions() {
        let mut source = base();
        source.insert("_xmlsignatures/origin.sigs".into(), Vec::new());
        source.insert("_xmlsignatures/sig1.xml".into(), b"<Signature/>".to_vec());
        source.insert("_xmlsignatures/_rels/origin.sigs.rels".into(), br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSig" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature" Target="sig1.xml"/></Relationships>"#.to_vec());
        append_relationship(&mut source, "_rels/.rels", r#"<Relationship Id="rOrigin" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="_xmlsignatures/origin.sigs"/>"#);
        let unchanged = audit(&source, &source, &[]);
        assert_eq!(unchanged.signature_status.package_signatures, PackageSignatureStatus::PresentUnverified);
        assert!(!unchanged.signature_status.cryptographically_verified);
        let mut target = source.clone(); target.insert(SHEET.into(), b"<worksheet/>".to_vec());
        let edited = audit(&source, &target, &[SHEET]);
        assert!(edited.preserved, "{:?}", edited.violations);
        assert_eq!(edited.signature_status.package_signatures, PackageSignatureStatus::InvalidatedByEdit);
        assert!(edited.warnings.iter().any(|issue| issue.code == "package_signatures_invalidated"));
        let mut tampered = source.clone(); tampered.insert("_xmlsignatures/sig1.xml".into(), b"<Signature>changed</Signature>".to_vec());
        assert!(!audit(&source, &tampered, &["_xmlsignatures/sig1.xml"]).preserved);
    }

    #[test]
    fn known_additions_and_removals_need_explicit_plan_and_unknown_additions_are_refused() {
        let mut source = base(); source.insert("xl/calcChain.xml".into(), b"<calcChain/>".to_vec());
        let mut target = source.clone(); target.remove("xl/calcChain.xml"); target.insert("xl/media/new.png".into(), b"synthetic picture".to_vec());
        assert!(!audit(&source, &target, &[]).preserved);
        let allowed = audit(&source, &target, &["xl/calcChain.xml", "xl/media/new.png"]);
        assert!(allowed.preserved, "{:?}", allowed.violations);
        assert_eq!(allowed.removed_entries, vec!["xl/calcChain.xml"]);
        assert_eq!(allowed.added_entries, vec!["xl/media/new.png"]);
        target.insert("vendor/extra.bin".into(), b"unmodelled payload".to_vec());
        assert!(!audit(&source, &target, &["xl/calcChain.xml", "xl/media/new.png", "vendor/extra.bin"]).preserved);
    }

    #[test]
    fn producer_specific_macro_filenames_are_detected_by_semantic_binding() {
        let mut source = base(); let bytes = source.remove("xl/vbaProject.bin").unwrap(); source.insert("xl/nonstandard.bin".into(), bytes);
        for name in [WORKBOOK_RELS, "[Content_Types].xml"] {
            let xml = String::from_utf8(source[name].clone()).unwrap(); source.insert(name.into(), xml.replace("vbaProject.bin", "nonstandard.bin").into_bytes());
        }
        let report = audit(&source, &source, &[]);
        assert!(report.preserved, "{:?}", report.violations);
        assert!(report.opaque_parts.iter().any(|part| part.name == "xl/nonstandard.bin" && part.kind == OpaquePartKind::VbaProject));
    }

    #[test]
    fn editable_note_vml_cannot_be_replaced_with_an_active_control() {
        let mut source = base();
        source.insert("xl/drawings/notes.vml".into(), br#"<xml xmlns:x="urn:schemas-microsoft-com:office:excel"><x:ClientData ObjectType="Note"/></xml>"#.to_vec());
        let mut target = source.clone();
        target.insert("xl/drawings/notes.vml".into(), br#"<xml xmlns:x="urn:schemas-microsoft-com:office:excel"><x:ClientData ObjectType="Button"/></xml>"#.to_vec());
        assert!(!audit(&source, &target, &["xl/drawings/notes.vml"]).preserved);
    }

    #[test]
    fn opaque_owned_relationship_parts_remain_opaque_even_when_their_graph_is_empty() {
        let mut source = base();
        let name = "vendor/_rels/private.dat.rels";
        source.insert(name.into(), br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"#.to_vec());
        let mut target = source.clone(); target.remove(name);
        let report = audit(&source, &target, &[name]);
        assert!(!report.preserved);
        assert!(report.violations.iter().any(|issue| issue.code == "protected_opaque_changed" && issue.entry.as_deref() == Some(name)));
    }

    #[test]
    fn unsafe_package_paths_and_noncanonical_allowlists_are_rejected() {
        let directory = tempfile::tempdir().unwrap(); let source = directory.path().join("source.xlsx"); let target = directory.path().join("target.xlsx");
        let mut parts = base(); write(&source, &parts, false); write(&target, &parts, false);
        assert!(audit_preservation(&source, &target, &["/xl/workbook.xml".into()]).is_err());
        parts.insert("../escape.xml".into(), b"<unsafe/>".to_vec()); write(&target, &parts, false);
        assert!(audit_preservation(&source, &target, &[]).is_err());
    }
}
