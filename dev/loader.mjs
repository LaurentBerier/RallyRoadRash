/* Node import-map shim: lets dev scripts and tests import modules that use the
   browser import map's bare specifiers ('three', 'three/addons/…').
   Usage:  node --experimental-loader ./dev/loader.mjs dev/some-check.mjs  */
export function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return next(new URL('../vendor/three/three.module.js', import.meta.url).href, context);
  }
  if (specifier.startsWith('three/addons/')) {
    return next(new URL('../vendor/three/examples/jsm/' + specifier.slice('three/addons/'.length),
      import.meta.url).href, context);
  }
  return next(specifier, context);
}
