//! Iconify icon packs (`mermdraw icons add|ls|rm`). Packs live in a global cache
//! (~/.config/mermdraw/icons) or are vendored into a repository (.mermdraw/icons) so
//! everyone who opens the docs sees the same icons. A project copy wins.

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
    Some(crate::config_dir()?.join("icons"))
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

pub struct Hit {
    pub pack: String,
    pub name: String,
    pub source: &'static str,
}

/// Icons of the installed packs whose `pack:name` contains every word of `query`, best first: the exact name, then
/// names starting with the query, then shorter names. Returns at most `limit` hits and the number of matches.
pub fn search(root: Option<&Path>, query: &str, limit: usize) -> (Vec<Hit>, usize) {
    let words: Vec<String> =
        query.split(|c: char| c.is_whitespace() || c == ',').filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    let joined = words.join("-");
    let mut hits: Vec<(u8, Hit)> = Vec::new();
    for p in installed(root) {
        let Ok(text) = fs::read_to_string(&p.path) else { continue };
        for name in icon_names(&text) {
            let full = format!("{}:{name}", p.name).to_lowercase();
            if !words.iter().all(|w| full.contains(w.as_str())) {
                continue;
            }
            let rank = if name == joined || full == joined {
                0
            } else if name.starts_with(&joined) {
                1
            } else {
                2
            };
            hits.push((rank, Hit { pack: p.name.clone(), name, source: p.source }));
        }
    }
    hits.sort_by(|(ra, a), (rb, b)| {
        ra.cmp(rb).then(a.name.len().cmp(&b.name.len())).then_with(|| (&a.name, &a.pack).cmp(&(&b.name, &b.pack)))
    });
    let total = hits.len();
    (hits.into_iter().take(limit).map(|(_, h)| h).collect(), total)
}

/// The icon and alias names of an Iconify icon set: the keys of its `icons` and `aliases` objects.
fn icon_names(json: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut s = Scan { b: json.as_bytes(), i: 0, depth: 0 };
    let _ = s.object(&mut |s, key| match key.as_str() {
        "icons" | "aliases" => s.object(&mut |s, name| {
            names.push(name);
            s.skip()
        }),
        _ => s.skip(),
    });
    names
}

/// Just enough of a JSON reader to walk an object's keys and skip their values.
struct Scan<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl Scan<'_> {
    fn peek(&mut self) -> Option<u8> {
        while self.b.get(self.i).is_some_and(|c| c.is_ascii_whitespace()) {
            self.i += 1;
        }
        self.b.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        let hit = self.peek() == Some(c);
        self.i += hit as usize;
        hit
    }

    fn string(&mut self) -> Option<String> {
        if !self.eat(b'"') {
            return None;
        }
        let mut out = Vec::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'u' => {
                            let hex = std::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
                            let ch = u32::from_str_radix(hex, 16).ok().and_then(char::from_u32).unwrap_or('\u{fffd}');
                            self.i += 4;
                            out.extend_from_slice(ch.encode_utf8(&mut [0; 4]).as_bytes());
                        }
                        b'n' => out.push(b'\n'),
                        b't' => out.push(b'\t'),
                        b'r' => out.push(b'\r'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        other => out.push(other),
                    }
                }
                c => out.push(c),
            }
        }
    }

    /// Calls `f` with every key of an object; `f` consumes the key's value.
    fn object(&mut self, f: &mut dyn FnMut(&mut Self, String) -> Option<()>) -> Option<()> {
        if !self.eat(b'{') {
            return None;
        }
        if self.eat(b'}') {
            return Some(());
        }
        loop {
            let key = self.string()?;
            if !self.eat(b':') {
                return None;
            }
            f(self, key)?;
            if !self.eat(b',') {
                return self.eat(b'}').then_some(());
            }
        }
    }

    fn skip(&mut self) -> Option<()> {
        match self.peek()? {
            b'"' => self.string().map(drop),
            open @ (b'{' | b'[') => {
                self.depth += 1;
                if self.depth > 64 {
                    return None;
                }
                let r = if open == b'{' { self.object(&mut |s, _| s.skip()) } else { self.array() };
                self.depth -= 1;
                r
            }
            _ => {
                let start = self.i;
                while self.b.get(self.i).is_some_and(|c| c.is_ascii_alphanumeric() || b"+-.".contains(c)) {
                    self.i += 1;
                }
                (self.i > start).then_some(())
            }
        }
    }

    fn array(&mut self) -> Option<()> {
        self.eat(b'[');
        if self.eat(b']') {
            return Some(());
        }
        loop {
            self.skip()?;
            if !self.eat(b',') {
                return self.eat(b']').then_some(());
            }
        }
    }
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
        let root = std::env::temp_dir().join(format!("mermdraw-icons-test-{}", std::process::id()));
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
    fn reads_iconify_names() {
        let json = r#"{"prefix":"x","info":{"name":"X","tags":["a",{"b":[1,2.5e3,null]}]},"icons":{"postgresql":{"body":"<g \"q\"/>","width":32},
            "python":{"body":"<p/>"},"rust\u002dlang":{"body":""}},"aliases":{"postgres":{"parent":"postgresql"}},"width":256,"ok":true}"#;
        assert_eq!(icon_names(json), vec!["postgresql", "python", "rust-lang", "postgres"]);
        assert_eq!(icon_names("{\"icons\":[]}"), Vec::<String>::new());
        assert_eq!(icon_names("not json"), Vec::<String>::new());
        let deep = format!("{{\"a\":{}{}, \"icons\":{{\"x\":1}}}}", "[".repeat(200), "]".repeat(200));
        assert_eq!(icon_names(&deep), Vec::<String>::new()); // too deep: gives up instead of overflowing the stack
    }

    #[test]
    fn search_ranks_exact_then_prefix_then_short() {
        let root = std::env::temp_dir().join(format!("mermdraw-search-test-{}", std::process::id()));
        fs::create_dir_all(project_dir(&root)).unwrap();
        let pack = r#"{"prefix":"zz-test","icons":{"postgresql-wordmark":{},"postgresql":{},"aws-lambda":{},"google-cloud-run":{}},"aliases":{"postgres":{}}}"#;
        fs::write(project_dir(&root).join("zz-test.json"), pack).unwrap();
        let names =
            |q: &str| -> Vec<String> { search(Some(&root), q, 50).0.into_iter().filter(|h| h.pack == "zz-test").map(|h| h.name).collect() };
        assert_eq!(names("postgresql"), vec!["postgresql", "postgresql-wordmark"]);
        assert_eq!(names("Postgres"), vec!["postgres", "postgresql", "postgresql-wordmark"]);
        assert_eq!(names("cloud run"), vec!["google-cloud-run"]);
        assert_eq!(names("zz-test:aws"), vec!["aws-lambda"]);
        assert!(names("kafka").is_empty());
        let (hits, total) = search(Some(&root), "zz-test", 2);
        assert!(hits.len() == 2 && total >= 5);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sizes_are_human() {
        assert_eq!(human(512), "512 B");
        assert_eq!(human(4096), "4 KB");
        assert_eq!(human(7_795_606), "7.4 MB");
    }
}
