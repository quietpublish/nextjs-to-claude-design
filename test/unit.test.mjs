import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs, exportSymbol, listExports, toAlias, bundleHeader, fmtBytes, fmtMs,
} from "../ds-component-kit/ds-component-kit.mjs";

const cfg = { srcAlias: { "@/*": "src/*" }, namespace: "DS_test", repoRoot: "/repo" };

test("parseArgs: command, positionals, and flags (value + boolean)", () => {
  const { cmd, pos, flags } = parseArgs(["build", "src/x.tsx", "--name", "X", "--keep"]);
  assert.equal(cmd, "build");
  assert.deepEqual(pos, ["src/x.tsx"]);
  assert.equal(flags.name, "X");
  assert.equal(flags.keep, true);
});

test("exportSymbol: default export wins", () => {
  assert.equal(exportSymbol(cfg, { name: "Card" }, "export default function Card(){}"), "default");
});

test("exportSymbol: named export matching the component name", () => {
  assert.equal(exportSymbol(cfg, { name: "Note" }, "export function Note(){}"), "Note");
  assert.equal(exportSymbol(cfg, { name: "Tag" }, "export const Tag = () => null"), "Tag");
});

test("exportSymbol: explicit config override beats detection", () => {
  assert.equal(exportSymbol(cfg, { name: "X", export: "Widget" }, "export default 1"), "Widget");
});

test("exportSymbol: returns null when no default and no matching named export", () => {
  assert.equal(exportSymbol(cfg, { name: "Hook" }, "export function useThing(){}\nexport const C = 2"), null);
});

test("listExports: collects default, named declarations, and brace re-exports", () => {
  // `export default function A` exports as `default` (A is just an internal name).
  const got = listExports("export default function A(){}\nexport const B = 1\nexport { c as C, d }");
  assert.deepEqual(new Set(got), new Set(["default", "B", "C", "d"]));
});

test("toAlias: maps an aliased path, passes others through to absolute", () => {
  assert.equal(toAlias(cfg, "src/app/Card.tsx"), "@/app/Card.tsx");
  assert.equal(toAlias(cfg, "lib/x.ts"), "/repo/lib/x.ts");
});

test("bundleHeader: valid @ds-bundle JSON listing components + sourcePaths", () => {
  const h = bundleHeader(cfg, [{ name: "Card", group: "Cards" }]);
  assert.match(h, /^\/\* @ds-bundle: /);
  assert.match(h, / \*\/$/);
  const json = JSON.parse(h.replace(/^\/\* @ds-bundle: /, "").replace(/ \*\/$/, ""));
  assert.equal(json.format, 3);
  assert.equal(json.namespace, "DS_test");
  assert.deepEqual(json.components, [
    { name: "Card", group: "Cards", sourcePath: "components/Cards/Card/Card.jsx" },
  ]);
  assert.deepEqual(json.inlinedExternals, []); // react is runtime-provided, not inlined
  assert.equal(json.runtimeGlobals.react, "React");
  assert.deepEqual(json.unexposedExports, []); // no exports info → nothing extra
});

test("bundleHeader: compound parts (PascalCase non-root exports) land in unexposedExports", () => {
  const h = bundleHeader(cfg, [
    { name: "Card", group: "Cards", exports: ["Card", "CardHeader", "CardTitle", "default", "cardClass"] },
  ]);
  const json = JSON.parse(h.replace(/^\/\* @ds-bundle: /, "").replace(/ \*\/$/, ""));
  // registered root (Card), `default`, and camelCase helper (cardClass) excluded; parts sorted.
  assert.deepEqual(json.unexposedExports, ["CardHeader", "CardTitle"]);
});

test("fmtBytes: B / KB / MB thresholds", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2 KB");
  assert.equal(fmtBytes(1572864), "1.5 MB");
});

test("fmtMs: ms vs seconds", () => {
  assert.equal(fmtMs(450), "450ms");
  assert.equal(fmtMs(1500), "1.5s");
});
