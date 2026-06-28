# ds-component-kit

Turn React components from an **application** repo (Next.js, Vite, CRA…) into the
component layout a [Claude Design](https://claude.ai/design) design system
consumes — so the design agent builds new screens out of your *real* components.

This exists because `/design-sync`'s converter targets a **component library**
(a package with a `dist/`, or a Storybook). An app has no such artifact: its
components are route-coupled, server-rendered, and styled with CSS Modules. This
kit bridges that gap for the parts that are deterministic, and clearly marks the
parts that need a human (or an AI pair) to finish.

> See the [write-up](../POST.md) for the story and the
> [tutorial](../TUTORIAL.md) for an end-to-end walkthrough.

## Requirements
- Node ≥ 18. `esbuild` is used from your repo's `node_modules/.bin` if present,
  otherwise fetched via `npx` on first run (no install needed).
- A Claude Design **design-system** project to upload into (create one with the
  `/design-sync` skill, or in the app).

## Quick start
```bash
cd ds-component-kit
node ds-component-kit.mjs init          # writes ds-component-kit.config.json
$EDITOR ds-component-kit.config.json    # set repoRoot, namespace, components[]
node ds-component-kit.mjs build         # → _ds_bundle.js + _ds_bundle.css (render-verify)
node ds-component-kit.mjs scaffold      # → components/<Group>/<Name>/{jsx,d.ts,prompt.md,html,fixture}
```
Then finish the TODOs (below) and upload `outDir` into your design system with
`/design-sync`. A worked `ds-component-kit.config.example.json` is included.

## Config
```jsonc
{
  "repoRoot": "..",                     // repo root, relative to this config
  "srcAlias": { "@/*": "src/*" },       // your tsconfig path aliases
  "namespace": "YourDS_abc123",         // window.<namespace> the bundle attaches to
  "outDir": "../ds-bundle",             // where artifacts are written
  "shimsDir": "./shims",                // next/* runtime shims (provided)
  "components": [
    { "path": "src/components/StatCard.tsx", "name": "StatCard", "group": "Cards" }
  ]
}
```
The `namespace` matches the one your design-system project already uses — copy it
from your project after a first sync.

## Commands
| Command | What it does | Automated? |
|---|---|---|
| `init` | write a config template | ✅ |
| `generate [--only A,B]` | produce each component `.jsx` from its real app source (`appPath`) — inline app-lib, shim `next/*`, CSS-module → scoped class map, npm deps bare. The `.jsx` is a build artifact, **not a fork** | ✅ fully |
| `drift [--only A,B]` | flag components whose app source changed since the last `generate` (**fresh / drifted / unsealed / manual / orphan**; exit 1 on drift) | ✅ |
| `build [--only A,B]` | esbuild → `_ds_bundle.js` + `_ds_bundle.css` (`--js-only` / `--css-only` to publish one without clobbering the other) | ✅ fully |
| `scaffold [--only A,B]` | stub `components/<Group>/<Name>/` metadata (`.d.ts`/`.prompt.md`/`.html`/`fixture.mjs`) with the CSS-module class map pre-extracted | ⚠️ stubs + TODOs |
| `verify [--only A,B]` | headless-render each component with its `fixture.mjs`; **ok / blank / error** (exit 1 on any error) | ✅ |
| `serve [--port]` | static-serve `outDir` for a browser render check | ✅ |

Ad-hoc, no config: `node ds-component-kit.mjs build src/components/X.tsx --name X --group Cards`.

### Generate, don't fork
Set both `path` (where the generated `.jsx` lives) and `appPath` (the real source)
on each component, then `generate` keeps the `.jsx` a deterministic artifact of the
app — change the app, re-`generate`, no drift. **Omit `appPath`** for a component you
must hand-author (e.g. one still wired to its own data fetching); `generate` skips
it and `drift` marks it `manual`. `generate` fingerprints sources into
`.dck-sync.json` (commit it) so `drift` — and CI — can catch a forgotten re-sync.

### Export style & resilience
- **Default vs named exports** are auto-detected: `export default`, else a named
  export matching the component `name`. For anything else (a differently-named
  export, or a re-export), set `"export": "<name>"` on the component's config entry.
- **`build` is resilient.** Components that can't resolve an export, or that fail
  to compile (e.g. they pull in an unshimmed dependency), are **skipped with a
  one-line reason** — the rest still build into the bundle. A component that turns
  out to be a hook or provider rather than a renderable view surfaces here:
  ```
  1 skipped
    ⚠ Dialog  no usable export (found: useDialogs, DialogProvider); set "export", or it isn't a component.
  ```

### Verifying renders
`verify` renders each component (real source + its `fixture.mjs`) in **headless
Chrome** and classifies the result:
- **ok** — rendered visible text
- **blank** — mounted but produced nothing (usually an empty/insufficient fixture)
- **error** — threw during render (the message is shown; exit code is 1)

It auto-finds Chrome/Chromium/Edge; override with `--chrome <path>` or `CHROME=`.
Components without a `fixture.mjs` are skipped (run `scaffold`, then author the
fixture). Because it exits non-zero on any error, it's CI-friendly.

```
  ◆ ds-component-kit › verify  3 selected
    ✓ StatCard      ok     210 chars
    ⚠ EmptyState    blank  rendered no text — check the fixture
    ✗ Chart         error  Cannot read properties of undefined (reading 'map')

  1 ok · 1 blank · 1 error · 1.8s
```
Output is colorized in a terminal (TTY); set `NO_COLOR=1` (or pipe to a file) for
plain text. The slow steps show a spinner while esbuild / headless Chrome run.

## Generated vs authored
- **`<Name>.jsx` is generated** by `generate` from the app source — don't edit it
  (re-run `generate` instead). For a component you must hand-author, omit `appPath`.
- **You author the metadata** (the kit can't invent these — they need judgment):
  1. **`<Name>.d.ts`** — the real prop/data types.
  2. **`<Name>.prompt.md`** — the usage prose the design agent reads.
  3. **`<Name>.html`** — a static preview thumbnail (your tokens) with a `@dsCard` first line.
  4. **`fixture.mjs`** — realistic props for the local render check.

`scaffold` stubs the metadata (marked `TODO(human/AI)`) and never overwrites a file
you've edited. The metadata is small and stable; the implementation comes from source.

## How a component is laid out
A design system reads components from a per-component directory:
```
components/<Group>/<Name>/
  <Name>.jsx        generated from app source (not hand-edited)
  <Name>.d.ts       the type contract
  <Name>.prompt.md  usage notes for the agent
  <Name>.html       static preview card (first line: <!-- @dsCard … -->)
  fixture.mjs       props for the local render check
```
Component CSS (`_ds_bundle.css`) must be reachable from your `styles.css`'s
`@import` closure so rendered designs receive it. After uploading, **open the
project once** so it re-indexes and the component appears.

## Limitations
- Only handles components that can render client-side. Components that fetch data
  internally must first have that data lifted to props (a source change).
- `next/font`, `next/dynamic`, server-only APIs are not shimmed — keep those out
  of synced components, or add shims under `shims/`.
- The `.jsx` self-containment is yours to finish; the kit does the bundling,
  class-map extraction, and layout — not the semantic rewrite.
