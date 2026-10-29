<!-- Aster Office modification (2026): fork-specific preview guide; original retained in README.upstream.md. -->

# Aster Office — Windows preview

Aster Office is an experimental desktop office suite based on
[GenOffice](https://github.com/genspark-ai/genoffice). It retains the six real
editors and adds a distinct workspace, document inspection, local recovery
history, and the Aster Mail companion. It is a preview, with no demonstrated claim of superiority to
Microsoft Office or complete file compatibility.

The original project README is preserved unchanged as
[README.upstream.md](README.upstream.md), including its original relative
links. Upstream descriptions and download links describe GenOffice, not an
Aster release. See [preview scope and release gates](docs/ASTER_PREVIEW.md)
before using this build for important work.

## What is included

| Editor        | Inherited foundation                                  |
| ------------- | ----------------------------------------------------- |
| Documents     | Editable DOCX files, document layout and OOXML engine |
| Spreadsheets  | XLSX editor, formula handling and native Rust sidecar |
| Presentations | PPTX editor, slide rendering and presentation tools   |
| PDF           | PDF editing and local conversion tools                |
| Markdown      | Markdown editing and export tools                     |
| HTML          | HTML source and preview editing                       |

These engines are inherited from GenOffice. Aster does not claim to have
invented their capabilities or verified every upstream feature.

Version **0.13.0** also includes **Aster Mail**, based on
[Depesha 0.8.17](https://github.com/fgbm/depesha). Mail opens as a separate native
application from its Home card or the **Open Aster Mail** command. The original
six document editors remain available in the same workspace.

Aster adds:

- A workspace with **Create document**, **Create spreadsheet**, **Create
  presentation**, **Create PDF**, **Create Markdown**, **Create HTML**, local
  file context and the existing file browser/search/settings.
- **Ctrl+K** command discovery with arrow keys, Enter and Escape. The shortcut
  uses Command on macOS, though this preview targets Windows.
- A local inspector for selected DOCX, XLSX, PPTX, PDF, Markdown and HTML files.
  It reports actual checks, the file path and inspection time; it does not
  assign a compatibility score.
- Previous-version snapshots and recovery into a separate new file, with
  stricter shared save publication.

## Use the intended Windows portable preview

When a portable artifact is provided, extract the **entire folder** into a
writable location and run its included Aster Office executable. Keep the
resources and native helpers beside it; copying only the executable will
break the suite. A packaged build does not require Node.js, npm or Rust on
the user's computer.

Use **Open file** or a creation button on Home. The command palette also
opens the inspector and recovery vault. Save a recovered version under a
new filename, then choose **Open recovered copy** if needed.

## Set up mail

Choose **Open Aster Mail** on Home or in the command palette. Add your accounts
inside Aster Mail. Its inherited capabilities include IMAP/SMTP and Exchange EWS;
authentication and server compatibility depend on your provider.

For Gmail, choose **Sign in with Google**. Aster Mail opens Google's sign-in and
consent page in your default web browser. After approval, its local callback
returns authorization to the app. Google authorization uses PKCE and the mail
permission required for IMAP/SMTP; the refresh grant is stored through the
system credential store. The Gmail setup path does not ask for your regular
Google password.

This build uses the Google Desktop app registration supplied by the owner.
That registration is currently in Google's **Testing** mode, so the account must
be listed under the project's **Test users**. A Google Workspace administrator
may also control access. Source builds can configure their own Desktop client
in the app's Google sign-in setup; the private registration JSON is excluded
from the source archive. See Google's [desktop sign-in guide](https://developers.google.com/identity/protocols/oauth2/native-app).

For **403: access_denied** with “currently being tested,” select this client's
project in Google Cloud, then open **Google Auth Platform → Audience → Test users
→ Add users**, add the intended Gmail account, and save. In Aster Mail, cancel
the pending attempt and choose **Sign in with Google** again. Google documents
this restriction in [Manage App Audience](https://support.google.com/cloud/answer/15549945).

No account is added automatically. Verification uses local mocked sign-in
responses and new test profiles; no real mailbox or outgoing message is used.

The mail companion requires **Microsoft Edge WebView2 Runtime**. Its application,
data and credential identities use `org.asteroffice.mail`, separate from an
existing Depesha installation. Existing accounts and queued messages are not
imported automatically. Tests use a new `ASTER_MAIL_PROFILE` directory, including
separate web data, process locks and credential names. The bundled companion's
independent updater is disabled; update it with the Aster suite.

This portable package does not register the `aster-mail` system link scheme.
Opening a message from a Windows notification or another application through
that scheme requires a future installer/registration step. Open Mail from Aster
directly in this preview. Provider login, sending, receiving, notifications and
autostart have not been exercised with real accounts.

Original Depesha and its vendored parser licenses and notices are retained.
The source is included under `companions/depesha`; the built application and
its dependency notices are under `resources/mail` in the runnable package.

“Portable” describes the application folder, not a self-contained profile.
Packaged settings, caches and recovery history use `%APPDATA%\AsterOffice`
by default; development uses `%APPDATA%\AsterOffice-Dev`. Files remain in the
locations selected by the user. Clean-machine launch, signing, ZIP extraction
and complete desktop acceptance remain release gates. A source
checkout or a successful component test is not a ready-to-run portable build.

## Inspection and recovery limits

Inspection accepts regular files up to **32 MiB**. Office packages and detailed
text/XML inspection have additional complexity limits. PDF inspection checks
file markers only; it does not analyze pages, rendering or PDF accessibility.
The report is a structural/accessibility spot check, not an Office fidelity
or accessibility certification.

The vault records the **previous saved bytes** when Aster replaces an existing
supported document. A new document's first save has no previous version.
Previous versions larger than **32 MiB** are not captured. App data, caches,
settings and non-document assets are excluded. The vault keeps at most
**10 versions per file**, **128 snapshots**, and **128 MiB of document payload**;
snapshot metadata consumes additional space. Older snapshots are pruned as
limits are reached.

Recovery verifies the stored content and creates a separate file. The vault
adds no encryption: unencrypted documents remain unencrypted, and encrypted
original document bytes retain their encryption. This history does not
cover every command-line operation or exported image asset, and does not
establish recovery of every unsaved edit. Completed failed-save rescue files
are separate from the vault quota. Keep independent backups.

## Preview boundaries

New Aster workspace text is English. Existing upstream language and theme
support remains, but full localization of the new features is unfinished.
File fidelity, screen-reader use, large-file performance and broader desktop
failure scenarios require their documented acceptance runs.

The spreadsheet compatibility contract explicitly limits VBA to preservation;
VBA execution/editing and external data refresh are unsupported. Full Excel
function coverage, advanced pivots and PowerPoint animation fidelity have not
been established. Depesha supplies a separate mail application; an Outlook-style
calendar and Access-style database application are not included. No real-time
co-authoring service is validated. See the [detailed scope](docs/ASTER_PREVIEW.md).

Local file engines, optional local AI endpoints and remote AI/provider/account
features are inherited. Remote AI, web/media services, cloud features and
optional reranking can use the network. This preview does not claim a
suite-wide network block or universal offline privacy guarantee. Aster's
packaging configuration does not inject upstream analytics credentials or
an upstream update feed.

## Build from source on Windows

Use **Node.js 22.12.0 or newer** and **npm 10 or newer**, matching the root
`engines`. Install a current stable **Rust/Cargo** toolchain supporting the
2024 edition. Rust 1.85 introduced that edition, but the locked dependencies
may require a newer compiler; it is not a guaranteed minimum for this tree.

For the standard Windows x64 native build, use a complete **MSVC C++ build
toolchain** and **Windows SDK**, with the linker, headers and libraries
available in the build environment. The Sheets script passes
`apps/sheets/native/xlsx-engine/.cargo/config.toml` explicitly to enable
static MSVC CRT linking. Package the matching **release** sidecar; never
substitute a debug or wrong-architecture executable.

Windows packaging also compiles the OCR helper. It needs the .NET Framework
4.x compiler, Windows 10/11 SDK `Windows.winmd` metadata, and the
`System.Runtime.WindowsRuntime` reference assembly. The exact discovery
rules are in
[build-win.mjs](packages/pdf2docx/ocr-helper/build-win.mjs). System OCR also
depends on installed recognition languages.

From the repository root, after those prerequisites are available:

```sh
npm ci
npm run fixtures
npm run typecheck
npm test
npm run build:all
npm run test:e2e -- --grep "Aster workspace|new file from home|home screen"
```

`npm ci` must finish successfully, including Electron installation, before
running dependency-based tools. `npm run build:all` builds all editors, the
CLI and shell; the Sheets build invokes Cargo. Main-process changes require
rebuilding the shell, and preload changes require a rebuild as well.

For an unpacked Windows application directory after the build and notices:

```sh
npm run build:mail
npm run notices
npm exec -w @genoffice/shell -- electron-builder --win --dir
```

`npm run build:mail` separately builds the pinned source in
`companions/depesha`, checks its frontend, and stages the Windows x64 application,
build record and locked dependency notices in `companions/depesha-bin`. Run it
with the same MSVC/Windows SDK environment and WebView2 development prerequisites.
It uses two Cargo jobs and a static MSVC runtime. The mail binary and notices are
required for Windows packaging; `build:all` builds the six office editors only.
After changing either mail dependency lockfile, regenerate and review its
dependency notices before staging. Windows packaging fails if companion resources
are missing. Mac and Linux packaging do not bundle this Windows mail companion.

The existing `npm run dist:win` path generates notices, rebuilds all apps and
packages the configured Windows portable ZIP. The ZIP contains the complete
application folder; extract it before launching. Package/test results and hashes must accompany any
delivered artifact; the commands above are build instructions, not claims
that every gate has already passed.

## Origin and license

This fork starts from GenOffice commit
`b239d2e591d3fe2e7f079354f4f3d5b61f598800`. Core code is under
[Apache-2.0](LICENSE); retain [NOTICE](NOTICE) and generated third-party
notices. The separately licensed `ee/` directory is excluded from Aster
distribution. GenOffice/Genspark and Microsoft product names identify the
origin or comparison products; their names and logos are not Aster's brand.

Internal `@genoffice/*` package and CLI identifiers remain for compatibility.
They do not indicate that Aster is an official upstream release. Upstream
contributor information remains in [CONTRIBUTING.md](CONTRIBUTING.md).
