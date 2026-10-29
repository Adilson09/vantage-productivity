// Vantage Productivity fork: keep profiles and credential identities separate from Depesha.
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const IDENTIFIER: &str = "org.asteroffice.mail";
pub const UPDATES_ENABLED: bool = false;
static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

fn selected_root(value: Option<OsString>) -> io::Result<Option<PathBuf>> {
    value
        .map(|value| {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "VANTAGE_MAIL_PROFILE (or the legacy profile override) must be an absolute directory",
                ));
            }
            Ok(path)
        })
        .transpose()
}

fn prepare_root(value: Option<OsString>) -> io::Result<Option<PathBuf>> {
    selected_root(value)?
        .map(|path| {
            std::fs::create_dir_all(&path)?;
            std::fs::canonicalize(path)
        })
        .transpose()
}

pub fn initialize() -> io::Result<()> {
    let selected = std::env::var_os("VANTAGE_MAIL_PROFILE")
        .or_else(|| std::env::var_os("ASTER_MAIL_PROFILE"));
    let root = prepare_root(selected)?;
    ROOT.set(root).map_err(|_| io::Error::other("mail profile already initialized"))
}

pub fn directory(kind: &str) -> Option<PathBuf> {
    ROOT.get().and_then(|root| root.as_ref()).map(|root| root.join(kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_override_uses_the_aster_identifier() {
        assert_eq!(selected_root(None).unwrap(), None);
        assert_eq!(IDENTIFIER, "org.asteroffice.mail");
        assert_ne!(IDENTIFIER, "ru.depesha.mail");
    }

    #[test]
    fn invalid_override_never_falls_back_to_a_real_profile() {
        for invalid in ["", "relative", "../mail"] {
            let error = selected_root(Some(invalid.into())).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn an_absolute_unicode_profile_is_preserved_without_creating_it() {
        let root = std::env::temp_dir().join("aster-mail-isolated-Δ");
        assert_eq!(selected_root(Some(root.clone().into_os_string())).unwrap(), Some(root));
    }

    #[test]
    fn unusable_profile_is_an_error_instead_of_a_fallback() {
        let file = std::env::temp_dir().join(format!("aster-mail-profile-file-{}", std::process::id()));
        let handle = std::fs::OpenOptions::new().write(true).create_new(true).open(&file).unwrap();
        let result = prepare_root(Some(file.clone().into_os_string()));
        drop(handle);
        std::fs::remove_file(file).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn new_profile_is_created_and_resolved_inside_the_explicit_root() {
        let root = std::env::temp_dir().join(format!("aster-mail-new-profile-{}", std::process::id()));
        assert!(!root.exists());
        let resolved = prepare_root(Some(root.clone().into_os_string())).unwrap().unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&root).unwrap());
        assert!(resolved.is_dir());
        std::fs::remove_dir(root).unwrap();
    }
}
