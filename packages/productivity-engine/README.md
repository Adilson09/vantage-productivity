# Vantage local productivity engine

This package adds working database, calendar/contact, document checkout and optional provider workflows. The desktop engine tools and the suite CLI call the same APIs.

## Local database

`VantageDatabase` creates versioned `.vdb` SQLite files. It supports typed tables, transactional record imports, optimistic record update/delete versions, parameterized read-only queries, saved form definitions, escaped form rendering, escaped HTML reports and quoted CSV exports. New database creation is exclusive; opening an unrelated SQLite database is refused. SQLite is the open source database engine, exposed through the bundled Node runtime's `node:sqlite` binding.

Interactive SQL should use `queryDatabaseIsolated`: a separate native `vantage-query-worker` uses the existing pinned rusqlite/bundled SQLite engine. It enables SQLite memory accounting before initialization, then applies a 64 MiB SQLite allocator limit. Input is limited to 256 KiB including framing, SQL to 32 KiB, rows to 10,000 and the complete JSON response to 2 MiB. Large database files remain paged; there is no database-file size cap. Cells are inspected before copying or base64 encoding. A deadline and held-open cancellation pipe bound each owned query; parent EOF terminates the helper independently of the query and stdout flush locks. This is a SQLite allocation limit, not a total Rust/process RSS limit or an OS sandbox. No Node SQLite query fallback runs when the native helper is missing. The synchronous `query` method remains for trusted caller-controlled queries and has no CPU time limit. The application runtime is Node 24.19; native compile/tests are an explicit build prerequisite. This is a Vantage database application model, without Access form/report/VBA file compatibility.

## Calendar and contacts

ICAL.js 2.2.1 (MPL-2.0) supplies the mature RFC calendar/contact parser and recurrence model. `inspectCalendar`, `expandCalendar`, `createCalendar`, `updateCalendarEvent`, `exportCalendar`, `parseContacts` and `exportContacts` support local iCalendar 2.0 and vCard 3.0/4.0 workflows.

Moment-Timezone 0.6.6 and Moment 2.30.1 (MIT) supply pinned transition data, not the machine's changing ICU database: tzdb 2026f contains 597 IANA names/aliases. A per-document adapter respects embedded VTIMEZONE definitions first, including historical offset seconds, without contaminating other calendars. Missing recognized IANA definitions use the pinned data. Unrecognized names need an embedded definition. New zoned exports include the published transition data as VTIMEZONE components.

Calendar recurrence supports all seven RFC frequencies, EXDATE/RDATE (including explicit PERIOD duration), detached moved/cancelled exceptions and bounded THISANDFUTURE time/text shifts or cancellation. Rule-generated nonexistent local times are excluded without consuming COUNT. Imported repeated times use the first occurrence and imported gaps use the preceding offset, as RFC5545 specifies. Interactive new wall times reject folds/gaps unless the caller chooses `earlier`, `later` or `compatible`; later-fold nonrecurring instants use UTC because ICS has no fold flag. A later-fold recurring start requires an explicit UTC series or separate instance exception. All-day exclusive ends and floating wall labels remain explicit; `viewTimeZone` controls their range filtering.

Sources are capped at 4 MiB, 50,000 lines and 5,000 components; UIDs at 1,024 bytes and attendees at 256/event. Occurrences have count/iteration/cooperative time limits and a 4 MiB aggregate response budget. Limit exhaustion fails visibly. Untrusted parser/iterator work belongs in the separately bounded calendar worker; a synchronous API deadline alone cannot interrupt a library call before it yields. No-op export retains original bytes, including a BOM and unknown properties. Edits preserve unknown properties, parameters and components but normalize serialization. Imported alarms, invitation files, attachments and URLs are never executed. Unsupported legacy EXRULE expansion, undefined multiple-RRULE semantics, series schedule changes with detached overrides and future-range rule/zone changes refuse instead of silently dropping data. Full live invitations/delegation, account refresh/write queues and CalDAV/CardDAV interoperability remain separate work.

## Persistent local calendar workspaces

`CalendarWorkspace(path,{create?})` uses an application-identified, private SQLite file. `create:true` is exclusive; existing files are never replaced. It implements `CalendarWorkspaceApi` from `src/calendar-types.ts` with primitive DTOs:

- `createCalendar({name,source?})`, `importCalendar(source,{name,originPath?,originSha256?})`, `listCalendars()` and `readCalendar(id)` retain full source privately. Calendar lists contain summaries, not source bodies.
- `occurrences(id,options)`/`allOccurrences(options)` return rich event instances, including calendar revision, stable instance ID, original recurrence ID, start/end/local wall labels, organizer and attendee state. `eventDetails(id,{uid,recurrenceId?,scope?})` provides the selected master/instance without parsing in a renderer.
- `mutateCalendar(id,mutation,{expectedRevision,queueMethod?})` applies create/update/delete/respond atomically. Stale revisions fail. A series with detached overrides can keep text/participant edits; schedule/rule changes require an explicit series split. `renameCalendar`/`removeCalendar` also require the observed revision.
- `applySchedulingMessage(id,ics,{expectedRevision})` applies local PUBLISH/REQUEST/REPLY/CANCEL files. Organizer mismatch, uninvited responses and stale sequences/timestamps fail or are explicitly ignored. Replies preserve the organizer's sequence; organizer changes/cancellations advance it. Incoming unsupported methods are never silently treated as requests.
- `exportCalendar(id)` retains unchanged source. `exportToFile(id,path,{expectedRevision,expectedOriginSha256?})` holds a SQLite writer transaction through shared atomic file publication, fences concurrent in-process edits, and checks destination fingerprints. SaveAs keeps an imported origin path/hash; the first export of a new local calendar establishes its origin. The workspace database itself cannot be an export destination. A post-publication metadata failure explicitly reports that the file was exported; it never pretends no change happened.
- `listOutbox()` contains no source bodies. `exportOutboxMessage(id)` exports local scheduling bytes; `discardOutbox(id)` releases them. No real send/notification/credential transport exists. `runLocalTestTransport({kind:'local-test',deliver})` and attempt/ack APIs are for explicit local tests, with attempt fencing and deadlines. Its delivered state means local test completion, not a received invitation.

