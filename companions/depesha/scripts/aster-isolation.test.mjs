// Vantage Productivity fork: configuration regressions must not reclaim Depesha identities.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const root = new URL("../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8"));

test("the companion has its own application and executable identity", () => {
  assert.equal(config.identifier, "org.asteroffice.mail");
  assert.equal(config.productName, "Vantage Mail");
  assert.equal(config.mainBinaryName, "aster-mail");
  const windows = JSON.parse(readFileSync(new URL("src-tauri/tauri.windows.conf.json", root), "utf8"));
  assert.equal(windows.app.windows[0].title, config.productName);
});

test("links cannot register the upstream protocol", () => {
  assert.deepEqual(config.plugins["deep-link"].desktop.schemes, ["aster-mail"]);
});

test("no upstream updater key, endpoint, artifact, or registered plugin is bundled", () => {
  assert.equal(config.plugins.updater, undefined);
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  const main = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
  assert.doesNotMatch(main, /\.plugin\(tauri_plugin_updater::/);
});
