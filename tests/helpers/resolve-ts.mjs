// Node >=22.15 compatibility entrypoint for the shared extensionless TypeScript resolver.
// Delegate to the audited resolver so this shim cannot introduce a second resolution policy.
export { resolve } from "./ts-extension-loader.mjs";
