//! Iconify icon packs (`mermdraw icons add|ls|rm`). Packs live in a global cache
//! (~/.config/mermdraw/icons) or are vendored into a repository (.mermdraw/icons) so
//! everyone who opens the docs sees the same icons. A project copy wins.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Releases mermdraw was tested with; other sets resolve to their latest release.
const PINNED: &[(&str, &str)] = &[("logos", "1.2.16"), ("devicon", "1.2.71")];

pub struct Pack {
    pub name: String,
    pub path: PathBuf,
    pub source: &'static str,
    pub size: u64,
}

pub fn global_dir() -> Option<PathBuf> {
    let base = match env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x),
        None if cfg!(windows) => PathBuf::from(env::var_os("APPDATA")?),
        None => PathBuf::from(env::var_os("HOME")?).join(".config"),
    };
    Some(base.join("mermdraw").join("icons"))
}

pub fn project_dir(root: &Path) -> PathBuf {
    root.join(".mermdraw").join("icons")
}

pub fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Installed packs, project copies first (they shadow global ones).
pub fn installed(root: Option<&Path>) -> Vec<Pack> {
    let mut dirs = Vec::new();
    if let Some(r) = root {
        dirs.push((project_dir(r), "project"));
    }
    if let Some(g) = global_dir() {
        dirs.push((g, "global"));
    }
    let mut out: Vec<Pack> = Vec::new();
    for (dir, source) in dirs {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let path = e.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".json")) else { continue };
            if !valid_name(name) || out.iter().any(|p| p.name == name) {
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(Pack { name: name.to_string(), path: path.clone(), source, size });
        }
    }
    out
}

pub fn find(root: &Path, name: &str) -> Option<PathBuf> {
    if !valid_name(name) {
        return None;
    }
    installed(Some(root)).into_iter().find(|p| p.name == name).map(|p| p.path)
}

/// Installs `name` or `name@version` into `dest`, returning the file and its size.
pub fn add(spec: &str, dest: &Path) -> Result<(PathBuf, u64), String> {
    let (name, version) = match spec.split_once('@') {
        Some((n, v)) => (n, Some(v)),
        None => (spec, None),
    };
    if !valid_name(name) {
        return Err(format!("'{name}' is not an Iconify set name (e.g. logos, devicon, simple-icons, mdi)"));
    }
    if let Some(v) = version {
        if v.is_empty() || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
            return Err(format!("'{v}' is not a version"));
        }
    }
    fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let target = dest.join(format!("{name}.json"));
    let size = |p: &Path| fs::metadata(p).map(|m| m.len()).unwrap_or(0);

    // Vendoring a pack that is already cached globally is a copy, not a download.
    if version.is_none() {
        if let Some(cached) = global_dir().map(|g| g.join(format!("{name}.json"))).filter(|g| g.exists() && *g != target) {
            fs::copy(&cached, &target).map_err(|e| format!("{}: {e}", target.display()))?;
            return Ok((target.clone(), size(&target)));
        }
    }

    let pinned = PINNED.iter().find(|(n, _)| *n == name).map(|(_, v)| *v);
    let url = match version.or(pinned) {
        Some(v) => format!("https://cdn.jsdelivr.net/npm/@iconify-json/{name}@{v}/icons.json"),
        None => format!("https://cdn.jsdelivr.net/npm/@iconify-json/{name}/icons.json"),
    };
    let tmp = dest.join(format!(".{name}.json.download"));
    let status = Command::new("curl")
        .args(["-fsSL", "--max-time", "300", "-o"])
        .arg(&tmp)
        .arg(&url)
        .status()
        .map_err(|e| format!("could not run curl ({e}); install curl or download {url} to {} yourself", target.display()))?;
    if !status.success() {
        let _ = fs::remove_file(&tmp);
        return Err(format!("download failed: {url}"));
    }
    let bytes = fs::read(&tmp).map_err(|e| e.to_string())?;
    let head: String = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).chars().filter(|c| !c.is_whitespace()).collect();
    if !head.starts_with(&format!("{{\"prefix\":\"{name}\"")) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{url} is not an Iconify icon set"));
    }
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok((target.clone(), size(&target)))
}

pub fn human(bytes: u64) -> String {
    match bytes {
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1u64 << 20) as f64),
        b if b >= 1 << 10 => format!("{} KB", b >> 10),
        b => format!("{b} B"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_names_are_restricted() {
        assert!(valid_name("logos") && valid_name("simple-icons") && valid_name("mdi"));
        assert!(!valid_name("../x") && !valid_name("Logos") && !valid_name("") && !valid_name("a/b"));
    }

    #[test]
    fn project_packs_shadow_global_ones() {
        let root = env::temp_dir().join(format!("mermdraw-icons-test-{}", std::process::id()));
        fs::create_dir_all(project_dir(&root)).unwrap();
        fs::write(project_dir(&root).join("logos.json"), "{}").unwrap();
        fs::write(project_dir(&root).join("bad name.json"), "{}").unwrap();
        let packs = installed(Some(&root));
        let logos = packs.iter().find(|p| p.name == "logos").unwrap();
        assert_eq!(logos.source, "project");
        assert!(packs.iter().all(|p| valid_name(&p.name)));
        assert_eq!(find(&root, "logos"), Some(project_dir(&root).join("logos.json")));
        assert_eq!(find(&root, "../logos"), None);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sizes_are_human() {
        assert_eq!(human(512), "512 B");
        assert_eq!(human(4096), "4 KB");
        assert_eq!(human(7_795_606), "7.4 MB");
    }
}
