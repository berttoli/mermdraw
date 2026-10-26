//! mmdr — a tiny local visual editor for mermaid diagrams that live inside markdown.
//!
//! The binary is std-only: it embeds the web UI (plus a gzipped mermaid bundle),
//! serves it on 127.0.0.1, watches the files the UI has open, and writes edits
//! back to disk atomically so they can be committed like any other change.

mod icons;
mod md;

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 7788;
const MAX_BODY: usize = 25 * 1024 * 1024;
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "vendor", "__pycache__"];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];

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
    /// feature flags forced on (true) or off (false) from the command line
    flags: Vec<(String, bool)>,
}

fn main() {
    let mut opts = Opts { port: None, open: true, app: false, kind: "flowchart".into(), title: None, vendor: false, flags: Vec::new() };
    let mut pos: Vec<String> = Vec::new();
    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let mut value = || {
            i += 1;
            args.get(i).cloned().unwrap_or_else(|| die(&format!("{a} needs a value")))
        };
        match a {
            "-h" | "--help" => return print_help(),
            "-V" | "--version" => return println!("mmdr {VERSION}"),
            "-p" | "--port" => opts.port = Some(value().parse().unwrap_or_else(|_| die("--port needs a number"))),
            "-t" | "--type" => opts.kind = value(),
            "--title" => opts.title = Some(value()),
            "--no-open" => opts.open = false,
            "--app" => opts.app = true,
            "--vendor" => opts.vendor = true,
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
    match pos.first().map(String::as_str) {
        Some("ls") => cmd_ls(&pos[1..]),
        Some("cat") => cmd_cat(&pos[1..]),
        Some("new") => cmd_new(&pos[1..], &opts),
        Some("icons") => cmd_icons(&pos[1..], &opts),
        Some("edit") | Some("open") => serve(pos.get(1).map(String::as_str), &opts),
        Some("help") => print_help(),
        other => serve(other, &opts),
    }
}

fn print_help() {
    println!(
        "mmdr {VERSION} — visual mermaid editor for markdown files

USAGE
  mmdr [PATH]                 open the editor for a .md/.mmd file or a directory (default: .)
  mmdr ls FILE                list the mermaid diagrams in FILE
  mmdr cat FILE [N]           print the source of diagram N (1-based, default 1)
  mmdr new FILE [-t TYPE] [--title TITLE]
                              append a new diagram (flowchart, sequence, class, state,
                              er, architecture, c4, gantt, mindmap)
  mmdr icons [ls]             list installed icon packs
  mmdr icons add PACK[@VER]... [--vendor]
                              install Iconify packs (logos, devicon, simple-icons, mdi, ...)
                              into ~/.config/mmdr/icons, or into this repo's .mmdr/icons
  mmdr icons rm PACK... [--vendor]

OPTIONS
  -p, --port N                port to listen on (default {DEFAULT_PORT}, next free one if taken)
      --no-open               don't open a browser
      --app                   open in a chromeless Chrome/Edge/Brave app window if available
      --enable F1,F2          turn feature flags on (see Labs in the editor)
      --disable F1,F2         turn feature flags off
  -h, --help                  show this help
  -V, --version               show version

The editor saves straight into the markdown file; commit it like any other change."
    );
}

fn die(msg: &str) -> ! {
    eprintln!("mmdr: {msg}");
    process::exit(1)
}

// ---------------------------------------------------------------- terminal commands

fn read_doc(path: &str) -> (String, Vec<md::Block>) {
    let text = fs::read_to_string(path).unwrap_or_else(|e| die(&format!("{path}: {e}")));
    let blocks = md::blocks(&text, md::is_mmd(path));
    (text, blocks)
}

fn cmd_ls(args: &[String]) {
    let path = args.first().unwrap_or_else(|| die("usage: mmdr ls FILE"));
    let (_, blocks) = read_doc(path);
    println!("{path} — {} diagram{}", blocks.len(), if blocks.len() == 1 { "" } else { "s" });
    for b in &blocks {
        let lines = format!("L{}-{}", b.start + 1, b.end + 1);
        println!("  {:>2}  {:<18} {:<10} {}", b.index + 1, b.kind, lines, b.title.as_deref().unwrap_or(""));
    }
}

fn cmd_cat(args: &[String]) {
    let path = args.first().unwrap_or_else(|| die("usage: mmdr cat FILE [N]"));
    let n: usize = args.get(1).map(|s| s.parse().unwrap_or_else(|_| die("N must be a number"))).unwrap_or(1);
    let (_, blocks) = read_doc(path);
    let b = blocks.get(n.wrapping_sub(1)).unwrap_or_else(|| die(&format!("{path} has no diagram #{n}")));
    print!("{}", b.source);
    if !b.source.ends_with('\n') {
        println!();
    }
}

fn cmd_new(args: &[String], opts: &Opts) {
    let path = args.first().unwrap_or_else(|| die("usage: mmdr new FILE [-t TYPE] [--title TITLE]"));
    let tpl = md::template(&opts.kind).unwrap_or_else(|| die(&format!("unknown diagram type '{}'", opts.kind)));
    let existing = fs::read_to_string(path).unwrap_or_default();
    let count = md::blocks(&existing, md::is_mmd(path)).len();
    let text = if md::is_mmd(path) {
        if count > 0 {
            die(".mmd files hold a single diagram");
        }
        tpl.to_string()
    } else {
        let stem = Path::new(path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        md::append_block(&existing, &stem, opts.title.as_deref(), tpl)
    };
    write_atomic(Path::new(path), text.as_bytes()).unwrap_or_else(|e| die(&format!("{path}: {e}")));
    println!("added {} diagram #{} to {path}", opts.kind, count + 1);
}

fn cmd_icons(args: &[String], opts: &Opts) {
    let root = env::current_dir().ok().map(|d| git_root(&d).unwrap_or(d));
    let dest = if opts.vendor { root.as_deref().map(icons::project_dir) } else { icons::global_dir() }
        .unwrap_or_else(|| die("cannot find a config directory (set XDG_CONFIG_HOME)"));
    match args.first().map(String::as_str) {
        None | Some("ls") | Some("list") => {
            let packs = icons::installed(root.as_deref());
            if packs.is_empty() {
                println!("no icon packs installed — try: mmdr icons add logos devicon");
            }
            for p in packs {
                println!("  {:<16} {:>8}  {:<8} {}", p.name, icons::human(p.size), p.source, p.path.display());
            }
        }
        Some("add") => {
            if args.len() < 2 {
                die("usage: mmdr icons add PACK[@VERSION]... [--vendor]");
            }
            for spec in &args[1..] {
                match icons::add(spec, &dest) {
                    Ok((path, size)) => println!("installed {spec} ({}) → {}", icons::human(size), path.display()),
                    Err(e) => die(&e),
                }
            }
        }
        Some("rm") | Some("remove") => {
            for name in &args[1..] {
                let path = dest.join(format!("{name}.json"));
                if icons::valid_name(name) && fs::remove_file(&path).is_ok() {
                    println!("removed {}", path.display());
                } else {
                    eprintln!("mmdr: {name} is not installed in {}", dest.display());
                }
            }
        }
        Some(other) => die(&format!("unknown icons command '{other}' (try: ls, add, rm)")),
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
    let target = PathBuf::from(target.unwrap_or("."));
    if !target.exists() {
        let name = target.to_string_lossy().to_string();
        if !(md::is_md(&name) || md::is_mmd(&name)) {
            die(&format!("{name} does not exist"));
        }
        if let Some(dir) = target.parent().filter(|d| !d.as_os_str().is_empty()) {
            fs::create_dir_all(dir).unwrap_or_else(|e| die(&format!("{}: {e}", dir.display())));
        }
        let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let tpl = md::template("flowchart").unwrap();
        let text = if md::is_mmd(&name) { tpl.to_string() } else { md::append_block("", &stem, Some("Overview"), tpl) };
        write_atomic(&target, text.as_bytes()).unwrap_or_else(|e| die(&format!("{name}: {e}")));
        println!("created {name}");
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

    let listener = bind(opts.port);
    let port = listener.local_addr().unwrap().port();
    let flags = opts.flags.iter().map(|(f, on)| format!("{}:{on}", json_str(f))).collect::<Vec<_>>().join(",");
    let state = Arc::new(State {
        root,
        initial: initial.clone(),
        flags: format!("{{{flags}}}"),
        web_dir: env::var_os("MMDR_WEB").map(PathBuf::from),
        watched: Mutex::new(HashMap::new()),
        hub: Mutex::new(Hub { seq: 0, events: Vec::new() }),
        cv: Condvar::new(),
    });

    let mut url = format!("http://127.0.0.1:{port}/");
    if let Some(f) = &initial {
        url.push_str(&format!("?file={}", url_encode(f)));
    }
    println!("mmdr {VERSION}  root {}", state.root.display());
    println!("  → {url}   (Ctrl+C to quit)");
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
/// modified outside mmdr (another editor, git checkout, ...).
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
                    let n = fs::read_to_string(st.root.join(rel)).map(|t| md::blocks(&t, md::is_mmd(rel)).len()).unwrap_or(0);
                    format!(r#"{{"path":{},"diagrams":{n}}}"#, json_str(rel))
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
            let current = version_of(&full);
            if let Some(base) = req.headers.get("x-base-version") {
                if base != &current && current != "missing" {
                    let bytes = fs::read(&full).unwrap_or_default();
                    return respond(s, "409 Conflict", "text/plain; charset=utf-8", &[("X-Version", current)], &bytes);
                }
            }
            if let Err(e) = write_atomic(&full, &req.body) {
                return text(s, "500 Internal Server Error", &e.to_string());
            }
            let v = version_of(&full);
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
            let raw = fs::read_to_string(st.root.join(".mmdr").join("config.json")).ok().filter(|t| t.trim_start().starts_with('{'));
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

fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.mmdr-tmp"));
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
