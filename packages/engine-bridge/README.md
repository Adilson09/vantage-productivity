# Local document engines

Vantage keeps its own editing engines and can call installed open source tools for separate tasks:

| Engine      | Purpose                                         | Result boundary                                                                                                                                                                     |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| qpdf        | PDF object and cross-reference diagnostics      | A structural pass does not establish PDF/A, PDF/UA, visual fidelity or accessibility.                                                                                               |
| veraPDF     | Machine validation of PDF/A and PDF/UA profiles | Results name every profile actually checked. Human accessibility and visual checks remain separate.                                                                                 |
| LibreOffice | Convert an independent document copy            | Only a completed output artifact counts. Layout preservation requires compatibility review. The extracted local trial remains unavailable; it is excluded from validated packaging. |

## Private veraPDF runtime

The tested Windows runtime is the unmodified veraPDF 1.30.3 CLI JAR with Eclipse Temurin JRE 21.0.13+9. It runs `java.exe` directly, without BAT/CMD or a system Java installation. The signed installer was unpacked as files; its installer was never executed.

```json
{
  "schemaVersion": 1,
  "engines": {
    "verapdf": {
      "path": "temurin21/jdk-21.0.13+9-jre/bin/java.exe",
      "sha256": "f8dc082a7dedbfd2924c3562405a5a1fd12efd2641808c92e2de819c76a58b7e",
      "launch": {
        "kind": "java-jar",
        "jar": "verapdf-1.30.3/bin/cli-1.30.3.jar",
        "sha256": "19f6edd5c92841a38d9b3b018a555b7ba173b13e4e0d29edecc232e5ba6c1d70"
      },
      "validation": {
        "status": "conformance-smoke-passed",
        "detail": "Verified against the pinned PDF/A and PDF/UA pass/fail corpus; machine checks only."
      }
    }
  }
}
```

Both hashes are checked before discovery launches the component. Relative paths are confined to the manifest directory, including real-path checks against linked escapes. JAR launch arguments are fixed by the bridge; the manifest cannot add JVM arguments or Java agents. The process gets a fresh private home/configuration/temp folder, a 256 MiB Java heap limit, two active processors, and a 60 second deadline. The first cold start can be slow. Inputs are limited to 128 MiB, output is bounded to at most 4 MiB, and exceeding a budget returns an incomplete result. These are process and heap limits, without an operating-system sandbox claim.

The bridge validates an independent PDF copy and verifies the source hash afterward. It supplies `--maxfailures -1` so checking does not stop at a configured failure count; `--maxfailuresdisplayed 10` bounds displayed details. Inherited Java option/agent variables are cleared. A full JSON report must contain exactly one matching input job, normal completion, strict per-profile boolean results, valid counters, matching summaries, and a consistent exit status. Exit 0 can pass; exit 1 can be a completed noncompliance result. Parsing failure 7, memory failure 3, cancellation, timeouts, malformed reports and contradictory reports remain incomplete.

Process deadlines are relative to the caller's event loop, rather than an absolute OS wall-clock guarantee across native spawn or event-loop stalls. An interrupted operation returns after a one-second cleanup grace even if Windows termination or pipe closure is delayed. `cleanup.status: 'pending'` means process cleanup is unconfirmed; private input, output and profile folders are retained until tree termination acknowledgment and process closure are both confirmed. The executable refuses replacement jobs meanwhile, and running plus uncertain jobs share an eight-process cap. A late exit zero remains interrupted. Windows termination runs in a separate trusted worker; its requested 16 MiB helper heap limit is best effort because inherited Node startup heap flags can override it. The helper never parses documents.

The app's **Document engines** controls expose the profile selector and **Validate PDF standard** action. Automatic mode checks declared profiles supported by veraPDF; absent or invalid declarations default to PDF/A-1b. An explicit profile checks only that profile. The returned profile IDs describe completed machine checks and do not imply that every accessibility requirement was examined.

## API and CLI

```js
import { discoverEngines, checkPdf } from '@vantage/engine-bridge'
const options = { manifestPath: '/absolute/engines/engines.json' }
const engines = await discoverEngines(options)
const result = await checkPdf('/absolute/document.pdf', {
  ...options,
  engine: 'verapdf',
  flavour: 'ua1',
})
// result.status: pass | fail | incomplete
// result.conformance: { complete, requestedFlavour, profiles, reason }
// result.sourceSha256 and result.sourceUnchanged
```

```text
node packages/engine-bridge/src/cli.mjs --manifest /absolute/engines.json engines
node packages/engine-bridge/src/cli.mjs --manifest /absolute/engines.json check-pdf /absolute/document.pdf verapdf 1b
node packages/engine-bridge/src/cli.mjs --manifest /absolute/engines.json check-pdf /absolute/document.pdf qpdf
```

