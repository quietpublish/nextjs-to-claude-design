// Build-only shim. Bundled deps (e.g. Radix UI) import react-dom for createPortal
// and flushSync; route them to the runtime-provided ReactDOM (window.ReactDOM) so
// no second copy is inlined alongside the runtime's own.
const RD = window.ReactDOM;

export default RD;
export const createPortal = RD.createPortal;
export const flushSync = RD.flushSync;
export const render = RD.render;
export const hydrate = RD.hydrate;
export const unmountComponentAtNode = RD.unmountComponentAtNode;
export const findDOMNode = RD.findDOMNode;
export const preconnect = RD.preconnect;
export const prefetchDNS = RD.prefetchDNS;
export const preload = RD.preload;
export const preinit = RD.preinit;
export const version = RD.version;