The store caps 100 calendars and 20,000 VEVENT definitions. The outbox caps 256 active messages and 64 MiB; completed/discarded payloads are released and metadata history is bounded. Mutations plus queued payloads commit together, so a quota error preserves the prior calendar. Independent clean-machine, live-provider and full calendar-client interoperability acceptance are not established by these local contracts.

Primary references: [RFC5545 date/time](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.5), [recurrence](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10), [RFC5546 sequencing](https://www.rfc-editor.org/rfc/rfc5546.html#section-2.1.5), [cancellation](https://www.rfc-editor.org/rfc/rfc5546.html#section-3.2.5), [Moment-Timezone data guidance](https://momentjs.com/timezone/guides/) and [official source/license](https://github.com/moment/moment-timezone).

## Cooperative document checkouts

`DocumentCheckoutRegistry` uses SQLite transactions to coordinate participants that share the same registry file. A lease has an unpredictable bearer token, owner display name, SHA-256 baseline and expiry. Reconnect/renew keeps the same lease; invalid tokens and expired owners cannot publish. Publication checks the source hash, retains outside changes and writes local edits to a separate conflict copy. A completed temporary file is retained if replacement fails. Actual reads and writes are capped at 32 MiB.

The CLI `checkout` command supports reserve/list/verify/renew/release/publish. Private lease JSON holds the bearer token and is created with restrictive permissions; the token is omitted from output and audit arguments. `VANTAGE_CHECKOUT_TOKEN` may override the stored token. Protect this file like a local credential. Owner names are labels, not authenticated identities. Existing editor saves do not implicitly join this registry. SQLite locking on network filesystems depends on the filesystem; this is not a server permission system or real-time coauthoring. A nonparticipating application can still race the final check/rename. One hundred deterministic multi-session trials and one independent process check exercise this local protocol; they are not one hundred network coauthoring trials.

## Optional read-only providers

`syncGraphMail`, `syncGmailMail` and `syncGoogleCalendar` implement real REST adapters. No provider is contacted unless explicitly enabled by its caller. Requests use HTTPS, a fixed authorized API origin, GET only, redirect refusal, cancellation, bounded retries honoring Retry-After, response byte limits, a whole-sync deadline and paging/item ceilings. Checkpoints are returned only after complete paging and metadata hydration. Expired checkpoints are explicit failures, with existing local state untouched. Google Calendar cancelled recurrence exceptions are retained to suppress the correct occurrence.

The suite CLI `provider info` lists required scopes and token environment names. `provider sync --enable` requires explicit account-read authorization for that invocation and reads tokens only from `VANTAGE_GRAPH_TOKEN`, `VANTAGE_GMAIL_TOKEN` or `VANTAGE_GOOGLE_CALENDAR_TOKEN`, never from flags. Sync records are published before advancing an optional checkpoint file. Partial sync leaves the checkpoint unchanged. Output files contain mailbox/calendar metadata and belong in a private location. These adapters do not migrate native Mail profiles, implement OAuth registration/refresh, send messages, or claim live provider interoperability. Tests use injected mock transports and synthetic credentials only.

Primary API references:

- [Microsoft Graph message delta](https://learn.microsoft.com/en-us/graph/api/message-delta)
- [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)
- [Gmail history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list)
- [Google Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)
- [ICAL.js upstream and license](https://github.com/kewisch/ical.js)
- [Node SQLite for trusted database CRUD](https://nodejs.org/api/sqlite.html)
- [SQLite hard heap limits and required memory accounting](https://www.sqlite.org/c3ref/hard_heap_limit64.html)
- [Pinned native rusqlite provider](https://docs.rs/rusqlite/0.40.2/rusqlite/)

## Examples

Run through `npm run productivity --` from the source root, or the packaged `vantage` CLI:

```text
calendar read calendar.ics
calendar expand calendar.ics --start 2026-10-29T00:00:00Z --end 2026-11-29T00:00:00Z
contacts read contacts.vcf
database create records.vdb --schema tables.json
database insert records.vdb --table Sales --rows records.json
database query records.vdb --sql "SELECT Customer,SUM(Amount) AS Total FROM Sales GROUP BY Customer"
database report records.vdb --sql "SELECT * FROM Sales" --out report.html
checkout reserve document.md --registry shared-locks.sqlite --owner Editor --lease private-lease.json
checkout publish --registry shared-locks.sqlite --lease private-lease.json --source prepared.md
provider info
provider sync graph-mail --enable --out changes.json --checkpoint-out graph-state.json
```

Schema JSON is an array of `{name,columns:[{name,type,required?}]}`; types are `TEXT`, `INTEGER` and `REAL`. Record JSON is an array of field/value objects. New document exports refuse existing destinations. Provider sync requires a consented token in the named environment variable.
