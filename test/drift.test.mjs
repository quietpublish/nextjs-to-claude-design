import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CLI = join(REPO, "ds-component-kit", "ds-component-kit.mjs");
const SHIMS = join(REPO, "ds-component-kit", "shims");

let out, src, cfgPath;
const run = (args) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

before(() => {
  out = mkdtempSync(join(REPO, ".dck-drift-")); // in-repo so react resolves
  src = join(out, "src", "Widget.tsx");
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, `export default function Widget() { return <div>hello widget</div>; }\n`);
  cfgPath = join(out, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({
    repoRoot: REPO, srcAlias: { "@/*": "src/*" }, namespace: "DS_drift", outDir: out, shimsDir: SHIMS,
    components: [{ name: "Widget", group: "Atoms", appPath: src, path: join(out, "components", "Atoms", "Widget", "Widget.jsx") }],
  }));
});

after(() => { if (out) rmSync(out, { recursive: true, force: true }); });

test("generate seals a source fingerprint, drift reports fresh (exit 0)", () => {
  assert.equal(run(["generate", "--config", cfgPath]).status, 0);
  const sync = JSON.parse(readFileSync(join(out, ".dck-sync.json"), "utf8"));
  assert.ok(sync.components.Widget?.hash?.startsWith("sha256:"), "Widget fingerprint sealed");

  const r = run(["drift", "--config", cfgPath]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Widget/);
  assert.match(r.stdout, /fresh/);
});

test("drift flags a changed source (exit 1)", () => {
  appendFileSync(src, `\n// a change to the app source\n`);
  const r = run(["drift", "--config", cfgPath]);
  assert.equal(r.status, 1, "non-zero on drift");
  assert.match(r.stdout, /drifted/);
});

test("re-generate clears the drift (exit 0 again)", () => {
  assert.equal(run(["generate", "--config", cfgPath]).status, 0);
  const r = run(["drift", "--config", cfgPath]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /fresh/);
});

test("drift flags an orphaned source (exit 1)", () => {
  rmSync(src);
  const r = run(["drift", "--config", cfgPath]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /orphan/);
});
