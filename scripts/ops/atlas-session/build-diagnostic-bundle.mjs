/**
 * Compile worker/atlas-revision-diagnostic-entry.ts into one ESM artifact and print its SHA-256.
 * Local, deterministic, no network. The printed hash is what a publisher compares against the served
 * main-module content; a contract marker inside the response never substitutes for this comparison.
 * Usage: node scripts/ops/atlas-session/build-diagnostic-bundle.mjs [outDir]
 */
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const ENTRY=fileURLToPath(new URL('../../../worker/atlas-revision-diagnostic-entry.ts',import.meta.url));
export const ARTIFACT_NAME='atlas-api-review.js';
export async function buildDiagnosticBundle(outDir){
 mkdirSync(outDir,{recursive:true});
 const outfile=resolve(outDir,ARTIFACT_NAME);
 await build({entryPoints:[ENTRY],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile,external:['cloudflare:workers','node:*'],legalComments:'none',logLevel:'silent',absWorkingDir:resolve(fileURLToPath(new URL('../../../',import.meta.url))),conditions:['workerd','worker','browser'],mainFields:['module','main']});
 const bytes=readFileSync(outfile);
 return {outfile,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=await buildDiagnosticBundle(process.argv[2]??'.atlas-diagnostic-build');
 console.log(JSON.stringify({artifact:result.outfile,bytes:result.bytes,sha256:result.sha256,sourceEntry:ENTRY},null,2));
}
