//! Addons (`mermdraw addons add|ls|rm`, `mermdraw NAME ARGS…`): separate `mermdraw-NAME` binaries, each released
//! from its own repository `berttoli/mermdraw-NAME` with the same asset layout as mermdraw's releases. They live in
//! ~/.config/mermdraw/addons or anywhere on PATH, and talk to the core only through its `--json` commands.

use crate::sha256;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const OWNER: &str = "berttoli";
const DEFAULT_BASE: &str = "https://github.com/berttoli";

pub struct Addon {
    pub name: String,
    pub path: PathBuf,
    /// "addons" (installed by mermdraw) or "PATH"
    pub source: &'static str,
    pub size: u64,
}

pub struct Installed {
    pub path: PathBuf,
    pub url: String,
    pub sha256: String,
    pub attestation: String,
}

pub fn dir() -> Option<PathBuf> {
    Some(crate::config_dir()?.join("addons"))
}

/// Official addon names: what follows `mermdraw-` in the binary and repository names.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && !n.starts_with('-') && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The binary in a release archive, and what `addons add` installs.
fn exe_name(name: &str) -> String {
    format!("mermdraw-{name}{}", env::consts::EXE_SUFFIX)
}

/// The extensions an addon's file may have, in the order they are tried in each folder: none on Unix; `.exe`, then
/// `.cmd` (a batch file, say one wrapping a script) on Windows.
fn extensions(windows: bool) -> &'static [&'static str] {
    if windows {
        &[".exe", ".cmd"]
    } else {
        &[""]
    }
}

fn file_names(name: &str) -> impl Iterator<Item = String> + '_ {
    extensions(cfg!(windows)).iter().map(move |e| format!("mermdraw-{name}{e}"))
}

/// The addon an executable's file name stands for: `mermdraw-mcp` (`mermdraw-mcp.exe`, `mermdraw-mcp.cmd`) → `mcp`.
fn addon_name(file: &str, windows: bool) -> Option<&str> {
    extensions(windows).iter().find_map(|e| file.strip_suffix(e))?.strip_prefix("mermdraw-").filter(|n| valid_name(n))
}

/// The executable that `mermdraw NAME` runs: from the addons folder, else the first folder on PATH that has one.
pub fn find(name: &str) -> Option<PathBuf> {
    if !valid_name(name) {
        return None;
    }
    let mut dirs: Vec<PathBuf> = dir().into_iter().collect();
    dirs.extend(env::var_os("PATH").map(|p| env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
    dirs.iter().flat_map(|d| file_names(name).map(move |f| d.join(f))).find(|p| is_executable(p))
}

pub fn on_path(file: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?).map(|d| d.join(file)).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    let Ok(m) = fs::metadata(p) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        m.is_file()
    }
}

/// Installed addons: the addons folder, then `mermdraw-*` executables on PATH that it doesn't shadow.
pub fn installed(builtins: &[&str]) -> Vec<Addon> {
    let mut dirs: Vec<(PathBuf, &'static str)> = dir().into_iter().map(|d| (d, "addons")).collect();
    if let Some(path) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path).map(|d| (d, "PATH")));
    }
    let mut out: Vec<Addon> = Vec::new();
    for (d, source) in dirs {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let path = e.path();
            let Some(fname) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let Some(name) = addon_name(fname, cfg!(windows)) else { continue };
            if builtins.contains(&name) || out.iter().any(|a| a.name == name) || !is_executable(&path) {
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(Addon { name: name.to_string(), path, source, size });
        }
    }
    out
}

/// The release target this binary runs on, as in the release asset names (`mermdraw-NAME-TARGET.tar.gz`).
pub fn target() -> Option<&'static str> {
    Some(match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        _ => return None,
    })
}

pub fn valid_tag(t: &str) -> bool {
    t.len() > 1 && t.len() <= 64 && t.starts_with('v') && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// The digest `SHA256SUMS.txt` (`sha256sum` output) lists for `asset`.
pub fn listed_sum<'a>(sums: &'a str, asset: &str) -> Option<&'a str> {
    sums.lines().find_map(|l| {
        let mut parts = l.split_whitespace();
        let (sum, file) = (parts.next()?, parts.next()?);
        (file.trim_start_matches('*') == asset && sum.len() == 64 && sum.bytes().all(|b| b.is_ascii_hexdigit())).then_some(sum)
    })
}

