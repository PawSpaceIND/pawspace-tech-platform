import { Fragment, type ReactNode } from "react";

// Text formatting only: no HTML parsing, executable content or link conversion.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export default function ReadableText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const key = index;
    if (!line.trim()) { index++; continue; }
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (bullet || ordered) {
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        items.push(<li key={index}>{inline(item[1])}</li>);
        index++;
      }
      blocks.push(ordered ? <ol key={key} start={Number(ordered[1])}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    blocks.push(heading ? <h3 key={key}>{inline(heading[1])}</h3> : <p key={key}>{inline(line)}</p>);
    index++;
  }
  return <div className="paw-readable-text">{blocks}</div>;
}
