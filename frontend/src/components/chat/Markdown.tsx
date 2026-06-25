import React from "react";
import { Link } from "react-router-dom";

// Minimal, safe markdown for chat replies — paragraphs, headings (#), ordered
// (1.) and unordered (- / *) lists, GitHub-style tables, **bold**, `code`, and
// [links](url). Internal links (/route) navigate in-app via the router; external
// links open in a new tab. No HTML injection (we build React nodes), so model
// output can't run arbitrary markup.
const INLINE = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .map((part, i) => {
      const key = `${keyBase}-${i}`;
      const link = part.match(LINK_RE);
      if (link) {
        const [, label, href] = link;
        const cls = "text-primary underline-offset-2 hover:underline";
        return href.startsWith("/") ? (
          <Link key={key} to={href} className={cls}>
            {label}
          </Link>
        ) : (
          <a key={key} href={href} target="_blank" rel="noreferrer" className={cls}>
            {label}
          </a>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={key} className="font-semibold text-foreground">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code
            key={key}
            className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[0.85em]"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      return <React.Fragment key={key}>{part}</React.Fragment>;
    });
}

// A table separator row: | --- | :--: | etc.
const isTableSep = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
};

export const Markdown: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let ul: string[] = [];
  let ol: string[] = [];

  const flushUl = (key: string) => {
    if (!ul.length) return;
    const items = ul;
    ul = [];
    blocks.push(
      <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
  };
  const flushOl = (key: string) => {
    if (!ol.length) return;
    const items = ol;
    ol = [];
    blocks.push(
      <ol key={key} className="my-1 list-decimal space-y-0.5 pl-5">
        {items.map((item, i) => (
          <li key={i} className="pl-0.5">
            {renderInline(item, `${key}-${i}`)}
          </li>
        ))}
      </ol>,
    );
  };
  const flushLists = (key: string) => {
    flushUl(`${key}-ul`);
    flushOl(`${key}-ol`);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Table: this line has a pipe and the next line is a separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushLists(`t-${i}`);
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j]));
        j++;
      }
      blocks.push(
        <div key={`table-${i}`} className="my-1.5 overflow-x-auto">
          <table className="w-full border-collapse text-[0.92em]">
            <thead>
              <tr>
                {header.map((h, x) => (
                  <th
                    key={x}
                    className="border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-left font-semibold text-foreground"
                  >
                    {renderInline(h, `th-${i}-${x}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, y) => (
                <tr key={y}>
                  {header.map((_, x) => (
                    <td key={x} className="border border-border px-2.5 py-1.5 align-top">
                      {renderInline(row[x] ?? "", `td-${i}-${y}-${x}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }

    // Heading (#, ##, ###) — rendered as a small bold lead line.
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushLists(`h-${i}`);
      blocks.push(
        <p key={`h-${i}`} className="mt-2 font-semibold text-foreground">
          {renderInline(heading[2], `h-${i}`)}
        </p>,
      );
      i++;
      continue;
    }

    // Ordered list item (1. text)
    const olItem = line.match(/^\s*\d+\.\s+(.*)$/);
    if (olItem) {
      flushUl(`u-${i}`);
      ol.push(olItem[1]);
      i++;
      continue;
    }

    // Unordered list item (- text / * text)
    const ulItem = line.match(/^\s*[-*]\s+(.*)$/);
    if (ulItem) {
      flushOl(`o-${i}`);
      ul.push(ulItem[1]);
      i++;
      continue;
    }

    // Blank line or paragraph.
    flushLists(`f-${i}`);
    if (line.trim() !== "") {
      blocks.push(
        <p key={`p-${i}`} className="leading-relaxed">
          {renderInline(line, `p-${i}`)}
        </p>,
      );
    }
    i++;
  }
  flushLists("end");

  return <div className="space-y-1.5">{blocks}</div>;
};
