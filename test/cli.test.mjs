import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

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

test("build: a compound component exposes its parts on the namespace (not just the root)", () => {
  const cp = join(out, "compound.config.json");
  writeFileSync(cp, JSON.stringify({
    repoRoot: REPO, srcAlias: { "@/*": "src/*" }, namespace: "DS_compound",
    outDir: join(out, "compound"), shimsDir: SHIMS,
    components: [{ path: "test/fixtures/Panel.tsx", name: "Panel", group: "Layout" }],
  }));
  const r = run(["build", "--config", cp, "--js-only"]);
  assert.equal(r.status, 0, r.stderr);

  const code = readFileSync(join(out, "compound", "_ds_bundle.js"), "utf8");
  // header: only Panel is a registered card; the parts are recorded as exposed-but-not-carded
  const json = JSON.parse(code.split("\n")[0].replace(/^\/\* @ds-bundle: /, "").replace(/ \*\/$/, ""));
  assert.deepEqual(json.components.map((c) => c.name), ["Panel"]);
  assert.deepEqual(json.unexposedExports, ["PanelBody", "PanelHeader"]); // camelCase panelClass excluded

  // runtime: evaluating the IIFE attaches the root AND its parts to window.<ns>.
  // The bundle resolves React from window.React (runtime-provided) — model that
  // with a permissive stub so the shim's eager reads succeed.
  const React = new Proxy({}, { get: () => () => null });
  const sandbox = { window: { React, ReactDOM: React }, console };
  vm.runInNewContext(code, sandbox);
  const ns = sandbox.window.DS_compound;
  assert.equal(typeof ns.Panel, "function", "root attached");
  assert.equal(typeof ns.PanelHeader, "function", "compound part attached");
  assert.equal(typeof ns.PanelBody, "function", "compound part attached");
  assert.equal(ns.panelClass, undefined, "camelCase helper is not exposed as a component");
});

test("build: React is resolved from the runtime global, not inlined", () => {
  const cp = join(out, "react-ext.config.json");
  writeFileSync(cp, JSON.stringify({
    repoRoot: REPO, srcAlias: { "@/*": "src/*" }, namespace: "DS_reactext",
    outDir: join(out, "react-ext"), shimsDir: SHIMS,
    components: [{ path: "test/fixtures/Panel.tsx", name: "Panel", group: "Layout" }],
  }));
  const r = run(["build", "--config", cp, "--js-only"]);
  assert.equal(r.status, 0, r.stderr);

  const code = readFileSync(join(out, "react-ext", "_ds_bundle.js"), "utf8");
  const json = JSON.parse(code.split("\n")[0].replace(/^\/\* @ds-bundle: /, "").replace(/ \*\/$/, ""));
  assert.deepEqual(json.inlinedExternals, [], "header declares nothing inlined");
  assert.equal(json.runtimeGlobals.react, "React");
  // the bundle reads React from the global rather than carrying its own copy
  assert.match(code, /window\.React/);
  // a second React would drag in its internals dispatcher; externalized, it won't
  assert.doesNotMatch(code, /ReactCurrentDispatcher/);
});

test("verify: isolates a component that fails to compile (others still verify)", { skip: !hasChrome() && "no Chrome available" }, () => {
  const vp = join(out, "verify-iso.config.json");
  const vout = join(out, "verify-iso");
  writeFileSync(vp, JSON.stringify({
    repoRoot: REPO, srcAlias: { "@/*": "src/*" }, namespace: "DS_iso",
    outDir: vout, shimsDir: SHIMS,
    components: [
      { path: "test/fixtures/StatCard.tsx", name: "StatCard", group: "Cards" },
      { path: "test/fixtures/Broken.tsx", name: "Broken", group: "Misc" }, // imports a missing module
    ],
  }));
  for (const [g, n] of [["Cards", "StatCard"], ["Misc", "Broken"]]) {
    const d = join(vout, "components", g, n);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "fixture.mjs"), `export const props = { label: "Revenue", value: "$9,000" };\n`);
  }

  const r = run(["verify", "--config", vp]);
  // Broken won't bundle → evicted + reported error → exit 1; StatCard still renders ok.
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /StatCard/);
  assert.match(r.stdout, /1 ok/);
  assert.match(r.stdout, /Broken/);
  assert.match(r.stdout, /\berror\b/);
});
