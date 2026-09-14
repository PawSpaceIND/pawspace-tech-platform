if(process.env.CAPACITOR_TARGET==="partner"&&!process.env.PAWSPACE_PARTNER_APP_URL)throw new Error("Set PAWSPACE_PARTNER_APP_URL to the approved HTTPS /partner-app workspace before syncing a native build.");
import {readFileSync,writeFileSync} from "node:fs";
// Upstream 1.2.26 declares core >=3 for npm but its SPM range still stops at Capacitor 7.
// Pin this targeted manifest adjustment until upstream publishes a Capacitor 8 SPM range.
const root=new URL("../node_modules/@capacitor-community/background-geolocation/",import.meta.url);
const pkg=JSON.parse(readFileSync(new URL("package.json",root),"utf8"));
const core=JSON.parse(readFileSync(new URL("../node_modules/@capacitor/core/package.json",import.meta.url),"utf8"));
if(pkg.version!=="1.2.26"||!core.version.startsWith("8."))throw new Error("Review native location compatibility before changing plugin or Capacitor versions.");
const manifest=new URL("Package.swift",root),source=readFileSync(manifest,"utf8");
if(!source.includes('from: "7.0.0"')&&!source.includes('from: "8.0.0"'))throw new Error("Unexpected background location SPM manifest");
writeFileSync(manifest,source.replace('from: "7.0.0"','from: "8.0.0"'));
