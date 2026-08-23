export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /^\.{1,2}\//.test(specifier) && !/\.[a-z0-9]+$/i.test(specifier)) {
      for (const extension of [".ts", ".tsx", ".js", ".mjs"]) {
        try {
          return await nextResolve(`${specifier}${extension}`, context);
        } catch {}
      }
    }
    throw error;
  }
}
