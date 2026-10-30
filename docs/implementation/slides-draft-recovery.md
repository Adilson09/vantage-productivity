# Slides draft recovery

Slides records a self-contained presentation package in the profile's private
recovery journal every 30 seconds when there are changes. This includes unnamed
presentations with AutoSave off. Recovery does not create unnamed files in the
normal document folder or silently write back to an imported presentation.
Ordinary Save and the optional AutoSave preference retain their existing roles.

The renderer captures pending rich text without moving its caret, pending table
cell text, speaker notes with their loaded baseline, and pending master/layout
text. The main process copies the current deck and ZIP entries before applying
these edits through the ordinary presentation operations. Every committed
master/layout operation already writes its part into the in-memory archive;
the copy therefore also includes committed geometry, fill and other part edits
while master view remains open. Original media, relationships and unknown ZIP
parts travel with the complete package. Recovery never invokes the ordinary
serializer on the live `OpenedPptx`, so it cannot change that object's save
snapshot or acknowledge edits on a normal save's behalf.

If typing resumes while an own notes write is awaiting its receipt, only the new
draft's baseline advances, and only when the part, previous baseline and exact
submitted read-back match. Its newer text stays intact. A peer replacement,
different part or differently normalized receipt remains a visible conflict.

Notes reads also carry presentation, part, load and edit generations. A late
read cannot replace text typed while it waited, or text from a newly active
slide or presentation. Initial notes editing waits for a known baseline with
a labelled loading state; a same-part reload stays editable. A new part waits
for an already-running previous-part flush, whose failed pending text remains
available for recovery. Notes get/set calls can name the persisted part as well
as an index. The main process resolves that name at the actual synchronous read
or mutation, so reordering slides does not redirect a queued notes write.
Invalid or missing parts are refused without falling back to another slide.
Batch-result baseline comparisons keep the pending notes reference live, so
recovery and Save never mistake a pending comparison for empty notes. Flushes
wait for the latest comparison. Source and reconciliation epochs reject old
callbacks, and a read failure leaves the latest pending text intact with visible
feedback instead of restoring another presentation's notes. A failed comparison
remains a fence: a later Save or blur retries the persisted baseline before it
can write. A conflicting peer baseline keeps the pending text and refuses the
write.

Undo and Redo decisions also advance a separate notes history epoch. Flushes
queued before that decision cannot restore an obsolete failed draft, mark newer
state dirty, or replace the new baseline with a late receipt. The selected
slide reloads its known baseline before editing resumes; newer notes typed after
that reload remain independent of older in-flight replies.

Each view has its own activation token and monotonically increasing sequence,
bound to the actual main-process Session identity. Views sharing a presentation
can have different pending editors, so saving or discarding one view clears only
that view's recovery entry. Peer entries remain until explicitly discarded or
acknowledged by their own view. A rename updates the session's active view paths.
A successful document replacement activates a new producer, including generated
whole-deck replacements. Canceled or failed Open does not activate a candidate.

The renderer observes the source revision before capturing pending content. The
write request carries a revision covering both semantic operations and the
identity of the parsed deck. A queued request is checked before capture and again
after serialization, before entering the journal writer. If the Session changed,
the older overlay is refused with visible retry feedback and the previous journal
is retained. This is a snapshot, not a guarantee that every edit made after capture
has already reached storage.

Root Recovery invalidates an active producer synchronously and notifies its view
before waiting for journal deletion. An unchanged pending editor remains
suppressed after this decision; new actual content or a new main revision can
start a fresh activation. A failed deletion preserves the previous journal and
restores the producer while retaining the old sequence watermark. Close waits
for text and notes commits before deciding whether the view is clean. A commit
failure or newer edits arriving during Save keep the presentation unsaved.

Capture checks the complete model/archive against a 64 MiB graph budget, 10,000
ZIP parts and 200,000 inspected nodes. Pending edits have a 1 MiB budget and
50,000-node limit. Only one full package capture/serialization runs at once;
queued requests are limited to 16 and 8 MiB including bounded metadata. Complete
compressed payloads are limited to 16 MiB and use the shared journal's storage,
integrity and retention rules. These are payload and work limits, not a hard
process-memory or CPU ceiling. A limit or storage failure leaves the previous
complete recovery package intact and shows feedback in the editor.

Encrypted PowerPoint packages and legacy binary `.ppt` remain unsupported by
the Slides importer. This implementation adds no password-protected PPTX import,
VBA execution, online collaboration, or external provider writes. The shared
journal's configured local protection policy applies independently of the
presentation format.

Focused source tests cover real pending DOM capture, timer/discard behavior,
alias and save races, committed and pending master/layout changes, package limits,
and the normal serializer's save acknowledgments. A separate owned Node process
publishes a package containing text, notes, an embedded PNG and an unknown part;
the test kills that process, restores an exclusive copy and reopens it. The
desktop specification `e2e/slides-draft-recovery.spec.ts` exercises three real
timer snapshots, a 35-second discard quiet period, an owned application crash,
same-profile restart, restore and reopen. Its desktop acceptance must be recorded
separately after a matching coordinated application build; authored tests alone
are not a passed desktop result.
