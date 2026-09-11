/**
 * Node test adapter only. Node 22.16.0 / Undici 6.21.2 registers a cloned request's
 * lifetime against the original tee branch. GC of an inspection clone can therefore
 * cancel the original body before the real route reads it. Retain native clones only
 * until dispatch finishes; do not recreate a body, patch globals, or change any gate.
 */
export async function withScopedRequestClones(request, dispatch) {
  const clones = [];
  const descriptor = Object.getOwnPropertyDescriptor(request, "clone");
  const nativeClone = request.clone;
  Object.defineProperty(request, "clone", { configurable: true, value: function () {
    const cloned = Reflect.apply(nativeClone, this, []);
    clones.push(cloned);
    return cloned;
  } });
  try {
    return await dispatch(request);
  } finally {
    if (descriptor) Object.defineProperty(request, "clone", descriptor);
    else delete request.clone;
    clones.length = 0;
  }
}
