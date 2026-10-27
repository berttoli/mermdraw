//! mermdraw — a tiny local visual editor for mermaid diagrams that live inside markdown.
//!
//! The binary is std-only: it embeds the web UI (plus a gzipped mermaid bundle),
//! serves it on 127.0.0.1, watches the files the UI has open, and writes edits
//! back to disk atomically so they can be committed like any other change.

mod addons;
mod icons;
mod md;
mod sha256;

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 7788;
const MAX_BODY: usize = 25 * 1024 * 1024;
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
/// Commands that are never looked up as addons.
const BUILTINS: &[&str] = &["ls", "cat", "new", "write", "icons", "addons", "edit", "open", "help"];
/// Exit code of `write` when the file changed since the version it was given.
const EXIT_CONFLICT: i32 = 3;
/// The addon contract's version (docs/ADDONS.md): bumped only by a breaking change to the JSON commands.
const CONTRACT: u32 = 1;

/// Set by `--json`: errors are then reported as JSON on stdout.
static JSON: AtomicBool = AtomicBool::new(false);

struct Asset {
    path: &'static str,
    file: &'static str,
    mime: &'static str,
    body: &'static [u8],
    gzipped: bool,
}

const ASSETS: &[Asset] = &[
    Asset { path: "/", file: "index.html", mime: "text/html; charset=utf-8", body: include_bytes!("../web/index.html"), gzipped: false },
    Asset { path: "/app.css", file: "app.css", mime: "text/css; charset=utf-8", body: include_bytes!("../web/app.css"), gzipped: false },
    Asset {
        path: "/app.js",
        file: "app.js",
        mime: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/app.js"),
        gzipped: false,
    },
    Asset {
        path: "/canvas.js",
        file: "canvas.js",
        mime: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/canvas.js"),
        gzipped: false,
    },
    Asset {
        path: "/flags.js",
        file: "flags.js",
        mime: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/flags.js"),
        gzipped: false,
    },
    Asset {
        path: "/icons.js",
        file: "icons.js",
        mime: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/icons.js"),
        gzipped: false,
    },
    Asset {
        path: "/model.js",
        file: "model.js",
        mime: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/model.js"),
        gzipped: false,
    },
    Asset {
        path: "/vendor/mermaid.min.js",
        file: "vendor/mermaid.min.js.gz",
        mime: "text/javascript; charset=utf-8",
        body: include_bytes!("../web/vendor/mermaid.min.js.gz"),
        gzipped: true,
    },
];

struct Opts {
    port: Option<u16>,
    open: bool,
    app: bool,
    kind: String,
    title: Option<String>,
    vendor: bool,
    /// start a server even when one is already serving the same folder
    new_server: bool,
    /// feature flags forced on (true) or off (false) from the command line
    flags: Vec<(String, bool)>,
    json: bool,
    /// `write --base`: the version of the file the new source was based on
    base: Option<String>,
    append: bool,
    /// `icons search --limit`
    limit: usize,
    /// `addons add --version`: a release tag
    tag: Option<String>,
}

fn main() {
    let raw: Vec<OsString> = env::args_os().skip(1).collect();
    // `mermdraw NAME ARGS…` runs the addon mermdraw-NAME before any option is parsed, so its arguments reach it as given.
    if let Some(name) = raw.first().and_then(|a| a.to_str()).filter(|n| !BUILTINS.contains(n)) {
        if let Some(bin) = addons::find(name) {
            run_addon(&bin, &raw[1..]);
        }
    }
    let mut opts = Opts {
        port: None,
        open: true,
        app: false,
        kind: "flowchart".into(),
        title: None,
        vendor: false,
        new_server: false,
        flags: Vec::new(),
        json: false,
        base: None,
        append: false,
        limit: 50,
        tag: None,
    };
    let mut pos: Vec<String> = Vec::new();
    let args: Vec<String> = raw
        .into_iter()
        .map(|a| {
            a.into_string().unwrap_or_else(|a| die(&format!("{} is not valid UTF-8; mermdraw needs UTF-8 paths", a.to_string_lossy())))
        })
        .collect();
    JSON.store(args.iter().any(|a| a == "--json"), Ordering::Relaxed);
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let mut value = || {
            i += 1;
            args.get(i).cloned().unwrap_or_else(|| die(&format!("{a} needs a value")))
        };
        match a {
            "-h" | "--help" => return print_help(),
            "--version" if pos.first().map(String::as_str) == Some("addons") => opts.tag = Some(value()),
            "-V" | "--version" => return out(&format!("mermdraw {VERSION}")),
            "-p" | "--port" => opts.port = Some(value().parse().unwrap_or_else(|_| die("--port needs a number"))),
            "-t" | "--type" => opts.kind = value(),
            "--title" => opts.title = Some(value()),
            "--no-open" => opts.open = false,
            "--app" => opts.app = true,
            "--vendor" => opts.vendor = true,
            "--new" => opts.new_server = true,
            "--json" => opts.json = true,
            "--base" => opts.base = Some(value()),
            "--append" => opts.append = true,
            "--limit" => opts.limit = value().parse().ok().filter(|n| *n > 0).unwrap_or_else(|| die("--limit needs a positive number")),
            "--enable" | "--disable" => {
                let on = a == "--enable";
                for f in value().split(',').map(str::trim).filter(|f| !f.is_empty()) {
                    opts.flags.push((f.to_string(), on));
                }
            }
            _ if a.starts_with('-') && a.len() > 1 => die(&format!("unknown option {a} (try --help)")),
            _ => pos.push(a.to_string()),
        }
        i += 1;
    }
    let cmd = pos.first().map(String::as_str);
    if opts.json && !matches!(cmd, Some("ls" | "cat" | "write" | "icons")) {
        die("--json works with ls, cat, write and icons search");
    }
    match cmd {
        Some("ls") => cmd_ls(&pos[1..], &opts),
        Some("cat") => cmd_cat(&pos[1..], &opts),
        Some("write") => cmd_write(&pos[1..], &opts),
        Some("new") => cmd_new(&pos[1..], &opts),
        Some("icons") => cmd_icons(&pos[1..], &opts),
        Some("addons") => cmd_addons(&pos[1..], &opts),
        Some("edit") | Some("open") => serve(pos.get(1).map(String::as_str), &opts),
        Some("help") => print_help(),
        other => serve(other, &opts),
    }
}

