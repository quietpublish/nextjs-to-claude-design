import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CLI = join(REPO, "ds-component-kit", "ds-component-kit.mjs");
const SHIMS = join(REPO, "ds-component-kit", "shims");
const run = (args) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

let out, cfgPath;
before(() => {
  out = mkdtempSync(join(REPO, ".dck-tw-")); // in-repo so esbuild resolves react
  // a Tailwind input + config the kit will compile against the generated .jsx
  writeFileSync(join(out, "globals.css"), "@tailwind base;\n@tailwind utilities;\n@layer base { :root { --brand: 270 90% 60%; } }\n");
  writeFileSync(join(out, "tailwind.config.js"),
    "module.exports = { content: [], theme: { extend: { colors: { brand: 'hsl(var(--brand))' } } } };\n");
  cfgPath = join(out, "cfg.json");
  writeFileSync(cfgPath, JSON.stringify({
    repoRoot: REPO, srcAlias: { "@/*": "src/*" }, namespace: "DS_tw", outDir: out, shimsDir: SHIMS,
    tailwind: { input: join(out, "globals.css"), config: join(out, "tailwind.config.js") },
    components: [{ name: "Brand", group: "UI", path: join(out, "components", "UI", "Brand", "Brand.jsx"), appPath: "test/fixtures/Brand.tsx" }],
  }));
});
after(() => { if (out) rmSync(out, { recursive: true, force: true }); });

test("build --tailwind compiles used utilities + vars into _ds_bundle.css", () => {
  assert.equal(run(["generate", "--config", cfgPath]).status, 0);
  const r = run(["build", "--tailwind", "--css-only", "--config", cfgPath]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const css = readFileSync(join(out, "_ds_bundle.css"), "utf8");
  assert.match(css, /\.bg-brand/, "the bg-brand utility used by the component is emitted");
  assert.match(css, /hsl\(var\(--brand\)\)/, "it maps to the themed CSS var");
  assert.match(css, /--brand:\s*270 90% 60%/, "the :root var passes through");
  // a utility the component does NOT use should be tree-shaken out
  assert.doesNotMatch(css, /\.bg-red-500\b/, "unused utilities are not emitted");
});

test("build --tailwind errors clearly without a tailwind config block", () => {
  const bad = join(out, "bad.json");
  writeFileSync(bad, JSON.stringify({
    repoRoot: REPO, namespace: "x", outDir: out, shimsDir: SHIMS, // no `tailwind` block
    components: [{ name: "Brand", group: "UI", path: join(out, "components", "UI", "Brand", "Brand.jsx"), appPath: "test/fixtures/Brand.tsx" }],
  }));
  const r = run(["build", "--tailwind", "--css-only", "--config", bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tailwind/i);
});
