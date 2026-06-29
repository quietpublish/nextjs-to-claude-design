// Build-only shim. The Claude Design preview runtime provides React as a global
// (`window.React`; see dc-runtime's getReact()). The uploaded `_ds_bundle.js` must
// use THAT React rather than inline a second copy — two React instances break
// hooks and context, so JS components mount unreliably.
//
// `build` aliases `react` → this directory; `verify` does NOT (it renders in real
// headless Chrome with its own bundled React). Named re-exports below are a
// superset of React's public API: a name the runtime's React lacks is harmless
// (undefined unless used), while a missing one would fail the build loudly.
const R = window.React;

export default R;
export const Children = R.Children;
export const Component = R.Component;
export const Fragment = R.Fragment;
export const Profiler = R.Profiler;
export const PureComponent = R.PureComponent;
export const StrictMode = R.StrictMode;
export const Suspense = R.Suspense;
export const cloneElement = R.cloneElement;
export const createContext = R.createContext;
export const createElement = R.createElement;
export const createRef = R.createRef;
export const forwardRef = R.forwardRef;
export const isValidElement = R.isValidElement;
export const lazy = R.lazy;
export const memo = R.memo;
export const startTransition = R.startTransition;
export const use = R.use;
export const useActionState = R.useActionState;
export const useCallback = R.useCallback;
export const useContext = R.useContext;
export const useDebugValue = R.useDebugValue;
export const useDeferredValue = R.useDeferredValue;
export const useEffect = R.useEffect;
export const useId = R.useId;
export const useImperativeHandle = R.useImperativeHandle;
export const useInsertionEffect = R.useInsertionEffect;
export const useLayoutEffect = R.useLayoutEffect;
export const useMemo = R.useMemo;
export const useOptimistic = R.useOptimistic;
export const useReducer = R.useReducer;
export const useRef = R.useRef;
export const useState = R.useState;
export const useSyncExternalStore = R.useSyncExternalStore;
export const useTransition = R.useTransition;
export const version = R.version;
