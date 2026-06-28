# Tutorial: sync a Next.js app into a Claude Design system

A reproducible, step-by-step guide for getting your **Next.js (or Vite/CRA) app's**
tokens and components into a [Claude Design](https://claude.ai/design) design
system, so the design agent builds new screens with your real brand and parts.

For the *why* and the design decisions, read [the write-up](./POST.md). This is
the *how*.

**You'll need:** Claude Code with the `/design-sync` skill, a Claude account with
design access, and Node ≥ 18. Time: tokens ~30 min; each component ~20–40 min of
authoring.

---

## Part A — Tokens, fonts, conventions (do this first)

### A1. Let `/design-sync` create the project
Run `/design-sync` in your repo. It detects you're an app (no Storybook/`dist/`)
and goes off-script. Let it create a **new** design-system project — don't pour an
app into an existing system you care about.

### A2. Produce the styling layer
The runtime consumes one entry stylesheet and its `@import` closure. Mirror your
token source into:

```
ds-bundle/
  styles.css        @import fonts + tokens, then your base resets/helpers
  tokens/theme.css  :root { --bg: …; --card: …; --font-serif: …; --radius-lg: … }
  fonts/fonts.css   @import url('https://fonts.googleapis.com/css2?family=…')
  README.md         the conventions doc (see A3)
```

`styles.css` starts with the imports (CSS requires `@import` before other rules):
```css
@import "./fonts/fonts.css";
@import "./tokens/theme.css";
/* base element styles + helpers below */
```
Copy your `:root` custom properties verbatim from your global CSS.

### A3. Write conventions the agent can act on
This file is inlined into the design agent's prompt. Enumerate **real** names:
surfaces, ink/text, accents, semantic tones, the type roles, radius, elevation —
plus a wrapping note (e.g. "dark canvas: set `background: var(--bg)`") and one
idiomatic snippet. **Validate every name** against your token file before shipping
(`grep`), or the agent will write vocabulary that doesn't resolve.

### A4. Upload + publish
`/design-sync` uploads `ds-bundle/` into the project. Then **open the project and
publish it** — an unpublished system won't appear in any canvas's picker. In your
canvas, click the design-system selector above the prompt and choose your system.

✅ The agent now designs on-brand. For many teams, this is the whole job.

---

## Part B — Components (the optional, bigger lift)

> **The rule that avoids the drift trap:** never hand-copy a component. *Generate*
> it from the real app source so it's a build artifact, not a fork — change the app,
> re-generate. The kit's `generate` does this for the prop-driven majority; the few
> data-coupled views that can't be generated stay hand-authored and are guarded by
> the `drift` check. See [the write-up](./POST.md#the-drift-trap--and-how-to-avoid-it).

### B1. Triage which components can sync
Only client-renderable, prop-driven components generate cleanly. Find the clean set:
```bash
# components that DON'T fetch/route internally (the easy wins)
comm -23 <(find src -name '*.tsx' | sort) \
        <(grep -rlE "fetch\(|/api/|next/navigation|next/headers" src --include='*.tsx' | sort)
```
Components that fetch internally need their data **lifted to props** first (a source
refactor), or they stay hand-authored. Route files (`page.tsx`/`layout.tsx`) aren't
components.

### B2. Configure ds-component-kit
```bash
cd ds-component-kit
node ds-component-kit.mjs init
$EDITOR ds-component-kit.config.json
```
Set `repoRoot`, your `srcAlias` (from tsconfig `paths`), and the `namespace` (copy it
from your project after a first sync). For each component give `name`, `group`,
`path` (where the generated `.jsx` lives, e.g. `design-system/components/<Group>/<Name>/<Name>.jsx`),
and `appPath` (the real app source it's generated from). **Omit `appPath` for a
component you intend to hand-author** — `generate` skips it and `drift` marks it
`manual`.

### B3. Generate the components from source
```bash
node ds-component-kit.mjs generate          # all; or --only YourComponent
```
Each `appPath` `.tsx` is bundled into a self-contained `.jsx` at its `path`: app-lib
helpers inlined, `next/*` shimmed, the CSS-module import turned into a scoped class
map, npm deps left as bare imports. The output is generated — **don't edit it**;
re-run `generate` when the app changes. `generate` also fingerprints each source into
`.dck-sync.json` (the `drift` baseline).

### B4. Build the bundle + compile CSS
```bash
node ds-component-kit.mjs build --js-only   # bundle the generated .jsx → _ds_bundle.js
node ds-component-kit.mjs build --css-only --config <appsrc>   # compile _ds_bundle.css from app CSS modules
```
Wire the component CSS into the design closure:
```css
/* styles.css */
@import "./_ds_bundle.css";
```

### B5. Render-check it
```bash
node ds-component-kit.mjs verify            # headless-render each component + fixture
```
`ok` rendered; `blank` = the fixture is too thin; `error` prints the thrown message
and exits non-zero (CI-friendly). `verify` reads each component's `fixture.mjs` — see
B6. For a visual pass, `serve` and open `templates/render-harness.html`.

> Tip: to capture a publishable screenshot, bundle React + ReactDOM + the component
> into one self-contained file and shoot it with headless Chrome
> (`--headless=new --screenshot --virtual-time-budget=5000`). esm.sh import maps
> don't resolve in headless; a self-contained bundle does.

### B6. Author the metadata (the irreducible hand parts)
`generate` produces the `.jsx`; the rest of each component dir is authored once.
`scaffold` stubs them:
```bash
node ds-component-kit.mjs scaffold --only YourComponent   # never clobbers edited files
```
- **`<Name>.d.ts`** — the prop/data contract the design agent codes against.
- **`<Name>.prompt.md`** — usage prose (states, props, don'ts).
- **`<Name>.html`** — a static preview thumbnail; its first line registers the card:
  ```html
  <!-- @dsCard group="Cards" name="YourComponent" subtitle="…" viewport="760x420" -->
  ```
- **`fixture.mjs`** — realistic props for `verify`.

These are metadata, not the implementation — small, and the only thing you maintain
by hand. Commit the whole component source dir.

### B7. Upload, then guard against drift
Upload with `/design-sync`, then **open the project** so it re-indexes — uploading
alone isn't enough for the component to appear. It shows under its group with its
card, types, and usage notes.

Then keep it honest: commit `.dck-sync.json` and run drift on every change —
```bash
node ds-component-kit.mjs drift             # fresh / drifted / unsealed / manual / orphan
```
Wire it into CI so a PR that changes an app view but forgets to re-`generate` goes
red (the kit ships a sample GitHub Actions workflow). Fix a drift by re-running
`generate` → `build --js-only` → re-upload.

---

## Gotchas (collected from doing it)
- **Publish before you look for it** in the canvas picker.
- **The project re-indexes on open** — uploading isn't enough to verify.
- **Components register from the `components/<Group>/<Name>/` directory** — not
  from anything in the bundle itself.
- **CSS must be in `styles.css`'s `@import` closure** — a card linking it
  directly proves nothing about designs.
- **esbuild needs an explicit `baseUrl`** to resolve `@/*` path aliases.
