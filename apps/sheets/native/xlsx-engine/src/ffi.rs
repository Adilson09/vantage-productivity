//! Optional allocator-neutral C ABI over the synchronous native JSON engine.
//! Pointer validity remains the trusted C caller's responsibility; null, size,
//! alignment, version and UTF-8 checks are not a process or memory sandbox.

use std::collections::BTreeMap;
use std::mem::size_of;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::protocol::Engine;

pub const ASTER_ABI_VERSION_V1: u32 = 1;
pub const ASTER_OK_V1: u32 = 0;
pub const ASTER_INVALID_ARGUMENT_V1: u32 = 1;
pub const ASTER_STALE_HANDLE_V1: u32 = 2;
pub const ASTER_UNSUPPORTED_VERSION_V1: u32 = 3;
pub const ASTER_INTERNAL_ERROR_V1: u32 = 4;
/// Complete 256 MiB checkpoints plus a bounded JSON transport envelope.
pub const MAX_FFI_REQUEST_BYTES: u64 = 256 * 1024 * 1024 + 1024 * 1024;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct AsterBufferV1 {
    pub struct_size: u32,
    pub abi_version: u32,
    pub handle: u64,
    pub data: *const u8,
    pub len: u64,
}

impl Default for AsterBufferV1 {
    fn default() -> Self {
        Self {
            struct_size: size_of::<Self>() as u32,
            abi_version: ASTER_ABI_VERSION_V1,
            handle: 0,
            data: ptr::null(),
            len: 0,
        }
    }
}

type EngineLease = Arc<Mutex<Engine>>;
static ENGINES: OnceLock<Mutex<BTreeMap<u64, EngineLease>>> = OnceLock::new();
static BUFFERS: OnceLock<Mutex<BTreeMap<u64, Box<[u8]>>>> = OnceLock::new();
// A shared ID space also prevents confusing an engine ID with a valid buffer
// ID. IDs are burned on failed allocations and are never recycled.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

fn engines() -> &'static Mutex<BTreeMap<u64, EngineLease>> {
    ENGINES.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn buffers() -> &'static Mutex<BTreeMap<u64, Box<[u8]>>> {
    BUFFERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn next_handle() -> Result<u64, u32> {
    NEXT_HANDLE.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| value.checked_add(1))
        .map_err(|_| ASTER_INTERNAL_ERROR_V1)
}
fn boundary(action: impl FnOnce() -> Result<(), u32>) -> u32 {
    match catch_unwind(AssertUnwindSafe(action)) {
        Ok(Ok(())) => ASTER_OK_V1,
        Ok(Err(status)) => status,
        Err(_) => ASTER_INTERNAL_ERROR_V1,
    }
}
fn engine_lease(handle: u64) -> Result<EngineLease, u32> {
    let table = engines().lock().map_err(|_| ASTER_INTERNAL_ERROR_V1)?;
    table.get(&handle).cloned().ok_or(ASTER_STALE_HANDLE_V1)
}

/// Checks only readable header fields. Caller-owned uninitialized result fields
/// are never read. A larger v1 struct is accepted; its unknown tail is untouched.
unsafe fn prepare_output(out: *mut AsterBufferV1) -> Result<(), u32> {
    if out.is_null() || !out.is_aligned() { return Err(ASTER_INVALID_ARGUMENT_V1); }
    // SAFETY: The C contract requires a live, aligned output structure with
    // readable size/version fields and writable storage for the declared size.
    let size = unsafe { ptr::addr_of!((*out).struct_size).read() };
    if size < size_of::<AsterBufferV1>() as u32 { return Err(ASTER_INVALID_ARGUMENT_V1); }
    let version = unsafe { ptr::addr_of!((*out).abi_version).read() };
    if version != ASTER_ABI_VERSION_V1 { return Err(ASTER_UNSUPPORTED_VERSION_V1); }
    unsafe { out.write(AsterBufferV1::default()); }
    Ok(())
}

