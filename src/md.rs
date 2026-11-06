//! Minimal markdown fence scanning: finds ```mermaid blocks and their titles.
//! The browser UI has its own (equivalent) scanner in web/model.js.

pub struct Block {
    pub index: usize,
    /// line of the opening fence (0-based)
    pub start: usize,
    /// line of the closing fence (0-based; == line count when unclosed)
    pub end: usize,
    pub kind: String,
    pub title: Option<String>,
    /// the diagram source, dedented by the fence's indentation
    pub source: String,
    /// indentation of the opening fence (a fence inside a list item), and its character and length
    pub indent: usize,
    pub fence: (char, usize),
}

/// The comment that holds a diagram's canvas positions (`%% mermdraw:layout id:x,y …`; see web/model.js).
const LAYOUT_TAG: &str = "mermdraw:layout";

pub fn is_md(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".md") || n.ends_with(".markdown")
}

pub fn is_mmd(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".mmd") || n.ends_with(".mermaid")
}

pub fn blocks(text: &str, whole_file: bool) -> Vec<Block> {
    let lines: Vec<&str> = text.lines().collect();
    if whole_file {
        let (kind, title) = describe(text);
        return vec![Block { index: 0, start: 0, end: lines.len(), kind, title, source: text.to_string(), indent: 0, fence: ('`', 3) }];
    }
    let mut out = Vec::new();
    let mut heading: Option<String> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let indent = line.len() - line.trim_start_matches(' ').len();
        let rest = line.trim_start_matches(' ');
        let fence = rest.chars().next().filter(|c| (*c == '`' || *c == '~') && indent <= 3);
        let Some(fc) = fence else {
            if indent <= 3 && rest.starts_with('#') {
                let t = rest.trim_start_matches('#');
                if t.is_empty() || t.starts_with(' ') {
                    heading = Some(t.trim().trim_end_matches('#').trim().to_string()).filter(|h| !h.is_empty());
                }
            }
            i += 1;
            continue;
        };
        let n = rest.chars().take_while(|c| *c == fc).count();
        if n < 3 || (fc == '`' && rest[n..].contains('`')) {
            i += 1;
            continue;
        }
        let info = rest[n..].trim().trim_start_matches('{').split(|c: char| c.is_whitespace() || c == '}').next().unwrap_or("");
        let start = i;
        let mut end = lines.len();
        let mut j = i + 1;
        while j < lines.len() {
            let r = lines[j].trim_start_matches(' ');
            let run = r.chars().take_while(|c| *c == fc).count();
            if lines[j].len() - r.len() <= 3 && run >= n && r[run..].trim().is_empty() {
                end = j;
                break;
            }
            j += 1;
        }
        if info.eq_ignore_ascii_case("mermaid") {
            let source: Vec<&str> = lines[start + 1..end.min(lines.len())]
                .iter()
                .map(|l| {
                    let strip = (l.len() - l.trim_start_matches(' ').len()).min(indent);
                    &l[strip..]
                })
                .collect();
            let source = source.join("\n");
            let (kind, fm_title) = describe(&source);
            let title = fm_title.or_else(|| heading.clone());
            out.push(Block { index: out.len(), start, end, kind, title, source, indent, fence: (fc, n) });
        }
        i = end + 1;
    }
    out
}

/// Returns (diagram keyword, frontmatter title).
/// The index of the diagram at 1-based `line` (as editors report it): the block containing the line, else the next
/// one below it, else the last one above.
pub fn block_at_line(blocks: &[Block], line: usize) -> Option<usize> {
    let l = line.saturating_sub(1);
    blocks
        .iter()
        .position(|b| b.start <= l && l <= b.end)
        .or_else(|| blocks.iter().position(|b| b.start > l))
        .or_else(|| blocks.len().checked_sub(1))
}

