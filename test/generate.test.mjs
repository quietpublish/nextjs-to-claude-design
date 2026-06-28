import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CLI = join(REPO, "ds-component-kit", "ds-component-kit.mjs");
const SHIMS = join(REPO, "ds-component-kit", "shims");

let out, cfgPath, genPath;
const run = (args) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

before(() => {
  // inside the repo so the generated .jsx's bare `react` imports resolve from
  // repoRoot/node_modules (mirrors the real design-system/ living in-repo).
  out = mkdtempSync(join(REPO, ".dck-gen-"));
  genPath = join(out, "components", "Atoms", "PriceTag", "PriceTag.jsx");
  cfgPath = join(out, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({
    repoRoot: REPO,
    srcAlias: { "@/*": "src/*" },
    namespace: "DS_gen_test",
    outDir: out,
    shimsDir: SHIMS,
    components: [
      // appPath = real source the generator reads; path = the generated artifact
      { appPath: "test/fixtures/PriceTag.tsx", path: genPath, name: "PriceTag", group: "Atoms" },
    ],
  }));
});

after(() => { if (out) rmSync(out, { recursive: true, force: true }); });

test("generate: emits the component .jsx from the real source", () => {
  const r = run(["generate", "--config", cfgPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(genPath), "generated PriceTag.jsx exists");
});

test("generate: output is self-contained (no next/* or app-lib imports)", () => {
  const src = readFileSync(genPath, "utf8");
  assert.doesNotMatch(src, /from\s+["']next\/link["']/, "next/link is shimmed away");
  assert.doesNotMatch(src, /from\s+["']\.\/format["']/, "the ./format import is inlined");
  assert.doesNotMatch(src, /import\s+\w+\s+from\s+["'][^"']*\.module\.css/, "no CSS-module import remains");
});

test("generate: inlines the lib helper and keeps react as a bare import", () => {
  const src = readFileSync(genPath, "utf8");
  assert.match(src, /function usd\b/, "usd() is inlined");
  assert.match(src, /from\s+["']react/, "react stays a bare (runtime-provided) import");
  assert.match(src, /export default|as default/, "default export preserved (incl. `as default`)");
});

test("generate: CSS-module classes become scoped string literals", () => {
  const src = readFileSync(genPath, "utf8");
  assert.match(src, /PriceTag_tag/, "scoped .tag class present");
  assert.match(src, /PriceTag_amount/, "scoped .amount class present");
});

test("generate: is deterministic (same input → identical output)", () => {
  const a = readFileSync(genPath, "utf8");
  run(["generate", "--config", cfgPath]);
  const b = readFileSync(genPath, "utf8");
  assert.equal(a, b);
});

test("generate + verify: the generated component renders (ok)", { skip: !hasChrome() && "no Chrome" }, () => {
  writeFileSync(join(dirname(genPath), "fixture.mjs"), `export const props = { cents: 1299, href: "#" };\n`);
  const r = run(["verify", "--config", cfgPath, "--only", "PriceTag"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PriceTag/);
  assert.match(r.stdout, /\bok\b/);
});

function hasChrome() {
  const c = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", process.env.CHROME].filter(Boolean);
  if (c.some(existsSync)) return true;
  for (const n of ["google-chrome", "chromium", "chromium-browser", "chrome"]) if (spawnSync("which", [n]).status === 0) return true;
  return false;
}