/// Returns zero only if an unexpected unwinding failure crossed the constant
/// version lookup. Other exported functions use the typed status values.
#[unsafe(no_mangle)]
pub extern "C" fn aster_abi_version_v1() -> u32 {
    catch_unwind(|| ASTER_ABI_VERSION_V1).unwrap_or(0)
}

/// # Safety
/// out_handle must point to aligned, writable uint64_t storage. It must not be
/// concurrently accessed while this call writes its result.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aster_engine_create_v1(out_handle: *mut u64) -> u32 {
    boundary(|| {
        if out_handle.is_null() || !out_handle.is_aligned() { return Err(ASTER_INVALID_ARGUMENT_V1); }
        unsafe { out_handle.write(0); }
        let engine = Arc::new(Mutex::new(Engine::new()));
        let handle = next_handle()?;
        engines().lock().map_err(|_| ASTER_INTERNAL_ERROR_V1)?.insert(handle, engine);
        unsafe { out_handle.write(handle); }
        Ok(())
    })
}

/// # Safety
/// data must denote len readable bytes for the entire call, even while waiting
/// for another request on this engine. out must satisfy prepare_output's
/// structure contract and must not overlap data. The input is never retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn aster_engine_request_v1(
    handle: u64,
    data: *const u8,
    len: u64,
    out: *mut AsterBufferV1,
) -> u32 {
    boundary(|| {
        unsafe { prepare_output(out)?; }
        if data.is_null() || len > MAX_FFI_REQUEST_BYTES { return Err(ASTER_INVALID_ARGUMENT_V1); }
        let length = usize::try_from(len).map_err(|_| ASTER_INVALID_ARGUMENT_V1)?;
        if length > isize::MAX as usize { return Err(ASTER_INVALID_ARGUMENT_V1); }
        // SAFETY: Null and length bounds were checked. Actual pointer validity
        // and absence of concurrent writes are obligations of the C caller.
        let bytes = unsafe { slice::from_raw_parts(data, length) };
        let request = std::str::from_utf8(bytes).map_err(|_| ASTER_INVALID_ARGUMENT_V1)?;
        let engine = engine_lease(handle)?;
        // The registry lock is already released. A removed handle cannot start
        // a new request, but this in-flight Arc lease remains valid until done.
        let response = {
            let mut engine = engine.lock().map_err(|_| ASTER_INTERNAL_ERROR_V1)?;
            engine.handle_line_blocking(request)
        };
        if response.is_empty() { return Err(ASTER_INTERNAL_ERROR_V1); }
        let owned = response.into_bytes().into_boxed_slice();
        let buffer_handle = next_handle()?;
        let result = AsterBufferV1 {
            struct_size: size_of::<AsterBufferV1>() as u32,
            abi_version: ASTER_ABI_VERSION_V1,
            handle: buffer_handle,
            data: owned.as_ptr(),
            len: owned.len() as u64,
        };
        buffers().lock().map_err(|_| ASTER_INTERNAL_ERROR_V1)?.insert(buffer_handle, owned);
        // SAFETY: The validated output structure remains exclusively writable
        // until return. The registered allocation now owns the response bytes.
        unsafe { out.write(result); }
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn aster_engine_release_v1(handle: u64) -> u32 {
    boundary(|| {
        let engine = engines().lock().map_err(|_| ASTER_INTERNAL_ERROR_V1)?
            .remove(&handle).ok_or(ASTER_STALE_HANDLE_V1)?;
        // Last-owner destruction can close SQLite/indexing resources. Do it
        // after releasing the global table lock, never during registry lookup.
        drop(engine);
        Ok(())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn aster_buffer_release_v1(handle: u64) -> u32 {
    boundary(|| {
        let buffer = buffers().lock().map_err(|_| ASTER_INTERNAL_ERROR_V1)?
            .remove(&handle).ok_or(ASTER_STALE_HANDLE_V1)?;
        drop(buffer);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::{Value, json};

    use super::*;
    use crate::document::empty_payload;

    fn create() -> u64 {
        let mut handle = 0;
        assert_eq!(unsafe { aster_engine_create_v1(&mut handle) }, ASTER_OK_V1);
        assert_ne!(handle, 0);
        handle
    }
    fn request(handle: u64, value: Value) -> Value {
        let bytes = serde_json::to_vec(&value).unwrap();
        let mut out = AsterBufferV1::default();
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), bytes.len() as u64, &mut out) }, ASTER_OK_V1);
        assert_eq!(out.abi_version, ASTER_ABI_VERSION_V1);
        assert_eq!(out.struct_size as usize, size_of::<AsterBufferV1>());
        assert_ne!(out.handle, 0); assert!(!out.data.is_null());
        let result = serde_json::from_slice(unsafe { slice::from_raw_parts(out.data, out.len as usize) }).unwrap();
        assert_eq!(aster_buffer_release_v1(out.handle), ASTER_OK_V1);
        result
    }
    fn capabilities() -> Value { json!({"version":1,"requestId":"ffi-capabilities","command":"capabilities"}) }

    #[test]
    fn ffi_version_create_capabilities_and_monotonic_handles() {
        fn assert_send<T: Send>() {}
        assert_send::<Engine>();
        assert_eq!(aster_abi_version_v1(), 1);
        let first = create(); let second = create(); assert!(second > first);
        let result = request(first, capabilities());
        assert_eq!(result["ok"], true); assert!(result["result"].is_object());
        assert_eq!(aster_engine_release_v1(first), ASTER_OK_V1);
        assert_eq!(aster_engine_release_v1(second), ASTER_OK_V1);
        let third = create(); assert!(third > second);
        assert_eq!(aster_engine_release_v1(third), ASTER_OK_V1);
    }

    #[test]
    fn ffi_memory_document_rpc_keeps_types_and_isolates_engines() {
        let directory = tempfile::tempdir().unwrap(); let source = directory.path().join("source.xlsx");
        fs::write(&source, b"fingerprinted source, not executed").unwrap();
        let first = create(); let second = create();
        let opened = request(first, json!({"version":1,"requestId":"open","command":"open_document","apiVersion":1,"documentId":"ffi-document","sourcePath":source,"sheets":[{"id":"s","name":"Sheet1"}]}));
        assert_eq!(opened["ok"], true);
        let mut payload = empty_payload();
        payload["edits"] = json!([{"sheetId":"s","row":0,"column":0,"writeValue":true,"value":"12"},{"sheetId":"s","row":0,"column":1,"writeValue":true,"value":12}]);
        let saved = request(first, json!({"version":1,"requestId":"checkpoint","command":"checkpoint_document","apiVersion":1,"documentId":"ffi-document","commandId":"one","expectedRevision":0,"actor":"c-sdk","payload":payload}));
        assert_eq!(saved["ok"], true); assert_eq!(saved["result"]["revision"], 1);
        let snapshot = json!({"version":1,"requestId":"snapshot","command":"document_snapshot","apiVersion":1,"documentId":"ffi-document"});
        let result = request(first, snapshot.clone());
        assert!(result["result"]["payload"]["edits"][0]["value"].is_string());
        assert!(result["result"]["payload"]["edits"][1]["value"].is_number());
        assert_eq!(request(second, snapshot)["ok"], false);
        assert_eq!(aster_engine_release_v1(first), ASTER_OK_V1);
        assert_eq!(aster_engine_release_v1(second), ASTER_OK_V1);
    }

    #[test]
    fn ffi_stale_releases_and_cross_type_handles_cannot_release_other_resources() {
        let handle = create(); let bytes = serde_json::to_vec(&capabilities()).unwrap();
        let mut out = AsterBufferV1::default();
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), bytes.len() as u64, &mut out) }, ASTER_OK_V1);
        assert_eq!(aster_buffer_release_v1(handle), ASTER_STALE_HANDLE_V1);
        assert_eq!(aster_engine_release_v1(out.handle), ASTER_STALE_HANDLE_V1);
        assert_eq!(aster_engine_release_v1(handle), ASTER_OK_V1);
        // Response bytes are owned independently of their originating engine.
        let result: Value = serde_json::from_slice(unsafe { slice::from_raw_parts(out.data, out.len as usize) }).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(aster_buffer_release_v1(out.handle), ASTER_OK_V1);
        assert_eq!(aster_buffer_release_v1(out.handle), ASTER_STALE_HANDLE_V1);
        assert_eq!(aster_engine_release_v1(handle), ASTER_STALE_HANDLE_V1);
        let mut unused = AsterBufferV1::default();
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), bytes.len() as u64, &mut unused) }, ASTER_STALE_HANDLE_V1);
    }

    #[test]
    fn ffi_rejects_invalid_utf8_nulls_oversize_and_output_version_before_reading_requests() {
        let handle = create(); let bytes = b"{}"; let mut out = AsterBufferV1::default();
        assert_eq!(unsafe { aster_engine_create_v1(ptr::null_mut()) }, ASTER_INVALID_ARGUMENT_V1);
        assert_eq!(unsafe { aster_engine_request_v1(handle, ptr::null(), 0, &mut out) }, ASTER_INVALID_ARGUMENT_V1);
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), u64::MAX, &mut out) }, ASTER_INVALID_ARGUMENT_V1);
        assert_eq!(unsafe { aster_engine_request_v1(handle, [0xff].as_ptr(), 1, &mut out) }, ASTER_INVALID_ARGUMENT_V1);
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), 2, ptr::null_mut()) }, ASTER_INVALID_ARGUMENT_V1);
        out.abi_version = 2;
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), 2, &mut out) }, ASTER_UNSUPPORTED_VERSION_V1);
        out = AsterBufferV1::default(); out.struct_size -= 1;
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), 2, &mut out) }, ASTER_INVALID_ARGUMENT_V1);
        assert_eq!(aster_engine_release_v1(handle), ASTER_OK_V1);
    }

    #[test]
    fn ffi_rpc_errors_remain_json_and_request_input_is_not_retained() {
        let handle = create();
        let mut bytes = b"not json".to_vec(); let mut out = AsterBufferV1::default();
        assert_eq!(unsafe { aster_engine_request_v1(handle, bytes.as_ptr(), bytes.len() as u64, &mut out) }, ASTER_OK_V1);
        bytes.fill(0); drop(bytes);
        let result: Value = serde_json::from_slice(unsafe { slice::from_raw_parts(out.data, out.len as usize) }).unwrap();
        assert_eq!(result["ok"], false);
        assert_eq!(aster_buffer_release_v1(out.handle), ASTER_OK_V1);
        assert_eq!(aster_engine_release_v1(handle), ASTER_OK_V1);
    }

    #[test]
    fn ffi_engine_requests_are_serialized_without_global_registry_locking() {
        let handle = create();
        let workers: Vec<_> = (0..4).map(|_| std::thread::spawn(move || {
            for _ in 0..4 { assert_eq!(request(handle, capabilities())["ok"], true); }
        })).collect();
        for worker in workers { worker.join().unwrap(); }
        assert_eq!(aster_engine_release_v1(handle), ASTER_OK_V1);
    }

    #[test]
    fn ffi_released_engine_inflight_lease_remains_valid_and_panics_are_contained() {
        let handle = create(); let lease = engine_lease(handle).unwrap();
        assert_eq!(aster_engine_release_v1(handle), ASTER_OK_V1);
        assert!(matches!(engine_lease(handle), Err(ASTER_STALE_HANDLE_V1)));
        let result = lease.lock().unwrap().handle_line_blocking(&capabilities().to_string());
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap()["ok"], true);
        drop(lease);
        assert_eq!(boundary(|| -> Result<(), u32> { panic!("synthetic FFI boundary panic"); }), ASTER_INTERNAL_ERROR_V1);
    }
}
