// Deliberately un-bundleable: imports a module that does not exist. Used to prove
// `verify` isolates a failing component instead of failing the whole batch.
import { nope } from "./this-module-does-not-exist";
export function Broken() {
  return <div>{nope}</div>;
}