`VANTAGE_ENGINE_MANIFEST` is also supported. Shell discovery uses that override for development and `resources/engines/engines.json` for a packaged app. Existing native qpdf and LibreOffice executable settings remain supported. A custom native veraPDF executable can be used, but shell scripts are rejected.

The desktop package also ships the complete standalone bridge source and launchers:

| Platform | Launcher relative to the application                   |
| -------- | ------------------------------------------------------ |
| Windows  | `resources/engine-bridge/bin/vantage-engines.cmd`      |
| Linux    | `resources/engine-bridge/bin/vantage-engines`          |
| macOS    | `Contents/Resources/engine-bridge/bin/vantage-engines` |

Invoke a launcher with the same commands, for example `engines` or `check-pdf "/path to/document.pdf" verapdf ua1`. It uses the app's bundled Electron/Node runtime and the adjacent `resources/engines/engines.json` (`Contents/Resources/engines/engines.json` on macOS), including after the app folder moves. The packaged launcher fixes this manifest and ignores inherited engine executable overrides. Missing packaged manifests fail explicitly. Stage the validated engine distributions before acceptance. Source CLI invocation with `--manifest` remains available for custom local components. Packaging includes Apache license text, upstream notice, README, all source modules and launcher files; it installs no global PATH entry.

## Verified upstream files and source

| Distribution                                                                                                 | Archive SHA256                                                     | Verification                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [veraPDF 1.30.3](https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.3-installer.zip)         | `b512bf24945503a33fc10738ecffc1f2dccaaf8593a448e94ee9ac86a9559a59` | Good detached signature, fingerprint `13DD102B4DD69354D12DE5A83184863278B17FE7`, matching the [official instructions](https://docs.verapdf.org/install/). |
| [Temurin 21.0.13+9 Windows JRE](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9) | `2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628` | Matches the official Adoptium API metadata and published checksum file.                                                                                   |

veraPDF is dual licensed MPLv2+ / GPLv3+. The package retains both upstream license files, the JAR's dependency licenses/notices, and `SOURCE.json` with release and source references. The app source tag resolves to commit `7d9b5c3f709846ab83f86ca1a538b24eac2d3f72` in [veraPDF-apps](https://github.com/veraPDF/veraPDF-apps/commit/7d9b5c3f709846ab83f86ca1a538b24eac2d3f72). The private Temurin runtime retains its complete `legal/` tree, including GPLv2 and the Classpath Exception. Its `release` file records source `2ab10ca20c19` in [adoptium/jdk21u](https://github.com/adoptium/jdk21u/tree/2ab10ca20c19) and build-source commit `1cf43d7a3e77886bfea7d550a902e151a87d724d`.

## Packaging and acceptance

```text
node tools/stage-engine-package.mjs --package UNPACKED_ROOT --manifest VERIFIED_QPDF_MANIFEST --additional-manifest VERIFIED_VERAPDF_MANIFEST --evidence STAGING_REPORT.json
node tools/validate-specialist-engines.mjs --manifest COMBINED_SOURCE_MANIFEST --fixtures PINNED_FIXTURE_DIRECTORY --evidence ACCEPTANCE_REPORT.json
```

Staging requires `structural-smoke-passed` for qpdf and `conformance-smoke-passed` for veraPDF. It copies complete distribution trees, requires legal/source files, verifies every copied file hash, rejects altered existing files and linked entries, and writes a relative manifest. It changes only `resources/engines`, leaving `app.asar` untouched. LibreOffice is skipped. Omitting the additional manifest preserves qpdf-only staging.

The real acceptance helper runs four official [CC-BY-4.0 corpus](https://github.com/veraPDF/veraPDF-corpus) fixtures pinned to `bb75f4f0073d9350dfd058c0162a367e6fadf25e`: PDF/A-1b pass/fail and PDF/UA-1 pass/fail. It also checks malformed PDF, an owned-process deadline and a deliberately small-heap Java failure. Every source hash is retained. qpdf accepts the structurally valid noncompliant fixtures, confirming the different scopes. This is a focused integration smoke, not comprehensive standards certification.

Unit tests include normalized reports captured from that actual runtime, malformed/contradictory reports, path/hash/JVM-argument refusals, and complete distribution staging. GUI acceptance is `e2e/pdf-standards.spec.ts`, with `VANTAGE_TEST_ENGINE_MANIFEST` and `VANTAGE_TEST_VERAPDF_FIXTURES` set to the verified runtime and corpus. An absent external runtime is recorded as unavailable, never treated as standards acceptance.
