// Vantage Productivity fork: native files follow the same isolated root as the webview.
use std::{io, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

pub fn identifier_for(profile: Option<&Path>) -> String {
    let base = crate::aster_profile::IDENTIFIER;
    let Some(profile) = profile else {
        return base.to_owned();
    };
    // Tauri's single-instance lock must not forward a scratch launch to a real profile.
    let digest = ring::digest::digest(&ring::digest::SHA256, profile.to_string_lossy().as_bytes());
    let suffix = digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    format!("{base}.profile.{suffix}")
}

pub fn data(app: &AppHandle) -> io::Result<PathBuf> {
    crate::aster_profile::directory("data")
        .map(Ok)
        .unwrap_or_else(|| app.path().app_data_dir().map_err(io::Error::other))
}

pub fn config(app: &AppHandle) -> io::Result<PathBuf> {
    crate::aster_profile::directory("config")
        .map(Ok)
        .unwrap_or_else(|| app.path().app_config_dir().map_err(io::Error::other))
}

pub fn logs(app: &AppHandle) -> io::Result<PathBuf> {
    crate::aster_profile::directory("logs")
        .map(Ok)
        .unwrap_or_else(|| app.path().app_log_dir().map_err(io::Error::other))
}

pub fn cache(app: &AppHandle) -> io::Result<PathBuf> {
    crate::aster_profile::directory("cache")
        .map(Ok)
        .unwrap_or_else(|| app.path().app_cache_dir().map_err(io::Error::other))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_explicit_profile_has_its_own_stable_process_lock_identity() {
        let first = Path::new("profile-one");
        let second = Path::new("profile-two");
        let normal = identifier_for(None);
        let first_id = identifier_for(Some(first));
        assert_eq!(normal, "org.asteroffice.mail");
        assert!(first_id.starts_with("org.asteroffice.mail.profile."));
        assert_ne!(first_id, normal);
        assert_ne!(first_id, identifier_for(Some(second)));
        assert_eq!(first_id, identifier_for(Some(first)));
    }
}
