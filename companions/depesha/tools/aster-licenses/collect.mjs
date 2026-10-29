// Aster Office packaging helper. Reads dependency metadata and copies notices only.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const licenseName = /(?:licen[cs]e|notices?|copying|copyright|authors)(?:[._-]|$)/i;
const skippedDirectories = new Set(["node_modules", ".git", "target", ".cache"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const folded = (value) => process.platform === "win32" ? value.toLowerCase() : value;
const inside = (root, value) => {
  const relative = path.relative(folded(root), folded(value));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function decode(bytes) {
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" }; }
  catch { return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" }; }
}

export function selectedLicense(declared, files) {
  const value = typeof declared === "string" ? declared.trim() : JSON.stringify(declared ?? null);
  const isSimpleDual = /^(?:\(?MIT\s+OR\s+Apache-2\.0\)?|\(?Apache-2\.0\s+OR\s+MIT\)?)$/i.test(value);
  return isSimpleDual && files.some((file) => /Permission is hereby granted, free of charge/i.test(file.text)) ? "MIT" : value;
}

async function noticeFiles(directory, explicit = null, allowedRoots = [directory], maxDepth = 7, nameFilter = licenseName) {
  const root = await fs.realpath(directory);
  const candidates = new Set();
  let entriesSeen = 0;
  async function visit(current, depth) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (++entriesSeen > 150000) throw new Error(`Notice scan limit exceeded: ${directory}`);
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < maxDepth && !skippedDirectories.has(entry.name)) await visit(absolute, depth + 1);
      } else if (entry.isFile() && (nameFilter.test(entry.name) || /(?:^|[\\/])(?:licenses?|legal)[\\/]/i.test(path.relative(root, absolute)))) {
        candidates.add(absolute);
      }
    }
  }
  await visit(root, 0);
  if (explicit) candidates.add(path.resolve(root, explicit));
  if (!candidates.size) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^readme(?:\.|$)/i.test(entry.name)) continue;
      const candidate = path.join(root, entry.name);
      const stat = await fs.stat(candidate);
      if (stat.size > 4 * 1024 * 1024) continue;
      const text = decode(await fs.readFile(candidate)).text;
      if (/Permission is hereby granted|Permission to use, copy|Redistribution and use in source and binary forms/i.test(text)) candidates.add(candidate);
    }
  }
  const files = [];
  for (const candidate of [...candidates].sort()) {
    const real = await fs.realpath(candidate);
    if (!allowedRoots.some((allowed) => inside(allowed, real))) throw new Error(`License path escapes approved source roots: ${candidate}`);
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`Invalid or oversized license file: ${candidate}`);
    const bytes = await fs.readFile(real);
    if (bytes.includes(0)) continue;
    const decoded = decode(bytes);
    files.push({ path: path.relative(root, real).replaceAll(path.sep, "/"), source: real, sha256: hash(bytes), bytes: bytes.length, ...decoded });
  }
  return files;
}

