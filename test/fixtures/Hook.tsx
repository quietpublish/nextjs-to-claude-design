// No default export and no export named "Hook" — the kit should skip this with a
// clear reason (it's a hook + a value, not a renderable component).
export function useThing(): number {
  return 1;
}
export const SOME_CONST = 2;