fn print_help() {
    out(&format!(
        "mermdraw {VERSION} — visual mermaid editor for markdown files

USAGE
  mermdraw [PATH]             open the editor for a .md/.mmd file or a directory (default: .)
  mermdraw FILE:LINE          open the diagram at LINE (FILE:LINE:COL works too, as editors pass it)
  mermdraw ls [FILE|DIR]      list the mermaid diagrams in FILE, or in the markdown files under DIR
  mermdraw cat FILE [N]       print the source of diagram N (1-based, default 1)
  mermdraw write FILE N [--base VERSION] < SOURCE
                              replace diagram N with the source on stdin, keeping its canvas
                              positions unless the input has its own layout comment
  mermdraw write FILE --append [--title TITLE] < SOURCE
                              append the diagram on stdin (creates FILE if needed)
  mermdraw new FILE [-t TYPE] [--title TITLE]
                              append a new diagram (flowchart, sequence, class, state,
                              er, architecture, c4, gantt, mindmap)
  mermdraw icons [ls]         list installed icon packs
  mermdraw icons add PACK[@VER]... [--vendor]
                              install Iconify packs (logos, devicon, simple-icons, mdi, ...)
                              into ~/.config/mermdraw/icons, or into this repo's .mermdraw/icons
  mermdraw icons rm PACK... [--vendor]
  mermdraw icons search QUERY [--limit N]
                              find icons in the installed packs (default: the best 50)
  mermdraw addons [ls]        list installed addons
  mermdraw addons add NAME... [--version vX.Y.Z]
                              install official addons (e.g. mcp) from github.com/berttoli/mermdraw-NAME
                              into ~/.config/mermdraw/addons, checked against the release's
                              SHA256SUMS.txt and, when gh is installed, its build attestation
  mermdraw addons rm NAME...
  mermdraw NAME [ARGS...]     run the addon mermdraw-NAME (addons folder first, then PATH)

OPTIONS
  -p, --port N                port to listen on (default {DEFAULT_PORT}, next free one if taken)
      --no-open               don't open a browser
      --app                   open in a chromeless Chrome/Edge/Brave app window if available
      --new                   start a new server even if one is already serving this folder
      --enable F1,F2          turn feature flags on (see Labs in the editor)
      --disable F1,F2         turn feature flags off
      --json                  JSON output for ls, cat, write and icons search, errors included
                              (an error object on stdout)
  -h, --help                  show this help
  -V, --version               show version

EXIT CODES
  0 done, 1 error, 3 write refused because the file changed since --base

A server already running for the same folder is reused: mermdraw opens a tab on it and exits.
The editor saves straight into the markdown file; commit it like any other change."
    ));
}

/// Writes a line to stdout. When stdout is a pipe that closed early (`mermdraw cat … | head -1`), mermdraw stops
/// quietly, as Unix tools do, instead of panicking on the write.
fn out(line: &str) {
    let mut o = io::stdout().lock();
    if o.write_all(line.as_bytes()).and_then(|_| o.write_all(b"\n")).is_err() {
        process::exit(0);
    }
}

fn die(msg: &str) -> ! {
    fail("error", msg, "", 1)
}

/// Reports an error and exits with `code`: for `--json` commands a JSON object on stdout, whose `fields` are extra
/// members of `error` (`,"version":"…"`); otherwise a line on stderr.
fn fail(kind: &str, msg: &str, fields: &str, code: i32) -> ! {
    if JSON.load(Ordering::Relaxed) {
        let err = format!(r#"{{"code":{},"message":{}{fields}}}"#, json_str(kind), json_str(msg));
        let _ = writeln!(io::stdout().lock(), r#"{{{},"error":{err}}}"#, json_head());
    } else {
        eprintln!("mermdraw: {msg}");
    }
    process::exit(code)
}

/// mermdraw's config folder: $XDG_CONFIG_HOME/mermdraw, else ~/.config/mermdraw (%APPDATA%\mermdraw on Windows).
fn config_dir() -> Option<PathBuf> {
    let base = match env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x),
        None if cfg!(windows) => PathBuf::from(env::var_os("APPDATA")?),
        None => PathBuf::from(env::var_os("HOME")?).join(".config"),
    };
    Some(base.join("mermdraw"))
}

/// Runs an addon in mermdraw's place. On Unix it replaces this process, so stdin and stdout (an MCP server's
/// protocol stream, say) belong to the addon; elsewhere mermdraw waits for it and exits with its code.
fn run_addon(bin: &Path, args: &[OsString]) -> ! {
    let mut cmd = Command::new(bin);
    cmd.args(args).env("MERMDRAW", env::current_exe().unwrap_or_else(|_| "mermdraw".into())).env("MERMDRAW_VERSION", VERSION);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let e = cmd.exec();
        die(&format!("could not run {}: {e}", bin.display()))
    }
    #[cfg(not(unix))]
    match cmd.status() {
        Ok(s) => process::exit(s.code().unwrap_or(1)),
        Err(e) => die(&format!("could not run {}: {e}", bin.display())),
    }
}

// ---------------------------------------------------------------- terminal commands

fn read_doc(path: &str) -> (String, Vec<md::Block>) {
    let text = fs::read_to_string(path).unwrap_or_else(|e| die(&format!("{path}: {e}")));
    let blocks = md::blocks(&text, md::is_mmd(path));
    (text, blocks)
}

