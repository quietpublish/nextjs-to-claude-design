#!/usr/bin/env node
// ds-component-kit — turn React components from an *application* repo (Next.js,
// CRA, Vite…) into the component layout a Claude Design system consumes.
//
// It automates the deterministic parts of a /design-sync component sync:
//   • build    — esbuild a component (with Next.js shims + path aliases) into a
//                self-contained _ds_bundle.js + _ds_bundle.css you can render to
//                verify fidelity before uploading.
//   • scaffold — create components/<Group>/<Name>/{<Name>.jsx,.d.ts,.prompt.md,
//                <Name>.html} with the @dsCard marker and the CSS-module class
//                map auto-extracted. Prose + fixtures are marked TODO (human/AI).
//   • serve    — static-serve the output dir for a browser render check.
//
// What it does NOT do: invent fixtures, write the usage prose, or fully
// "self-contain" a component that imports app-only modules. Those need judgment;
// the scaffold leaves clearly-marked TODOs. See README.md.
//
// Zero install: esbuild is run from node_modules/.bin if present, else via npx.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve, join, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const ESBUILD_VERSION = "0.24.0";

// ---------- args + config ----------------------------------------------------
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
      flags[key] = val;
    } else pos.push(rest[i]);
  }
  return { cmd, pos, flags };
}

function loadConfig(flags) {
  const path = resolve(flags.config || join(HERE, "ds-component-kit.config.json"));
  if (!existsSync(path)) die(`config not found: ${path}\nRun: ds-component-kit init`);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.__dir = dirname(path);
  cfg.repoRoot = resolve(cfg.__dir, cfg.repoRoot || ".");
  cfg.outDir = resolve(cfg.__dir, cfg.outDir || "./ds-bundle");
  cfg.shimsDir = resolve(cfg.__dir, cfg.shimsDir || "./shims");
  return cfg;
}

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function pickComponents(cfg, flags, pos) {
  if (flags.name && pos[0]) return [{ path: pos[0], name: flags.name, group: flags.group || "Components" }];
  if (flags.only) {
    const want = String(flags.only).split(",").map((s) => s.trim());
    return cfg.components.filter((c) => want.includes(c.name));
  }
  return cfg.components;
}

