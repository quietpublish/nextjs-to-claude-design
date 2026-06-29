// Build-only shim for the automatic JSX runtime, backed by the runtime-provided
// React (window.React). esbuild's `--jsx=automatic` emits imports of jsx/jsxs/
// Fragment from "react/jsx-runtime"; we implement them via React.createElement so
// no second React is inlined. (Aliasing the `react` directory also remaps this
// subpath here.)
const R = window.React;

export const Fragment = R.Fragment;

export function jsx(type, props, key) {
  const { children, ...rest } = props || {};
  if (key !== void 0) rest.key = key;
  return R.createElement(type, rest, children);
}

// jsxs (static children array) has the same shape through createElement.
export const jsxs = jsx;