async function installedNpmPackages(nodeModules) {
  const packages = [];
  async function scan(modules) {
    let entries;
    try { entries = await fs.readdir(modules, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const absolute = path.join(modules, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await fs.readdir(absolute, { withFileTypes: true })) {
          if (scoped.isDirectory() || scoped.isSymbolicLink()) await add(path.join(absolute, scoped.name));
        }
      } else await add(absolute);
    }
  }
  async function add(directory) {
    const real = await fs.realpath(directory);
    if (!inside(nodeModules, real)) throw new Error(`NPM package escapes dependency root: ${directory}`);
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(real, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") throw new Error(`Package manifest missing: ${directory}`); throw error; }
    packages.push({ directory: real, manifest });
    await scan(path.join(real, "node_modules"));
  }
  await scan(nodeModules);
  return packages;
}

export async function collect({ sourceRoot, nodeModules, cargoHome, metadataPath, outputDirectory, supplementsPath = null }) {
  sourceRoot = await fs.realpath(sourceRoot);
  nodeModules = await fs.realpath(nodeModules);
  cargoHome = await fs.realpath(cargoHome);
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  const lockHashes = {};
  for (const name of ["Cargo.lock", "package-lock.json"]) lockHashes[name] = hash(await fs.readFile(path.join(sourceRoot, name)));
  const npmLocks = new Map();
  try {
    const lock = JSON.parse(await fs.readFile(path.join(sourceRoot, "package-lock.json"), "utf8"));
    for (const [location, item] of Object.entries(lock.packages ?? {})) {
      const index = location.lastIndexOf("node_modules/");
      if (index < 0 || !item.version) continue;
      npmLocks.set(`${location.slice(index + "node_modules/".length)}@${item.version}`, item);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!metadata.resolve?.nodes?.length) throw new Error("Complete Cargo metadata with a dependency resolve graph is required");
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const reachable = new Set();
  function walk(id) {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) walk(dependency.pkg);
  }
  for (const id of metadata.workspace_members) walk(id);
  const components = [];
  for (const item of metadata.packages.filter((item) => reachable.has(item.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    const directory = await fs.realpath(path.dirname(item.manifest_path));
    if (![sourceRoot, cargoHome].some((approved) => inside(approved, directory))) throw new Error(`Crate escapes approved sources: ${directory}`);
    let files = await noticeFiles(directory, item.license_file, [sourceRoot, cargoHome]);
    if (!item.source && inside(sourceRoot, directory) && !files.length) {
      files = await noticeFiles(sourceRoot, null, [sourceRoot], 0, /^(?:licen[cs]e|copying|copyright|notice)(?:[._-]|$)/i);
    }
    components.push({ ecosystem: "Cargo", name: item.name, version: item.version, authors: item.authors, declaredLicense: item.license, selectedLicense: selectedLicense(item.license, files), repository: item.repository, source: item.source ?? "local workspace or vendor", sourceArchive: item.source?.startsWith("registry+") ? `https://crates.io/api/v1/crates/${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}/download` : "Modified workspace/vendor source accompanies the Aster source archive", sourceDirectory: directory, files });
  }
  for (const { directory, manifest } of (await installedNpmPackages(nodeModules)).sort((a, b) => `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`))) {
    const files = await noticeFiles(directory);
    const license = manifest.license ?? manifest.licenses ?? null;
    const lock = npmLocks.get(`${manifest.name}@${manifest.version}`);
    components.push({ ecosystem: "npm", name: manifest.name, version: manifest.version, authors: manifest.author ?? manifest.contributors ?? [], declaredLicense: license, selectedLicense: selectedLicense(license, files), repository: manifest.repository ?? manifest.homepage ?? null, source: "installed locked frontend/build dependency", sourceArchive: lock?.resolved ?? `https://registry.npmjs.org/${manifest.name}/-/${manifest.name.split("/").at(-1)}-${manifest.version}.tgz`, sourceIntegrity: lock?.integrity ?? null, sourceDirectory: directory, files });
  }
  if (supplementsPath) {
    const supplementsRoot = await fs.realpath(path.dirname(supplementsPath));
    const supplements = JSON.parse(await fs.readFile(supplementsPath, "utf8"));
    for (const supplement of supplements.components) {
      const component = components.find((item) => item.ecosystem === supplement.ecosystem && item.name === supplement.name && item.version === supplement.version);
      if (!component) throw new Error(`Supplement has no matching locked component: ${supplement.name} ${supplement.version}`);
      for (const item of supplement.files) {
        const real = await fs.realpath(path.resolve(supplementsRoot, item.path));
        if (!inside(supplementsRoot, real)) throw new Error(`Supplement escapes approved sources: ${real}`);
        const bytes = await fs.readFile(real);
        if (hash(bytes) !== item.sha256) throw new Error(`Supplement integrity mismatch: ${real}`);
        component.files.push({ path: `upstream-supplement/${path.basename(real)}`, source: item.sourceUrl, revision: item.revision, kind: item.kind ?? "upstream-license-file", description: item.description, sha256: item.sha256, bytes: bytes.length, ...decode(bytes) });
      }
      component.selectedLicense = selectedLicense(component.declaredLicense, component.files);
    }
  }
  const missing = components.filter((component) => component.files.every((file) => file.kind === "package-attribution" || /(?:^|\/)authors(?:\.|$)/i.test(file.path))).map(({ecosystem, name, version, declaredLicense}) => ({ ecosystem, name, version, declaredLicense }));
  const standardTextSupplemented = components.filter((component) => component.files.some((file) => file.kind === "canonical-spdx"));
  const heading = [
    "ASTER MAIL — THIRD-PARTY NOTICES",
    "Pinned upstream: https://github.com/fgbm/depesha at d3c3a2b63cc9a1e194aa3ed3842d8d3fd0f2e0b4 (0.8.17).",
    "These notices reproduce license and attribution files from the fetched Windows-target Cargo graph and installed frontend/build dependencies. Build/test-only components are included conservatively; inclusion does not assert that every listed component is linked in the executable.",
    "Where a simple MIT OR Apache-2.0 option offers a captured MIT permission text, the MIT option is selected; both original license files are preserved below. Other expressions are retained as declared.",
    missing.length ? `INCOMPLETE: ${missing.length} component(s) have no captured standalone license/notice text; see the accompanying inventory before redistribution.` : "All discovered components have captured license or notice texts.",
    `${standardTextSupplemented.length} packages omit standalone license text in their published package/source revision. For these, the declared SPDX license's standard text and original package attribution/metadata are supplied and explicitly marked; no copyright year or owner has been invented.`,
    "Original Depesha project and vendored imap-proto licenses are included separately with the companion. Aster fork changes are described in ASTER_MAIL_FORK_NOTICE.txt.",
    "",
  ];
  for (const component of components) {
    heading.push("=".repeat(78), `${component.ecosystem}: ${component.name} ${component.version}`, `Declared license: ${typeof component.declaredLicense === "string" ? component.declaredLicense : JSON.stringify(component.declaredLicense)}`, `Selected expression: ${component.selectedLicense}`, `Published author/contributor metadata: ${JSON.stringify(component.authors)}`, `Upstream: ${typeof component.repository === "string" ? component.repository : JSON.stringify(component.repository)}`, `Corresponding source: ${component.sourceArchive}`, "");
    for (const file of component.files) heading.push(`--- ${file.path} (SHA-256 ${file.sha256}) ---`, ...(file.revision ? [`Retrieved from: ${file.source}`, `Revision: ${file.revision}`, `Text classification: ${file.kind}`, ...(file.description ? [file.description] : []), ""] : []), file.text.trimEnd(), "");
    if (!component.files.length) heading.push("No standalone license or notice file was present in this fetched package.", "");
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, "THIRD-PARTY-NOTICES.txt"), heading.join("\n"), "utf8");
  const inventory = { generatedUtc: new Date().toISOString(), metadataPath, sourceRoot, nodeModules, cargoHome, complete: missing.length === 0, counts: { cargo: components.filter((c) => c.ecosystem === "Cargo").length, npm: components.filter((c) => c.ecosystem === "npm").length, noticeFiles: components.reduce((count, component) => count + component.files.length, 0), standardTextSupplemented: standardTextSupplemented.length, missing: missing.length }, missing, components: components.map(({ files, ...component }) => ({ ...component, files: files.map(({ text, ...file }) => file) })) };
  await fs.writeFile(path.join(outputDirectory, "depesha-license-inventory.json"), JSON.stringify(inventory, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(outputDirectory, "ASTER_NOTICE_LOCKS.json"), JSON.stringify(lockHashes, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(outputDirectory, "ASTER_NOTICE_PROVENANCE.json"), JSON.stringify({ generatedUtc: inventory.generatedUtc, upstreamCommit: "d3c3a2b63cc9a1e194aa3ed3842d8d3fd0f2e0b4", upstreamVersion: "0.8.17", completeTextCollection: inventory.complete, counts: inventory.counts, standardTextSupplemented: standardTextSupplemented.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })), locks: lockHashes, noticesSha256: hash(await fs.readFile(path.join(outputDirectory, "THIRD-PARTY-NOTICES.txt"))), generatorSha256: hash(await fs.readFile(new URL(import.meta.url))) }, null, 2) + "\n", "utf8");
  return inventory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 2) args[process.argv[index].replace(/^--/, "")] = process.argv[index + 1];
  const report = await collect({ sourceRoot: args.source, nodeModules: args["node-modules"], cargoHome: args["cargo-home"], metadataPath: args.metadata, outputDirectory: args.output, supplementsPath: args.supplements });
  console.log(JSON.stringify({ complete: report.complete, ...report.counts, output: args.output, missing: report.missing }, null, 2));
  if (!report.complete) process.exitCode = 2;
}
