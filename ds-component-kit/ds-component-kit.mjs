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
//   • verify   — headless-render each component + fixture; report ok/blank/error.
//   • serve    — static-serve the output dir for a browser render check.
//
// What it does NOT do: invent fixtures, write the usage prose, or fully
// "self-contain" a component that imports app-only modules. Those need judgment;
// the scaffold leaves clearly-marked TODOs. See README.md.
//
// Zero install: esbuild is run from node_modules/.bin if present, else via npx.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, join, basename, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const ESBUILD_VERSION = "0.24.0";

// ---------- ui ---------------------------------------------------------------
const TTY = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const sgr = (n) => (s) => (TTY ? `\x1b[${n}m${s}\x1b[0m` : `${s}`);
const bold = sgr(1), dim = sgr(2), red = sgr(31), green = sgr(32), yellow = sgr(33),
  blue = sgr(34), magenta = sgr(35), cyan = sgr(36), gray = sgr(90);
const G = { ok: green("✓"), warn: yellow("⚠"), err: red("✗"), dot: gray("·"), arrow: cyan("→") };

const fmtBytes = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
const sep = ` ${dim("·")} `;

function head(cmd, subtitle) {
  console.log(`\n  ${magenta("◆")} ${bold("ds-component-kit")} ${dim("›")} ${bold(cmd)}${subtitle ? dim("  " + subtitle) : ""}`);
}

let cursorHidden = false;
const showCursor = () => { if (cursorHidden && TTY) { process.stdout.write("\x1b[?25h"); cursorHidden = false; } };
process.on("exit", showCursor);
process.on("SIGINT", () => { showCursor(); process.exit(130); });

function spinner(text) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const state = { text };
  if (!TTY) { console.log(`  ${dim(text)}`); return { set(t) { state.text = t; }, stop() {} }; }
  let i = 0;
  cursorHidden = true;
  process.stdout.write("\x1b[?25l");
  const id = setInterval(() => {
    process.stdout.write(`\r\x1b[2K  ${magenta(frames[i = (i + 1) % frames.length])} ${state.text}`);
  }, 80);
  return {
    set(t) { state.text = t; },
    stop(line) { clearInterval(id); process.stdout.write("\r\x1b[2K"); showCursor(); if (line) console.log(line); },
  };
}

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
  if (!existsSync(path)) die(`config not found: ${dim(path)}\n  run ${cyan("ds-component-kit init")} to create one.`);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  cfg.__dir = dirname(path);
  cfg.repoRoot = resolve(cfg.__dir, cfg.repoRoot || ".");
  cfg.outDir = resolve(cfg.__dir, cfg.outDir || "./ds-bundle");
  cfg.shimsDir = resolve(cfg.__dir, cfg.shimsDir || "./shims");
  return cfg;
}

function die(msg) {
  showCursor();
  console.error(`\n  ${G.err} ${msg}\n`);
  process.exit(1);
}

const rel = (p) => { const r = relative(process.cwd(), p); return r.startsWith("..") ? p : r || "."; };

function pickComponents(cfg, flags, pos) {
  if (flags.name && pos[0]) return [{ path: pos[0], name: flags.name, group: flags.group || "Components" }];
  if (flags.only) {
    const want = String(flags.only).split(",").map((s) => s.trim());
    return cfg.components.filter((c) => want.includes(c.name));
  }
  return cfg.components;
}

// ---------- esbuild ----------------------------------------------------------
// async runner — streams output, returns { ok, stderr, stdout }.
function sh(bin, args) {
  return new Promise((res) => {
    const p = spawn(bin, args, { encoding: "utf8" });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => res({ ok: false, stdout: out, stderr: String(e) }));
    p.on("close", (code) => res({ ok: code === 0, stdout: out, stderr: err }));
  });
}

