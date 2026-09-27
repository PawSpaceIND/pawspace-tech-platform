/**
 * Split SQLite SQL text into complete statements, and group them into chunks small enough for D1's
 * ordinary query API.
 *
 * WHY. `wrangler d1 execute --remote --file` runs through D1's IMPORT API, and while an import runs
 * the database refuses every other query ("Currently processing a long-running import"; wrangler
 * warns "your D1 database will be unavailable to serve queries"). The staging deploy imported 50
 * migration files and 4 seed files that way on every deploy, so anyone booking during a deploy got a
 * failure. `--command` goes through the query API instead and runs alongside live traffic, but it
 * takes SQL text rather than a file - hence this splitter, which only has to find where one
 * statement ends and the next begins. D1 parses each chunk itself.
 *
 * A semicolon ends a statement except inside a quoted string or identifier ('…', "…", `…`, […]),
 * a comment (-- … or /* … *\/), or a trigger body (CREATE TRIGGER … BEGIN … END), where CASE … END
 * expressions may nest. Comments are dropped; everything else is kept byte for byte.
 */

const TRIGGER_HEAD = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const WORD = /[A-Za-z0-9_$]/;

export function splitSqlStatements(sql) {
  const text = String(sql ?? "");
  const statements = [];
  let current = "";
  let depth = 0;
  let word = "";

  const endWord = () => {
    if (!word) return;
    const upper = word.toUpperCase();
    if (upper === "CASE") depth += 1;
    else if (upper === "BEGIN" && TRIGGER_HEAD.test(current)) depth += 1;
    else if (upper === "END" && depth > 0) depth -= 1;
    word = "";
  };
  const finish = () => {
    const statement = current.trim();
    if (statement) statements.push(statement);
    current = "";
    depth = 0;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === "-" && next === "-") {
      endWord();
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end - 1;
      current += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      endWord();
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unterminated /* comment in SQL");
      i = end + 1;
      current += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      endWord();
      const close = char === "[" ? "]" : char;
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new Error(`Unterminated ${char} quote in SQL`);
        if (text[j] === close) {
          if (close !== "]" && text[j + 1] === close) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (WORD.test(char)) {
      word += char;
      current += char;
      continue;
    }
    endWord();
    if (char === ";" && depth === 0) {
      finish();
      continue;
    }
    current += char;
  }
  endWord();
  finish();
  return statements;
}

const bytes = (value) => Buffer.byteLength(value, "utf8");

/**
 * Group statements, in order, into chunks of at most maxBytes (a statement larger than that travels
 * alone). Each chunk is one `wrangler d1 execute --command`, which also keeps it far below both D1's
 * 100 KB statement limit and Linux's 128 KB limit on a single command-line argument.
 */
export function chunkSqlStatements(statements, maxBytes = 30_000) {
  const chunks = [];
  let chunk = "";
  for (const statement of statements) {
    const piece = `${statement};\n`;
    if (chunk && bytes(chunk) + bytes(piece) > maxBytes) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += piece;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** D1 runs each request in its own transaction and refuses explicit transaction control. */
export function assertNoTransactionControl(statements) {
  const offending = statements.find((statement) => /^(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|COMMIT|END(?:\s+TRANSACTION)?|ROLLBACK)\s*$/i.test(statement));
  if (offending) throw new Error(`SQL for D1 must not contain transaction control: "${offending}"`);
}
