import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImports, makeResolver, parseAliases, SOURCE_RE } from "../tools/audit/build-blocks.mjs";

// ---- extractImports -------------------------------------------------------

test("extractImports: multiline import (Prettier-style) with trailing comma", () => {
  const text = ['import {', '  A,', '  B,', '} from "x";'].join("\n");
  assert.deepEqual(extractImports(text), ["x"]);
});

test("extractImports: multiline export ... from", () => {
  const text = ['export {', '  X,', '} from "y";'].join("\n");
  assert.deepEqual(extractImports(text), ["y"]);
});

test("extractImports: no cross-statement over-capture — plain string containing 'from' after an import", () => {
  const text = [
    'import a from "x";',
    'const s = "returns from a function, not an import";',
  ].join("\n");
  assert.deepEqual(extractImports(text), ["x"]);
});

test("extractImports: import ... from (double quotes)", () => {
  assert.deepEqual(extractImports(`import { a } from "pkg-a";`), ["pkg-a"]);
});

test("extractImports: import ... from (single quotes)", () => {
  assert.deepEqual(extractImports(`import { a } from 'pkg-a';`), ["pkg-a"]);
});

test("extractImports: bare side-effect import (no from)", () => {
  assert.deepEqual(extractImports(`import "pkg-b";`), ["pkg-b"]);
});

test("extractImports: export ... from", () => {
  assert.deepEqual(extractImports(`export { x } from "pkg-c";`), ["pkg-c"]);
});

test("extractImports: export * from", () => {
  assert.deepEqual(extractImports(`export * from "pkg-d";`), ["pkg-d"]);
});

test("extractImports: require(...)", () => {
  assert.deepEqual(extractImports(`const x = require("pkg-e");`), ["pkg-e"]);
});

test("extractImports: dynamic import(...)", () => {
  assert.deepEqual(extractImports(`const x = await import("pkg-f");`), ["pkg-f"]);
});

test("extractImports: all five forms in one file, dedup + first-seen order preserved", () => {
  const text = [
    `import { a } from "pkg-a";`,
    `import "pkg-b";`,
    `export { x } from "pkg-c";`,
    `const y = require("pkg-e");`,
    `const z = await import("pkg-f");`,
    `import { again } from "pkg-a";`, // duplicate — must not appear twice or move position
  ].join("\n");
  assert.deepEqual(extractImports(text), ["pkg-a", "pkg-b", "pkg-c", "pkg-e", "pkg-f"]);
});

test("extractImports: no imports → empty array", () => {
  assert.deepEqual(extractImports("const x = 1;\n"), []);
});

// ---- SOURCE_RE --------------------------------------------------------------

test("SOURCE_RE: matches ts/tsx/js/jsx/mjs/cjs/mts/cts, rejects others", () => {
  for (const f of ["a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.mts", "a.cts"]) {
    assert.ok(SOURCE_RE.test(f), `${f} should match`);
  }
  for (const f of ["a.json", "a.md", "a.php", "a.css"]) {
    assert.ok(!SOURCE_RE.test(f), `${f} should not match`);
  }
});

