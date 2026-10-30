// The acceptance worker uses the production entry point under a separate
// filename, so integration checks never replace a worker used by an open app.
include!("main.rs");
