//! One read-only query per process. SQLite owns the bounded query allocator;
//! neither Node/V8 nor the spreadsheet engine is initialized in this binary.

#[cfg(target_arch = "wasm32")]
fn main() {
    panic!("vantage-query-worker requires a native process");
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    native::main();
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use rusqlite::{Connection, OpenFlags, ffi};
    use serde::{Deserialize, Serialize};
    use serde_json::{Map, Value, json};
    use std::ffi::{CStr, CString};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::path::Path;
    use std::ptr;
    use std::time::{Duration, Instant};

    const HEAP_BYTES: i64 = 64 * 1024 * 1024;
    const INPUT_BYTES: usize = 256 * 1024;
    const OUTPUT_BYTES: usize = 2 * 1024 * 1024;
    const SQL_BYTES: usize = 32 * 1024;
    const APPLICATION_ID: i64 = 0x5641_4e54;

    #[cfg(unix)]
    unsafe extern "C" { fn _exit(status: i32) -> !; }
    #[cfg(windows)]
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn TerminateProcess(process: *mut std::ffi::c_void, code: u32) -> i32;
    }
    fn immediate_exit(code: i32) -> ! {
        // Do not run stdio/atexit flush handlers: another thread may be blocked
        // writing to a pipe the parent stopped draining. Only this process exits.
        #[cfg(unix)]
        unsafe { _exit(code); }
        #[cfg(windows)]
        unsafe { TerminateProcess(GetCurrentProcess(), code as u32); }
        #[allow(unreachable_code)]
        std::process::abort()
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        protocol: u32,
        nonce: String,
        path: String,
        sql: String,
        parameters: Vec<Value>,
        max_rows: usize,
        deadline_ms: u64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Failure {
        code: &'static str,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        sqlite_code: Option<i32>,
    }

    impl Failure {
        fn new(code: &'static str, message: impl Into<String>) -> Self {
            Self { code, message: message.into().chars().take(512).collect(), sqlite_code: None }
        }
        fn sqlite(db: *mut ffi::sqlite3, code: i32) -> Self {
            let primary = code & 0xff;
            let kind = match primary {
                ffi::SQLITE_NOMEM => "QUERY_MEMORY_LIMIT",
                ffi::SQLITE_INTERRUPT => "QUERY_TIMEOUT",
                ffi::SQLITE_READONLY | ffi::SQLITE_AUTH => "QUERY_READ_ONLY",
                _ => "QUERY_SQLITE_ERROR",
            };
            let message = if primary == ffi::SQLITE_NOMEM {
                "SQLite refused an allocation at the 64 MiB query memory limit.".into()
            } else if primary == ffi::SQLITE_INTERRUPT {
                "The query exceeded its time limit.".into()
            } else if db.is_null() {
                format!("SQLite operation failed ({primary}).")
            } else {
                unsafe { CStr::from_ptr(ffi::sqlite3_errmsg(db)) }
                    .to_string_lossy().chars().take(512).collect()
            };
            Self { code: kind, message, sqlite_code: Some(primary) }
        }
    }

    struct Statement(*mut ffi::sqlite3_stmt);
    impl Drop for Statement {
        fn drop(&mut self) { unsafe { ffi::sqlite3_finalize(self.0); } }
    }
    struct ProgressGuard(*mut ffi::sqlite3);
    impl Drop for ProgressGuard {
        fn drop(&mut self) {
            unsafe { ffi::sqlite3_progress_handler(self.0, 0, None, ptr::null_mut()); }
        }
    }

    #[derive(Serialize)]
    struct QueryResult {
        columns: Vec<String>,
        rows: Vec<Map<String, Value>>,
        truncated: bool,
    }

    /// MEMSTATUS is a start-time setting. A pragma readback alone cannot prove
    /// enforcement when a host embedding compiled/initialized accounting off.
    fn initialize_allocator() -> Result<(), Failure> {
        unsafe {
            let configured = ffi::sqlite3_config(ffi::SQLITE_CONFIG_MEMSTATUS, 1_i32);
            if configured != ffi::SQLITE_OK {
                return Err(Failure::new("QUERY_RUNTIME_CONFIG", "SQLite memory accounting could not be enabled before initialization."));
            }
            let initialized = ffi::sqlite3_initialize();
            if initialized != ffi::SQLITE_OK {
                return Err(Failure::sqlite(ptr::null_mut(), initialized));
            }
            ffi::sqlite3_hard_heap_limit64(HEAP_BYTES);
            if ffi::sqlite3_hard_heap_limit64(-1) != HEAP_BYTES {
                return Err(Failure::new("QUERY_RUNTIME_CONFIG", "The SQLite allocation limit was not applied."));
            }
        }
        Ok(())
    }

    fn validate(request: &Request) -> Result<(), Failure> {
        let first = request.sql.trim_start().split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or("");
        if request.protocol != 1 || request.nonce.len() != 36
            || !request.nonce.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || !Path::new(&request.path).is_absolute()
            || request.sql.len() > SQL_BYTES
            || !["SELECT", "WITH"].iter().any(|keyword| first.eq_ignore_ascii_case(keyword))
            || !(1..=10_000).contains(&request.max_rows)
            || !(100..=30_000).contains(&request.deadline_ms)
            || request.parameters.iter().any(|v| !matches!(v, Value::Null | Value::String(_) | Value::Number(_)))
        {
            return Err(Failure::new("QUERY_INVALID_REQUEST", "Use one SELECT or WITH query with bounded scalar parameters and a saved database path."));
        }
        Ok(())
    }

    unsafe extern "C" fn deadline_reached(context: *mut std::ffi::c_void) -> i32 {
        let deadline = unsafe { &*(context as *const Instant) };
        i32::from(Instant::now() >= *deadline)
    }

    fn configure_connection(connection: &Connection) -> Result<(), Failure> {
        let db = unsafe { connection.handle() };
        for (setting, value) in [
            (ffi::SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0),
            (ffi::SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0),
            (ffi::SQLITE_DBCONFIG_DQS_DML, 0),
            (ffi::SQLITE_DBCONFIG_DQS_DDL, 0),
            (ffi::SQLITE_DBCONFIG_DEFENSIVE, 1),
        ] {
            let mut applied = -1_i32;
            let code = unsafe { ffi::sqlite3_db_config(db, setting, value, &mut applied) };
            if code != ffi::SQLITE_OK || applied != value {
                return Err(Failure::new("QUERY_RUNTIME_CONFIG", "A required read-only SQLite safety setting is unavailable."));
            }
        }
        connection.execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-4096;")
            .map_err(|_| Failure::sqlite(db, unsafe { ffi::sqlite3_errcode(db) }))?;
        let application: i64 = connection.query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(|_| Failure::sqlite(db, unsafe { ffi::sqlite3_errcode(db) }))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| Failure::sqlite(db, unsafe { ffi::sqlite3_errcode(db) }))?;
        if application != APPLICATION_ID || version != 1 {
            return Err(Failure::new("QUERY_DATABASE_FORMAT", "This is not a supported Vantage database (schema version 1)."));
        }
        if unsafe { ffi::sqlite3_memory_used() } <= 0 {
            return Err(Failure::new("QUERY_RUNTIME_CONFIG", "SQLite allocation accounting is not active."));
        }
        Ok(())
    }

    fn prepare(connection: &Connection, sql: &str) -> Result<Statement, Failure> {
        let db = unsafe { connection.handle() };
        let sql = CString::new(sql).map_err(|_| Failure::new("QUERY_INVALID_REQUEST", "SQL cannot contain NUL."))?;
        let mut statement = ptr::null_mut();
        let mut tail = ptr::null();
        let code = unsafe { ffi::sqlite3_prepare_v3(db, sql.as_ptr(), -1, 0, &mut statement, &mut tail) };
        let first = Statement(statement);
        if code != ffi::SQLITE_OK { return Err(Failure::sqlite(db, code)); }
        if first.0.is_null() { return Err(Failure::new("QUERY_INVALID_REQUEST", "Enter one query.")); }
        // Let SQLite parse trailing comments/whitespace; never execute a second statement.
        let mut second = ptr::null_mut();
        let code = unsafe { ffi::sqlite3_prepare_v3(db, tail, -1, 0, &mut second, ptr::null_mut()) };
        let second = Statement(second);
        if code & 0xff == ffi::SQLITE_NOMEM { return Err(Failure::sqlite(db, code)); }
        if code != ffi::SQLITE_OK || !second.0.is_null() {
            return Err(Failure::new("QUERY_MULTIPLE_STATEMENTS", "Only one SQL statement is allowed."));
        }
        if unsafe { ffi::sqlite3_stmt_readonly(first.0) } == 0 {
            return Err(Failure::new("QUERY_READ_ONLY", "The query is readonly; writes are not allowed."));
        }
        Ok(first)
    }

    fn bind(db: *mut ffi::sqlite3, statement: &Statement, parameters: &[Value]) -> Result<(), Failure> {
        let expected = unsafe { ffi::sqlite3_bind_parameter_count(statement.0) } as usize;
        if parameters.len() != expected {
            return Err(Failure::new("QUERY_PARAMETERS", format!("The query needs {expected} scalar parameters.")));
        }
        for (index, value) in parameters.iter().enumerate() {
            let index = (index + 1) as i32;
            let code = unsafe {
                match value {
                    Value::Null => ffi::sqlite3_bind_null(statement.0, index),
                    Value::Number(value) => ffi::sqlite3_bind_double(statement.0, index, value.as_f64().unwrap()),
                    Value::String(value) => ffi::sqlite3_bind_text(statement.0, index, value.as_ptr().cast(), value.len() as i32, ffi::SQLITE_TRANSIENT()),
                    _ => unreachable!(),
                }
            };
            if code != ffi::SQLITE_OK { return Err(Failure::sqlite(db, code)); }
        }
        Ok(())
    }

    fn json_string_bytes(value: &str) -> usize {
        2 + value.bytes().map(|b| match b {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
            0..=31 => 6,
            _ => 1,
        }).sum::<usize>()
    }

    /// Return None before copying/encoding any cell which cannot fit the output.
    fn cell(db: *mut ffi::sqlite3, statement: &Statement, column: i32, remaining: usize) -> Result<Option<(Value, usize)>, Failure> {
        let value = match unsafe { ffi::sqlite3_column_type(statement.0, column) } {
            ffi::SQLITE_NULL => Value::Null,
            ffi::SQLITE_INTEGER => {
                let number = unsafe { ffi::sqlite3_column_int64(statement.0, column) };
                if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&number) { json!(number) }
                else { Value::String(number.to_string()) }
            }
            ffi::SQLITE_FLOAT => json!(unsafe { ffi::sqlite3_column_double(statement.0, column) }),
            ffi::SQLITE_TEXT => {
                let pointer = unsafe { ffi::sqlite3_column_text(statement.0, column) };
                let length = unsafe { ffi::sqlite3_column_bytes(statement.0, column) } as usize;
                if length > remaining { return Ok(None); }
                if pointer.is_null() { return Err(Failure::sqlite(db, ffi::SQLITE_NOMEM)); }
                let bytes = if length == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(pointer, length) } };
                let text = std::str::from_utf8(bytes).map_err(|_| Failure::new("QUERY_TEXT_ENCODING", "A text cell is not valid UTF-8."))?;
                let size = json_string_bytes(text);
                if size > remaining { return Ok(None); }
                return Ok(Some((Value::String(text.to_owned()), size)));
            }
            ffi::SQLITE_BLOB => {
                let length = unsafe { ffi::sqlite3_column_bytes(statement.0, column) } as usize;
                let size = 9 + length.div_ceil(3) * 4; // quoted base64: prefix
                if size > remaining { return Ok(None); }
                let pointer = unsafe { ffi::sqlite3_column_blob(statement.0, column) };
                if pointer.is_null() && length != 0 { return Err(Failure::sqlite(db, ffi::SQLITE_NOMEM)); }
                let bytes = if length == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), length) } };
                return Ok(Some((Value::String(format!("base64:{}", STANDARD.encode(bytes))), size)));
            }
            _ => return Err(Failure::new("QUERY_SQLITE_ERROR", "Unsupported SQLite value type.")),
        };
        let size = serde_json::to_vec(&value).unwrap().len();
        Ok((size <= remaining).then_some((value, size)))
    }

    fn query(request: &Request) -> Result<QueryResult, Failure> {
        validate(request)?;
        let connection = Connection::open_with_flags(&request.path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(code, message) => {
                    let mut failure = Failure::sqlite(ptr::null_mut(), code.extended_code);
                    if code.extended_code & 0xff != ffi::SQLITE_NOMEM {
                        failure.code = "QUERY_DATABASE_OPEN";
                        if let Some(message) = message {
                            failure.message = message.chars().take(512).collect();
                        }
                    }
                    failure
                }
                error => Failure::new("QUERY_DATABASE_OPEN", error.to_string()),
            })?;
        configure_connection(&connection)?;
        let db = unsafe { connection.handle() };
        let deadline = Instant::now() + Duration::from_millis(request.deadline_ms);
        unsafe { ffi::sqlite3_progress_handler(db, 10_000, Some(deadline_reached), (&deadline as *const Instant).cast_mut().cast()); }
        let _progress = ProgressGuard(db);
        let statement = prepare(&connection, &request.sql)?;
        bind(db, &statement, &request.parameters)?;
        let count = unsafe { ffi::sqlite3_column_count(statement.0) };
        let mut columns = Vec::new();
        // Reserve bounded space for the protocol envelope and allocator metadata.
        let mut used = 1024_usize;
        for index in 0..count {
            let pointer = unsafe { ffi::sqlite3_column_name(statement.0, index) };
            if pointer.is_null() { return Err(Failure::sqlite(db, ffi::SQLITE_NOMEM)); }
            let name = unsafe { CStr::from_ptr(pointer) }.to_str()
                .map_err(|_| Failure::new("QUERY_TEXT_ENCODING", "A column name is not valid UTF-8."))?;
            used = used.saturating_add(json_string_bytes(name) + 1);
            if used > OUTPUT_BYTES { return Err(Failure::new("QUERY_OUTPUT_LIMIT", "Column names exceed the result limit.")); }
            columns.push(name.to_owned());
        }
        let mut result = QueryResult { columns, rows: Vec::new(), truncated: false };
        'rows: loop {
            let code = unsafe { ffi::sqlite3_step(statement.0) };
            if code == ffi::SQLITE_DONE { break; }
            if code != ffi::SQLITE_ROW { return Err(Failure::sqlite(db, code)); }
            if result.rows.len() == request.max_rows { result.truncated = true; break; }
            let mut row = Map::new();
            let mut row_bytes = 3_usize;
            for (index, name) in result.columns.iter().enumerate() {
                row_bytes = row_bytes.saturating_add(json_string_bytes(name) + 2);
                let remaining = OUTPUT_BYTES.saturating_sub(used.saturating_add(row_bytes));
                let Some((value, size)) = cell(db, &statement, index as i32, remaining)? else {
                    result.truncated = true;
                    break 'rows;
                };
                row_bytes = row_bytes.saturating_add(size);
                row.insert(name.clone(), value);
            }
            used = used.saturating_add(row_bytes);
            result.rows.push(row);
        }
        // Drop order: statement, progress guard, deadline, then connection.
        Ok(result)
    }

    pub fn main() {
        // Even if the parent dies or sends a partial stdin request, this owned
        // helper cannot remain in a native function or input read indefinitely.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(32));
            immediate_exit(124);
        });
        let mut nonce = String::new();
        let result = (|| {
            initialize_allocator()?;
            let mut input = Vec::new();
            let mut pipe = BufReader::new(std::io::stdin());
            (&mut pipe).take((INPUT_BYTES + 1) as u64).read_until(b'\n', &mut input)
                .map_err(|_| Failure::new("QUERY_INVALID_REQUEST", "The query request could not be read."))?;
            if input.len() > INPUT_BYTES { return Err(Failure::new("QUERY_INPUT_LIMIT", "Query parameters exceed 256 KiB.")); }
            if input.last() != Some(&b'\n') { return Err(Failure::new("QUERY_INVALID_REQUEST", "A complete query request line is required.")); }
            let request: Request = serde_json::from_slice(&input)
                .map_err(|_| Failure::new("QUERY_INVALID_REQUEST", "The query request is not valid bounded JSON."))?;
            nonce = request.nonce.clone();
            // The parent retains this pipe until the result closes. EOF (parent
            // cancellation/death) or extra input terminates this exact process;
            // no external PID lookup or foreign-process termination is needed.
            std::thread::spawn(move || {
                let mut extra = [0_u8; 1];
                let _ = pipe.read(&mut extra);
                immediate_exit(125);
            });
            query(&request)
        })();
        let limits = json!({ "sqliteHeapBytes": HEAP_BYTES, "sqliteHighwaterBytes": unsafe { ffi::sqlite3_memory_highwater(0) } });
        let (response, code) = match result {
            Ok(result) => (json!({ "protocol": 1, "nonce": nonce, "ok": true, "result": result, "limits": limits }), 0),
            Err(error) => (json!({ "protocol": 1, "nonce": nonce, "ok": false, "error": error, "limits": limits }), 1),
        };
        let output = serde_json::to_vec(&response).unwrap();
        if output.len() > OUTPUT_BYTES { std::process::exit(3); }
        if std::io::stdout().write_all(&output).is_err() { std::process::exit(4); }
        std::process::exit(code);
    }
}