function runEsbuild(cfg, args) {
  const local = join(cfg.repoRoot, "node_modules", ".bin", "esbuild");
  const useLocal = existsSync(local);
  return sh(useLocal ? local : "npx", useLocal ? args : ["--yes", `esbuild@${ESBUILD_VERSION}`, ...args]);
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
function writeTsconfig(cfg, dir) {
  const paths = {};
  for (const [k, v] of Object.entries(cfg.srcAlias || { "@/*": "src/*" })) paths[k] = [v];
  const tsconfig = join(dir, ".dck-tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({ compilerOptions: { baseUrl: cfg.repoRoot, paths, jsx: "react-jsx" } }, null, 2),
  );
  return tsconfig;
}

// Transient build scratch under repoRoot, so esbuild resolves bare imports
// (react, react-dom) from repoRoot/node_modules regardless of where outDir is.
const tmpDir = (cfg) => { const d = join(cfg.repoRoot, ".dck-tmp"); mkdirSync(d, { recursive: true }); return d; };

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

const aliasFlags = (cfg) => [
  `--alias:next/link=${join(cfg.shimsDir, "next-link.jsx")}`,
  `--alias:next/image=${join(cfg.shimsDir, "next-image.jsx")}`,
  `--alias:next/navigation=${join(cfg.shimsDir, "next-navigation.js")}`,
];

async function build(cfg, comps) {
  head("build", `${comps.length} selected`);
  mkdirSync(cfg.outDir, { recursive: true });
  const tmp = tmpDir(cfg);
  const tsconfig = writeTsconfig(cfg, tmp);
  const entry = join(tmp, ".dck-entry.jsx");
  const cleanup = () => existsSync(tmp) && rmSync(tmp, { recursive: true, force: true });
  const failed = [];

  // 1. resolve each component's export symbol up front; unresolvable → skipped
  let pending = [];
  for (const c of comps) {
    const abs = resolve(cfg.repoRoot, c.path);
    if (!existsSync(abs)) { failed.push({ name: c.name, reason: `file not found: ${c.path}` }); continue; }
    const src = readFileSync(abs, "utf8");
    const sym = exportSymbol(cfg, c, src);
    if (!sym) {
      failed.push({ name: c.name, reason: `no usable export (found: ${listExports(src).join(", ") || "none"}); set "export", or it isn't a component.` });
      continue;
    }
    pending.push({ ...c, sym });
  }

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
  const t0 = Date.now();
  const sp = spinner(`bundling ${pending.length} component${pending.length === 1 ? "" : "s"}…`);
  while (pending.length) {
    writeEntry(pending);
    const r = await runEsbuild(cfg, [
      entry, "--bundle", "--format=iife", "--jsx=automatic",
      `--tsconfig=${tsconfig}`, ...aliasFlags(cfg),
      `--banner:js=${bundleHeader(cfg, pending)}`,
      `--outfile=${join(cfg.outDir, "_ds_bundle.js")}`,
    ]);
    if (r.ok) break;
    const culprits = pending.filter((c) => r.stderr.includes(basename(c.path)) || r.stderr.includes(c.name));
    if (!culprits.length) { sp.stop(); cleanup(); die(`esbuild error not attributable to a component:\n${dim(r.stderr.trim())}`); }
    for (const c of culprits) failed.push({ name: c.name, reason: errorFor(c, r.stderr) });
    pending = pending.filter((c) => !culprits.includes(c));
    sp.set(`bundling ${pending.length} component${pending.length === 1 ? "" : "s"}… ${dim(`(evicted ${culprits.map((c) => c.name).join(", ")})`)}`);
  }
  sp.stop();
  cleanup();

  // 3. report
  if (pending.length) {
    const jsP = join(cfg.outDir, "_ds_bundle.js"), cssP = join(cfg.outDir, "_ds_bundle.css");
    const size = (existsSync(jsP) ? statSync(jsP).size : 0) + (existsSync(cssP) ? statSync(cssP).size : 0);
    console.log(`  ${G.ok} ${bold("built")}${sep}${pending.length} component${pending.length === 1 ? "" : "s"}${sep}${fmtBytes(size)}${sep}${fmtMs(Date.now() - t0)}`);
    const byGroup = {};
    for (const c of pending) (byGroup[c.group] ||= []).push(c.name);
    for (const [g, ns] of Object.entries(byGroup)) console.log(`    ${dim(pad(g, 10))} ${dim(ns.join(", "))}`);
    console.log(`  ${G.arrow} ${cyan(rel(jsP))} ${dim("+ _ds_bundle.css")}`);
  } else {
    console.log(`  ${G.err} ${bold("no components built.")}`);
  }
  if (failed.length) {
    console.log(`\n  ${yellow(`${failed.length} skipped`)}`);
    const w = Math.max(...failed.map((f) => f.name.length));
    for (const f of failed) console.log(`    ${G.warn} ${pad(f.name, w)}  ${dim(f.reason)}`);
  }
  console.log("");
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

function scaffold(cfg, comp, width) {
  const dir = join(cfg.outDir, "components", comp.group, comp.name);
  if (!existsSync(resolve(cfg.repoRoot, comp.path))) {
    console.log(`    ${G.warn} ${pad(`${comp.group}/${comp.name}`, width)}  ${dim("source not found — skipped")}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  const map = cssClassMap(cfg, comp);
  const stylesDecl = map
    ? `const styles = ${JSON.stringify(map, null, 2)};\n`
    : `const styles = {}; // no CSS module on the source — style with var(--*) tokens inline.\n`;
  const firstClass = map ? Object.keys(map)[0] : null;

  let created = 0, kept = 0;
  const w = (p, content) => (writeMissing(join(dir, p), content) ? created++ : kept++);
  w(`${comp.name}.jsx`, jsxTemplate(cfg, comp, stylesDecl, firstClass));
  w(`${comp.name}.d.ts`, dtsTemplate(comp));
  w(`${comp.name}.prompt.md`, promptTemplate(comp));
  w(`${comp.name}.html`, cardTemplate(comp));
  w(`fixture.mjs`, fixtureTemplate(comp));
  const detail = kept === 0 ? green(`${created} new`) : created === 0 ? dim("all kept") : `${green(`${created} new`)}${dim(", " + kept + " kept")}`;
  console.log(`    ${created ? G.ok : G.dot} ${pad(`${comp.group}/${comp.name}`, width)}  ${detail}`);
}

function writeMissing(path, content) {
  if (existsSync(path)) return false;
  writeFileSync(path, content);
  return true;
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
  head("serve");
  const port = Number(flags.port || 8770);
  const root = cfg.outDir;
  const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".mjs": "text/javascript", ".json": "application/json" };
  createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/render.html";
    const file = join(root, p);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    const ext = p.slice(p.lastIndexOf("."));
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(port, () => {
    console.log(`  ${G.ok} serving ${dim(rel(root))} at ${cyan(`http://localhost:${port}`)}`);
    console.log(`  ${G.dot} a card: ${dim(`http://localhost:${port}/components/<Group>/<Name>/<Name>.html`)}`);
    console.log(`  ${G.dot} live component: copy ${dim("templates/render-harness.html")} → ${dim("render.html")} (see README)`);
    console.log(dim(`  ctrl-c to stop\n`));
  });
}

// ---------- verify (headless render check) ----------------------------------
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

async function verify(cfg, comps, flags) {
  head("verify", `${comps.length} selected`);
  const chrome = findChrome(flags);
  if (!chrome) die(`no Chrome/Chromium found. Set ${cyan("CHROME=<path>")} or pass ${cyan("--chrome <path>")}.`);
  mkdirSync(cfg.outDir, { recursive: true });
  const tmp = tmpDir(cfg);
  const tsconfig = writeTsconfig(cfg, tmp);
  const entry = join(tmp, ".dck-verify.jsx");      // under repoRoot → react resolves
  const html = join(cfg.outDir, ".dck-verify.html"); // next to styles.css for the render
  const js = join(cfg.outDir, ".dck-verify.js");
  const keep = !!flags.keep;
  const cleanup = () => { if (!keep) { existsSync(tmp) && rmSync(tmp, { recursive: true, force: true }); [html, js, js.replace(/\.js$/, ".css")].forEach((f) => existsSync(f) && rmSync(f)); } };

  const runnable = [], skipped = [];
  for (const c of comps) {
    const abs = resolve(cfg.repoRoot, c.path);
    const fix = join(cfg.outDir, "components", c.group, c.name, "fixture.mjs");
    if (!existsSync(abs)) { skipped.push({ name: c.name, reason: "source not found" }); continue; }
    if (!existsSync(fix)) { skipped.push({ name: c.name, reason: "no fixture.mjs — run scaffold first" }); continue; }
    const sym = exportSymbol(cfg, c, readFileSync(abs, "utf8"));
    if (!sym) { skipped.push({ name: c.name, reason: "no usable export" }); continue; }
    runnable.push({ ...c, sym, fix });
  }
  if (!runnable.length) {
    cleanup();
    console.log(`  ${G.err} ${bold("nothing to verify.")}`);
    for (const s of skipped) console.log(`    ${G.dot} ${s.name} ${dim("— " + s.reason)}`);
    console.log("");
    process.exit(1);
  }

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

  const sp = spinner(`rendering ${runnable.length} component${runnable.length === 1 ? "" : "s"} in headless Chrome…`);
  const t0 = Date.now();
  const b = await runEsbuild(cfg, [entry, "--bundle", "--format=iife", "--jsx=automatic", `--tsconfig=${tsconfig}`, ...aliasFlags(cfg), `--outfile=${js}`]);
  if (!b.ok) { sp.stop(); cleanup(); die(`verify bundle failed:\n${dim(b.stderr.trim())}`); }
  const r = await sh(chrome, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--virtual-time-budget=6000", "--dump-dom", `file://${html}`]);
  sp.stop();
  cleanup();

  const m = (r.stdout || "").match(/<pre id="__results">([^<]*)<\/pre>/);
  if (!m) die(`could not read render results from headless Chrome.\n${dim((r.stderr || "").split("\n").slice(0, 5).join("\n"))}`);
  let results;
  try { results = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); }
  catch { die(`could not parse render results.`); }

  const w = Math.max(...results.map((x) => x.name.length), ...skipped.map((x) => x.name.length), 0);
  let okN = 0, blankN = 0, errN = 0;
  for (const res of results) {
    if (res.error) { errN++; console.log(`    ${G.err} ${pad(res.name, w)}  ${red("error")}  ${dim(res.error)}`); }
    else if (!res.ok) { blankN++; console.log(`    ${G.warn} ${pad(res.name, w)}  ${yellow("blank")}  ${dim("rendered no text — check the fixture")}`); }
    else { okN++; console.log(`    ${G.ok} ${pad(res.name, w)}  ${green("ok")}     ${dim(res.len + " chars")}`); }
  }
  for (const s of skipped) console.log(`    ${G.dot} ${pad(s.name, w)}  ${gray("skip")}   ${dim(s.reason)}`);

  const parts = [okN ? green(`${okN} ok`) : dim("0 ok")];
  parts.push(blankN ? yellow(`${blankN} blank`) : dim("0 blank"));
  parts.push(errN ? red(`${errN} error`) : dim("0 error"));
  if (skipped.length) parts.push(gray(`${skipped.length} skipped`));
  console.log(`\n  ${parts.join(sep)}${sep}${dim(fmtMs(Date.now() - t0))}\n`);
  if (errN > 0) process.exit(1);
}

// ---------- init -------------------------------------------------------------
function init(flags) {
  head("init");
  const path = resolve(flags.config || join(process.cwd(), "ds-component-kit.config.json"));
  if (existsSync(path)) die(`already exists: ${dim(rel(path))}`);
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
  console.log(`  ${G.ok} wrote ${cyan(rel(path))}`);
  console.log(`  ${G.dot} edit it, then ${cyan("ds-component-kit build")} ${dim("&&")} ${cyan("ds-component-kit scaffold")}\n`);
}

function help() {
  const cmd = (n, d) => `  ${cyan(pad(n, 22))} ${dim(d)}`;
  console.log(`
  ${magenta("◆")} ${bold("ds-component-kit")}  ${dim("— React app components → Claude Design system layout")}

  ${bold("Usage")}  ${dim("ds-component-kit <command> [flags]")}

${cmd("init", "write a config template")}
${cmd("build [--only A,B]", "bundle components → _ds_bundle.js + .css")}
${cmd("scaffold [--only A,B]", "scaffold components/<Group>/<Name>/ artifacts")}
${cmd("verify [--only A,B]", "headless-render each component + fixture (ok/blank/error)")}
${cmd("serve [--port 8770]", "static-serve the output dir for a render check")}

  ${bold("Flags")}
    ${cyan("--config")} ${dim("<path>")}   ${dim("config file (default: ./ds-component-kit.config.json)")}
    ${cyan("--only")} ${dim("<A,B>")}      ${dim("limit to named components")}
    ${cyan("--name")} ${dim("<N>")} ${cyan("--group")} ${dim("<G>")}  ${dim("ad-hoc, no config (with a path arg)")}
    ${cyan("--chrome")} ${dim("<path>")}   ${dim("verify: Chrome binary (or set CHROME=)")}
    ${cyan("--keep")}            ${dim("verify: keep temp render files")}
    ${dim("NO_COLOR=1")}        ${dim("disable colored output")}

  ${bold("Example")}  ${dim("ds-component-kit build src/app/X.tsx --name X --group Views")}

  ${dim("See README.md for the full workflow and the parts that need human authoring.")}
`);
}

// ---------- main -------------------------------------------------------------
// Exported for tests; main() only runs when invoked directly as a CLI.
export { parseArgs, exportSymbol, listExports, toAlias, bundleHeader, cssClassMap, fmtBytes, fmtMs };

async function main() {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const select = (cfg) => {
    const sel = pickComponents(cfg, flags, pos);
    if (!sel.length) die(`no components selected${flags.only ? ` matching ${cyan("--only " + flags.only)}` : ""}. Check your config.`);
    return sel;
  };
  switch (cmd) {
    case "init": init(flags); break;
    case "build": { const cfg = loadConfig(flags); await build(cfg, select(cfg)); break; }
    case "scaffold": {
      const cfg = loadConfig(flags); const sel = select(cfg);
      head("scaffold", `${sel.length} selected`);
      const width = Math.max(...sel.map((c) => `${c.group}/${c.name}`.length));
      for (const c of sel) scaffold(cfg, c, width);
      console.log(dim(`\n  edit each TODO(human/AI), then ${cyan("ds-component-kit verify")}\n`));
      break;
    }
    case "verify": { const cfg = loadConfig(flags); await verify(cfg, select(cfg), flags); break; }
    case "serve": { const cfg = loadConfig(flags); serve(cfg, flags); break; }
    case "help": case "--help": case "-h": case undefined: help(); break;
    default: die(`unknown command ${cyan(cmd)}. Run ${cyan("ds-component-kit help")}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
