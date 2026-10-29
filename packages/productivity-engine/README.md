# Vantage local productivity engine

This package adds working database, calendar/contact, document checkout and optional provider workflows. The desktop engine tools and the suite CLI call the same APIs.

## Local database

`VantageDatabase` creates versioned `.vdb` SQLite files. It supports typed tables, transactional record imports, optimistic record update/delete versions, parameterized read-only queries, saved form definitions, escaped form rendering, escaped HTML reports and quoted CSV exports. New database creation is exclusive; opening an unrelated SQLite database is refused. SQLite is the open source database engine, exposed through the bundled Node runtime's `node:sqlite` binding.

Interactive SQL should use `queryDatabaseIsolated`: an independent Node process enforces a deadline, a 64 MiB SQLite allocator ceiling, a 96 MiB JavaScript heap ceiling, read-only file access, bounded results and bounded output. The synchronous `query` method is for trusted caller-controlled queries and has no CPU time limit. Node 22.13 is supported; runtimes predating `Statement.columns()` cannot report column names for an empty result. This is a Vantage database application model, without Access form/report/VBA file compatibility.

## Calendar and contacts

ICAL.js 2.2.1 (MPL-2.0) supplies the mature RFC calendar/contact parser and recurrence model. `inspectCalendar`, `expandCalendar`, `createCalendar`, `updateCalendarEvent`, `exportCalendar`, `parseContacts` and `exportContacts` support local iCalendar 2.0 and vCard 3.0/4.0 workflows.

Calendar recurrence supports daily, weekly, monthly and yearly rules, EXDATE/RDATE, detached moved/cancelled exceptions and embedded VTIMEZONE definitions. Unknown named zones are refused. All-day exclusive ends and floating wall times remain explicit. Expansion has occurrence and iteration ceilings; limit exhaustion is an error, rather than a silently successful partial calendar. Input is capped at 4 MiB, 50,000 lines and 5,000 components. No-op calendar export retains original bytes and unknown properties; edited output normalizes serialization. Imported alarms, invitations, attachment references and URLs are never executed. Provider invitations, shared-calendar permissions, offline write queues and CalDAV/CardDAV sync are additional work.

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
- [Node SQLite](https://nodejs.org/api/sqlite.html)

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
