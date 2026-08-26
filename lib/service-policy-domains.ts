/**
 * The barrel that makes the governed policy domains REACHABLE.
 *
 * lib/service-policy-governance.ts holds its domains in a module-level Map that each domain fills by
 * calling registerServicePolicyDomain at import time. That works only if something imports the domain
 * module. app/api/service-policy-control/route.ts - the Control Center surface whose entire purpose is
 * to list and change these policies - imported the kernel and nothing else, so in a cold worker the Map
 * was EMPTY: GET answered {"domains":[]} and POST answered "Unknown policy domain" for every one of
 * them. Every domain suite hid it, because each imports its own domain module before calling the route.
 *
 * Importing here is not incidental - it IS the registration. Anything that reads the registry must
 * import this file, and any new domain must be added below. tests/ptja-policy-domain-registry.test.mjs
 * fails if a lib module registers a domain that is not listed here. [PTJA-W2-B4-M04]
 */
import"./cancellation-case-governance";
import"./city-status-authority";
import"./collection-ledger";
import"./media-upload-boundary";
import"./provider-verification-policy";
import"./purpose-based-access";
import"./quiet-hours-override";
import"./refund-policy-governance";
import"./revenue-reconciliation-report";

export{listServicePolicies,resolveServicePolicy,seedServicePolicyDefault,servicePolicyAudit,servicePolicyDomain,servicePolicyDomains,writeServicePolicy}from"./service-policy-governance";
