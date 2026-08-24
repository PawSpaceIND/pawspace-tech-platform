import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../lib/api-gateway.ts", import.meta.url);
let source = await readFile(path, "utf8");

const replacements = [
  [
    '  if(url.pathname==="/api/uat-provider-switch")return "bookings.view";',
    '  // This is the pre-session UAT login boundary. The route is production-dead unless the UAT gate is enabled,\n  // and its POST authenticates with the governed access code before minting the provider session. Requiring\n  // bookings.view here made the first session impossible and hid both the invalid-code and production-dead paths.\n  if(url.pathname==="/api/uat-provider-switch")return null;',
  ],
  [
    '  if(url.pathname==="/api/conversations")return "communications.message";\n  // Voice.',
    '  if(url.pathname==="/api/conversations")return "communications.message";\n  // The web-chat surface deliberately has two security modes. Public knowledge/lead capture is\n  // anonymous and is constrained inside the route (public-only knowledge, no customer/tool access,\n  // same-origin writes). Authenticated mode is customer self-service and then enforces the exact\n  // customer binding in runAuthenticatedAiWebChat(). Falling through to dashboard.view blocked both\n  // intended audiences and let an unrelated staff permission define who could converse.\n  if(url.pathname==="/api/ai-web-chat"){\n    if(method==="GET")return null;\n    const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;\n    return String(body.mode||"public")==="authenticated"?"scheduling.book":null;\n  }\n  // Voice.',
  ],
  [
    '  if(url.pathname==="/api/training-finance")return method==="GET"?"finance.view":"finance.manage";\n  if(url.pathname==="/api/training-cancellation")',
    '  if(url.pathname==="/api/training-finance")return method==="GET"?"finance.view":"finance.manage";\n  // Training sandbox capture is a customer checkout action. dashboard.view rejected the customer while\n  // admitting dashboard-only staff such as Finance; scheduling.book matches the canonical booking boundary.\n  if(url.pathname==="/api/training-payment-sandbox")return "scheduling.book";\n  if(url.pathname==="/api/training-cancellation")',
  ],
];

for (const [before, after] of replacements) {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) throw new Error(`Expected exactly one gateway replacement target, found ${occurrences}: ${before}`);
  source = source.replace(before, after);
}

await writeFile(path, source);
