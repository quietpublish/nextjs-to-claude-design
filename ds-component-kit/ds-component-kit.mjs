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
function esbuild(args) {
  const local = join(cfg.repoRoot, "node_modules", ".bin", "esbuild");
  const bin = existsSync(local) ? local : "npx";
  const full = existsSync(local) ? args : ["--yes", `esbuild@${ESBUILD_VERSION}`, ...args];
  const r = spawnSync(bin, full, { encoding: "utf8" });
  if (r.status !== 0) die(`esbuild failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
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
  // temp entry: import every component, attach to window.<namespace>.<Name>
  const entry = join(cfg.outDir, ".dck-entry.jsx");
  const imports = comps
    .map((c, i) => `import C${i} from ${JSON.stringify(toAlias(cfg, c.path))};`)
    .join("\n");
  const attach = comps.map((c, i) => `__ds_ns[${JSON.stringify(c.name)}] = C${i};`).join("\n");
  writeFileSync(
    entry,
    `import React from "react";\n${imports}\n` +
      `const __ds_ns = (window.${cfg.namespace} = window.${cfg.namespace} || {});\n` +
      `(__ds_ns.__errors = __ds_ns.__errors || []);\n__ds_ns.React = React;\n${attach}\n`,
  );

  const aliasFlags = [
    `--alias:next/link=${join(cfg.shimsDir, "next-link.jsx")}`,
    `--alias:next/image=${join(cfg.shimsDir, "next-image.jsx")}`,
    `--alias:next/navigation=${join(cfg.shimsDir, "next-navigation.js")}`,
  ];
  esbuild([
    entry,
    "--bundle",
    "--format=iife",
    "--jsx=automatic",
    `--tsconfig=${tsconfig}`,
    ...aliasFlags,
    `--banner:js=${bundleHeader(cfg, comps)}`,
    `--outfile=${join(cfg.outDir, "_ds_bundle.js")}`,
  ]);
  rmSync(entry);
  rmSync(tsconfig);
  console.log(`✓ built _ds_bundle.js + _ds_bundle.css  (${comps.map((c) => c.name).join(", ")})`);
  console.log(`  → ${cfg.outDir}`);
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
    : `// No CSS module detected on the source — style with var(--*) tokens inline.\n`;

  writeMissing(join(dir, `${comp.name}.jsx`), jsxTemplate(cfg, comp, stylesDecl));
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

const jsxTemplate = (cfg, comp, stylesDecl) => `// ${comp.name} — scaffolded by ds-component-kit. SELF-CONTAINED SOURCE.
// TODO(human/AI): make this standalone for the design runtime —
//   1. inline any helpers imported from app libs (no @/lib imports),
//   2. replace next/link with <a>, next/image with <img>,
//   3. keep the class names below (they match _ds_bundle.css).
// Source of truth: ${comp.path}
import React from "react";

${stylesDecl}
export default function ${comp.name}(props) {
  // TODO: paste the component body from ${comp.path}, adapted per the notes above.
  return <div className={styles?.${firstKey(comp)} ?? ""}>${comp.name} — TODO</div>;
}
`;

const firstKey = () => "root";

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
  case "build":
    cfg = loadConfig(flags); build(cfg, pickComponents(cfg, flags, pos)); break;
  case "scaffold":
    cfg = loadConfig(flags);
    for (const c of pickComponents(cfg, flags, pos)) scaffold(cfg, c);
    break;
  case "serve":
    cfg = loadConfig(flags); serve(cfg, flags); break;
  default:
    console.log(`ds-component-kit — Next.js/React components → Claude Design system layout

Usage:
  ds-component-kit init                     write a config template
  ds-component-kit build   [--only A,B]     build _ds_bundle.js + .css (render-verify)
  ds-component-kit scaffold [--only A,B]    scaffold components/<Group>/<Name>/ artifacts
  ds-component-kit serve   [--port 8770]    static-serve the output dir for a render check

  ad-hoc (no config): ds-component-kit build src/app/X.tsx --name X --group Views

Flags: --config <path>  --only <Name,Name>  --name <Name>  --group <Group>
See README.md for the full workflow and the parts that need human authoring.`);
}
