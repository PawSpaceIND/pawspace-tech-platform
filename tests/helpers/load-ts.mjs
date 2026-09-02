import { register } from "node:module";

// Preload the delegated resolver before Node discovers the Web test modules.
// node:module.register is available on the pinned Node 22.13 runner and keeps
// the resolver itself compatible with the Node >=22.15 registerHooks self-test.
register(new URL("./resolve-ts.mjs", import.meta.url), import.meta.url);