// ---------- esbuild ----------------------------------------------------------
// Non-dying runner — returns { ok, stderr } so callers can recover (e.g. evict a
// failing component and retry) instead of aborting the whole build.
function runEsbuild(cfg, args) {
  const local = join(cfg.repoRoot, "node_modules", ".bin", "esbuild");
  const bin = existsSync(local) ? local : "npx";
  const full = existsSync(local) ? args : ["--yes", `esbuild@${ESBUILD_VERSION}`, ...args];
  const r = spawnSync(bin, full, { encoding: "utf8" });
  return { ok: r.status === 0, stderr: r.stderr || "", stdout: r.stdout || "" };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Which symbol to import for a component: an explicit config `export`, else
// `default` if present, else a named export matching the component name. null if
// none — the component is skipped with a clear reason (it may not be a component).
function exportSymbol(cfg, comp, src) {
  if (comp.export) return comp.export;
  if (/export\s+default/.test(src)) return "default";
  if (new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${escapeRe(comp.name)}\\b`).test(src))
    return comp.name;
  return null;
}

function listExports(src) {
  const names = new Set();
  if (/export\s+default/.test(src)) names.add("default");
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g))
    m[1].split(",").forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); });
  return [...names];
}

// first non-empty line of esbuild's error block that mentions this component
function errorFor(comp, stderr) {
  const base = basename(comp.path);
  const line = stderr.split("\n").find((l) => l.includes("ERROR") && (l.includes(base) || l.includes(comp.name)))
    || stderr.split("\n").find((l) => l.includes(base));
  return (line || "esbuild error").replace(/^.*?ERROR\]?\s*/, "").trim() || "esbuild error";
}

// A temp tsconfig so esbuild resolves the repo's path aliases (e.g. @/*).
function writeTsconfig(cfg) {
  const paths = {};
  for (const [k, v] of Object.entries(cfg.srcAlias || { "@/*": "src/*" })) paths[k] = [v];
  const tsconfig = join(cfg.outDir, ".dck-tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({ compilerOptions: { baseUrl: cfg.repoRoot, paths, jsx: "react-jsx" } }, null, 2),
  );
  return tsconfig;
}

function bundleHeader(cfg, comps) {
  return (
    `/* @ds-bundle: ` +
    JSON.stringify({
      format: 3,
      namespace: cfg.namespace,
      components: comps.map((c) => ({
        name: c.name,
        group: c.group,
        sourcePath: `components/${c.group}/${c.name}/${c.name}.jsx`,
      })),
      sourceHashes: {},
      inlinedExternals: ["react", "react/jsx-runtime"],
      unexposedExports: [],
    }) +
    ` */`
  );
}

function build(cfg, comps) {
  mkdirSync(cfg.outDir, { recursive: true });
  const tsconfig = writeTsconfig(cfg);
  const entry = join(cfg.outDir, ".dck-entry.jsx");
  const cleanup = () => [entry, tsconfig].forEach((f) => existsSync(f) && rmSync(f));
  const failed = [];

  // 1. resolve each component's export symbol up front; unresolvable → skipped
  let pending = [];
  for (const c of comps) {
    const abs = resolve(cfg.repoRoot, c.path);
    if (!existsSync(abs)) { failed.push({ name: c.name, reason: `file not found: ${c.path}` }); continue; }
    const src = readFileSync(abs, "utf8");
    const sym = exportSymbol(cfg, c, src);
    if (!sym) {
      failed.push({ name: c.name, reason: `no usable export (found: ${listExports(src).join(", ") || "none"}). Add "export":"<name>", or it isn't a component.` });
      continue;
    }
    pending.push({ ...c, sym });
  }

  const aliasFlags = [
    `--alias:next/link=${join(cfg.shimsDir, "next-link.jsx")}`,
    `--alias:next/image=${join(cfg.shimsDir, "next-image.jsx")}`,
    `--alias:next/navigation=${join(cfg.shimsDir, "next-navigation.js")}`,
  ];
  const writeEntry = (list) => {
    const imports = list
      .map((c, i) => c.sym === "default"
        ? `import C${i} from ${JSON.stringify(toAlias(cfg, c.path))};`
        : `import { ${c.sym} as C${i} } from ${JSON.stringify(toAlias(cfg, c.path))};`)
      .join("\n");
    const attach = list.map((c, i) => `__ds_ns[${JSON.stringify(c.name)}] = C${i};`).join("\n");
    writeFileSync(
      entry,
      `import React from "react";\n${imports}\n` +
        `const __ds_ns = (window.${cfg.namespace} = window.${cfg.namespace} || {});\n` +
        `(__ds_ns.__errors = __ds_ns.__errors || []);\n__ds_ns.React = React;\n${attach}\n`,
    );
  };

  // 2. build; on failure, evict the offending component(s) and retry
  while (pending.length) {
    writeEntry(pending);
    const r = runEsbuild(cfg, [
      entry, "--bundle", "--format=iife", "--jsx=automatic",
      `--tsconfig=${tsconfig}`, ...aliasFlags,
      `--banner:js=${bundleHeader(cfg, pending)}`,
      `--outfile=${join(cfg.outDir, "_ds_bundle.js")}`,
    ]);
    if (r.ok) break;
    const culprits = pending.filter((c) => r.stderr.includes(basename(c.path)) || r.stderr.includes(c.name));
    if (!culprits.length) { cleanup(); die(`esbuild error not attributable to a component:\n${r.stderr}`); }
    for (const c of culprits) failed.push({ name: c.name, reason: errorFor(c, r.stderr) });
    pending = pending.filter((c) => !culprits.includes(c));
  }
  cleanup();

  // 3. report
  if (pending.length) {
    console.log(`✓ built _ds_bundle.js + _ds_bundle.css  →  ${cfg.outDir}`);
    console.log(`  ${pending.length} component(s): ${pending.map((c) => c.name).join(", ")}`);
  } else {
    console.log(`✗ no components built.`);
  }
  if (failed.length) {
    console.log(`\n⚠ ${failed.length} skipped:`);
    for (const f of failed) console.log(`  · ${f.name} — ${f.reason}`);
  }
  if (!pending.length) process.exit(1);
}

// repo-relative path → alias path if it lives under an aliased root, else abs
function toAlias(cfg, p) {
  for (const [k, v] of Object.entries(cfg.srcAlias || { "@/*": "src/*" })) {
    const prefix = v.replace(/\*$/, "");
    if (p.startsWith(prefix)) return k.replace(/\*$/, "") + p.slice(prefix.length);
  }
  return resolve(cfg.repoRoot, p);
}