/// The document's first `# ` heading outside code fences (shown in the file picker).
pub fn title(text: &str) -> Option<String> {
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let indent = line.len() - line.trim_start_matches(' ').len();
        let rest = line.trim_start_matches(' ');
        if indent > 3 {
            continue;
        }
        if let Some(fc @ ('`' | '~')) = rest.chars().next() {
            let n = rest.chars().take_while(|c| *c == fc).count();
            if n >= 3 {
                match fence {
                    None if !(fc == '`' && rest[n..].contains('`')) => fence = Some((fc, n)),
                    Some((f, m)) if f == fc && n >= m && rest[n..].trim().is_empty() => fence = None,
                    _ => {}
                }
                continue;
            }
        }
        if fence.is_none() {
            if let Some(t) = rest.strip_prefix("# ") {
                let t = t.trim().trim_end_matches('#').trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

fn describe(src: &str) -> (String, Option<String>) {
    let mut title = None;
    let mut in_fm = false;
    let mut seen = false;
    for line in src.lines() {
        let t = line.trim();
        if t == "---" && (!seen || in_fm) {
            in_fm = !in_fm;
            seen = true;
            continue;
        }
        seen = true;
        if in_fm {
            if let Some(v) = t.strip_prefix("title:") {
                title = Some(v.trim().trim_matches('"').to_string());
            }
            continue;
        }
        if t.is_empty() || t.starts_with("%%") {
            continue;
        }
        let kw = t.split(|c: char| c.is_whitespace() || c == ';').next().unwrap_or("");
        return (kw.to_string(), title);
    }
    ("empty".into(), title)
}

pub fn template(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "flowchart" | "flow" | "graph" => "flowchart LR\n    client([Client]) --> api[API Gateway]\n    api --> svc[Service]\n    svc --> db[(Database)]\n",
        "sequence" | "sequenceDiagram" => "sequenceDiagram\n    participant C as Client\n    participant A as API\n    C->>A: request\n    A-->>C: response\n",
        "class" | "classDiagram" => "classDiagram\n    class Service {\n        +handle(req) Response\n    }\n    class Repository\n    Service --> Repository\n",
        "state" | "stateDiagram" => "stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running: start\n    Running --> Idle: stop\n",
        "er" | "erDiagram" => "erDiagram\n    USER ||--o{ ORDER : places\n    ORDER ||--|{ LINE_ITEM : contains\n",
        "architecture" | "arch" => "architecture-beta\n    group api(cloud)[API]\n\n    service db(database)[Database] in api\n    service server(server)[Server] in api\n\n    db:L -- R:server\n",
        "c4" | "C4Context" => "C4Context\n    title System Context\n    Person(user, \"User\")\n    System(sys, \"System\")\n    Rel(user, sys, \"Uses\")\n",
        "gantt" => "gantt\n    title Roadmap\n    dateFormat YYYY-MM-DD\n    section Build\n    Design :a1, 2026-01-01, 14d\n    Implement :after a1, 30d\n",
        "mindmap" => "mindmap\n  root((System))\n    Frontend\n    Backend\n      API\n      Workers\n",
        _ => return None,
    })
}

/// Appends a fenced mermaid block (with an optional `## title`) to a markdown text.
pub fn append_block(existing: &str, stem: &str, title: Option<&str>, tpl: &str) -> String {
    // the appended lines follow the file's line endings (CRLF files stay CRLF)
    let crlf = existing.contains("\r\n");
    let mut out = existing.replace("\r\n", "\n");
    if out.trim().is_empty() {
        out = format!("# {stem}\n");
    }
    while !out.ends_with("\n\n") {
        out.push('\n');
    }
    if let Some(t) = title {
        out.push_str(&format!("## {t}\n\n"));
    }
    out.push_str("```mermaid\n");
    out.push_str(tpl);
    if !tpl.ends_with('\n') {
        out.push('\n');
    }
    out.push_str("```\n");
    if crlf {
        out = out.replace('\n', "\r\n");
    }
    out
}

pub fn is_layout_line(line: &str) -> bool {
    line.trim().strip_prefix("%%").is_some_and(|r| r.trim_start().starts_with(LAYOUT_TAG))
}

/// A diagram's source without its layout comment, and the comment's lines (verbatim, normally one).
pub fn split_layout(source: &str) -> (String, Vec<&str>) {
    let (layout, rest): (Vec<&str>, Vec<&str>) = source.lines().partition(|l| is_layout_line(l));
    (rest.join("\n"), layout)
}

/// A canvas position: a node (or empty group) id and its x, y on the canvas.
pub type Position = (String, f64, f64);

/// One `id:x,y` token of a layout comment, read the way web/model.js reads it.
pub fn parse_position(tok: &str) -> Option<Position> {
    let num = |s: &str| {
        let digits = s.strip_prefix('-').unwrap_or(s);
        let (int, frac) = digits.split_once('.').unwrap_or((digits, "0"));
        let ok = |d: &str| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit());
        if ok(int) && ok(frac) {
            s.parse::<f64>().ok().filter(|n| n.is_finite())
        } else {
            None
        }
    };
    let (id, xy) = tok.rsplit_once(':')?;
    let (x, y) = xy.split_once(',')?;
    if id.is_empty() {
        return None;
    }
    Some((id.to_string(), num(x)?, num(y)?))
}