test("makeResolver: .mjs spec resolves to its .mts TS-ESM twin", () => {
  const files = ["packages/util/src/a.ts", "packages/util/src/b.mts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "./b.mjs"), "packages/util/src/b.mts");
});

test("makeResolver: .cjs spec resolves to its .cts TS-ESM twin", () => {
  const files = ["packages/util/src/a.ts", "packages/util/src/b.cts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "./b.cjs"), "packages/util/src/b.cts");
});

// ---- makeResolver: relative resolution -------------------------------------

test("makeResolver: relative spec with explicit extension resolves to exact file", () => {
  const files = ["apps/api/src/orders/service.ts", "apps/api/src/orders/model.ts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("apps/api/src/orders/service.ts", "./model.ts"), "apps/api/src/orders/model.ts");
});

test("makeResolver: relative spec without extension resolves via appended extension", () => {
  const files = ["apps/api/src/orders/service.ts", "apps/api/src/orders/model.ts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("apps/api/src/orders/service.ts", "./model"), "apps/api/src/orders/model.ts");
});

test("makeResolver: .js spec resolves to its .ts TS-ESM twin", () => {
  const files = ["packages/util/src/a.ts", "packages/util/src/b.ts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "./b.js"), "packages/util/src/b.ts");
});

test("makeResolver: .jsx spec resolves to its .tsx TS-ESM twin", () => {
  const files = ["packages/util/src/a.ts", "packages/util/src/Widget.tsx"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "./Widget.jsx"), "packages/util/src/Widget.tsx");
});

test("makeResolver: directory spec resolves to /index.ts", () => {
  const files = ["packages/util/src/a.ts", "packages/util/src/sub/index.ts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "./sub"), "packages/util/src/sub/index.ts");
});

test("makeResolver: relative spec escaping above repo root → null", () => {
  const files = ["packages/util/src/a.ts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "../../../../outside/thing.ts"), null);
});

test("makeResolver: relative spec that resolves to nothing in files → null", () => {
  const files = ["packages/util/src/a.ts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "./missing"), null);
});

// ---- makeResolver: bare workspace package names ----------------------------

test("makeResolver: bare workspace name resolves to that package's package.json", () => {
  const files = [
    "packages/util/package.json",
    "packages/util/src/a.ts",
    "apps/api/src/orders/service.ts",
  ];
  const readFile = (rel: string) => {
    if (rel === "packages/util/package.json") return JSON.stringify({ name: "@acme/util" });
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const resolve = makeResolver(files, readFile);
  assert.equal(resolve("apps/api/src/orders/service.ts", "@acme/util"), "packages/util/package.json");
});

test("makeResolver: bare workspace name with subpath resolves to the owning package's package.json", () => {
  const files = ["packages/util/package.json", "packages/util/src/a.ts"];
  const readFile = (rel: string) => {
    if (rel === "packages/util/package.json") return JSON.stringify({ name: "@acme/util" });
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const resolve = makeResolver(files, readFile);
  assert.equal(resolve("apps/api/src/orders/service.ts", "@acme/util/subpath"), "packages/util/package.json");
});

test("makeResolver: external (non-workspace) bare package → null", () => {
  const files = ["packages/util/package.json", "packages/util/src/a.ts"];
  const readFile = (rel: string) => JSON.stringify({ name: "@acme/util" });
  const resolve = makeResolver(files, readFile);
  assert.equal(resolve("apps/api/src/orders/service.ts", "react"), null);
});

test("makeResolver: overlapping scoped names — longest match wins, deterministic", () => {
  const files = ["packages/util/package.json", "packages/util-extra/package.json"];
  const readFile = (rel: string) => {
    if (rel === "packages/util/package.json") return JSON.stringify({ name: "@acme/util" });
    if (rel === "packages/util-extra/package.json") return JSON.stringify({ name: "@acme/util/extra" });
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const resolve = makeResolver(files, readFile);
  // "@acme/util/extra/thing" matches both "@acme/util" (prefix "@acme/util/") and
  // "@acme/util/extra" (prefix "@acme/util/extra/") — the longer name must win.
  assert.equal(resolve("apps/api/src/x.ts", "@acme/util/extra/thing"), "packages/util-extra/package.json");
});

test("makeResolver: package.json with invalid JSON is skipped, not thrown", () => {
  const files = ["packages/broken/package.json", "packages/util/package.json"];
  const readFile = (rel: string) => {
    if (rel === "packages/broken/package.json") return "{ not json";
    if (rel === "packages/util/package.json") return JSON.stringify({ name: "@acme/util" });
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const resolve = makeResolver(files, readFile);
  assert.equal(resolve("apps/api/src/x.ts", "@acme/util"), "packages/util/package.json");
  assert.equal(resolve("apps/api/src/x.ts", "@acme/broken"), null);
});

test("makeResolver: manifest detection is exact basename \"package.json\", not endsWith — legacy-package.json is ignored", () => {
  const files = ["packages/foo/legacy-package.json", "packages/foo/src/a.ts"];
  const readFile = (rel: string) => {
    if (rel === "packages/foo/legacy-package.json") return JSON.stringify({ name: "@acme/legacy" });
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const resolve = makeResolver(files, readFile);
  // Not a real manifest (basename differs) — must not register in the bare-name map.
  assert.equal(resolve("apps/x.ts", "@acme/legacy"), null);
});

test("makeResolver: determinism — same input yields same output across calls", () => {
  const files = ["packages/util/package.json", "packages/util/src/a.ts", "apps/api/src/x.ts"];
  const readFile = (rel: string) => JSON.stringify({ name: "@acme/util" });
  const resolve1 = makeResolver(files, readFile);
  const resolve2 = makeResolver(files, readFile);
  assert.equal(resolve1("apps/api/src/x.ts", "@acme/util"), resolve2("apps/api/src/x.ts", "@acme/util"));
  assert.equal(resolve1("apps/api/src/x.ts", "./x.ts"), resolve2("apps/api/src/x.ts", "./x.ts"));
});

// ---- parseAliases + makeResolver alias resolution --------------------------

test("parseAliases: wildcard alias resolves via makeResolver", () => {
  const files = ["tsconfig.json", "apps/web/src/lib/x.ts"];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["apps/web/src/*"] } } });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("somewhere/else.ts", "@/lib/x"), "apps/web/src/lib/x.ts");
});

test("parseAliases: exact alias resolves via makeResolver", () => {
  const files = ["tsconfig.json", "apps/web/src/shim.ts"];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { shim: ["apps/web/src/shim"] } } });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("somewhere/else.ts", "shim"), "apps/web/src/shim.ts");
});

test("parseAliases: JSONC comments tolerated", () => {
  const files = ["tsconfig.json", "apps/web/src/lib/x.ts"];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") {
      return [
        "{",
        "  // line comment",
        '  "compilerOptions": {',
        "    /* block",
        "       comment */",
        '    "baseUrl": ".",',
        '    "paths": { "@/*": ["apps/web/src/*"] }',
        "  }",
        "}",
      ].join("\n");
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("somewhere/else.ts", "@/lib/x"), "apps/web/src/lib/x.ts");
});

test("parseAliases: longest prefix wins on collision", () => {
  const files = ["tsconfig.json", "apps/web/src/generated/g.ts", "apps/web/src/other/o.ts"];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") {
      return JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["apps/web/src/other/*"],
            "@/generated/*": ["apps/web/src/generated/*"],
          },
        },
      });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("x.ts", "@/generated/g"), "apps/web/src/generated/g.ts");
  assert.equal(resolve("x.ts", "@/o"), "apps/web/src/other/o.ts");
});

