# Next.js → Claude Design

Sync an existing **Next.js application** (not a component library) into a
[Claude Design](https://claude.ai/design) design system — so the design agent
builds new screens with your real tokens, fonts, and components.

`/design-sync` expects a packaged design system (a `dist/` or a Storybook). Most
apps have neither: route-coupled components, CSS Modules, no component build. This
repo documents how to bridge that gap, and ships a small tool to do it.

![Design tokens rendered from the synced stylesheet](./assets/tokens-colors.png)

## What's here

| | |
|---|---|
| **[POST.md](./POST.md)** | The write-up: the app-vs-library mismatch, a tokens-first strategy, the component triage, the build harness, the component layout, and what it actually costs. |
| **[TUTORIAL.md](./TUTORIAL.md)** | A reproducible, step-by-step guide for your own repo — tokens first, then components. |
| **[ds-component-kit/](./ds-component-kit/)** | A config-driven CLI: build a render-verification bundle (esbuild + `next/*` shims + path aliases) and scaffold the `components/<Group>/<Name>/` layout, with the CSS-module class map pre-extracted. |

## TL;DR

1. **Tokens first.** Mirror your `var(--*)` palette + web fonts into a `styles.css`
   whose `@import` closure carries everything, write a conventions doc that names
   real tokens, upload with `/design-sync`, and publish. For many teams this is
   the whole job.
2. **Components, if you want them.** Only client-renderable, prop-driven ones
   qualify. Build + render-check with the kit, then author the self-contained
   source, types, usage notes, preview card, and fixture per component.

A real application view, rendered standalone from the bundle:

![A real component rendered standalone](./assets/component-scorecardview.png)

## Quick start (the tool)

```bash
cd ds-component-kit
node ds-component-kit.mjs init
$EDITOR ds-component-kit.config.json
node ds-component-kit.mjs build
node ds-component-kit.mjs scaffold
```

See [ds-component-kit/README.md](./ds-component-kit/README.md) for the full
workflow and the parts that need human authoring.

## Status

Documents a working approach as of mid-2026. Claude Design is evolving; treat the
specifics as a starting point and verify against the current `/design-sync`
behavior. The token sync is stable and high-fidelity; the component path is more
involved (the kit automates the deterministic parts and marks the rest).

## License

MIT — see [LICENSE](./LICENSE).
