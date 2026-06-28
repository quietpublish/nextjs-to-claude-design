import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CLI = join(REPO, "ds-component-kit", "ds-component-kit.mjs");
const SHIMS = join(REPO, "ds-component-kit", "shims");

let out, cfgPath;

function run(args) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

const hasChrome = () => {
  const cands = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  if (cands.some((c) => existsSync(c))) return true;
  for (const n of ["google-chrome", "chromium", "chromium-browser", "chrome"])
    if (spawnSync("which", [n]).status === 0) return true;
  return false;
};

before(() => {
  out = mkdtempSync(join(tmpdir(), "dck-test-"));
  cfgPath = join(out, "ds-component-kit.config.json");
  writeFileSync(cfgPath, JSON.stringify({
    repoRoot: REPO,                       // absolute → esbuild/react devDeps resolve
    srcAlias: { "@/*": "src/*" },
    namespace: "DS_test_abc123",
    outDir: join(out, "ds-bundle"),
    shimsDir: SHIMS,
    components: [
      { path: "test/fixtures/StatCard.tsx", name: "StatCard", group: "Cards" },
      { path: "test/fixtures/Note.tsx", name: "Note", group: "Atoms" },
      { path: "test/fixtures/Hook.tsx", name: "Hook", group: "Misc" },
    ],
  }));
});

after(() => { if (out) rmSync(out, { recursive: true, force: true }); });

test("build: bundles components, skips non-components, writes a valid header", () => {
  const r = run(["build", "--config", cfgPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /built/);
  assert.match(r.stdout, /2 components/);
  assert.match(r.stdout, /Hook/);                 // reported as skipped

  const js = join(out, "ds-bundle", "_ds_bundle.js");
  assert.ok(existsSync(js), "_ds_bundle.js exists");
  const header = readFileSync(js, "utf8").split("\n")[0];
  const json = JSON.parse(header.replace(/^\/\* @ds-bundle: /, "").replace(/ \*\/$/, ""));
  const names = json.components.map((c) => c.name);
  assert.deepEqual(new Set(names), new Set(["StatCard", "Note"]));
  assert.ok(existsSync(join(out, "ds-bundle", "_ds_bundle.css")), "_ds_bundle.css exists");
});

test("scaffold: creates the 5 artifacts and is idempotent", () => {
  const r1 = run(["scaffold", "--config", cfgPath, "--only", "StatCard"]);
  assert.equal(r1.status, 0, r1.stderr);
  const dir = join(out, "ds-bundle", "components", "Cards", "StatCard");
  for (const f of ["StatCard.jsx", "StatCard.d.ts", "StatCard.prompt.md", "StatCard.html", "fixture.mjs"])
    assert.ok(existsSync(join(dir, f)), `${f} created`);

  // CSS-module class map extracted into the stub
  assert.match(readFileSync(join(dir, "StatCard.jsx"), "utf8"), /StatCard_card/);
  // @dsCard marker on the preview card
  assert.match(readFileSync(join(dir, "StatCard.html"), "utf8"), /@dsCard group="Cards" name="StatCard"/);

  // second run keeps edited files (idempotent)
  const r2 = run(["scaffold", "--config", cfgPath, "--only", "StatCard"]);
  assert.match(r2.stdout, /all kept/);
});

test("error: unknown command exits non-zero", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});

test("error: empty --only selection is reported", () => {
  const r = run(["build", "--config", cfgPath, "--only", "Nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no components selected/);
});

test("verify: renders a component with its fixture (ok)", { skip: !hasChrome() && "no Chrome available" }, () => {
  // ensure the component dir + a real fixture exist
  run(["scaffold", "--config", cfgPath, "--only", "StatCard"]);
  const fix = join(out, "ds-bundle", "components", "Cards", "StatCard", "fixture.mjs");
  writeFileSync(fix, `export const props = { label: "Revenue", value: "$9,000" };\n`);

  const r = run(["verify", "--config", cfgPath, "--only", "StatCard"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /StatCard/);
  assert.match(r.stdout, /\bok\b/);
  assert.match(r.stdout, /1 ok/);
});
