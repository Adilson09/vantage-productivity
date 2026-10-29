# Save, history, draft and backup contract

The JavaScript buffer, copy and streaming writers and the native Sheets archive publisher share `packages/electron-utils/src/atomic-write.ts`. Native serialization runs inside the same per-path queue as publication. The queue carries the destination fingerprint across nested serialization and publication, so a writer cannot accidentally reset its conflict baseline after producing its output.

## Publication

1. Capture the destination metadata and, for files up to 32 MiB, its SHA256. Streamed hashing enforces both the initial size and a 32 MiB actual-read ceiling.
2. Complete the new output in a distinct temporary file beside the destination. Flush it, with unsupported-filesystem flush errors reported by the documented best-effort policy.
3. Check the destination fingerprint, capture and verify the prior version, and recheck immediately before publication.
4. Retry transient rename locks within a fixed budget. Never fall back to truncating the existing destination. A refused publication raises `AtomicSaveError` with a completed retained rescue path. Native Sheets callers retain this path too.
5. After first publication, capture a baseline only when its hash matches the completed new output. A baseline failure does not misreport an already published document as unsaved. It is available through `getAtomicSaveReports()` as a published-save warning.

The fingerprint check plus rename is not an operating-system compare-and-swap across competing processes. Larger files receive metadata conflict checks rather than unbounded hashing. Team check-out is a separate capability. Each editor still needs its own open/edit/serialization/reopen acceptance.

## History and storage

Retention preferences are stored in `recovery/policy.json`, validated at every operation and bounded by hard ceilings: 32 MiB per file, 2 GiB payload budget, 384 entries and 100 versions per file. Defaults remain 128 MiB, 128 entries and ten versions, plus a 64 MiB free-disk reserve. Status separates payload, total occupied space and orphan payloads; metadata and drafts do not masquerade as document payload capacity. Invalid or unreadable settings fail closed. Existing snapshots remain visible after a budget reduction; subsequent capture prunes to the new policy.

Recovery returns a separate new file after checking size and SHA256. NTFS publishes the new copy with an exclusive hardlink. Filesystems such as exFAT, which do not support hardlinks, use an exclusive copy, flush and byte verification. Neither path overwrites an existing destination. A process crash during the exFAT copy can leave a partial **new** destination; a successful function return certifies the full verified bytes. Source documents and stored recovery payloads remain unchanged.

## Encryption and portable recovery

Optional local recovery protection uses AES-256-GCM with a random 256-bit application key protected by Electron `safeStorage`. Keys remain in the main process. Nonces are fresh per payload and the version marker is authenticated. Missing or corrupt existing protected keys fail closed. Enabling encryption protects new payloads; existing plaintext versions remain plaintext and the UI reports their count. Paths and version metadata are not encrypted. This does not protect against another application running as the same OS user.

A portable `.vantagebackup` encrypts saved-version history with scrypt-derived AES-256-GCM. It has fixed, versioned derivation parameters, password validation, manifest and payload limits, authenticated decryption and individual SHA256 checks. Restore is to separate new copies. The export is limited to 128 MiB of document payload. This is a history backup, not complete device/application backup, and losing the password loses access to that export.

## Unsaved drafts

A separate bounded journal protects up to 64 drafts, 16 MiB per draft and 128 MiB total. Metadata is committed only after a complete flushed payload. Updates discard the replaced payload only after committing its new metadata. Explicit discard invalidates pending writes with an epoch so they cannot resurrect a draft. Restores check hashes and create new copies. The journal uses the same optional recovery cipher.

The Markdown editor records its actual serialized dirty text every 15 seconds and on blur, including unnamed documents. A journal tick does not save over the document or clear dirty state. Save/clean acknowledgment and explicit Don't Save clear its draft; a crashed process leaves it available in Workspace Recovery settings. Draft assets such as newly pasted images are not included in this text-only journal. Other editors retain their existing recovery paths; adopting this shared unsaved journal in all six modules requires further integration and editor-specific fixtures.

## Validation boundary

Focused filesystem tests cover publication locks, complete rescue retention, first-save baselines, configurable pruning, disk reserve, encrypted payload tampering, missing-key behavior, password backup restore drills, draft corruption and discard races, and external modifications during streaming/native serialization. `e2e/recovery-drafts.spec.ts` drives real unnamed Markdown typing, journal timer, process termination and relaunch, exact-byte separate-copy restore and explicit discard. Its result must be recorded separately from unit/contract results.

## Unmodified Markdown source retention

The default editor now retains the exact loaded UTF-8 source for Save/Save As only when its clean flag, immutable document model and envelope fingerprint all still match. This protects mixed line endings, BOM, frontmatter, raw HTML and reference syntax without changing the experimental round-trip preference. Real edits keep the existing block-splice/serializer path. Source-pane edits invalidate old raw snapshots. Save As still relocates assets and rewrites their references, then records the actual written text as the next clean baseline. The GUI regression test covers a default-off no-op Save As, an actual edit, save and reopen; helper/filesystem cases separately cover legitimate image relocation.
