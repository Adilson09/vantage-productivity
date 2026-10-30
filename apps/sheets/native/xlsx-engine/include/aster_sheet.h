#ifndef ASTER_SHEET_H
#define ASTER_SHEET_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32) && defined(ASTER_SHEET_SHARED)
#  define ASTER_SHEET_API __declspec(dllimport)
#else
#  define ASTER_SHEET_API
#endif
#if defined(_WIN32)
#  define ASTER_SHEET_CALL __cdecl
#else
#  define ASTER_SHEET_CALL
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define ASTER_ABI_VERSION_V1 1u
#define ASTER_OK_V1 0u
#define ASTER_INVALID_ARGUMENT_V1 1u
#define ASTER_STALE_HANDLE_V1 2u
#define ASTER_UNSUPPORTED_VERSION_V1 3u
#define ASTER_INTERNAL_ERROR_V1 4u

/* Output is UTF-8 bytes, not NUL-terminated. The allocation remains owned by
 * Rust and must be released using its handle, never free/delete/realloc. */
typedef struct AsterBufferV1 {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t handle;
    const uint8_t *data;
    uint64_t len;
} AsterBufferV1;

#define ASTER_BUFFER_V1_INIT \
    { (uint32_t)sizeof(AsterBufferV1), ASTER_ABI_VERSION_V1, UINT64_C(0), NULL, UINT64_C(0) }

ASTER_SHEET_API uint32_t ASTER_SHEET_CALL aster_abi_version_v1(void);
ASTER_SHEET_API uint32_t ASTER_SHEET_CALL aster_engine_create_v1(uint64_t *out_handle);

/* Initialize out with ASTER_BUFFER_V1_INIT before every call. Input must remain
 * readable and unchanged until return and must not overlap out. data must be
 * non-NULL, even for an empty request. Maximum input: 256 MiB + 1 MiB framing.
 * A nonzero status is an ABI error. Status 0 may contain an RPC {ok:false}
 * response; inspect the JSON envelope as well as the status. */
ASTER_SHEET_API uint32_t ASTER_SHEET_CALL aster_engine_request_v1(
    uint64_t engine_handle,
    const uint8_t *data,
    uint64_t len,
    AsterBufferV1 *out
);

/* Engine release prevents new calls. Calls already holding an in-flight engine
 * lease finish normally. Response buffers survive engine release. */
ASTER_SHEET_API uint32_t ASTER_SHEET_CALL aster_engine_release_v1(uint64_t engine_handle);
/* After buffer release no thread may read its data pointer. Release once. */
ASTER_SHEET_API uint32_t ASTER_SHEET_CALL aster_buffer_release_v1(uint64_t buffer_handle);

#ifdef __cplusplus
}
#endif
#endif