fn layout_tokens(line: &str) -> impl Iterator<Item = &str> {
    let body = line.trim().strip_prefix("%%").map(str::trim_start).and_then(|r| r.strip_prefix(LAYOUT_TAG)).unwrap_or("");
    body.split_whitespace()
}

/// The canvas positions in a diagram source's layout comments, in their order; for an id given twice, the last wins.
pub fn positions(source: &str) -> Vec<Position> {
    let mut out: Vec<Position> = Vec::new();
    for (id, x, y) in source.lines().filter(|l| is_layout_line(l)).flat_map(layout_tokens).filter_map(parse_position) {
        match out.iter_mut().find(|p| p.0 == id) {
            Some(p) => (p.1, p.2) = (x, y),
            None => out.push((id, x, y)),
        }
    }
    out
}

/// A coordinate as the editor's `Math.round` writes it: ties go toward positive infinity.
pub fn coord(v: f64) -> String {
    let rounded = (v + 0.5).floor();
    if rounded == 0.0 {
        "0".into()
    } else {
        format!("{rounded:.0}")
    }
}

/// `source` with `places` set in its layout comment: a position the comment already has is changed where it stands,
/// a new one is added at the end of the comment. None when the source has no layout comment to add to.
pub fn place(source: &str, places: &[Position]) -> Option<String> {
    let mut lines: Vec<String> = source.lines().map(str::to_string).collect();
    let first = lines.iter().position(|l| is_layout_line(l))?;
    for (id, x, y) in places {
        let token = format!("{id}:{},{}", coord(*x), coord(*y));
        let mut found = false;
        for line in lines.iter_mut().filter(|l| is_layout_line(l)) {
            let mut start = 0;
            while let Some(at) = line[start..].find(&format!("{id}:")).map(|at| at + start) {
                let end = line[at..].find(char::is_whitespace).map_or(line.len(), |e| at + e);
                let whole = line[..at].ends_with(char::is_whitespace) && parse_position(&line[at..end]).is_some_and(|p| &p.0 == id);
                if whole {
                    line.replace_range(at..end, &token);
                    found = true;
                }
                start = at + if whole { token.len() } else { id.len() + 1 };
            }
        }
        if !found {
            lines[first] = format!("{} {token}", lines[first].trim_end());
        }
    }
    Some(lines.join("\n"))
}

