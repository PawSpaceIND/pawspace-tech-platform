import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import matrix from "../security/api-authorization-matrix.mjs";

const gatewaySource = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
const serverAuthSource = await readFile(new URL("../lib/server-auth.ts", import.meta.url), "utf8");
const securitySource = await readFile(new URL("../lib/platform-security.ts", import.meta.url), "utf8");
const sessionSource = await readFile(new URL("../lib/session-api-gateway.ts", import.meta.url), "utf8");

function functionText(source, name, fileName) {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!found) throw new Error(`Could not find ${name} in ${fileName}`);
  return found.getText(parsed).replace(/^export\s+/, "");
}

function productionFunction(source, name, fileName, bindings = {}) {
  const output = ts.transpileModule(functionText(source, name, fileName), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    fileName,
  }).outputText;
  const keys = Object.keys(bindings);
  return new Function(...keys, `${output}\nreturn ${name};`)(...keys.map((key) => bindings[key]));
}

const requiredPermission = productionFunction(gatewaySource, "requiredPermission", "lib/api-gateway.ts");
const hasPermission = productionFunction(securitySource, "hasPermission", "lib/platform-security.ts");
const authFailure = (message, status) => Response.json({ error: message }, { status });
const noopAudit = async () => {};

function gatewayAuthorizer({ uatActor = null, platformSession = null } = {}) {
  return productionFunction(gatewaySource, "authorizeApiRequest", "lib/api-gateway.ts", {
    requiredPermission,
    resolveUatStaffActor: async () => uatActor,
    resolvePlatformSession: async () => platformSession,
    uatLoginEnabled: () => false,
    signInRequiredResponse: () => Response.json({ error: "Authentication required" }, { status: 401 }),
    ensureGatewayTables: async () => {},
    hasPermission,
    audit: noopAudit,
  });
}

function requestFor(entry, headers = {}) {
  const init = { method: entry.method, headers: { ...headers } };
  if (entry.stateChanging) {
    init.headers["content-type"] = "application/json";
    init.body = "{}";
  }
  return new Request(`https://pawspace.example${entry.route}`, init);
}

async function responseFromThrown(promise) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  assert.fail("expected authorization primitive to reject");
}

test("every protected route/method rejects unauthenticated and forged-header callers", async () => {
  const authorizeApiRequest = gatewayAuthorizer();
  const forgedHeaders = {
    authorization: "Bearer forged",
    "x-user-email": "founder@attacker.invalid",
    "x-authenticated-user-email": "founder@attacker.invalid",
    "x-pawspace-user-email": "founder@attacker.invalid",
  };
  const emptyDb = {
    prepare() { return { bind() { return this; }, first: async () => null, run: async () => ({ success: true }) }; },
  };
  const protectedRows = matrix.filter((entry) => entry.access === "protected");
  assert.ok(protectedRows.length > 0);
  for (const entry of protectedRows) {
    const unauthenticated = await authorizeApiRequest(requestFor(entry), {});
    assert.equal(unauthenticated.status, 401, `unauthenticated ${entry.method} ${entry.route} was not refused`);
    const forged = await authorizeApiRequest(requestFor(entry, forgedHeaders), { DB: emptyDb });
    assert.equal(forged.status, 401, `untrusted forged headers bypassed ${entry.method} ${entry.route}`);
    const forgedWorkspace = await authorizeApiRequest(
      requestFor(entry, { "oai-authenticated-user-email": "forged@attacker.invalid" }),
      { DB: emptyDb },
    );
    assert.equal(forgedWorkspace.status, 403, `unprovisioned forged workspace identity bypassed ${entry.method} ${entry.route}`);
  }
});

test("every protected route/method rejects an under-privileged authenticated actor", async () => {
  const authorizeApiRequest = gatewayAuthorizer({
    uatActor: { email: "limited@pawspace.test", roleCode: "limited", permissions: [] },
  });
  for (const entry of matrix.filter((item) => item.access === "protected")) {
    const response = await authorizeApiRequest(requestFor(entry), {});
    assert.equal(response.status, 403, `under-privileged actor reached ${entry.method} ${entry.route}`);
    assert.equal((await response.json()).error, "Permission denied");
  }
});

test("route-level customer ownership rejects cross-customer access for every classified row", async () => {
  const requireCustomerOwnership = productionFunction(serverAuthSource, "requireCustomerOwnership", "lib/server-auth.ts", {
    hasPermission,
    findIdentityBinding: async () => ({ subject_id: "customer-a" }),
    authFailure,
  });
  const actor = {
    email: "customer-a@pawspace.test",
    permissions: [],
    developmentPreview: false,
    identitySource: "workspace",
    principalType: "email",
    principalKey: "customer-a@pawspace.test",
  };
  const rows = matrix.filter((entry) => entry.ownershipOptions.includes("customer") && entry.ownershipSources.includes("route"));
  for (const entry of rows) {
    const response = await responseFromThrown(requireCustomerOwnership({}, actor, "customer-b"));
    assert.equal(response.status, 403, `cross-customer route guard did not reject ${entry.method} ${entry.route}`);
    assert.equal((await response.json()).error, "Customer ownership denied");
  }
});

test("route-level provider ownership rejects cross-provider access for every classified row", async () => {
  const requireProviderOwnership = productionFunction(serverAuthSource, "requireProviderOwnership", "lib/server-auth.ts", {
    hasPermission,
    findIdentityBinding: async () => ({ subject_id: "provider-a" }),
    authFailure,
  });
  const actor = {
    email: "provider-a@pawspace.test",
    permissions: [],
    developmentPreview: false,
    identitySource: "workspace",
    principalType: "email",
    principalKey: "provider-a@pawspace.test",
  };
  const rows = matrix.filter((entry) => entry.ownershipOptions.includes("provider") && entry.ownershipSources.includes("route"));
  for (const entry of rows) {
    const response = await responseFromThrown(requireProviderOwnership({}, actor, "provider-b"));
    assert.equal(response.status, 403, `cross-provider route guard did not reject ${entry.method} ${entry.route}`);
    assert.equal((await response.json()).error, "Provider ownership denied");
  }
});

test("platform-session subject checks reject cross-subject access for every session-owned row", () => {
  const subjectAllowed = productionFunction(sessionSource, "subjectAllowed", "lib/session-api-gateway.ts");
  const rows = matrix.filter((entry) => entry.ownershipSources.includes("session"));
  assert.ok(rows.length > 0, "expected session-owned rows in the authorization matrix");
  for (const entry of rows) {
    for (const kind of entry.ownershipOptions.filter((value) => value !== "none")) {
      const opposite = kind === "customer" ? "provider" : "customer";
      assert.equal(
        subjectAllowed({ subjectType: opposite, subjectId: `${opposite}-a` }, { subjectType: kind, subjectId: `${kind}-b` }),
        false,
        `cross-subject session was accepted for ${entry.method} ${entry.route}`,
      );
      if (entry.ownershipIdBound) {
        assert.equal(
          subjectAllowed({ subjectType: kind, subjectId: `${kind}-a` }, { subjectType: kind, subjectId: `${kind}-b` }),
          false,
          `cross-${kind} session was accepted for ${entry.method} ${entry.route}`,
        );
      }
    }
  }
});