// ---------- scaffold ---------------------------------------------------------
// Extract `import styles from "./X.module.css"` and the colocated module's class
// names → a literal {name:"<Scoped>_name"} map for the self-contained .jsx.
function cssClassMap(cfg, comp) {
  const src = readFileSync(resolve(cfg.repoRoot, comp.path), "utf8");
  const m = src.match(/import\s+\w+\s+from\s+["'](\.\/[^"']+\.module\.css)["']/);
  if (!m) return null;
  const cssPath = resolve(cfg.repoRoot, dirname(comp.path), m[1]);
  if (!existsSync(cssPath)) return null;
  const css = readFileSync(cssPath, "utf8");
  const names = new Set();
  for (const mm of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) names.add(mm[1]);
  const map = {};
  for (const n of [...names].sort()) map[n] = `${comp.name}_${n}`;
  return map;
}

function scaffold(cfg, comp) {
  const dir = join(cfg.outDir, "components", comp.group, comp.name);
  mkdirSync(dir, { recursive: true });
  const map = cssClassMap(cfg, comp);
  const stylesDecl = map
    ? `const styles = ${JSON.stringify(map, null, 2)};\n`
    : `const styles = {}; // no CSS module on the source — style with var(--*) tokens inline.\n`;
  const firstClass = map ? Object.keys(map)[0] : null;

  writeMissing(join(dir, `${comp.name}.jsx`), jsxTemplate(cfg, comp, stylesDecl, firstClass));
  writeMissing(join(dir, `${comp.name}.d.ts`), dtsTemplate(comp));
  writeMissing(join(dir, `${comp.name}.prompt.md`), promptTemplate(comp));
  writeMissing(join(dir, `${comp.name}.html`), cardTemplate(comp));
  writeMissing(join(dir, `fixture.mjs`), fixtureTemplate(comp));
  console.log(`✓ scaffolded components/${comp.group}/${comp.name}/  (5 files; TODOs marked)`);
}

function writeMissing(path, content) {
  if (existsSync(path)) {
    console.log(`  · kept existing ${basename(path)}`);
    return;
  }
  writeFileSync(path, content);
}

const jsxTemplate = (cfg, comp, stylesDecl, firstClass) => `// ${comp.name} — scaffolded by ds-component-kit. SELF-CONTAINED SOURCE.
// TODO(human/AI): make this standalone for the design runtime —
//   1. inline any helpers imported from app libs (no @/lib imports),
//   2. replace next/link with <a>, next/image with <img>,
//   3. keep the class names below (they match _ds_bundle.css).
// Source of truth: ${comp.path}
import React from "react";

${stylesDecl}
export default function ${comp.name}(props) {
  // TODO: paste the component body from ${comp.path}, adapted per the notes above.
  return <div className={styles${firstClass ? `.${firstClass}` : '[""]'}}>${comp.name} — TODO</div>;
}
`;

const dtsTemplate = (comp) => `// Type contract for ${comp.name} — scaffolded by ds-component-kit.
// TODO(human/AI): fill in the real prop + data types (mirror the repo's lib types).
export interface ${comp.name}Props {
  // e.g. data: SomeType | null;
}
declare const ${comp.name}: (props: ${comp.name}Props) => JSX.Element;
export default ${comp.name};
`;

const promptTemplate = (comp) => `# ${comp.name}

TODO(human/AI): one-paragraph description of what this component is for.

## Usage
\`\`\`jsx
<${comp.name} /* props */ />
\`\`\`

## Composition & styling
- Place on your canvas background; uses your \`var(--*)\` design tokens.
- TODO: note the key props, states, and any data-* tone conventions.

## Don't
- TODO: list the misuse traps (empty-state honesty, width limits, etc.).
`;

const cardTemplate = (comp) => `<!DOCTYPE html>
<!-- @dsCard group="${comp.group}" name="${comp.name}" subtitle="TODO short subtitle" viewport="760x420" --><html><head><meta charset="utf-8">
<link rel="stylesheet" href="../../../styles.css">
<style>
  body { margin: 0; padding: 22px; background: var(--bg); color: var(--ink); }
  /* TODO(human/AI): author a static preview thumbnail using your design tokens. */
</style></head><body>
  <div style="font-family: var(--font-display); color: var(--ink-3)">${comp.name} — TODO preview</div>
</body></html>
`;

const fixtureTemplate = (comp) => `// Render fixture for ${comp.name} — used by the local render check, not uploaded.
// TODO(human/AI): author realistic props matching ${comp.name}.d.ts.
export const props = {};
`;

