// Build-only shim for react-dom/client, backed by window.ReactDOM. Components
// rarely import this (createRoot is app-level), but a bundled dep might.
const RD = window.ReactDOM;

export const createRoot = RD.createRoot;
export const hydrateRoot = RD.hydrateRoot;