/// The members every JSON output starts with: mermdraw's version and the addon contract's.
fn json_head() -> String {
    format!(r#""mermdraw":{},"contract":{CONTRACT}"#, json_str(VERSION))
}

fn json_opt(s: Option<&str>) -> String {
    s.map_or_else(|| "null".into(), json_str)
}

/// A diagram's JSON members: its 1-based number, the 1-based lines of its fences, and whether the source has a
/// canvas-position comment.
fn diagram_fields(b: &md::Block, line_count: usize) -> String {
    format!(
        r#""index":{},"kind":{},"title":{},"start_line":{},"end_line":{},"layout":{}"#,
        b.index + 1,
        json_str(&b.kind),
        json_opt(b.title.as_deref()),
        b.start + 1,
        b.end.min(line_count.saturating_sub(1)) + 1,
        b.source.lines().any(md::is_layout_line)
    )
}

fn cmd_ls(args: &[String], opts: &Opts) {
    if args.len() > 1 {
        die("usage: mermdraw ls [FILE|DIR] [--json]");
    }
    let path = args.first().map(String::as_str).unwrap_or(".");
    let dir = Path::new(path).is_dir();
    let files: Vec<String> = if dir {
        let mut rels = Vec::new();
        walk(Path::new(path), Path::new(path), &mut rels, 0);
        rels.into_iter().map(|r| if path == "." { r } else { format!("{}/{r}", path.trim_end_matches('/')) }).collect()
    } else {
        vec![path.to_string()]
    };
    let (mut items, mut shown) = (Vec::new(), 0);
    for file in &files {
        let version = version_of(Path::new(file));
        let text = match fs::read_to_string(file) {
            Ok(text) => text,
            Err(_) if dir => continue,
            Err(e) => die(&format!("{file}: {e}")),
        };
        let mmd = md::is_mmd(file);
        let blocks = md::blocks(&text, mmd);
        if dir && blocks.is_empty() {
            continue;
        }
        if opts.json {
            let title = if mmd { blocks.first().and_then(|b| b.title.clone()) } else { md::title(&text) };
            let n = text.lines().count();
            let diagrams: Vec<String> = blocks.iter().map(|b| format!("{{{}}}", diagram_fields(b, n))).collect();
            items.push(format!(
                r#"{{"file":{},"version":{},"title":{},"diagrams":[{}]}}"#,
                json_str(file),
                json_str(&version),
                json_opt(title.as_deref()),
                diagrams.join(",")
            ));
            continue;
        }
        shown += 1;
        out(&format!("{file} — {} diagram{}", blocks.len(), if blocks.len() == 1 { "" } else { "s" }));
        for b in &blocks {
            let lines = format!("L{}-{}", b.start + 1, b.end + 1);
            out(&format!("  {:>2}  {:<18} {:<10} {}", b.index + 1, b.kind, lines, b.title.as_deref().unwrap_or("")));
        }
    }
    if opts.json {
        out(&format!(r#"{{{},"files":[{}]}}"#, json_head(), items.join(",")));
    } else if shown == 0 {
        out(&format!("no mermaid diagrams under {path}"));
    }
}

fn cmd_cat(args: &[String], opts: &Opts) {
    let path = args.first().unwrap_or_else(|| die("usage: mermdraw cat FILE [N] [--json]"));
    let n: usize = args.get(1).map(|s| s.parse().unwrap_or_else(|_| die("N must be a number"))).unwrap_or(1);
    // read before the text, so a change in between makes the version older, never newer, than the source
    let version = version_of(Path::new(path));
    let (text, blocks) = read_doc(path);
    let b = blocks.get(n.wrapping_sub(1)).unwrap_or_else(|| die(&format!("{path} has no diagram #{n}")));
    if opts.json {
        let (source, _) = md::split_layout(&b.source);
        out(&format!(
            r#"{{{},"file":{},"version":{},{},"source":{}}}"#,
            json_head(),
            json_str(path),
            json_str(&version),
            diagram_fields(b, text.lines().count()),
            json_str(&source)
        ));
    } else {
        out(b.source.strip_suffix('\n').unwrap_or(&b.source));
    }
}

/// `write FILE N` replaces diagram N with the source on stdin; `write FILE --append` adds it as a new diagram.
/// The write is refused (exit 3) when the file changed since `--base`, or since it was read here.
fn cmd_write(args: &[String], opts: &Opts) {
    const USAGE: &str =
        "usage: mermdraw write FILE N [--base VERSION] < diagram.mmd, or: mermdraw write FILE --append [--title TITLE] < diagram.mmd";
    let path = args.first().filter(|_| args.len() <= 2).unwrap_or_else(|| die(USAGE));
    if !(md::is_md(path) || md::is_mmd(path)) {
        die(&format!("{path}: give a markdown (.md) or mermaid (.mmd) file"));
    }
    let n: Option<usize> = match (args.get(1), opts.append) {
        (Some(n), false) => Some(n.parse().ok().filter(|n| *n > 0).unwrap_or_else(|| die("N must be a diagram number (1-based)"))),
        (None, true) => None,
        _ => die(USAGE),
    };
    let source = read_source();
    let mmd = md::is_mmd(path);
    let file = Path::new(path);
    let read_version = version_of(file);
    let existing = match fs::read_to_string(file) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == io::ErrorKind::NotFound && n.is_none() => None,
        Err(e) => die(&format!("{path}: {e}")),
    };
    let created = existing.is_none();
    let existing = existing.unwrap_or_default();
    let blocks = md::blocks(&existing, mmd);
    let check_fence = |fence| {
        if let Some(l) = md::closing_fence_line(&source, fence).filter(|_| !mmd) {
            die(&format!("line {l} of the diagram would end its markdown code block; give the source without ``` fences"));
        }
    };
    let (text, index, layout) = match n {
        Some(n) => {
            let b = blocks.get(n - 1).unwrap_or_else(|| die(&format!("{path} has no diagram #{n} (it has {})", blocks.len())));
            check_fence(b.fence);
            let (_, old_layout) = md::split_layout(&b.source);
            let (source, layout) = if source.lines().any(md::is_layout_line) {
                (source.clone(), "input")
            } else if !old_layout.is_empty() {
                (format!("{source}\n{}", old_layout.join("\n")), "kept")
            } else {
                (source.clone(), "none")
            };
            (md::replace_block(&existing, b, &source, mmd), n, layout)
        }
        None => {
            check_fence(('`', 3));
            let layout = if source.lines().any(md::is_layout_line) { "input" } else { "none" };
            if mmd {
                if !existing.trim().is_empty() {
                    die(&format!(".mmd files hold a single diagram; replace it with: mermdraw write {path} 1"));
                }
                (format!("{source}\n"), 1, layout)
            } else {
                let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                (md::append_block(&existing, &stem, opts.title.as_deref(), &source), blocks.len() + 1, layout)
            }
        }
    };
    create_parent(file);
    let base = opts.base.clone().unwrap_or(read_version);
    let version = match save_doc(file, text.as_bytes(), Some(&base)) {
        Ok(v) => v,
        Err(SaveError::Conflict(now)) => fail(
            "conflict",
            &format!("{path} changed since version {base} (it is now {now}); read it again and redo the change"),
            &format!(r#","version":{}"#, json_str(&now)),
            EXIT_CONFLICT,
        ),
        Err(SaveError::Io(e)) => die(&format!("{path}: {e}")),
    };
    if opts.json {
        out(&format!(
            r#"{{{},"file":{},"index":{index},"version":{},"layout":{},"created":{created}}}"#,
            json_head(),
            json_str(path),
            json_str(&version),
            json_str(layout)
        ));
    } else {
        let kept = if layout == "kept" { " (canvas positions kept)" } else { "" };
        match (n, created) {
            (Some(_), _) => out(&format!("wrote diagram #{index} in {path}{kept}")),
            (None, true) => out(&format!("created {path} with the diagram")),
            (None, false) => out(&format!("added diagram #{index} to {path}")),
        }
    }
}

/// The diagram source `write` reads from stdin: LF line endings, without surrounding blank lines.
fn read_source() -> String {
    let mut stdin = io::stdin();
    if stdin.is_terminal() {
        die("write reads the diagram source from stdin, e.g.: mermdraw write docs/arch.md 2 < diagram.mmd");
    }
    let mut raw = String::new();
    stdin.read_to_string(&mut raw).unwrap_or_else(|e| die(&format!("could not read the diagram from stdin: {e}")));
    let lines: Vec<&str> = raw.lines().skip_while(|l| l.trim().is_empty()).collect();
    let source = lines.join("\n").trim_end().to_string();
    if source.is_empty() {
        die("no diagram source on stdin");
    }
    source
}

fn cmd_new(args: &[String], opts: &Opts) {
    let path = args.first().unwrap_or_else(|| die("usage: mermdraw new FILE [-t TYPE] [--title TITLE]"));
    let tpl = md::template(&opts.kind).unwrap_or_else(|| die(&format!("unknown diagram type '{}'", opts.kind)));
    if !(md::is_md(path) || md::is_mmd(path)) {
        die(&format!("{path}: give a markdown (.md) or mermaid (.mmd) file, e.g. docs/architecture.md"));
    }
    // Only a missing file counts as empty; any other read error must not lead to overwriting it.
    let existing = match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => die(&format!("{path}: {e}")),
    };
    let created = existing.is_none();
    let existing = existing.unwrap_or_default();
    let count = md::blocks(&existing, md::is_mmd(path)).len();
    let text = if md::is_mmd(path) {
        if !existing.trim().is_empty() {
            die(".mmd files hold a single diagram");
        }
        tpl.to_string()
    } else {
        let stem = Path::new(path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        md::append_block(&existing, &stem, opts.title.as_deref(), tpl)
    };
    create_parent(Path::new(path));
    write_atomic(Path::new(path), text.as_bytes()).unwrap_or_else(|e| die(&format!("{path}: {e}")));
    if created {
        out(&format!("created {path} with a {} diagram", opts.kind));
    } else {
        let n = if md::is_mmd(path) { 1 } else { count + 1 };
        out(&format!("added {} diagram #{n} to {path}", opts.kind));
    }
}

fn cmd_icons(args: &[String], opts: &Opts) {
    let root = env::current_dir().ok().map(|d| git_root(&d).unwrap_or(d));
    let dest = if opts.vendor { root.as_deref().map(icons::project_dir) } else { icons::global_dir() }
        .unwrap_or_else(|| die("cannot find a config directory (set XDG_CONFIG_HOME)"));
    if opts.json && !matches!(args.first().map(String::as_str), Some("search" | "find")) {
        die("--json works with icons search");
    }
    match args.first().map(String::as_str) {
        None | Some("ls") | Some("list") => {
            let packs = icons::installed(root.as_deref());
            if packs.is_empty() {
                out("no icon packs installed — try: mermdraw icons add logos devicon");
            }
            for p in packs {
                out(&format!("  {:<16} {:>8}  {:<8} {}", p.name, icons::human(p.size), p.source, p.path.display()));
            }
        }
        Some("add") => {
            if args.len() < 2 {
                die("usage: mermdraw icons add PACK[@VERSION]... [--vendor]");
            }
            for spec in &args[1..] {
                match icons::add(spec, &dest) {
                    Ok((path, size)) => out(&format!("installed {spec} ({}) → {}", icons::human(size), path.display())),
                    Err(e) => die(&e),
                }
            }
        }
        Some("rm") | Some("remove") => {
            if args.len() < 2 {
                die("usage: mermdraw icons rm PACK... [--vendor]");
            }
            let mut missing = false;
            for name in &args[1..] {
                let path = dest.join(format!("{name}.json"));
                if icons::valid_name(name) && fs::remove_file(&path).is_ok() {
                    out(&format!("removed {}", path.display()));
                } else {
                    eprintln!("mermdraw: {name} is not installed in {}", dest.display());
                    missing = true;
                }
            }
            if missing {
                process::exit(1);
            }
        }
        Some("search") | Some("find") => {
            let query = args[1..].join(" ");
            if query.trim().is_empty() {
                die("usage: mermdraw icons search QUERY [--limit N] [--json]");
            }
            let packs = icons::installed(root.as_deref());
            let (hits, total) = icons::search(root.as_deref(), &query, opts.limit);
            if opts.json {
                let packs: Vec<String> =
                    packs.iter().map(|p| format!(r#"{{"name":{},"source":{}}}"#, json_str(&p.name), json_str(p.source))).collect();
                let found: Vec<String> = hits
                    .iter()
                    .map(|h| {
                        let icon = format!("{}:{}", h.pack, h.name);
                        format!(
                            r#"{{"icon":{},"pack":{},"name":{},"source":{}}}"#,
                            json_str(&icon),
                            json_str(&h.pack),
                            json_str(&h.name),
                            json_str(h.source)
                        )
                    })
                    .collect();
                out(&format!(
                    r#"{{{},"query":{},"packs":[{}],"icons":[{}],"total":{total}}}"#,
                    json_head(),
                    json_str(&query),
                    packs.join(","),
                    found.join(",")
                ));
            } else if packs.is_empty() {
                out("no icon packs installed — try: mermdraw icons add logos devicon");
            } else if total == 0 {
                let names: Vec<&str> = packs.iter().map(|p| p.name.as_str()).collect();
                out(&format!("no icons match '{query}' in {}", names.join(", ")));
            } else {
                for h in &hits {
                    out(&format!("  {:<40} {}", format!("{}:{}", h.pack, h.name), h.source));
                }
                if total > hits.len() {
                    out(&format!("  … and {} more (--limit N shows more)", total - hits.len()));
                }
            }
        }
        Some(other) => die(&format!("unknown icons command '{other}' (try: ls, add, rm, search)")),
    }
}

fn cmd_addons(args: &[String], opts: &Opts) {
    let dir = addons::dir().unwrap_or_else(|| die("cannot find a config directory (set XDG_CONFIG_HOME)"));
    let sub = args.first().map(String::as_str);
    if opts.tag.is_some() && !matches!(sub, Some("add" | "install")) {
        die("--version VERSION goes with: mermdraw addons add NAME --version vX.Y.Z");
    }
    match sub {
        None | Some("ls") | Some("list") => {
            let list = addons::installed(BUILTINS);
            if list.is_empty() {
                out("no addons installed — try: mermdraw addons add mcp");
            }
            for a in list {
                out(&format!("  {:<16} {:>8}  {:<7} {}", a.name, icons::human(a.size), a.source, a.path.display()));
            }
        }
        Some("add") | Some("install") => {
            if args.len() < 2 {
                die("usage: mermdraw addons add NAME... [--version vX.Y.Z]");
            }
            if let Some(t) = opts.tag.as_deref().filter(|t| !addons::valid_tag(t)) {
                die(&format!("'{t}' is not a release tag like v0.1.0"));
            }
            for name in &args[1..] {
                if !addons::valid_name(name) {
                    die(&format!("'{name}' is not an addon name: official addons are named with a-z, 0-9 and -, e.g. mcp"));
                }
                if BUILTINS.contains(&name.as_str()) {
                    die(&format!("'{name}' is a mermdraw command, not an addon"));
                }
                match addons::add(name, opts.tag.as_deref(), &dir) {
                    Ok(i) => {
                        out(&format!("installed {name} → {}", i.path.display()));
                        out(&format!("  from         {}", i.url));
                        out(&format!("  sha256       {} matches SHA256SUMS.txt", i.sha256));
                        out(&format!("  attestation  {}", i.attestation));
                        out(&format!("  run it with  mermdraw {name}"));
                    }
                    Err(e) => die(&e),
                }
            }
        }
        Some("rm") | Some("remove") | Some("uninstall") => {
            if args.len() < 2 {
                die("usage: mermdraw addons rm NAME...");
            }
            let mut missing = false;
            for name in &args[1..] {
                match addons::remove(name) {
                    Ok(path) => out(&format!("removed {}", path.display())),
                    Err(e) => {
                        eprintln!("mermdraw: {e}");
                        missing = true;
                    }
                }
            }
            if missing {
                process::exit(1);
            }
        }
        Some(other) => die(&format!("unknown addons command '{other}' (try: ls, add, rm)")),
    }
}

// ---------------------------------------------------------------- server

struct Hub {
    seq: u64,
    events: Vec<(u64, String)>,
}

struct State {
    root: PathBuf,
    initial: Option<String>,
    /// JSON object of feature flags set on the command line
    flags: String,
    web_dir: Option<PathBuf>,
    watched: Mutex<HashMap<String, String>>,
    hub: Mutex<Hub>,
    cv: Condvar,
}

impl State {
    fn publish(&self, json: String) {
        let mut hub = self.hub.lock().unwrap();
        hub.seq += 1;
        let seq = hub.seq;
        hub.events.push((seq, json));
        if hub.events.len() > 256 {
            hub.events.drain(..128);
        }
        self.cv.notify_all();
    }
}

fn serve(target: Option<&str>, opts: &Opts) {
    let (target, line) = split_line(target.unwrap_or("."));
    let target = PathBuf::from(target);
    let name = target.to_string_lossy().to_string();
    if !target.exists() {
        if !(md::is_md(&name) || md::is_mmd(&name)) {
            if !name.contains(['/', '\\', '.']) {
                die(&format!("{name} is not a command, an installed addon or an existing file (try --help)"));
            }
            die(&format!("{name} does not exist"));
        }
        create_parent(&target);
        let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let tpl = md::template("flowchart").unwrap();
        let text = if md::is_mmd(&name) { tpl.to_string() } else { md::append_block("", &stem, Some("Overview"), tpl) };
        write_atomic(&target, text.as_bytes()).unwrap_or_else(|e| die(&format!("{name}: {e}")));
        out(&format!("created {name}"));
    }
    if target.is_file() && !(md::is_md(&name) || md::is_mmd(&name)) {
        die(&format!("{name} is not a markdown (.md) or mermaid (.mmd) file"));
    }
    let target = target.canonicalize().unwrap_or_else(|e| die(&format!("{}: {e}", target.display())));
    let (root, initial) = if target.is_dir() {
        (target.clone(), None)
    } else {
        let parent = target.parent().unwrap().to_path_buf();
        let root = git_root(&parent).unwrap_or(parent);
        let rel = rel_str(target.strip_prefix(&root).unwrap());
        (root, Some(rel))
    };

    // FILE:LINE opens the diagram at that line
    let diagram = match (&initial, line) {
        (Some(_), Some(line)) => {
            let text = fs::read_to_string(&target).unwrap_or_default();
            md::block_at_line(&md::blocks(&text, md::is_mmd(&target.to_string_lossy())), line)
        }
        _ => None,
    };

    // Reuse a server already serving this folder (unless asked for a new one or for different flags).
    if !opts.new_server && opts.flags.is_empty() {
        if let Some(port) = running_server(&root, opts.port) {
            let url = page_url(port, initial.as_deref(), diagram);
            out(&format!("mermdraw {VERSION}  already running for {}", root.display()));
            out(&format!("  → {url}"));
            if opts.open {
                open_browser(&url, opts.app);
            }
            return;
        }
    }

    let listener = bind(opts.port);
    let port = listener.local_addr().unwrap().port();
    let flags = opts.flags.iter().map(|(f, on)| format!("{}:{on}", json_str(f))).collect::<Vec<_>>().join(",");
    let state = Arc::new(State {
        root,
        initial: initial.clone(),
        flags: format!("{{{flags}}}"),
        web_dir: env::var_os("MERMDRAW_WEB").map(PathBuf::from),
        watched: Mutex::new(HashMap::new()),
        hub: Mutex::new(Hub { seq: 0, events: Vec::new() }),
        cv: Condvar::new(),
    });

    let url = page_url(port, initial.as_deref(), diagram);
    // a closed stdout (whoever started the server stopped reading) must not stop the server
    let _ = writeln!(io::stdout().lock(), "mermdraw {VERSION}  root {}\n  → {url}   (Ctrl+C to quit)", state.root.display());
    if opts.open {
        open_browser(&url, opts.app);
    }

    let w = state.clone();
    thread::spawn(move || watch_loop(w));
    for stream in listener.incoming().flatten() {
        let st = state.clone();
        thread::spawn(move || {
            let _ = handle(stream, &st);
        });
    }
}

/// Creates the folders a new document will live in (`docs/` in `mermdraw new docs/arch.md`).
fn create_parent(path: &Path) {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir).unwrap_or_else(|e| die(&format!("{}: {e}", dir.display())));
    }
}

/// `docs/arch.md:42` (or `:42:7`, as editors pass file:line:column): the path and its 1-based line. A path that
/// exists as written is never split.
fn split_line(arg: &str) -> (&str, Option<usize>) {
    if Path::new(arg).exists() {
        return (arg, None);
    }
    let num = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match arg.rsplit_once(':') {
        Some((rest, last)) if num(last) && !rest.is_empty() => match rest.rsplit_once(':') {
            Some((path, line)) if num(line) && !path.is_empty() => (path, line.parse().ok()),
            _ => (rest, last.parse().ok()),
        },
        _ => (arg, None),
    }
}

/// The editor URL for a file and (0-based) diagram index.
fn page_url(port: u16, file: Option<&str>, diagram: Option<usize>) -> String {
    let mut url = format!("http://127.0.0.1:{port}/");
    if let Some(f) = file {
        url.push_str(&format!("?file={}", url_encode(f)));
        if let Some(d) = diagram {
            url.push_str(&format!("#d={}", d + 1));
        }
    }
    url
}

/// The port of a mermdraw server of this version already serving `root`, looked for on `port`, or on the ports
/// `bind` picks from when none is given.
fn running_server(root: &Path, port: Option<u16>) -> Option<u16> {
    let want = format!(r#""version":{},"root":{}"#, json_str(VERSION), json_str(&root.to_string_lossy()));
    let ports: Vec<u16> = match port {
        Some(p) => vec![p],
        None => (DEFAULT_PORT..DEFAULT_PORT + 20).collect(),
    };
    ports.into_iter().find(|&p| {
        let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], p).into(), Duration::from_millis(200)) else {
            return false;
        };
        let _ = s.set_read_timeout(Some(Duration::from_millis(300)));
        let req = format!("GET /api/info HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nConnection: close\r\n\r\n");
        if s.write_all(req.as_bytes()).is_err() {
            return false;
        }
        let mut buf = Vec::new();
        let _ = s.read_to_end(&mut buf); // a timeout keeps what arrived
        String::from_utf8_lossy(&buf).contains(&want)
    })
}

fn bind(port: Option<u16>) -> TcpListener {
    if let Some(p) = port {
        return TcpListener::bind(("127.0.0.1", p)).unwrap_or_else(|e| die(&format!("port {p}: {e}")));
    }
    (DEFAULT_PORT..DEFAULT_PORT + 20)
        .find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok())
        .or_else(|| TcpListener::bind(("127.0.0.1", 0)).ok())
        .unwrap_or_else(|| die("could not bind a local port"))
}

