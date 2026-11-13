//! Explicit upgrades of the running binary. The release check is read-only; the existing
//! installers do the checksum and optional provenance checks before replacing the binary.

use crate::out;
use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::process::Command;
#[cfg(unix)]
use std::process::Stdio;

const RELEASE_API: &str = "https://api.github.com/repos/berttoli/mermdraw/releases/latest";

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    stable: bool,
}

fn version(raw: &str) -> Option<Version> {
    let raw = raw.strip_prefix('v').unwrap_or(raw);
    let raw = raw.split_once('+').map_or(raw, |(v, _)| v);
    let (numbers, pre) = raw.split_once('-').map_or((raw, None), |(v, pre)| (v, Some(pre)));
    if pre.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))) {
        return None;
    }
    let mut parts = numbers.split('.');
    let number = |part: &str| {
        (!part.is_empty() && (part.len() == 1 || !part.starts_with('0')) && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    };
    let v = Version { major: number(parts.next()?)?, minor: number(parts.next()?)?, patch: number(parts.next()?)?, stable: pre.is_none() };
    parts.next().is_none().then_some(v)
}

// Read one top-level string member of GitHub's JSON response without adding a dependency to the std-only binary.
fn json_string_field<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    let bytes = body.as_bytes();
    let mut at = 0;
    let mut depth: usize = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'{' => depth += 1,
            b'}' => depth = depth.checked_sub(1)?,
            b'"' => {
                let end = string_end(bytes, at)?;
                if depth == 1 && &body[at + 1..end] == name {
                    let mut value = end + 1;
                    while bytes.get(value).is_some_and(u8::is_ascii_whitespace) {
                        value += 1;
                    }
                    if bytes.get(value) == Some(&b':') {
                        value += 1;
                        while bytes.get(value).is_some_and(u8::is_ascii_whitespace) {
                            value += 1;
                        }
                        if bytes.get(value) == Some(&b'"') {
                            let end = string_end(bytes, value)?;
                            let found = &body[value + 1..end];
                            return (!found.contains('\\')).then_some(found);
                        }
                    }
                }
                at = end;
            }
            _ => {}
        }
        at += 1;
    }
    None
}

fn string_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut at = start + 1;
    while at < bytes.len() {
        match bytes[at] {
            b'\\' => at += 2,
            b'"' => return Some(at),
            _ => at += 1,
        }
    }
    None
}

