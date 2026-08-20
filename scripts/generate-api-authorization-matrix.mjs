import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HTTP_METHOD = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function functionText(source, name, fileName = "source.ts") {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!found) throw new Error(`Could not find function ${name} in ${fileName}`);
  return found.getText(parsed).replace(/^export\s+/, "");
}

function executableFunction(source, name, fileName) {
  const compiled = ts.transpileModule(functionText(source, name, fileName), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName,
  }).outputText;
  return new Function(`${compiled}\nreturn ${name};`)();
}

function routeClause(source, route) {
  const literal = `url.pathname===\"${route}\"`;
  const position = source.indexOf(literal);
  if (position < 0) return "";
  const starts = [...source.matchAll(/if\(url\.pathname/g)].map((match) => match.index ?? 0);
  const start = starts.filter((value) => value <= position).at(-1) ?? 0;
  const end = starts.find((value) => value > position) ?? source.length;
  return source.slice(start, end);
}

function permissionOptions(gateway, route) {
  const clause = routeClause(gateway, route);
  if (!clause) return [];
  const values = new Set();
  for (const match of clause.matchAll(/[\"']([a-z_]+\.[a-z_]+)[\"']/g)) values.add(match[1]);
  if (/return\s+null\b/.test(clause)) values.add("public");
  return [...values].sort();
}

function sessionOwnership(sessionGateway, route) {
  const clause = routeClause(sessionGateway, route);
  const kinds = new Set();
  for (const match of clause.matchAll(/subjectType:\s*[\"'](customer|provider)[\"']/g)) kinds.add(match[1]);
  return [...kinds].sort();
}

function exportedMethodText(routeSource, method, fileName = "route.ts") {
  const parsed = ts.createSourceFile(fileName, routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === method) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found ? found.getText(parsed) : routeSource;
}

function routeOwnership(routeSource) {
  const kinds = new Set();
  if (/\brequireCustomerOwnership\s*\(/.test(routeSource) || /\bresolveOwnedCustomerEmail\s*\(/.test(routeSource)) kinds.add("customer");
  if (/\brequireProviderOwnership\s*\(/.test(routeSource) || /\bresolveOwnedProviderEmail\s*\(/.test(routeSource)) kinds.add("provider");
  return [...kinds].sort();
}

function routeAuthGuards(routeSource) {
  const guards = [];
  const candidates = [
    "authorize",
    "requirePermission",
    "resolveActor",
    "requireCustomerOwnership",
    "requireProviderOwnership",
    "resolveOwnedCustomerEmail",
    "resolveOwnedProviderEmail",
  ];
  for (const name of candidates) if (new RegExp(`\\b${name}\\s*\\(`).test(routeSource)) guards.push(name);
  return guards;
}

function routePermissionChecks(routeSource, fileName = "route.ts") {
  const parsed = ts.createSourceFile(fileName, routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const permissions = new Set();
  const variableInitializers = new Map();

  const indexVariables = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variableInitializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, indexVariables);
  };
  indexVariables(parsed);

  const collectPermissionLiterals = (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^[a-z_]+\.[a-z_]+$/.test(node.text)) {
      permissions.add(node.text);
    }
    ts.forEachChild(node, collectPermissionLiterals);
  };

  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === "authorize" || node.expression.text === "requirePermission")
      && node.arguments[1]
    ) {
      const permissionArgument = node.arguments[1];
      if (ts.isIdentifier(permissionArgument) && variableInitializers.has(permissionArgument.text)) {
        collectPermissionLiterals(variableInitializers.get(permissionArgument.text));
      } else {
        collectPermissionLiterals(permissionArgument);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...permissions].sort();
}

function requestFor(route, method, { action, query = "" } = {}) {
  const init = { method };
  if (!SAFE_METHODS.has(method)) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify({
      ...(action ? { action } : {}),
      customerId: "customer-probe",
      providerId: "provider-probe",
      customer: { id: "customer-probe" },
    });
  }
  return new Request(`https://pawspace.example${route}${query}`, init);
}

function sessionProbeActions(sessionGateway) {
  const values = new Set();
  for (const match of sessionGateway.matchAll(/[\"\']([a-z][a-z0-9_-]{1,40})[\"\']/g)) values.add(match[1]);
  return [...values];
}

async function sessionScopesFor(sessionScope, route, method, actions) {
  const probes = [requestFor(route, method, { query: "?providerId=provider-probe&customerId=customer-probe&scope=customer" })];
  if (!SAFE_METHODS.has(method)) for (const action of actions) probes.push(requestFor(route, method, { action }));
  const scopes = [];
  for (const request of probes) {
    const scope = await sessionScope(request.clone());
    if (scope) scopes.push(scope);
  }
  return scopes;
}

async function apiSurface(root) {
  const apiRoot = join(root, "app", "api");
  const entries = await readdir(apiRoot, { withFileTypes: true });
  const routes = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(apiRoot, entry.name, "route.ts");
    const source = await readFile(file, "utf8").catch(() => "");
    if (!source) continue;
    const methods = [...source.matchAll(HTTP_METHOD)].map((match) => match[1]);
    if (!methods.length) throw new Error(`/api/${entry.name} has route.ts but no exported HTTP method`);
    routes.push({ route: `/api/${entry.name}`, source, methods: [...new Set(methods)].sort() });
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

export async function generateAuthorizationMatrix({ root = DEFAULT_ROOT } = {}) {
  const [gateway, sessionGateway, surface] = await Promise.all([
    readFile(join(root, "lib", "api-gateway.ts"), "utf8"),
    readFile(join(root, "lib", "session-api-gateway.ts"), "utf8"),
    apiSurface(root),
  ]);
  const requiredPermission = executableFunction(gateway, "requiredPermission", "lib/api-gateway.ts");
  const sessionScope = executableFunction(sessionGateway, "sessionScope", "lib/session-api-gateway.ts");
  const rows = [];
  const sessionActions = sessionProbeActions(sessionGateway);

  for (const item of surface) {
    if (!gateway.includes(`url.pathname===\"${item.route}\"`)) throw new Error(`${item.route} is missing from the authoritative gateway registry`);
    const routeKindsPossible = routeOwnership(item.source);
    const sessionKindsPossible = sessionOwnership(sessionGateway, item.route);
    const gatewayOptions = permissionOptions(gateway, item.route);

    for (const method of item.methods) {
      const methodSource = exportedMethodText(item.source, method, `${item.route}/route.ts`);
      const routeKinds = routeOwnership(methodSource);
      const guards = routeAuthGuards(methodSource);
      const directPermissionChecks = routePermissionChecks(methodSource, `${item.route}/route.ts`);
      const request = requestFor(item.route, method);
      const permission = await requiredPermission(request.clone());
      const gatewayPermissionOptions = gatewayOptions.length ? gatewayOptions : [permission === null ? "public" : permission];
      const effectivePermissionOptions = [...new Set([...gatewayPermissionOptions, ...directPermissionChecks])].sort();
      const scopes = await sessionScopesFor(sessionScope, item.route, method, sessionActions);
      const sessionKinds = [...new Set(scopes.map((scope) => scope.subjectType))].sort();
      const ownership = new Set([...routeKinds, ...sessionKinds]);
      const ownershipOptions = new Set([...routeKindsPossible, ...sessionKindsPossible, ...sessionKinds]);
      const ownershipSources = [];
      if (routeKindsPossible.length) ownershipSources.push("route");
      if (sessionKindsPossible.length || sessionKinds.length) ownershipSources.push("session");
      const layers = ["worker-gateway"];
      if (routeKindsPossible.length || guards.length) layers.push("route-guard");
      if (ownershipSources.includes("session")) layers.push("session-scope");
      rows.push({
        route: item.route,
        method,
        access: permission === null ? "public" : "protected",
        permission: permission === null ? "public" : permission,
        permissionOptions: effectivePermissionOptions,
        permissionLayers: {
          "worker-gateway": gatewayPermissionOptions,
          ...(directPermissionChecks.length ? { "route-guard": directPermissionChecks } : {}),
        },
        ownership: ownership.size ? [...ownership].sort() : ["none"],
        ownershipOptions: ownershipOptions.size ? [...ownershipOptions].sort() : ["none"],
        ownershipSources,
        ownershipIdBound: scopes.some((scope) => Boolean(scope.subjectId)) || routeKindsPossible.length > 0,
        enforcementLayers: [...new Set(layers)],
        routeAuthGuards: guards,
        routePermissionChecks: directPermissionChecks,
        stateChanging: !SAFE_METHODS.has(method),
      });
    }
  }

  return rows.sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
}

export const authorizationPolicySourceFiles = Object.freeze([
  "lib/api-gateway.ts",
  "lib/session-api-gateway.ts",
  "lib/server-auth.ts",
  "lib/platform-security.ts",
  "worker/index.ts",
]);

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const matrix = await generateAuthorizationMatrix();
  process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
}