/// Whether a flowchart names `id` as a node or subgraph, ignoring labels, edge text, metadata and comments.
pub fn mentions(source: &str, id: &str) -> bool {
    fn ident(c: char) -> bool {
        c.is_alphanumeric() || c == '_'
    }

    // Keep only the parts of a statement that can contain node syntax. In particular, an id in
    // `a[ghost]`, `a["ghost"]`, `a -->|ghost| b`, or `a@{ label: "ghost" }` is not a node.
    fn structure(line: &str) -> String {
        let mut out = String::with_capacity(line.len());
        let (mut closing, mut quoted, mut edge_label) = (Vec::new(), false, false);
        let mut chars = line.chars().peekable();
        while let Some(c) = chars.next() {
            if quoted {
                if c == '"' {
                    quoted = false;
                }
            } else if c == '"' {
                quoted = true;
            } else if let Some(&end) = closing.last() {
                if c == end {
                    closing.pop();
                } else if let Some(next) = match c {
                    '[' => Some(']'),
                    '(' => Some(')'),
                    '{' => Some('}'),
                    _ => None,
                } {
                    closing.push(next);
                }
            } else if c == '|' {
                edge_label = !edge_label;
                out.push(' ');
            } else if edge_label {
                continue;
            } else if c == '%' && chars.peek() == Some(&'%') {
                break;
            } else if let Some(next) = match c {
                '[' => Some(']'),
                '(' => Some(')'),
                '{' => Some('}'),
                _ => None,
            } {
                closing.push(next);
                out.push(if c == '{' && out.ends_with('@') { '{' } else { ' ' });
            } else {
                out.push(c);
            }
        }
        out
    }

    fn node_token(line: &str, id: &str) -> bool {
        let mut chars = line.char_indices().peekable();
        while let Some((start, c)) = chars.next() {
            if !ident(c) {
                continue;
            }
            let mut end = start + c.len_utf8();
            while let Some(&(_, next)) = chars.peek() {
                if ident(next) || (next == '-' && chars.clone().nth(1).is_some_and(|(_, c)| ident(c))) {
                    let (at, c) = chars.next().unwrap();
                    end = at + c.len_utf8();
                } else {
                    break;
                }
            }
            if &line[start..end] != id {
                continue;
            }
            let before = line[..start].trim_end();
            let after = line[end..].trim_start();
            if after.starts_with('@') && !after.starts_with("@{") {
                continue;
            } // an edge id
            if before.is_empty()
                || before.ends_with(';')
                || before.ends_with('&')
                || before.ends_with('>')
                || ["---", "===", "~~~", "-.-", "<--", "--o", "--x", "==o", "==x", ".-o", ".-x"]
                    .iter()
                    .any(|suffix| before.ends_with(suffix))
            {
                return true;
            }
        }
        false
    }

    let mut first = true;
    let mut frontmatter = false;
    for line in source.lines() {
        let mut line = line.trim();
        if line.is_empty() {
            continue;
        }
        if first {
            first = false;
            if line == "---" {
                frontmatter = true;
                continue;
            }
        }
        if frontmatter {
            if line == "---" {
                frontmatter = false;
            }
            continue;
        }
        if line.starts_with("%%") {
            continue;
        }
        let word = line.split(|c: char| c.is_whitespace() || c == ';').next().unwrap_or("");
        if matches!(word, "end" | "direction" | "classDef" | "class" | "style" | "linkStyle" | "click" | "accTitle" | "accDescr") {
            continue;
        }
        if word == "subgraph" {
            line = line[word.len()..].trim_start();
            let visible = structure(line);
            if node_token(&visible, id) {
                return true;
            }
            continue;
        }
        if matches!(word, "flowchart" | "flowchart-elk" | "graph") {
            line = line[word.len()..].trim_start();
            let first = line.split(|c: char| c.is_whitespace() || c == ';').next().unwrap_or("");
            if matches!(first, "TB" | "TD" | "BT" | "RL" | "LR") {
                line = line[first.len()..].trim_start();
            }
            line = line.trim_start_matches(';').trim_start();
        }
        if node_token(&structure(line), id) {
            return true;
        }
    }
    false
}

/// The 1-based number of the first line of `source` that would end a block fenced with `fence` early.
pub fn closing_fence_line(source: &str, (fc, n): (char, usize)) -> Option<usize> {
    source
        .lines()
        .position(|l| {
            let r = l.trim_start();
            let run = r.chars().take_while(|c| *c == fc).count();
            run >= n && r[run..].trim().is_empty()
        })
        .map(|i| i + 1)
}

