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
    pub source: String,
}

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
        return vec![Block { index: 0, start: 0, end: lines.len(), kind, title, source: text.to_string() }];
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
            out.push(Block { index: out.len(), start, end, kind, title: fm_title.or_else(|| heading.clone()), source });
        }
        i = end + 1;
    }
    out
}

/// Returns (diagram keyword, frontmatter title).
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
    let mut out = existing.to_string();
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
    fn title_is_the_first_h1_outside_fences() {
        assert_eq!(title("intro\n```bash\n# not a title\n```\n## Sub\n# Real title #\n# Second\n").as_deref(), Some("Real title"));
        assert_eq!(title("## Only h2\n#hashtag\n").as_deref(), None);
        assert_eq!(title("~~~~\n# inside\n~~~\n# still inside\n~~~~\n# after\n").as_deref(), Some("after"));
    }

    #[test]
    fn append_creates_heading() {
        let t = append_block("", "arch", Some("API"), "graph TD\n");
        assert_eq!(t, "# arch\n\n## API\n\n```mermaid\ngraph TD\n```\n");
        let b = blocks(&t, false);
        assert_eq!(b[0].title.as_deref(), Some("API"));
    }
}