fn git_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf)
}

fn open_browser(url: &str, app: bool) {
    let quiet = |c: &mut Command| c.stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    let app_arg = format!("--app={url}");
    if cfg!(target_os = "macos") {
        if app {
            for b in ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"] {
                if quiet(Command::new("open").args(["-na", b, "--args", &app_arg])) {
                    return;
                }
            }
        }
        quiet(Command::new("open").arg(url));
    } else if cfg!(windows) {
        if app && quiet(Command::new("cmd").args(["/C", "start", "", "msedge", &app_arg])) {
            return;
        }
        quiet(Command::new("cmd").args(["/C", "start", "", url]));
    } else {
        if app {
            for b in ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"] {
                if Command::new(b).arg(&app_arg).stdout(Stdio::null()).stderr(Stdio::null()).spawn().is_ok() {
                    return;
                }
            }
        }
        let _ = Command::new("xdg-open").arg(url).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }
}

/// Polls the files the UI has opened and publishes a change event when one is
/// modified outside mermdraw (another editor, git checkout, ...).
fn watch_loop(st: Arc<State>) {
    loop {
        thread::sleep(Duration::from_millis(300));
        let paths: Vec<String> = st.watched.lock().unwrap().keys().cloned().collect();
        for rel in paths {
            let v = version_of(&st.root.join(&rel));
            let changed = {
                let mut w = st.watched.lock().unwrap();
                let changed = w.get(&rel) != Some(&v);
                w.insert(rel.clone(), v.clone());
                changed
            };
            if changed {
                st.publish(format!(r#"{{"type":"change","path":{},"version":{},"origin":""}}"#, json_str(&rel), json_str(&v)));
            }
        }
    }
}

fn version_of(p: &Path) -> String {
    match fs::metadata(p) {
        Ok(m) => {
            let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            format!("{t}-{}", m.len())
        }
        Err(_) => "missing".into(),
    }
}

struct Req {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn handle(mut stream: TcpStream, st: &State) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    (&mut reader).take(8192).read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if (&mut reader).take(16384).read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
        if headers.len() > 64 {
            return text(&mut stream, "431 Request Header Fields Too Large", "too many headers");
        }
    }
    // Only answer requests addressed to the loopback host (blocks DNS rebinding).
    let host = headers.get("host").map(String::as_str).unwrap_or("");
    let host_name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    if !matches!(host_name, "127.0.0.1" | "localhost" | "[::1]") {
        return text(&mut stream, "403 Forbidden", "bad host");
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return text(&mut stream, "413 Payload Too Large", "too large");
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    let (path, qs) = target.split_once('?').unwrap_or((&target, ""));
    let req = Req { method, path: url_decode(path), query: parse_query(qs), headers, body };
    route(&mut stream, st, &req)
}

fn route(s: &mut TcpStream, st: &State, req: &Req) -> io::Result<()> {
    let q = |k: &str| req.query.get(k).map(String::as_str).unwrap_or("");
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/api/info") => {
            let initial = st.initial.as_deref().map(json_str).unwrap_or_else(|| "null".into());
            let name = st.root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let body = format!(
                r#"{{"version":{},"root":{},"rootName":{},"initial":{},"flags":{}}}"#,
                json_str(VERSION),
                json_str(&st.root.to_string_lossy()),
                json_str(&name),
                initial,
                st.flags
            );
            respond(s, "200 OK", "application/json", &[], body.as_bytes())
        }
        ("GET", "/api/files") => {
            let mut files = Vec::new();
            walk(&st.root, &st.root, &mut files, 0);
            let items: Vec<String> = files
                .iter()
                .map(|rel| {
                    let Ok(text) = fs::read_to_string(st.root.join(rel)) else {
                        return format!(r#"{{"path":{},"diagrams":0,"title":null}}"#, json_str(rel));
                    };
                    let mmd = md::is_mmd(rel);
                    let blocks = md::blocks(&text, mmd);
                    let title = if mmd { blocks.first().and_then(|b| b.title.clone()) } else { md::title(&text) };
                    let title = title.map_or("null".to_string(), |t| json_str(&t));
                    format!(r#"{{"path":{},"diagrams":{},"title":{title}}}"#, json_str(rel), blocks.len())
                })
                .collect();
            respond(s, "200 OK", "application/json", &[], format!(r#"{{"files":[{}]}}"#, items.join(",")).as_bytes())
        }
        ("GET", "/api/file") => {
            let Some((rel, full)) = resolve_doc(st, q("path")) else { return text(s, "400 Bad Request", "bad path") };
            match fs::read(&full) {
                Ok(bytes) => {
                    let v = version_of(&full);
                    st.watched.lock().unwrap().insert(rel, v.clone());
                    respond(s, "200 OK", "text/plain; charset=utf-8", &[("X-Version", v)], &bytes)
                }
                Err(_) => text(s, "404 Not Found", "not found"),
            }
        }
        ("PUT", "/api/file") => {
            let Some((rel, full)) = resolve_doc(st, q("path")) else { return text(s, "400 Bad Request", "bad path") };
            let v = match save_doc(&full, &req.body, req.headers.get("x-base-version").map(String::as_str)) {
                Ok(v) => v,
                Err(SaveError::Conflict(current)) => {
                    let bytes = fs::read(&full).unwrap_or_default();
                    return respond(s, "409 Conflict", "text/plain; charset=utf-8", &[("X-Version", current)], &bytes);
                }
                Err(SaveError::Io(e)) => return text(s, "500 Internal Server Error", &e.to_string()),
            };
            st.watched.lock().unwrap().insert(rel.clone(), v.clone());
            let origin = req.headers.get("x-client").cloned().unwrap_or_default();
            st.publish(format!(
                r#"{{"type":"change","path":{},"version":{},"origin":{}}}"#,
                json_str(&rel),
                json_str(&v),
                json_str(&origin)
            ));
            respond(s, "200 OK", "text/plain", &[("X-Version", v)], b"ok")
        }
        ("GET", "/api/config") => {
            // project defaults for the editor (feature flags today); the browser validates it
            let raw = fs::read_to_string(st.root.join(".mermdraw").join("config.json")).ok().filter(|t| t.trim_start().starts_with('{'));
            respond(s, "200 OK", "application/json", &[], raw.as_deref().unwrap_or("{}").as_bytes())
        }
        ("GET", "/api/icons") => {
            let items: Vec<String> = icons::installed(Some(&st.root))
                .iter()
                .map(|p| format!(r#"{{"name":{},"source":{},"size":{}}}"#, json_str(&p.name), json_str(p.source), p.size))
                .collect();
            respond(s, "200 OK", "application/json", &[], format!(r#"{{"packs":[{}]}}"#, items.join(",")).as_bytes())
        }
        ("GET", p) if p.starts_with("/api/icons/") && p.ends_with(".json") => {
            match icons::find(&st.root, &p[11..p.len() - 5]).and_then(|f| fs::read(f).ok()) {
                Some(bytes) => respond(s, "200 OK", "application/json", &[("Cache-Control", "private, max-age=300".into())], &bytes),
                None => text(s, "404 Not Found", "icon pack not installed"),
            }
        }
        ("POST", "/api/upload") => upload(s, st, req),
        ("GET", "/api/events") => events(s, st),
        ("GET", p) if p.starts_with("/raw/") => {
            let Some(full) = resolve(&st.root, &p[5..]) else { return text(s, "400 Bad Request", "bad path") };
            match fs::read(&full) {
                Ok(bytes) => respond(s, "200 OK", mime_for(&full), &[], &bytes),
                Err(_) => text(s, "404 Not Found", "not found"),
            }
        }
        ("GET", p) => match ASSETS.iter().find(|a| a.path == p) {
            Some(a) => {
                if let (Some(dir), false) = (&st.web_dir, a.gzipped) {
                    if let Ok(bytes) = fs::read(dir.join(a.file)) {
                        return respond(s, "200 OK", a.mime, &[], &bytes);
                    }
                }
                let extra: &[(&str, String)] = if a.gzipped { &[("Content-Encoding", String::from("gzip"))] } else { &[] };
                respond(s, "200 OK", a.mime, extra, a.body)
            }
            None => text(s, "404 Not Found", "not found"),
        },
        _ => text(s, "405 Method Not Allowed", "method not allowed"),
    }
}

fn events(s: &mut TcpStream, st: &State) -> io::Result<()> {
    let mut last = st.hub.lock().unwrap().seq;
    s.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\nretry: 1000\n\n",
    )?;
    s.flush()?;
    loop {
        let batch: Vec<String> = {
            let hub = st.hub.lock().unwrap();
            let (hub, _) = st.cv.wait_timeout_while(hub, Duration::from_secs(15), |h| h.seq == last).unwrap();
            let batch = hub.events.iter().filter(|(n, _)| *n > last).map(|(_, e)| e.clone()).collect();
            last = hub.seq;
            batch
        };
        let mut out = String::new();
        if batch.is_empty() {
            out.push_str(": ping\n\n");
        }
        for e in batch {
            out.push_str(&format!("data: {e}\n\n"));
        }
        s.write_all(out.as_bytes())?;
        s.flush()?;
    }
}

/// Stores a dropped/pasted image next to the markdown file in `assets/` and
/// returns its path relative to that markdown file.
fn upload(s: &mut TcpStream, st: &State, req: &Req) -> io::Result<()> {
    let q = |k: &str| req.query.get(k).map(String::as_str).unwrap_or("");
    let Some((_, doc)) = resolve_doc(st, q("file")) else { return text(s, "400 Bad Request", "bad file") };
    let name: String = q("name").chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).collect();
    let name = name.trim_matches(|c| c == '.' || c == '-').to_string();
    let name = if name.is_empty() { "image.png".to_string() } else { name };
    let ext = Path::new(&name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return text(s, "400 Bad Request", "only images can be uploaded");
    }
    let dir = doc.parent().unwrap().join("assets");
    if let Err(e) = fs::create_dir_all(&dir) {
        return text(s, "500 Internal Server Error", &e.to_string());
    }
    let stem = Path::new(&name).file_stem().unwrap().to_string_lossy().to_string();
    let mut dest = dir.join(&name);
    let mut n = 1;
    while dest.exists() {
        if fs::read(&dest).map(|b| b == req.body).unwrap_or(false) {
            break;
        }
        dest = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    if let Err(e) = fs::write(&dest, &req.body) {
        return text(s, "500 Internal Server Error", &e.to_string());
    }
    let rel = format!("assets/{}", dest.file_name().unwrap().to_string_lossy());
    respond(s, "200 OK", "application/json", &[], format!(r#"{{"path":{}}}"#, json_str(&rel)).as_bytes())
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<String>, depth: usize) {
    if depth > 12 || out.len() >= 4000 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                walk(&e.path(), root, out, depth + 1);
            }
        } else if ft.is_file() && (md::is_md(&name) || md::is_mmd(&name)) {
            if let Ok(rel) = e.path().strip_prefix(root) {
                out.push(rel_str(rel));
            }
        }
    }
}

/// Resolves a markdown/mermaid document path inside the root.
fn resolve_doc(st: &State, rel: &str) -> Option<(String, PathBuf)> {
    if !(md::is_md(rel) || md::is_mmd(rel)) {
        return None;
    }
    let full = resolve(&st.root, rel)?;
    Some((rel_str(full.strip_prefix(&st.root).ok()?), full))
}

/// Joins `rel` onto `root`, refusing anything that escapes it (`..`, absolute
/// paths, symlinks pointing outside).
fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel.trim_start_matches('/'));
    if rel.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return None;
    }
    let full = root.join(p);
    if let Ok(c) = full.canonicalize() {
        return c.starts_with(root).then_some(c);
    }
    let parent = full.parent()?.canonicalize().ok()?;
    parent.starts_with(root).then(|| parent.join(full.file_name().unwrap()))
}

enum SaveError {
    /// the file changed since the base version; this is its version now
    Conflict(String),
    Io(io::Error),
}

/// Saves a document unless it changed since version `base` (one deleted since never conflicts) and returns its new
/// version. The editor's `PUT /api/file` and `mermdraw write` both save through here.
fn save_doc(path: &Path, data: &[u8], base: Option<&str>) -> Result<String, SaveError> {
    let current = version_of(path);
    if base.is_some_and(|b| b != current && current != "missing") {
        return Err(SaveError::Conflict(current));
    }
    write_atomic(path, data).map_err(SaveError::Io)?;
    Ok(version_of(path))
}

fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.mermdraw-tmp"));
    fs::write(&tmp, data)?;
    if let Ok(m) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, m.permissions());
    }
    fs::rename(&tmp, path)
}