/// `text` with block `b`'s source replaced by `source`, indented like its fence and in the file's line endings.
/// Every other byte of the file stays as it was.
pub fn replace_block(text: &str, b: &Block, source: &str, whole_file: bool) -> String {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let pad = " ".repeat(b.indent);
    let mut body = String::with_capacity(source.len() + 64);
    for l in source.lines() {
        if !l.is_empty() {
            body.push_str(&pad);
        }
        body.push_str(l);
        body.push_str(eol);
    }
    if whole_file {
        return body;
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut out = String::with_capacity(text.len() + body.len());
    for l in &lines[..=b.start] {
        out.push_str(l);
    }
    if !out.ends_with('\n') {
        out.push_str(eol); // an unclosed fence on the last line
    }
    out.push_str(&body);
    for l in lines.get(b.end..).unwrap_or_default() {
        out.push_str(l);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_mermaid_blocks_and_titles() {
        let text = "# Doc\n\n## Overview\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```js\n```mermaid\n```\n\n````mermaid\n---\ntitle: Seq\n---\nsequenceDiagram\n````\n";
        let b = blocks(text, false);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].kind, "flowchart");
        assert_eq!(b[0].title.as_deref(), Some("Overview"));
        assert_eq!(b[0].source, "flowchart LR\n  A --> B");
        assert_eq!((b[0].start, b[0].end), (4, 7));
        assert_eq!(b[1].kind, "sequenceDiagram");
        assert_eq!(b[1].title.as_deref(), Some("Seq"));
    }

    #[test]
    fn indented_fences_are_dedented() {
        let b = blocks("- item\n  ```mermaid\n  graph TD\n    A\n  ```\n", false);
        assert_eq!(b[0].source, "graph TD\n  A");
        assert_eq!(b[0].kind, "graph");
    }

    #[test]
    fn block_at_line_picks_the_diagram_under_the_cursor() {
        // lines (1-based): 1 "# Doc", 3-5 first block, 7 "## Two", 9-11 second block, 13 "tail"
        let text = "# Doc\n\n```mermaid\ngraph TD\n```\n\n## Two\n\n```mermaid\ngraph LR\n```\n\ntail\n";
        let b = blocks(text, false);
        assert_eq!(block_at_line(&b, 3), Some(0)); // opening fence
        assert_eq!(block_at_line(&b, 4), Some(0));
        assert_eq!(block_at_line(&b, 11), Some(1)); // closing fence
        assert_eq!(block_at_line(&b, 1), Some(0)); // above every block: the next one
        assert_eq!(block_at_line(&b, 7), Some(1)); // a heading: the block below it
        assert_eq!(block_at_line(&b, 13), Some(1)); // below every block: the last one
        assert_eq!(block_at_line(&[], 3), None);
        assert_eq!(block_at_line(&blocks("graph TD\n  A\n", true), 2), Some(0));
        // .mmd: the whole file
    }

    #[test]
    fn title_is_the_first_h1_outside_fences() {
        assert_eq!(title("intro\n```bash\n# not a title\n```\n## Sub\n# Real title #\n# Second\n").as_deref(), Some("Real title"));
        assert_eq!(title("## Only h2\n#hashtag\n").as_deref(), None);
        assert_eq!(title("~~~~\n# inside\n~~~\n# still inside\n~~~~\n# after\n").as_deref(), Some("after"));
    }

    #[test]
    fn append_keeps_crlf_line_endings() {
        let t = append_block("# Doc\r\n\r\nText.\r\n", "doc", Some("API"), "graph TD\n");
        assert_eq!(t, "# Doc\r\n\r\nText.\r\n\r\n## API\r\n\r\n```mermaid\r\ngraph TD\r\n```\r\n");
        assert!(!t.replace("\r\n", "").contains('\n'));
        assert_eq!(append_block("a\n", "doc", None, "graph TD\n"), "a\n\n```mermaid\ngraph TD\n```\n");
        // LF stays LF
    }

    #[test]
    fn layout_comments_are_split_off() {
        let src = "flowchart LR\n    a --> b\n    %% a note\n    %%mermdraw:layout a:0,0 b:200,0";
        let (body, layout) = split_layout(src);
        assert_eq!(body, "flowchart LR\n    a --> b\n    %% a note");
        assert_eq!(layout, vec!["    %%mermdraw:layout a:0,0 b:200,0"]);
        assert!(
            is_layout_line("%% mermdraw:layout x:1,2") && !is_layout_line("%% mermdraw: layout") && !is_layout_line("a %% mermdraw:layout")
        );
        assert_eq!(split_layout("graph TD\n  A").1.len(), 0);
    }

    #[test]
    fn reads_canvas_positions_like_the_editor() {
        let src = "flowchart LR\n  a --> b\n  %% mermdraw:layout a:0,0 b:-200,40.5 bad c:1,x a:10,20 x:y:3,4";
        let p = positions(src);
        assert_eq!(p, vec![("a".into(), 10.0, 20.0), ("b".into(), -200.0, 40.5), ("x:y".into(), 3.0, 4.0)]);
        assert!(positions("graph TD\n  a --> b").is_empty());
        assert_eq!(parse_position("n1:-5,7"), Some(("n1".into(), -5.0, 7.0)));
        for bad in ["n1:5", ":1,2", "n1:1,2,3", "n1:1.,2", "n1:+1,2", "n1:1e3,2"] {
            assert_eq!(parse_position(bad), None, "{bad}");
        }
        assert_eq!(parse_position(&format!("n1:{},0", "9".repeat(400))), None);
        assert_eq!(coord(-1.5), "-1");
        assert_eq!(coord(-0.5), "0");
        assert_eq!(coord(0.5), "1");
        assert_eq!(coord(1e20), "100000000000000000000");
    }

    #[test]
    fn places_nodes_in_the_layout_comment() {
        let src = "flowchart LR\n  a --> b\n  b --> c\n  %% mermdraw:layout a:0,0 ab:5,5 b:200,0";
        let placed = place(src, &[("c".into(), 400.0, 0.4), ("b".into(), 210.6, -10.0)]).unwrap();
        // b moves where it stands, ab (which starts like a) is left alone, and c is added at the end
        assert_eq!(placed, "flowchart LR\n  a --> b\n  b --> c\n  %% mermdraw:layout a:0,0 ab:5,5 b:211,-10 c:400,0");
        assert_eq!(positions(&placed).last(), Some(&("c".into(), 400.0, 0.0)));
        assert_eq!(place("graph TD\n  a --> b", &[("a".into(), 1.0, 2.0)]), None, "no layout comment to add to");
        assert!(mentions("graph TD\n  api-->db[(DB)]", "db") && mentions("graph TD\n  api-->db", "api"));
        assert!(!mentions("graph TD\n  dbx --> y", "db") && !mentions("graph TD\n  %% db\n  a", "db"));
        for src in [
            "flowchart LR\n  a[ghost] --> b",
            "flowchart LR\n  a[\"ghost\"] --> b",
            "flowchart LR\n  a -->|ghost| b",
            "flowchart LR\n  a -- ghost --> b",
            "flowchart LR\n  a@{ label: \"ghost\" } --> b",
            "flowchart LR\n  a --> b\n  classDef ghost fill:red",
            "flowchart LR\n  a:::ghost --> b",
            "---\ntitle: ghost\n---\nflowchart LR\n  a --> b",
        ] {
            assert!(!mentions(src, "ghost"), "{src}");
        }
        assert!(mentions("flowchart LR\n  subgraph cluster [Ghost]\n    a --> b\n  end", "cluster"));
        assert!(mentions("flowchart LR; a --> b", "b"));
        assert!(mentions("flowchart LR\n  db@{ icon: \"logos:postgresql\", label: \"DB\" }", "db"));
    }

    #[test]
    fn finds_lines_that_would_close_the_fence() {
        assert_eq!(closing_fence_line("graph TD\n  A\n```", ('`', 3)), Some(3));
        assert_eq!(closing_fence_line("graph TD\n  ````  ", ('`', 3)), Some(2));
        assert_eq!(closing_fence_line("graph TD\n```", ('`', 4)), None);
        assert_eq!(closing_fence_line("graph TD\n```mermaid\n~~~", ('`', 3)), None);
        assert_eq!(closing_fence_line("graph TD\n  A[\"```\"]", ('`', 3)), None);
    }

    #[test]
    fn replace_block_changes_only_the_block() {
        let text = "# Doc\r\n\r\n- item\r\n  ```mermaid\r\n  graph TD\r\n    A\r\n  ```\r\n\r\n```mermaid\r\ngraph LR\r\n```\r\ntail";
        let b = blocks(text, false);
        let t = replace_block(text, &b[0], "graph TD\n  A --> B\n\n  B", false);
        assert_eq!(
            t,
            "# Doc\r\n\r\n- item\r\n  ```mermaid\r\n  graph TD\r\n    A --> B\r\n\r\n    B\r\n  ```\r\n\r\n```mermaid\r\ngraph LR\r\n```\r\ntail"
        );
        let again = blocks(&t, false);
        assert_eq!(again[0].source, "graph TD\n  A --> B\n\n  B");
        assert_eq!(again[1].source, "graph LR");
        // an unclosed fence runs to the end of the file
        let t = replace_block("```mermaid", &blocks("```mermaid", false)[0], "graph TD", false);
        assert_eq!(t, "```mermaid\ngraph TD\n");
        assert_eq!(replace_block("graph TD\r\n", &blocks("graph TD\r\n", true)[0], "graph LR\n  A", true), "graph LR\r\n  A\r\n");
    }

    #[test]
    fn append_creates_heading() {
        let t = append_block("", "arch", Some("API"), "graph TD\n");
        assert_eq!(t, "# arch\n\n## API\n\n```mermaid\ngraph TD\n```\n");
        let b = blocks(&t, false);
        assert_eq!(b[0].title.as_deref(), Some("API"));
    }
}