/// Downloads addon `name` (the latest release, or `tag`), checks it against the release's SHA256SUMS.txt and, when
/// `gh` is installed, its build-provenance attestation, then installs its binary into `dest`.
pub fn add(name: &str, tag: Option<&str>, dest: &Path) -> Result<Installed, String> {
    let target = target().ok_or_else(|| {
        format!(
            "no prebuilt addons for {}-{}; build it with: cargo install --git https://github.com/{OWNER}/mermdraw-{name}",
            env::consts::OS,
            env::consts::ARCH
        )
    })?;
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let asset = format!("mermdraw-{name}-{target}.{ext}");
    let base = env::var("MERMDRAW_ADDONS_URL").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| DEFAULT_BASE.into());
    let release = match tag {
        Some(t) => format!("releases/download/{t}"),
        None => "releases/latest/download".into(),
    };
    let url = format!("{}/mermdraw-{name}/{release}/", base.trim_end_matches('/'));

    fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let work = dest.join(format!(".mermdraw-{name}.download"));
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| format!("{}: {e}", work.display()))?;
    let result = fetch_and_install(name, target, &asset, &url, &work, dest);
    let _ = fs::remove_dir_all(&work);
    result
}

fn fetch_and_install(name: &str, target: &str, asset: &str, url: &str, work: &Path, dest: &Path) -> Result<Installed, String> {
    let archive = work.join(asset);
    let sums_file = work.join("SHA256SUMS.txt");
    let release = format!("{OWNER}/mermdraw-{name}");
    download(&format!("{url}{asset}"), &archive)
        .map_err(|e| format!("{e}\n  is there a release of {release} with a {target} build? see https://github.com/{release}/releases"))?;
    download(&format!("{url}SHA256SUMS.txt"), &sums_file)?;

    let sums = fs::read_to_string(&sums_file).map_err(|e| format!("SHA256SUMS.txt: {e}"))?;
    let expected = listed_sum(&sums, asset).ok_or_else(|| format!("SHA256SUMS.txt of {release} does not list {asset}"))?;
    let actual = sha256::file_hex(&archive).map_err(|e| format!("{asset}: {e}"))?;
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(format!(
            "checksum mismatch for {asset}: SHA256SUMS.txt says {expected}, the download is {actual}; nothing was installed"
        ));
    }

    let attestation = match on_path(&format!("gh{}", env::consts::EXE_SUFFIX)) {
        None => "not checked: gh is not installed (https://cli.github.com)".to_string(),
        Some(gh) => {
            let out = Command::new(gh)
                .args(["attestation", "verify"])
                .arg(&archive)
                .args(["-R", &release])
                .output()
                .map_err(|e| format!("could not run gh: {e}"))?;
            match out.status.code() {
                Some(0) => format!("verified with gh: built by {release}'s release workflow"),
                // gh's exit code for "not logged in": verification was impossible, not failed
                Some(4) => "not checked: gh is not logged in (gh auth login)".to_string(),
                _ => {
                    let msg = String::from_utf8_lossy(&out.stderr);
                    return Err(format!(
                        "gh attestation verify rejected {asset}; nothing was installed\n{}",
                        msg.trim().lines().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n")
                    ));
                }
            }
        }
    };

    let unpacked = work.join("unpacked");
    fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
    let flags = if asset.ends_with(".zip") { "-xf" } else { "-xzf" };
    let status = Command::new("tar")
        .arg(flags)
        .arg(&archive)
        .arg("-C")
        .arg(&unpacked)
        .status()
        .map_err(|e| format!("could not run tar ({e}); unpack {asset} yourself"))?;
    if !status.success() {
        return Err(format!("tar could not unpack {asset}"));
    }
    let folder = asset.trim_end_matches(".zip").trim_end_matches(".tar.gz");
    let bin = unpacked.join(folder).join(exe_name(name));
    // a regular file, not a link out of the archive
    if !fs::symlink_metadata(&bin).map(|m| m.is_file()).unwrap_or(false) {
        return Err(format!("{asset} has no {folder}/{}", exe_name(name)));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let path = dest.join(exe_name(name));
    fs::rename(&bin, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(Installed { path, url: format!("{url}{asset}"), sha256: actual, attestation })
}

fn download(url: &str, to: &Path) -> Result<(), String> {
    let status = Command::new("curl")
        .args(["-fsSL", "--max-time", "300", "-o"])
        .arg(to)
        .arg(url)
        .status()
        .map_err(|e| format!("could not run curl ({e}); install curl, or download {url} yourself"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("download failed: {url}"))
    }
}

/// Removes addon `name` from the addons folder. Copies on PATH were not installed by mermdraw and stay.
pub fn remove(name: &str) -> Result<PathBuf, String> {
    let d = dir().ok_or("cannot find a config directory (set XDG_CONFIG_HOME)")?;
    if valid_name(name) {
        for path in file_names(name).map(|f| d.join(f)) {
            if fs::remove_file(&path).is_ok() {
                return Ok(path);
            }
        }
    }
    match file_names(name).find_map(|f| on_path(&f)).filter(|_| valid_name(name)) {
        Some(p) => Err(format!("{name} is not installed in {}; {} is on PATH and was not installed by mermdraw", d.display(), p.display())),
        None => Err(format!("{name} is not installed in {}", d.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addon_names_are_official_names_only() {
        assert!(valid_name("mcp") && valid_name("openapi") && valid_name("c4-import") && valid_name("x2"));
        for bad in ["", "../x", "MCP", "a/b", "a.b", "-x", "a b", "a_b", "mcp.exe"] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert_eq!(find("../../bin/sh"), None);
    }

    #[test]
    fn addon_file_names() {
        assert_eq!(addon_name("mermdraw-mcp", false), Some("mcp"));
        assert_eq!(addon_name("mermdraw-c4-import", false), Some("c4-import"));
        assert_eq!(addon_name("mermdraw-mcp.exe", false), None); // a dot is not part of a name
        assert_eq!(addon_name("mermdraw-mcp.exe", true), Some("mcp"));
        assert_eq!(addon_name("mermdraw-mcp.cmd", true), Some("mcp"));
        assert_eq!(addon_name("mermdraw-mcp", true), None); // Windows runs .exe and .cmd files only
        assert_eq!(addon_name("mermdraw-mcp.bat", true), None);
        assert_eq!(addon_name("mermdraw.exe", true), None);
        assert_eq!(addon_name("mermdraw-Bad.exe", true), None);
        assert_eq!(extensions(true), [".exe", ".cmd"]); // .exe is tried first
    }

    #[test]
    fn tags_are_versions() {
        assert!(valid_tag("v0.1.0") && valid_tag("v1.2.3-rc.1"));
        for bad in ["", "v", "0.1.0", "v1;rm", "v1/2", "v1 2"] {
            assert!(!valid_tag(bad), "{bad}");
        }
    }

    #[test]
    fn reads_sha256sums() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let sums = format!(
            "{a}  mermdraw-mcp-aarch64-apple-darwin.tar.gz\n{b} *mermdraw-mcp-x86_64-pc-windows-msvc.zip\nnot a line\nabc  short.tar.gz\n"
        );
        assert_eq!(listed_sum(&sums, "mermdraw-mcp-aarch64-apple-darwin.tar.gz"), Some(a.as_str()));
        assert_eq!(listed_sum(&sums, "mermdraw-mcp-x86_64-pc-windows-msvc.zip"), Some(b.as_str()));
        assert_eq!(listed_sum(&sums, "mermdraw-mcp-aarch64-apple"), None);
        assert_eq!(listed_sum(&sums, "short.tar.gz"), None);
    }

    #[test]
    fn knows_its_release_target() {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(target(), Some("aarch64-apple-darwin"));
        }
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert_eq!(target(), Some("x86_64-unknown-linux-musl"));
        }
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(target(), Some("x86_64-pc-windows-msvc"));
        }
    }
}