// ---------- serve (render check) --------------------------------------------
function serve(cfg, flags) {
  const port = Number(flags.port || 8770);
  const root = cfg.outDir;
  const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".mjs": "text/javascript", ".json": "application/json" };
  createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/render.html";
    const file = join(root, p);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404); res.end("not found"); return;
    }
    const ext = p.slice(p.lastIndexOf("."));
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(port, () => {
    console.log(`✓ serving ${root} at http://localhost:${port}`);
    console.log(`  open http://localhost:${port}/components/<Group>/<Name>/<Name>.html for a card,`);
    console.log(`  or build a render harness (see README) for the live component.`);
  });
}

// ---------- verify (headless render check) ----------------------------------
// Renders each component (real source + its fixture) in headless Chrome and
// flags blanks/errors — the automated half of "does it actually render?".
function findChrome(flags) {
  const cands = [
    flags.chrome, process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function verify(cfg, comps, flags) {
  const chrome = findChrome(flags);
  if (!chrome) die(`no Chrome/Chromium found. Set CHROME=<path> or pass --chrome <path>.`);
  mkdirSync(cfg.outDir, { recursive: true });
  const tsconfig = writeTsconfig(cfg);
  const entry = join(cfg.outDir, ".dck-verify.jsx");
  const html = join(cfg.outDir, ".dck-verify.html");
  const js = join(cfg.outDir, ".dck-verify.js");
  const keep = !!flags.keep;
  const cleanup = () => { if (!keep) [entry, tsconfig, html, js, js.replace(/\.js$/, ".css")].forEach((f) => existsSync(f) && rmSync(f)); };

  // components that have an authored (or stub) fixture + a resolvable export
  const runnable = [], skipped = [];
  for (const c of comps) {
    const abs = resolve(cfg.repoRoot, c.path);
    const fix = join(cfg.outDir, "components", c.group, c.name, "fixture.mjs");
    if (!existsSync(abs)) { skipped.push({ name: c.name, reason: "source not found" }); continue; }
    if (!existsSync(fix)) { skipped.push({ name: c.name, reason: "no fixture.mjs (run scaffold, then author it)" }); continue; }
    const sym = exportSymbol(cfg, c, readFileSync(abs, "utf8"));
    if (!sym) { skipped.push({ name: c.name, reason: "no usable export" }); continue; }
    runnable.push({ ...c, sym, fix });
  }
  if (!runnable.length) { cleanup(); console.log("✗ nothing to verify."); skipped.forEach((s) => console.log(`  · ${s.name} — ${s.reason}`)); process.exit(1); }

  const imp = runnable.map((c, i) =>
    (c.sym === "default" ? `import C${i} from ${JSON.stringify(toAlias(cfg, c.path))};`
      : `import { ${c.sym} as C${i} } from ${JSON.stringify(toAlias(cfg, c.path))};`) +
    `\nimport { props as P${i} } from ${JSON.stringify(c.fix)};`).join("\n");
  const items = runnable.map((c, i) => `{ name: ${JSON.stringify(c.name)}, C: C${i}, props: P${i} }`).join(", ");
  writeFileSync(entry,
    `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { flushSync } from "react-dom";\n${imp}\n` +
    `const items = [${items}];\nconst results = [];\n` +
    `for (const it of items) {\n` +
    `  const el = document.createElement("div"); document.body.appendChild(el);\n` +
    `  let error = null;\n` +
    `  const root = createRoot(el, { onUncaughtError: (e) => { error = String((e && e.message) || e); }, onCaughtError: (e) => { error = String((e && e.message) || e); } });\n` +
    `  try { flushSync(() => root.render(React.createElement(it.C, it.props))); }\n` +
    `  catch (e) { error = error || String((e && e.message) || e); }\n` +
    `  const text = (el.textContent || "").trim();\n` +
    `  results.push({ name: it.name, ok: !error && text.length > 0, len: text.length, error });\n` +
    `}\n` +
    `const pre = document.createElement("pre"); pre.id = "__results"; pre.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(results)))); document.body.appendChild(pre);\n`);
  writeFileSync(html, `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="./.dck-verify.css"></head><body><script src="./.dck-verify.js"></script></body></html>`);

  const aliasFlags = [
    `--alias:next/link=${join(cfg.shimsDir, "next-link.jsx")}`,
    `--alias:next/image=${join(cfg.shimsDir, "next-image.jsx")}`,
    `--alias:next/navigation=${join(cfg.shimsDir, "next-navigation.js")}`,
  ];
  const b = runEsbuild(cfg, [entry, "--bundle", "--format=iife", "--jsx=automatic", `--tsconfig=${tsconfig}`, ...aliasFlags, `--outfile=${js}`]);
  if (!b.ok) { cleanup(); die(`verify bundle failed:\n${b.stderr}`); }

  const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--virtual-time-budget=6000", "--dump-dom", `file://${html}`], { encoding: "utf8", maxBuffer: 1 << 27 });
  cleanup();
  const m = (r.stdout || "").match(/<pre id="__results">([^<]*)<\/pre>/);
  if (!m) die(`could not read render results from headless Chrome.\n${(r.stderr || "").split("\n").slice(0, 5).join("\n")}`);
  let results;
  try { results = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); }
  catch { die(`could not parse render results.`); }

  let okN = 0, blankN = 0, errN = 0;
  console.log(`render check (headless):`);
  for (const res of results) {
    if (res.error) { errN++; console.log(`  ✗ ${res.name} — ERROR: ${res.error}`); }
    else if (!res.ok) { blankN++; console.log(`  ⚠ ${res.name} — BLANK (rendered no text; check the fixture)`); }
    else { okN++; console.log(`  ✓ ${res.name} — ok (${res.len} chars)`); }
  }
  if (skipped.length) { console.log(`  skipped:`); skipped.forEach((s) => console.log(`    · ${s.name} — ${s.reason}`)); }
  console.log(`\n${okN} ok · ${blankN} blank · ${errN} error · ${skipped.length} skipped`);
  if (errN > 0) process.exit(1);
}

// ---------- init -------------------------------------------------------------
function init(flags) {
  const path = resolve(flags.config || join(process.cwd(), "ds-component-kit.config.json"));
  if (existsSync(path)) die(`already exists: ${path}`);
  writeFileSync(path, JSON.stringify({
    repoRoot: "..",
    srcAlias: { "@/*": "src/*" },
    namespace: "YourDesignSystem_xxxxxx",
    outDir: "../ds-bundle",
    shimsDir: "./shims",
    components: [
      { path: "src/app/SomeView.tsx", name: "SomeView", group: "Views" },
    ],
  }, null, 2));
  console.log(`✓ wrote ${path} — edit it, then: ds-component-kit build && ds-component-kit scaffold`);
}

// ---------- main -------------------------------------------------------------
const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
let cfg;
switch (cmd) {
  case "init":
    init(flags); break;
  case "build": {
    cfg = loadConfig(flags);
    const sel = pickComponents(cfg, flags, pos);
    if (!sel.length) die(`no components selected${flags.only ? ` matching --only ${flags.only}` : ""}. Check ds-component-kit.config.json.`);
    build(cfg, sel);
    break;
  }
  case "scaffold": {
    cfg = loadConfig(flags);
    const sel = pickComponents(cfg, flags, pos);
    if (!sel.length) die(`no components selected${flags.only ? ` matching --only ${flags.only}` : ""}. Check ds-component-kit.config.json.`);
    for (const c of sel) scaffold(cfg, c);
    break;
  }
  case "verify": {
    cfg = loadConfig(flags);
    const sel = pickComponents(cfg, flags, pos);
    if (!sel.length) die(`no components selected${flags.only ? ` matching --only ${flags.only}` : ""}. Check ds-component-kit.config.json.`);
    verify(cfg, sel, flags);
    break;
  }
  case "serve":
    cfg = loadConfig(flags); serve(cfg, flags); break;
  default:
    console.log(`ds-component-kit — Next.js/React components → Claude Design system layout

Usage:
  ds-component-kit init                     write a config template
  ds-component-kit build   [--only A,B]     build _ds_bundle.js + .css (render-verify)
  ds-component-kit scaffold [--only A,B]    scaffold components/<Group>/<Name>/ artifacts
  ds-component-kit verify  [--only A,B]     headless-render each component + fixture; flag blanks/errors
  ds-component-kit serve   [--port 8770]    static-serve the output dir for a render check

  ad-hoc (no config): ds-component-kit build src/app/X.tsx --name X --group Views

Flags: --config <path>  --only <Name,Name>  --name <Name>  --group <Group>
       --chrome <path>  (verify; or set CHROME=)   --keep (keep verify temp files)
See README.md for the full workflow and the parts that need human authoring.`);
}
