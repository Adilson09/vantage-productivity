# Vantage companion license notices

`collect.mjs` regenerates `THIRD-PARTY-NOTICES.txt`, `VANTAGE_NOTICE_LOCKS.json`, and `VANTAGE_NOTICE_PROVENANCE.json` from a complete Cargo dependency graph, installed frontend/build packages, and the checked-in license supplements. It reads local dependency sources and makes no network requests, accesses no mail profile or credentials, and never executes package scripts. Run it from the Depesha source root after installing the pinned dependencies. Both lockfiles must exist.

Create a UTF-8 metadata file with `cargo metadata --format-version 1 --locked --offline --filter-platform x86_64-pc-windows-msvc`. Keep this file and the generator's detailed `depesha-license-inventory.json` in a scratch directory: they contain local installation paths and are build records, not distribution notices. `CARGO_HOME` must point to the directory containing the fetched registry sources.

```powershell
node tools/aster-licenses/collect.mjs --source . --node-modules node_modules --cargo-home "$env:CARGO_HOME" --metadata scratch/windows-cargo-metadata.json --output scratch/notices --supplements licenses/aster-supplements/supplements.json
node --test tools/aster-licenses/collect.node-test.mjs
node node_modules/vitest/vitest.mjs run scripts/aster-isolation.test.mjs --maxWorkers 1
```

After a successful generation, review the summary and copy the three distribution files from `scratch/notices` to the source root. The companion build helper compares `VANTAGE_NOTICE_LOCKS.json` with the current `Cargo.lock` and `package-lock.json` and refuses stale notices. A changed dependency graph requires refreshed license sources and review; do not bypass this check or change the lock map without regenerating the notices. Existing supplements identify exact package versions and cannot silently attach to a different version.

`licenses/aster-supplements/supplements.json` records public source URLs, immutable source revisions or published package versions, SHA-256 digests, and text classifications. Thirty-six small text files supplement licenses omitted from published archives, and Microsoft SDK notices. Seven packages declare a standard SPDX license but omit a standalone full license file in the published package/source revision. These entries explicitly supply the standard SPDX text plus the exact original package attribution, readme, and available source headers; no copyright year or owner is invented. The standard texts come from SPDX license-list-data commit `d46e94e2c78ceede1cfc63cfa0396472d2798d4c` (v3.27.0). Simple MIT OR Apache-2.0 options use MIT where its permission text is captured; both upstream root and vendored imap-proto license alternatives remain preserved.

The Windows WebView2 SDK 1.0.3800.47 original `LICENSE.txt` and `NOTICE.txt` were extracted from the official NuGet package. Its SHA-512 matched the NuGet catalog, and the x64 loader DLL and static loader library matched the corresponding bytes in webview2-com-sys 0.39.1. `webview2-sdk-provenance.json` records the public archive URL and package/text digests. The SDK archive and build binaries are deliberately absent from these source supplements.

The inventory conservatively includes the Windows Cargo graph and installed frontend/build dependencies, including build/test tooling; this does not assert that every listed package is linked into the executable. Corresponding-source archive URLs are listed per component, including the publisher's actual locked CDN URL where npm is not the source. Local Depesha and patched imap-proto source travels with the Vantage source distribution. Original Depesha and imap-proto license files and `VANTAGE_MAIL_FORK_NOTICE.txt` must remain beside the generated notices.
