/**
 * A tiny synchronous client runtime for customer-facing TSX components.
 *
 * react-dom/server renders a component ONCE and never runs an effect, so a screen whose content
 * arrives from an effect (a pet list, a coupon list, a policy preview) renders empty there and any
 * assertion against that markup is vacuous. tests/stay-flow-money-display.test.mjs solved this for
 * StayFlow by driving React's own dispatcher slot; this file is that same runtime, factored out so
 * more than one customer suite can REALLY execute a component - effects, state updates and button
 * clicks - and then render the settled tree with react-dom/server.
 *
 * Exactly the hooks these components use are implemented, with real semantics: state survives passes,
 * effects run after a pass and only when their dependencies change, memos are cached on their deps.
 */
import assert from "node:assert/strict";

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
assert.ok(internals && "H" in internals, "React exposes the dispatcher slot this harness drives");

export function mount(Component, props, { label = Component.name || "component", passes = 40 } = {}) {
  const hooks = [];
  const queue = [];
  let cursor = 0;
  let dirty = false;

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const slot = () => { const index = cursor++; if (!hooks[index]) hooks[index] = { index }; return hooks[index]; };
  const update = (cell, next) => {
    const value = typeof next === "function" ? next(cell.value) : next;
    if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
  };
  const effectSlot = (create, deps) => {
    const cell = slot();
    if (!("deps" in cell) || !sameDeps(cell.deps, deps)) { cell.deps = deps; cell.create = create; queue.push(cell); }
  };
  const dispatcher = {
    useState(initial) {
      const cell = slot();
      if (!("value" in cell)) cell.value = typeof initial === "function" ? initial() : initial;
      return [cell.value, (next) => update(cell, next)];
    },
    useReducer(reducer, initialArg, init) {
      const cell = slot();
      if (!("value" in cell)) cell.value = init ? init(initialArg) : initialArg;
      return [cell.value, (action) => update(cell, (current) => reducer(current, action))];
    },
    useRef(initial) { const cell = slot(); if (!("ref" in cell)) cell.ref = { current: initial }; return cell.ref; },
    useMemo(create, deps) {
      const cell = slot();
      if (!("memo" in cell) || !sameDeps(cell.deps, deps)) { cell.deps = deps; cell.memo = create(); }
      return cell.memo;
    },
    useCallback(fn, deps) { return dispatcher.useMemo(() => fn, deps); },
    useEffect: effectSlot,
    useLayoutEffect: effectSlot,
    useInsertionEffect() { slot(); },
    useImperativeHandle() { slot(); },
    useContext(context) { return context._currentValue; },
    useDebugValue() {},
    useId() { const cell = slot(); return `:r${cell.index}:`; },
    useSyncExternalStore(_subscribe, getSnapshot, getServerSnapshot) { slot(); return (getServerSnapshot ?? getSnapshot)(); },
    useTransition() { slot(); return [false, (callback) => callback()]; },
    useDeferredValue(value) { slot(); return value; },
    useOptimistic(value) { slot(); return [value, () => {}]; },
    useActionState(_action, initial) { slot(); return [initial, () => {}, false]; },
    useEffectEvent(fn) { return fn; },
    use(usable) { return usable; },
  };

  const pass = () => {
    cursor = 0;
    dirty = false;
    const previous = internals.H;
    internals.H = dispatcher;
    try { return Component(props); } finally { internals.H = previous; }
  };
  const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

  let tree = pass();
  const settle = async () => {
    for (let i = 0; i < passes; i++) {
      for (const cell of queue.splice(0)) {
        if (typeof cell.cleanup === "function") { cell.cleanup(); cell.cleanup = undefined; }
        const result = cell.create();
        if (typeof result === "function") cell.cleanup = result;
      }
      await drain();
      if (!dirty && queue.length === 0) return tree;
      tree = pass();
    }
    throw new Error(`${label} never reached a stable render`);
  };
  return { settle, tree: () => tree, html: () => renderToStaticMarkup(tree) };
}

// --- element-tree helpers ---------------------------------------------------
export function* walk(node) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  yield node;
  yield* walk(node.props?.children);
}
export const textOf = (node) => {
  let out = "";
  const visit = (value) => {
    if (value == null || typeof value === "boolean") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === "object") { visit(value.props?.children); return; }
    out += String(value);
  };
  visit(node);
  return out;
};
export const all = (tree, predicate) => [...walk(tree)].filter(predicate);
export const find = (tree, predicate) => [...walk(tree)].find(predicate);
export const button = (tree, label) => {
  const node = find(tree, (n) => n.type === "button" && textOf(n).includes(label));
  assert.ok(node, `a button labelled "${label}" is on screen`);
  return node;
};
/** Plain text of the rendered screen, so assertions read the customer's words, not markup. */
export const screenText = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&#x2F;/g, "/").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** A per-test in-memory Storage, installed on globalThis.window/sessionStorage. */
export function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    clear: () => map.clear(),
    _map: map,
  };
}
