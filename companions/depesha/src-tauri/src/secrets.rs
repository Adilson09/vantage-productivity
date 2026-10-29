//! Passwords in the OS keyring: Secret Service on Linux, Keychain, Credential Manager.

use crate::error::{CmdError, CmdResult};
use crate::tr;

// Vantage Productivity fork: never look up the upstream credential namespace.
const SERVICE: &str = crate::aster_profile::IDENTIFIER;

fn service_for(profile: Option<&std::path::Path>) -> String {
    let Some(profile) = profile else {
        return SERVICE.to_owned();
    };
    // A scratch profile must not share credentials with the normal Vantage profile.
    let digest = ring::digest::digest(&ring::digest::SHA256, profile.to_string_lossy().as_bytes());
    let suffix = digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    format!("{SERVICE}.profile.{suffix}")
}

fn entry(account_id: &str) -> CmdResult<keyring::Entry> {
    let profile = crate::aster_profile::directory("keyring");
    keyring::Entry::new(&service_for(profile.as_deref()), account_id).map_err(|e| {
        CmdError::new(
            depesha_core::ErrorKind::Keyring,
            tr!("keyring: {e}", "связка ключей: {e}"),
        )
    })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::new(depesha_core::ErrorKind::Keyring, e.to_string()))?
}

pub async fn get(account_id: &str) -> CmdResult<Option<String>> {
    let id = account_id.to_owned();
    blocking(move || match entry(&id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CmdError::new(
            depesha_core::ErrorKind::Keyring,
            tr!("the keyring is unavailable: {e}", "связка ключей недоступна: {e}"),
        )),
    })
    .await
}

pub async fn set(account_id: &str, password: String) -> CmdResult<()> {
    let id = account_id.to_owned();
    blocking(move || {
        entry(&id)?.set_password(&password).map_err(|e| {
            CmdError::new(
                depesha_core::ErrorKind::Keyring,
                tr!(
                    "could not save the password to the keyring: {e}",
                    "не удалось сохранить пароль в связку ключей: {e}"
                ),
            )
        })
    })
    .await
}

pub async fn delete(account_id: &str) -> CmdResult<()> {
    let id = account_id.to_owned();
    blocking(move || match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(CmdError::new(depesha_core::ErrorKind::Keyring, e.to_string())),
    })
    .await
}

#[cfg(test)]
mod aster_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn profile_overrides_get_separate_credential_names_without_accessing_keyring() {
        let normal = service_for(None);
        let first = service_for(Some(Path::new("profile-one")));
        let second = service_for(Some(Path::new("profile-two")));
        assert_eq!(normal, "org.asteroffice.mail");
        assert_ne!(normal, "ru.depesha.mail");
        assert_ne!(normal, first);
        assert_ne!(first, second);
        assert_eq!(first, service_for(Some(Path::new("profile-one"))));
    }
}
