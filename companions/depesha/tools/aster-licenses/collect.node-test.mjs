import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collect, selectedLicense } from "./collect.mjs";

const mitText = "Copyright Fixture Authors\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, "aster-license-test-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("aster-license-test-"));
    await fs.rm(resolved, { recursive: true });
  });
  const opts = { sourceRoot: path.join(root, "source"), cargoHome: path.join(root, "cargo"), nodeModules: path.join(root, "node_modules"), metadataPath: path.join(root, "metadata.json"), outputDirectory: path.join(root, "output") };
  for (const dir of [opts.sourceRoot, opts.cargoHome, opts.nodeModules]) await fs.mkdir(dir);
  await fs.writeFile(path.join(opts.sourceRoot, "Cargo.lock"), "version = 4\n");
  await fs.writeFile(path.join(opts.sourceRoot, "package-lock.json"), JSON.stringify({ packages: {} }));
  await fs.mkdir(path.join(opts.sourceRoot, "src-tauri"));
  await fs.writeFile(path.join(opts.sourceRoot, "LICENSE-MIT"), mitText);
  await fs.writeFile(path.join(opts.sourceRoot, "LICENSE-APACHE"), "Apache license fixture\n");
  const rootPackage = { id: "workspace", name: "depesha", version: "0.8.17", license: "MIT OR Apache-2.0", source: null, manifest_path: path.join(opts.sourceRoot, "src-tauri/Cargo.toml") };
  const metadata = { packages: [rootPackage], workspace_members: ["workspace"], resolve: { nodes: [{ id: "workspace", deps: [] }] } };
  await fs.writeFile(opts.metadataPath, JSON.stringify(metadata));
  return { root, opts, metadata };
}

test("a workspace crate inherits real root license files and npm notices retain hashes", async (t) => {
  const { opts } = await fixture(t);
  await fs.writeFile(path.join(opts.sourceRoot, "ASTER_NOTICE_PROVENANCE.json"), "Generated bookkeeping, not a project license");
  await fs.writeFile(path.join(opts.sourceRoot, "THIRD-PARTY-NOTICES.txt"), "Previously generated dependency notices, not the workspace license");
  const dependency = path.join(opts.nodeModules, "example");
  await fs.mkdir(dependency);
  await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "example", version: "1.0.0", license: "MIT" }));
  await fs.writeFile(path.join(dependency, "LICENSE"), mitText);
  const report = await collect(opts);
  assert.equal(report.complete, true);
  assert.equal(report.counts.cargo, 1);
  assert.equal(report.counts.npm, 1);
  assert.equal(report.counts.noticeFiles, 3);
  assert.equal(report.components[0].selectedLicense, "MIT");
  assert.match(report.components[1].files[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(await fs.readFile(path.join(opts.outputDirectory, "THIRD-PARTY-NOTICES.txt"), "utf8"), /Copyright Fixture Authors/);
});

test("missing license text is reported as incomplete rather than invented", async (t) => {
  const { opts } = await fixture(t);
  const dependency = path.join(opts.nodeModules, "missing");
  await fs.mkdir(dependency);
  await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "missing", version: "1.0.0", license: "MIT" }));
  const report = await collect(opts);
  assert.equal(report.complete, false);
  assert.equal(report.counts.missing, 1);
  assert.equal(report.missing[0].name, "missing");
  assert.match(await fs.readFile(path.join(opts.outputDirectory, "THIRD-PARTY-NOTICES.txt"), "utf8"), /INCOMPLETE: 1/);
});

test("a metadata license-file cannot read outside the approved source roots", async (t) => {
  const { opts, root, metadata } = await fixture(t);
  const outside = path.join(root, "outside-LICENSE");
  await fs.writeFile(outside, "fixture secret that must not enter notices");
  metadata.packages[0].license_file = outside;
  await fs.writeFile(opts.metadataPath, JSON.stringify(metadata));
  await assert.rejects(collect(opts), /License path escapes approved source roots/);
});

test("only a simple dual option with a captured MIT grant selects MIT", () => {
  assert.equal(selectedLicense("MIT OR Apache-2.0", [{ text: mitText }]), "MIT");
  assert.equal(selectedLicense("(Apache-2.0 OR MIT)", [{ text: mitText }]), "MIT");
  assert.equal(selectedLicense("MIT OR Apache-2.0", []), "MIT OR Apache-2.0");
  assert.equal(selectedLicense("MIT AND Unicode-3.0", [{ text: mitText }]), "MIT AND Unicode-3.0");
});

test("embedded README grants are captured and non-registry source URLs stay exact", async (t) => {
  const { opts } = await fixture(t);
  const dependency = path.join(opts.nodeModules, "cdn-package");
  await fs.mkdir(dependency);
  await fs.writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "cdn-package", version: "1.0.0", license: "MIT" }));
  await fs.writeFile(path.join(dependency, "README.md"), `Project description\n\n## License\n${mitText}`);
  await fs.writeFile(path.join(opts.sourceRoot, "package-lock.json"), JSON.stringify({ packages: { "node_modules/cdn-package": { version: "1.0.0", resolved: "https://publisher.example/exact-1.0.0.tgz", integrity: "sha512-fixture" } } }));
  const report = await collect(opts);
  const component = report.components.find((item) => item.name === "cdn-package");
  assert.equal(report.complete, true);
  assert.equal(component.files[0].path, "README.md");
  assert.equal(component.sourceArchive, "https://publisher.example/exact-1.0.0.tgz");
  assert.equal(component.sourceIntegrity, "sha512-fixture");
});

test("supplement bytes must match their recorded digest", async (t) => {
  const { opts, root } = await fixture(t);
  const supplements = path.join(root, "supplements");
  await fs.mkdir(supplements);
  await fs.writeFile(path.join(supplements, "LICENSE"), "tampered bytes");
  const supplementsPath = path.join(supplements, "manifest.json");
  await fs.writeFile(supplementsPath, JSON.stringify({ components: [{ ecosystem: "Cargo", name: "depesha", version: "0.8.17", files: [{ path: "LICENSE", sha256: "0000" }] }] }));
  await assert.rejects(collect({ ...opts, supplementsPath }), /Supplement integrity mismatch/);
});