fn latest_tag() -> Result<String, String> {
    // This override also lets the offline installer tests supply a local release response.
    let url = env::var("MERMDRAW_UPDATE_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| RELEASE_API.into());
    let response = Command::new("curl")
        .args([
            "-q",
            "-fsSL",
            "--max-time",
            "20",
            "--proto",
            "=https,file",
            "--proto-redir",
            "=https",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            "-A",
            "mermdraw-update",
        ])
        .arg(url)
        .output()
        .map_err(|e| format!("could not run curl to check releases: {e}"))?;
    if !response.status.success() {
        return Err(format!("could not check the latest release: {}", String::from_utf8_lossy(&response.stderr).trim()));
    }
    let body = std::str::from_utf8(&response.stdout).map_err(|_| "the release response is not UTF-8")?;
    let tag = json_string_field(body, "tag_name").ok_or("the release response has no tag_name")?;
    let parsed = version(tag).ok_or_else(|| format!("the latest release has an invalid tag: {tag}"))?;
    if !tag.starts_with('v') || !parsed.stable {
        return Err(format!("the latest release has an unexpected tag: {tag}"));
    }
    Ok(tag.into())
}

pub fn run(current: &str, check_only: bool, yes: bool) -> Result<(), String> {
    let tag = latest_tag()?;
    let available = version(&tag).ok_or("invalid latest release version")?;
    let installed = version(current).ok_or_else(|| format!("invalid installed version: {current}"))?;
    if available <= installed {
        if available == installed {
            out(&format!("mermdraw {current} is current (latest stable: {tag})."));
        } else {
            out(&format!("mermdraw {current} is newer than the latest stable release ({tag})."));
        }
        return Ok(());
    }
    out(&format!("Update available: mermdraw {current} → {}.", tag.trim_start_matches('v')));
    if check_only {
        out("Run `mermdraw update` to install it.");
        return Ok(());
    }

    let exe = env::current_exe().map_err(|e| format!("cannot find the running mermdraw: {e}"))?;
    let dir = exe.parent().ok_or("cannot find the installed mermdraw folder")?;
    if !yes {
        if !io::stdin().is_terminal() {
            return Err("confirmation needs a terminal; run `mermdraw update --yes` to install without a prompt".into());
        }
        print!("Replace {}? [y/N] ", exe.display());
        io::stdout().flush().map_err(|e| format!("could not show confirmation: {e}"))?;
        let mut reply = String::new();
        io::stdin().read_line(&mut reply).map_err(|e| format!("could not read confirmation: {e}"))?;
        if !matches!(reply.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            out("Update cancelled.");
            return Ok(());
        }
    }

    out(&format!("Installing {tag} at {}...", exe.display()));
    install(&tag, dir)?;
    let result = Command::new(&exe).arg("--version").output().map_err(|e| format!("could not run the updated binary: {e}"))?;
    let printed = String::from_utf8_lossy(&result.stdout);
    let expected = format!("mermdraw {}", tag.trim_start_matches('v'));
    if !result.status.success() || printed.trim() != expected {
        return Err(format!("the installer finished, but {} does not report {expected}", exe.display()));
    }
    out(&format!("Updated {} to {tag}. Restart any open editor to use the new version.", exe.display()));
    Ok(())
}

#[cfg(unix)]
fn install(tag: &str, dir: &Path) -> Result<(), String> {
    let mut child = Command::new("sh")
        .args(["-s", "--"])
        .env("MERMDRAW_INSTALL_VERSION", tag)
        .env("MERMDRAW_INSTALL_DIR", dir)
        .env("MERMDRAW_NO_MODIFY_PATH", "1")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the installer: {e}"))?;
    let sent = child.stdin.take().ok_or_else(|| "could not open the installer input".to_string()).and_then(|mut input| {
        input.write_all(include_bytes!("../scripts/install.sh")).map_err(|e| format!("could not send the installer: {e}"))
    });
    if let Err(e) = sent {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let status = child.wait().map_err(|e| format!("could not wait for the installer: {e}"))?;
    status.success().then_some(()).ok_or_else(|| "the installer failed; see its error above".into())
}

#[cfg(windows)]
fn install(tag: &str, dir: &Path) -> Result<(), String> {
    use std::fs::{self, OpenOptions};
    use std::time::{SystemTime, UNIX_EPOCH};

    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let path = env::temp_dir().join(format!("mermdraw-update-{}-{nonce}.ps1", std::process::id()));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let written = file.write_all(include_bytes!("../scripts/install.ps1"));
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(&path);
        return Err(format!("{}: {e}", path.display()));
    }
    let result = Command::new("powershell.exe")
        // When launched from pwsh through mermdraw, PS7's module paths would hide
        // Windows PowerShell's built-in modules (including Get-FileHash). Let the
        // installer shell construct its own defaults without changing our parent.
        .env_remove("PSModulePath")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path)
        .env("MERMDRAW_INSTALL_VERSION", tag)
        .env("MERMDRAW_INSTALL_DIR", dir)
        .env("MERMDRAW_NO_MODIFY_PATH", "1")
        .status();
    let _ = fs::remove_file(&path);
    let status = result.map_err(|e| format!("could not start PowerShell: {e}"))?;
    status.success().then_some(()).ok_or_else(|| "the installer failed; see its error above".into())
}

#[cfg(not(any(unix, windows)))]
fn install(_tag: &str, _dir: &Path) -> Result<(), String> {
    Err("there is no installer for this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_stable_releases_with_installed_versions() {
        assert!(version("v0.3.0") > version("0.2.9"));
        assert!(version("v0.3.0") > version("0.3.0-rc.1"));
        assert!(version("v0.3.0") <= version("0.3.0"));
        assert!(version("v0.3.0") < version("0.4.0-rc.1"));
        assert!(version("v01.3.0").is_none());
        assert!(version("v0.3").is_none());
        assert!(version("v0.3.0;evil").is_none());
    }

    #[test]
    fn finds_only_the_top_level_release_tag() {
        let body = r#"{"body":"the text says \"tag_name\": \"v9.9.9\"", "assets":[{"tag_name":"v8.8.8"}], "tag_name":"v0.3.0"}"#;
        assert_eq!(json_string_field(body, "tag_name"), Some("v0.3.0"));
        assert_eq!(json_string_field("{\"tag_name\":null}", "tag_name"), None);
    }
}
