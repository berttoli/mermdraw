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
