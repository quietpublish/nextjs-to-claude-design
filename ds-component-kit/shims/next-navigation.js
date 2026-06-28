// Design-runtime shim for next/navigation — inert router + static path/params.
// Components that read these render as if on a stable route; actions are no-ops.
export function useRouter() {
  return { push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {} };
}
export function usePathname() {
  return "/";
}
export function useSearchParams() {
  return new URLSearchParams();
}
export function useParams() {
  return {};
}
export function redirect() {}
export function notFound() {}