fn respond(s: &mut TcpStream, status: &str, ctype: &str, extra: &[(&str, String)], body: &[u8]) -> io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n",
        body.len()
    );
    if !extra.iter().any(|(k, _)| k.eq_ignore_ascii_case("cache-control")) {
        head.push_str("Cache-Control: no-store\r\n");
    }
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes())?;
    s.write_all(body)?;
    s.flush()
}

fn text(s: &mut TcpStream, status: &str, msg: &str) -> io::Result<()> {
    respond(s, status, "text/plain; charset=utf-8", &[], msg.as_bytes())
}

fn mime_for(p: &Path) -> &'static str {
    match p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("md" | "markdown" | "mmd" | "mermaid" | "txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn rel_str(p: &Path) -> String {
    p.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn parse_query(qs: &str) -> HashMap<String, String> {
    qs.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (url_decode(k), url_decode(v))
        })
        .collect()
}

fn url_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_line_reads_editor_locations() {
        assert_eq!(split_line("docs/arch.md:42"), ("docs/arch.md", Some(42)));
        assert_eq!(split_line("docs/arch.md:42:7"), ("docs/arch.md", Some(42)));
        assert_eq!(split_line("docs/arch.md"), ("docs/arch.md", None));
        assert_eq!(split_line("docs/arch.md:"), ("docs/arch.md:", None));
        assert_eq!(split_line("C:\\repo\\arch.md:3"), ("C:\\repo\\arch.md", Some(3)));
        assert_eq!(split_line("Cargo.toml"), ("Cargo.toml", None)); // exists as written
    }

    #[test]
    fn page_url_points_at_the_diagram() {
        assert_eq!(page_url(7788, None, None), "http://127.0.0.1:7788/");
        assert_eq!(page_url(7788, Some("docs/a b.md"), None), "http://127.0.0.1:7788/?file=docs/a%20b.md");
        assert_eq!(page_url(7788, Some("docs/a.md"), Some(1)), "http://127.0.0.1:7788/?file=docs/a.md#d=2");
    }
}
