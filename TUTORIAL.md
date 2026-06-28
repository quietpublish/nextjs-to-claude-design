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

### B1. Triage which components can sync
Only client-renderable, prop-driven components qualify. Find the clean set:
```bash
# components that DON'T fetch/route internally (the easy wins)
comm -23 <(find src -name '*.tsx' | sort) \
        <(grep -rlE "fetch\(|/api/|next/navigation|next/headers" src --include='*.tsx' | sort)
```
Components that fetch internally need their data **lifted to props** first (a
source refactor). Route files (`page.tsx`/`layout.tsx`) are not components.

### B2. Configure ds-component-kit
```bash
cd ds-component-kit
node ds-component-kit.mjs init
$EDITOR ds-component-kit.config.json
```
Set `repoRoot`, your `srcAlias` (from tsconfig `paths`), the `namespace` (the one
your project already uses — copy it after a first sync), and list `components[]`
with `path` / `name` / `group`. See `ds-component-kit.config.example.json`.

### B3. Build the render-verification bundle
```bash
node ds-component-kit.mjs build --only YourComponent
```
This esbuilds the component with `next/*` shimmed and your aliases resolved into
`ds-bundle/_ds_bundle.js` + `_ds_bundle.css`. Wire the CSS into the closure:
```css
/* styles.css */
@import "./_ds_bundle.css";
```

### B4. Render-check it locally
```bash
node ds-component-kit.mjs serve            # static-serves ds-bundle/
```
Copy `templates/render-harness.html` to `ds-bundle/render.html`, set the namespace
+ component + fixture import, and open it. Confirm it's pixel-faithful with a clean
console **before** uploading — fidelity here is fidelity in every design the agent
builds.

> Tip: to capture a publishable screenshot, bundle React + ReactDOM + the
> component into one self-contained file and shoot it with headless Chrome
> (`--headless=new --screenshot --virtual-time-budget=5000`). esm.sh import maps
> don't resolve in headless; a self-contained bundle does.

### B5. Scaffold the component directory
```bash
node ds-component-kit.mjs scaffold --only YourComponent
```
Creates `ds-bundle/components/<Group>/<Name>/` with five files; the CSS-module
class map is pre-extracted into the `.jsx`. Now finish the `TODO(human/AI)` parts:
1. **`<Name>.jsx`** — paste the body, inline app-lib helpers, `next/link`→`<a>`.
2. **`<Name>.d.ts`** — the real prop/data types.
3. **`<Name>.prompt.md`** — usage prose (states, props, don'ts).
4. **`<Name>.html`** — a static preview thumbnail in your tokens.
5. **`fixture.mjs`** — realistic props (you already have this from B4).

The `@dsCard` first line is what registers the card:
```html
<!-- @dsCard group="Cards" name="YourComponent" subtitle="…" viewport="760x420" -->
```

### B6. Upload and verify
Upload the new files with `/design-sync`, then **open the project** so it
re-indexes — uploading alone isn't enough to make the component appear. Your
component shows under its group, with its card, type contract, and usage notes.
Click it to confirm.

### B7. Repeat / scale
Repeat B3–B6 per component. Re-running `scaffold` never clobbers files you've
edited. For a large set, parallelize the authoring — the recipe is fixed; only
the per-component judgment varies.

---

## Gotchas (collected from doing it)
- **Publish before you look for it** in the canvas picker.
- **The project re-indexes on open** — uploading isn't enough to verify.
- **Components register from the `components/<Group>/<Name>/` directory** — not
  from anything in the bundle itself.
- **CSS must be in `styles.css`'s `@import` closure** — a card linking it
  directly proves nothing about designs.
- **esbuild needs an explicit `baseUrl`** to resolve `@/*` path aliases.