test("parseAliases: broken tsconfig is skipped, not thrown", () => {
  const files = ["tsconfig.json", "apps/web/src/lib/x.ts"];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") return "{ not json";
    throw new Error(`unexpected readFile: ${rel}`);
  };
  assert.doesNotThrow(() => parseAliases(files, readFile));
  assert.deepEqual(parseAliases(files, readFile), []);
});

// ---- alias scoping by tsconfig subtree (gate-cycle-2) ----------------------

test("parseAliases + makeResolver: same-prefix alias in two tsconfig subtrees resolves per-scope, not globally", () => {
  const files = [
    "apps/api/tsconfig.json",
    "apps/web/tsconfig.json",
    "apps/api/src/a.ts",
    "apps/api/src/lib/x.ts",
    "apps/web/src/b.ts",
    "apps/web/src/lib/y.ts",
  ];
  const readFile = (rel: string) => {
    if (rel === "apps/api/tsconfig.json" || rel === "apps/web/tsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  // Each importer resolves "@/lib/*" against its OWN tsconfig's scope, not
  // whichever tsconfig's alias happens to sort first / have the longest prefix.
  assert.equal(resolve("apps/api/src/a.ts", "@/lib/x"), "apps/api/src/lib/x.ts");
  assert.equal(resolve("apps/web/src/b.ts", "@/lib/y"), "apps/web/src/lib/y.ts");
});

test("parseAliases + makeResolver: importer outside every alias's scope gets null, not a wrong cross-app hit", () => {
  const files = [
    "apps/api/tsconfig.json",
    "apps/web/tsconfig.json",
    "apps/api/src/lib/x.ts",
    "apps/web/src/lib/y.ts",
    "outside/z.ts",
  ];
  const readFile = (rel: string) => {
    if (rel === "apps/api/tsconfig.json" || rel === "apps/web/tsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("outside/z.ts", "@/lib/x"), null);
});

test("parseAliases + makeResolver: root-tsconfig alias (scopeDir '') still applies to importers anywhere", () => {
  const files = [
    "tsconfig.json",
    "apps/api/tsconfig.json",
    "shared/util.ts",
    "apps/api/src/lib/x.ts",
    "outside/z.ts",
  ];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["shared/*"] } } });
    }
    if (rel === "apps/api/tsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("apps/api/src/lib/x.ts", "~/util"), "shared/util.ts");
  assert.equal(resolve("outside/z.ts", "~/util"), "shared/util.ts");
  // Scoped alias still doesn't leak outside its own subtree even with a root alias present.
  assert.equal(resolve("outside/z.ts", "@/lib/x"), null);
});

// ---- tsconfig trailing commas (gate-cycle-2) --------------------------------

test("parseAliases: trailing commas in paths and outer object are tolerated (TS accepts them, JSON.parse does not)", () => {
  const files = ["tsconfig.json", "apps/web/src/lib/x.ts"];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") {
      return [
        "{",
        '  "compilerOptions": {',
        '    "baseUrl": ".",',
        '    "paths": { "@/*": ["apps/web/src/*"], },',
        "  },",
        "}",
      ].join("\n");
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  assert.notDeepEqual(aliases, []); // must NOT silently drop all aliases
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("somewhere/else.ts", "@/lib/x"), "apps/web/src/lib/x.ts");
});

// ---- INDEX_EXTS parity with REL_EXTS (gate-cycle-2) -------------------------

test("makeResolver: directory spec resolves to /index.mts (index candidates match the full REL_EXTS family)", () => {
  const files = ["packages/util/src/a.ts", "packages/util/src/sub/index.mts"];
  const resolve = makeResolver(files, () => { throw new Error("not a package.json"); });
  assert.equal(resolve("packages/util/src/a.ts", "./sub"), "packages/util/src/sub/index.mts");
});

// ---- jsconfig.json (gate-cycle-2-retry #3) ---------------------------------

test("parseAliases: jsconfig.json (not just tsconfig.json) is read for path aliases", () => {
  const files = ["jsconfig.json", "apps/web/src/lib/x.ts"];
  const readFile = (rel: string) => {
    if (rel === "jsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["apps/web/src/*"] } } });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("somewhere/else.ts", "@/lib/x"), "apps/web/src/lib/x.ts");
});

// ---- tsconfig `extends` chain (gate-cycle-2-retry #1) ----------------------

test("parseAliases: extends-only child inherits base's paths, resolved BASE-relative (TS semantics), not child-relative", () => {
  // The base config lives OFF the repo root (base-config/), so its own
  // top-level entry is scoped to base-config/ and can NOT itself cover the
  // apps/web/ importer below — isolating this assertion so it can only pass
  // through genuine extends-inheritance (scopeDir = the CHILD's dir), not
  // through the base's own scope happening to apply repo-wide. Inherited
  // "shared/*" must still resolve against the BASE's own directory
  // (base-config/), landing on base-config/shared/x.ts — not apps/web/shared/x.ts,
  // which is what a (wrong) child-relative resolution would produce.
  const files = [
    "base-config/tsconfig.json", "apps/web/tsconfig.json",
    "apps/web/src/a.ts", "base-config/shared/x.ts",
  ];
  const readFile = (rel: string) => {
    if (rel === "base-config/tsconfig.json") {
      return JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["shared/*"] } } });
    }
    if (rel === "apps/web/tsconfig.json") {
      return JSON.stringify({ extends: "../../base-config/tsconfig.json" });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("apps/web/src/a.ts", "@/x"), "base-config/shared/x.ts");
});

test("parseAliases: extends chain — child's own paths entry overrides just that key; an un-redeclared key stays inherited", () => {
  // Same off-root base as above, so neither key is reachable via the base's
  // own repo-wide scope — both assertions below can only pass through the
  // merge logic itself. Base declares "@/*" and "@x/*"; the child redeclares
  // only "@/*" (its own mapping must win, with the base's same-key mapping as
  // a live decoy at base-config/shared/y.ts) while "@x/*" is left untouched
  // and must still resolve base-relative.
  const files = [
    "base-config/tsconfig.json", "apps/web/tsconfig.json", "apps/web/src/a.ts",
    "base-config/shared/y.ts", "apps/web/local/y.ts", "base-config/extra/z.ts",
  ];
  const readFile = (rel: string) => {
    if (rel === "base-config/tsconfig.json") {
      return JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["shared/*"], "@x/*": ["extra/*"] } },
      });
    }
    if (rel === "apps/web/tsconfig.json") {
      return JSON.stringify({
        extends: "../../base-config/tsconfig.json",
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["local/*"] } },
      });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  // Redeclared key: child's own mapping wins over the base's same-key decoy.
  assert.equal(resolve("apps/web/src/a.ts", "@/y"), "apps/web/local/y.ts");
  // Un-redeclared key: still inherited, still resolved against the BASE's dir.
  assert.equal(resolve("apps/web/src/a.ts", "@x/z"), "base-config/extra/z.ts");
});

test("parseAliases: cyclic extends (A extends B extends A) does not infinite-loop — resolves what's resolvable", () => {
  // Root tsconfig.json only extends sub/tsconfig.json (no own paths); sub's
  // tsconfig.json extends back to the root (the cycle) AND declares its own
  // "@b/*" alias. The root's top-level entry must still pick up "@b/*"
  // transitively (proving the cycle guard breaks the loop without discarding
  // whatever WAS resolvable), and — because inherited targets resolve against
  // the DECLARING config (sub/), not the leaf (root) — the target must land
  // under sub/target-b/, not a root-relative target-b/.
  const files = ["tsconfig.json", "sub/tsconfig.json", "sub/target-b/y.ts", "elsewhere/importer.ts"];
  const readFile = (rel: string) => {
    if (rel === "tsconfig.json") return JSON.stringify({ extends: "./sub/tsconfig.json" });
    if (rel === "sub/tsconfig.json") {
      return JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { baseUrl: ".", paths: { "@b/*": ["target-b/*"] } },
      });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  const aliases = parseAliases(files, readFile); // must return promptly, not hang
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("elsewhere/importer.ts", "@b/y"), "sub/target-b/y.ts");
});

test("parseAliases: extends targeting an npm package (bare specifier) is skipped silently, own paths still parsed", () => {
  const files = ["apps/web/tsconfig.json", "apps/web/src/lib/x.ts"];
  const readFile = (rel: string) => {
    if (rel === "apps/web/tsconfig.json") {
      return JSON.stringify({
        extends: "@tsconfig/node20/tsconfig.json", // not a tracked file — bare/npm specifier
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      });
    }
    throw new Error(`unexpected readFile: ${rel}`);
  };
  assert.doesNotThrow(() => parseAliases(files, readFile));
  const aliases = parseAliases(files, readFile);
  const resolve = makeResolver(files, readFile, aliases);
  assert.equal(resolve("apps/web/src/a.ts", "@/lib/x"), "apps/web/src/lib/x.ts");
});
