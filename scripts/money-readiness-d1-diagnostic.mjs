import fs from "node:fs";
import path from "node:path";

const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const required=(name)=>{const value=args.get(name);if(!value)throw new Error(`Missing ${name}`);return value;};
const readJson=(file)=>JSON.parse(fs.readFileSync(file,"utf8"));
const rows=(value)=>{const found=[];const visit=(item)=>{if(Array.isArray(item)){for(const child of item)visit(child);return;}if(!item||typeof item!=="object")return;if(Array.isArray(item.results))for(const row of item.results)if(row&&typeof row==="object")found.push(row);for(const [key,child] of Object.entries(item))if(key!=="results")visit(child);};visit(value);return found;};
const sqlFiles=(root)=>fs.readdirSync(root,{withFileTypes:true}).flatMap((entry)=>entry.isDirectory()?sqlFiles(path.join(root,entry.name)):entry.name.endsWith(".sql")?[path.join(root,entry.name)]:[]);
const sourceFiles=(root)=>fs.readdirSync(root,{withFileTypes:true}).flatMap((entry)=>entry.isDirectory()?sourceFiles(path.join(root,entry.name)):/\.(?:ts|tsx|mjs)$/.test(entry.name)?[path.join(root,entry.name)]:[]);
const tableNames=(files,pattern)=>{const names=new Set();for(const file of files){const source=fs.readFileSync(file,"utf8");for(const match of source.matchAll(pattern))names.add(match[1].toLowerCase());}return names;};
const root=process.cwd(),drizzleTables=tableNames(sqlFiles(path.join(root,"drizzle")),/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-zA-Z_][\w]*)[`"]?/gi),runtimeCreators=tableNames([...sourceFiles(path.join(root,"lib")),...sourceFiles(path.join(root,"app"))],/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+[`"]?([a-zA-Z_][\w]*)[`"]?/gi),drizzleOnly=[...drizzleTables].filter((name)=>!runtimeCreators.has(name)).sort();
const tableRows=rows(readJson(required("--tables"))),liveTables=[...new Set(tableRows.map((row)=>String(row.name||"").trim().toLowerCase()).filter(Boolean))].sort();
const count=(file,status,exists,label)=>{if(!exists)return null;if(status!=="0")throw new Error(`${label} exists but its read-only count query failed`);const row=rows(readJson(file)).find((item)=>Object.hasOwn(item,"row_count"));if(!row)throw new Error(`${label} count result was missing`);const value=Number(row.row_count);if(!Number.isSafeInteger(value)||value<0)throw new Error(`${label} count was invalid`);return value;};
const live=new Set(liveTables),journalExists=live.has("journal_entries"),financeExists=live.has("finance_journal_entries");
const summary={environment:required("--environment"),tableCount:liveTables.length,tables:liveTables,drizzleOnlyCount:drizzleOnly.length,drizzleOnly,missingDrizzleOnly:drizzleOnly.filter((name)=>!live.has(name)),journalEntries:{exists:journalExists,rowCount:count(required("--journal"),required("--journal-status"),journalExists,"journal_entries")},financeJournalEntries:{exists:financeExists,rowCount:count(required("--finance"),required("--finance-status"),financeExists,"finance_journal_entries")}};
process.stdout.write(`${JSON.stringify(summary,null,2)}\n`);
