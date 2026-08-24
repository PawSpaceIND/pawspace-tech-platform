import { readFile, writeFile } from "node:fs/promises";

async function update(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`No change produced for ${path}`);
  await writeFile(path, after);
}

function replaceExactly(source, before, after, expected = 1) {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== expected) {
    throw new Error(`Expected ${expected} occurrence(s), found ${occurrences}: ${before}`);
  }
  return source.replaceAll(before, after);
}

await update("lib/platform-security.ts", (source) => {
  let next = replaceExactly(
    source,
    '  "communications.call", "communications.message", "payments.view", "payments.manage",',
    '  "communications.call", "communications.message", "communications.manage", "payments.view", "payments.manage",',
  );
  for (const role of ["admin", "manager", "associate"]) {
    const line = next.split("\n").find((candidate) => candidate.includes(`{ code:"${role}"`));
    if (!line) throw new Error(`Role ${role} was not found`);
    const changed = replaceExactly(
      line,
      '"communications.call","communications.message",',
      '"communications.call","communications.message","communications.manage",',
    );
    next = replaceExactly(next, line, changed);
  }
  return next;
});

await update("lib/api-gateway.ts", (source) => replaceExactly(
  source,
  '  if(url.pathname==="/api/communications"){if(method==="GET")return "communications.message";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"enqueue");if(action==="adapter_readiness"||action==="policy_update")return "settings.manage";if(action==="preference")return "customers.manage";return "communications.message";}\n  if(url.pathname==="/api/conversations")return "communications.message";',
  '  // communications.message is deliberately narrow: it lets providers report/contact through routes\n  // that enforce booking/provider ownership. The system-wide ledger, queue, dispatch and assignment\n  // surfaces require communications.manage so a service provider cannot read or mutate another customer.\n  if(url.pathname==="/api/communications"){if(method==="GET")return "communications.manage";const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>,action=String(body.action||"enqueue");if(action==="adapter_readiness"||action==="policy_update")return "settings.manage";if(action==="preference")return "customers.manage";return "communications.manage";}\n  if(url.pathname==="/api/conversations"||url.pathname==="/api/ai-human-handoff")return "communications.manage";',
));

for (const path of [
  "app/api/communications/route.ts",
  "app/api/conversations/route.ts",
  "app/api/ai-human-handoff/route.ts",
]) {
  await update(path, (source) => {
    const occurrences = source.split("communications.message").length - 1;
    if (occurrences < 1) throw new Error(`No handler permission was found in ${path}`);
    return source.replaceAll("communications.message", "communications.manage");
  });
}

await update("lib/ai-human-handoff.ts", (source) => replaceExactly(
  source,
  'actor.permissions.includes("communications.message")',
  'actor.permissions.includes("communications.manage")',
));
await update("lib/ai-conversation-orchestrator.ts", (source) => replaceExactly(
  source,
  'actor.permissions.includes("communications.message")',
  'actor.permissions.includes("communications.manage")',
));
await update("lib/ai-tool-registry.ts", (source) => {
  let next = replaceExactly(
    source,
    'staffPermissions:["communications.message"]',
    'staffPermissions:["communications.manage"]',
  );
  next = replaceExactly(
    next,
    'actor.permissions.includes("communications.message")',
    'actor.permissions.includes("communications.manage")',
  );
  return next;
});
await update("tests/ai-human-handoff.test.mjs", (source) => replaceExactly(
  source,
  'authorize\\(request,"communications.message"\\)',
  'authorize\\(request,"communications.manage"\\)',
));
