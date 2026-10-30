# Aster Sheet native ABI v1

The optional `native-ffi` feature exposes the synchronous Rust engine through
`include/aster_sheet.h`. Normal desktop builds continue to produce the sidecar;
the feature does not change default crate types or require a shared library.
A separate shared-library build can use:

```text
cargo rustc --release --locked --features native-ffi --crate-type cdylib --lib
```

Use the library built for the caller's operating system and architecture. This
ABI does not imply that the shared Node OOXML mutation adapter has been ported
to Rust. Native capabilities identify the available document/calculation/IO
operations. Calculation requiring materialization needs a revision-pinned export
through the preserving writer first.

## Calls and ownership

1. Check `aster_abi_version_v1() == 1`.
2. Call `aster_engine_create_v1(&handle)` with aligned writable `uint64_t` storage.
3. Initialize `AsterBufferV1 response = ASTER_BUFFER_V1_INIT`.
4. Call `aster_engine_request_v1(handle, utf8_bytes, byte_length, &response)`.
5. On status 0, read exactly `response.len` bytes and inspect the JSON envelope.
6. Call `aster_buffer_release_v1(response.handle)` exactly once. Never free or
   resize the returned pointer using another allocator.
7. Release the engine with `aster_engine_release_v1(handle)` when finished.

The request bytes are borrowed only during the call and are never retained.
They need not end with NUL. They must be readable, unchanged and non-NULL for
the entire call, including time spent waiting for an engine's prior request.
The output structure must be aligned, exclusively writable, initialized with
its size/version, and must not overlap the input bytes. Only its size/version
are read before initialization; other output fields need not contain readable
values. A larger structure declaring ABI v1 is accepted, but unknown tail fields
are untouched. Release a prior response before reusing its output structure.

Response storage belongs to its buffer handle. It remains valid after another
request or after engine release, until that buffer is released. This is an owned
response buffer, not a zero-copy view of live worksheet memory. Every nonzero
engine/buffer ID is unique for the library's loaded lifetime; released IDs are
never reused. Zero is reserved. Handles are process-local and are not persistent
document IDs or interchangeable across loaded library instances.

## Status values

| Value | Meaning                                                                   |
| ----- | ------------------------------------------------------------------------- |
| 0     | Request processed or resource operation succeeded                         |
| 1     | Null, misaligned output, invalid size, invalid UTF-8 or oversized request |
| 2     | Unknown, released or wrong-resource-type handle                           |
| 3     | Unsupported output ABI version                                            |
| 4     | Internal failure, poisoned mutex or contained unwinding panic             |

RPC validation, revision conflicts and workbook errors remain UTF-8 JSON
responses with `ok: false` and an `error` body, while the ABI call returns 0.
For an accepted output header, ABI failures leave an empty response. An invalid
output size/version leaves the supplied structure unchanged. No buffer release
is needed unless the call returned status 0 with a nonzero response handle.

## Bulk protocol

Each request is one complete JSON object using the existing transport:

```json
{ "version": 1, "requestId": "example", "command": "capabilities" }
```

Document checkpoint API versions are independent of the transport/ABI version.
Use `open_document`, `checkpoint_document`, `document_snapshot`,
`document_command_result` and `close_document` for complete typed document state.
Use the exposed revision-pinned calculation and preservation operations reported
by capabilities. Group values, formulas, formatting and document metadata into
bulk checkpoints; avoid one ABI request for every cell.

SDK range operations use zero-based, half-open coordinates. Existing legacy
viewport/recalculation range requests retain zero-based **inclusive** ends;
the C transport does not reinterpret those JSON fields. Consult the particular
command's contract. Text and JSON lengths are byte lengths, not character counts.
Input is capped at 256 MiB plus 1 MiB of framing, and each command also enforces
its own smaller collection, calculation, format and processing limits.

## Threads and failure boundaries

Different engines may run concurrently. Requests on one engine are serialized.
Global handle-table locks are released before engine processing or resource
destruction. Engine release removes the ID immediately: new calls receive status
2, while calls that already acquired an in-flight engine lease finish normally.
Do not read a response while another thread releases its buffer. Release and
caller-owned pointer access must be coordinated by the caller.

Rust unwinding panics are caught at every exported operation; poisoned locks
return status 4. This cannot contain process aborts, out-of-memory termination,
foreign exceptions, invalid pointer access, hardware faults, or a build configured
to abort on panic. The API is for trusted native callers and does not validate
arbitrary pointers or sandbox scripts. Untrusted automation needs a separate
restricted process and the brokered JSON protocol.
