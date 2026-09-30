import { describe, expect, it } from "vitest";
import { addedScriptsOnly, inertScriptAddition } from "./manifest.js";
import type { Mention } from "./manifest.js";

const manifest = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "app", scripts, dependencies: { next: "15.0.0" }, ...extra }, null, 2)}\n`;

const BASE = manifest({ test: "vitest run", lint: "eslint ." });

/** The manifest's own lines naming the new scripts, as git grep reports them. */
function declarations(path: string, head: string, names: string[]): Map<string, Mention[]> {
  const hits = new Map<string, Mention[]>();
  head.split("\n").forEach((text, i) => {
    for (const n of names) if (text.includes(n)) hits.set(n, [...(hits.get(n) ?? []), { file: path, line: i + 1, text }]);
  });
  return hits;
}

/** Which files the graph has nodes for. */
const isCode = (file: string) => /\.(ts|js)$/.test(file);

describe("addedScriptsOnly", () => {
  it("returns the scripts a change only adds", () => {
    const head = manifest({ test: "vitest run", lint: "eslint .", "docs:check": "bun run scripts/docs.ts" });
    expect(addedScriptsOnly(BASE, head)).toEqual(new Map([["docs:check", "bun run scripts/docs.ts"]]));
  });

  it("refuses an edited or removed script", () => {
    expect(addedScriptsOnly(BASE, manifest({ test: "vitest run --coverage", lint: "eslint .", x: "y" }))).toBeNull();
    expect(addedScriptsOnly(BASE, manifest({ test: "vitest run", x: "y" }))).toBeNull();
  });

  // A dependency bump changes what every test runs against.
  it("refuses any change outside scripts", () => {
    const head = manifest({ test: "vitest run", lint: "eslint .", x: "y" }, { dependencies: { next: "15.1.0" } });
    expect(addedScriptsOnly(BASE, head)).toBeNull();
  });

  it("refuses what it cannot parse", () => {
    expect(addedScriptsOnly(BASE, "{ not json")).toBeNull();
  });
});

describe("inertScriptAddition", () => {
  const head = manifest({ test: "vitest run", lint: "eslint .", "docs:check": "bun run scripts/docs.ts" });

  it("proves a new script nothing invokes inert", () => {
    expect(inertScriptAddition("package.json", BASE, head, (n) => declarations("package.json", head, n), isCode)).toEqual({
      why: "only adds scripts nothing runs: docs:check",
      readers: [],
    });
  });

  it("calls a whitespace-only change inert", () => {
    const reindented = BASE.replace(/\n  /g, "\n    ");
    expect(inertScriptAddition("package.json", BASE, reindented, () => new Map(), isCode)).toEqual({ why: "changes formatting only", readers: [] });
  });

  // Review of #52: Node picks the first matching `exports` condition, and Jest
  // the first matching `moduleNameMapper` entry, so order is behaviour.
  it("refuses a change that only reorders keys", () => {
    const before = manifest({ test: "vitest run" }, { exports: { ".": { node: "./node.js", default: "./browser.js" } } });
    const after = manifest({ test: "vitest run" }, { exports: { ".": { default: "./browser.js", node: "./node.js" } } });
    expect(inertScriptAddition("package.json", before, after, () => new Map(), isCode)).toBeNull();
    const scriptsSwapped = manifest({ lint: "eslint .", test: "vitest run", x: "y" });
    expect(addedScriptsOnly(BASE, scriptsSwapped)).toBeNull();
  });

  it("refuses a new script whose name splits on other separators", () => {
    for (const name of ["test/e2e", "test.e2e", "test e2e"]) {
      const withIt = manifest({ test: "vitest run", lint: "eslint .", [name]: "playwright test" });
      expect(inertScriptAddition("package.json", BASE, withIt, (n) => declarations("package.json", withIt, n), isCode)).toBeNull();
    }
  });

  it("does not let a prototype name skip the check", () => {
    const withIt = manifest({ test: "vitest run", lint: "eslint .", constructor: "node ci.js" });
    expect(addedScriptsOnly(BASE, withIt)).toEqual(new Map([["constructor", "node ci.js"]]));
  });

  // npm and bun run `pretest` before `test`; hosts run `build` and friends.
  it("refuses a script a package manager or host runs by name", () => {
    for (const name of ["pretest", "postinstall", "prepare", "build", "vercel-build"]) {
      const withHook = manifest({ test: "vitest run", lint: "eslint .", [name]: "node setup.js" });
      expect(inertScriptAddition("package.json", BASE, withHook, (n) => declarations("package.json", withHook, n), isCode)).toBeNull();
    }
  });

  it("refuses a new script a workflow invokes", () => {
    const mentions = (n: string[]) => {
      const hits = declarations("package.json", head, n);
      hits.set("docs:check", [...(hits.get("docs:check") ?? []), { file: ".github/workflows/ci.yml", line: 9, text: "      - run: bun run docs:check" }]);
      return hits;
    };
    expect(inertScriptAddition("package.json", BASE, head, mentions, isCode)).toBeNull();
  });

  // Another package's manifest can run it, and so can config keyed by it.
  it("refuses a mention in the manifest that is not the new declaration", () => {
    const withPipeline = manifest({ test: "vitest run", lint: "eslint .", "docs:check": "bun run scripts/docs.ts" }, { turbo: { pipeline: { "docs:check": {} } } });
    const baseWithPipeline = manifest({ test: "vitest run", lint: "eslint ." }, { turbo: { pipeline: { "docs:check": {} } } });
    expect(
      inertScriptAddition("package.json", baseWithPipeline, withPipeline, (n) => declarations("package.json", withPipeline, n), isCode),
    ).toBeNull();
  });

  // `ci` already called `docs:check`, which did not exist; adding it changes `ci`.
  it("refuses a new script an existing one already calls", () => {
    const base = manifest({ test: "vitest run", ci: "bun run docs:check && bun test" });
    const withIt = manifest({ test: "vitest run", ci: "bun run docs:check && bun test", "docs:check": "bun run scripts/docs.ts" });
    expect(inertScriptAddition("package.json", base, withIt, (n) => declarations("package.json", withIt, n), isCode)).toBeNull();
  });

  // Found on a real PR: `.gitignore` lines such as `yarn-debug.log*`, and
  // `bunx playwright` in a comment, read as pattern runners.
  it("ignores runner names inside other words and files that never run anything", () => {
    const mentions = (n: string[]) => {
      const hits = declarations("package.json", head, n);
      hits.set("yarn", [{ file: ".gitignore", line: 30, text: "yarn-error.log*" }]);
      hits.set("nx", [{ file: "e2e/a.spec.ts", line: 9, text: "const cmd = `bunx playwright test --update-snapshots *`;" }]);
      return hits;
    };
    expect(inertScriptAddition("package.json", BASE, head, mentions, isCode)?.why).toBe("only adds scripts nothing runs: docs:check");
  });

  // `run-s "lint:*"` starts running a new `lint:css` without naming it.
  it("refuses a new script an existing pattern runner picks up", () => {
    const base = manifest({ test: "vitest run", lint: "run-s lint:*", "lint:js": "eslint ." });
    const withIt = manifest({ test: "vitest run", lint: "run-s lint:*", "lint:js": "eslint .", "lint:css": "stylelint ." });
    expect(inertScriptAddition("package.json", base, withIt, (n) => declarations("package.json", withIt, n), isCode)).toBeNull();
  });

  // Review of #52: each of these runs `web:e2e` or `test:e2e` without naming it.
  it("refuses every pattern form found in review", () => {
    const cases: [string, string, string][] = [
      ["test:e2e", "package.json", '    "test": "pnpm run \\"/^test:/\\"",'],
      ["web:test", "package.json", '    "all": "node_modules/.bin/run-p \\"*:test\\"",'],
      ["web:e2e", ".github/workflows/ci.yml", '            "*:e2e"'],
      ["web:e2e", ".github/workflows/ci.yml", '      - run: npx nx@latest run-many -t "*:e2e"'],
      ["test:e2e", ".github/scripts/ci.sh", "npm run test:e2e --if-present"],
      ["lint:types", ".pre-commit-config.yaml", "    entry: npm run lint:types"],
    ];
    for (const [name, file, text] of cases) {
      const head2 = manifest({ test: "vitest run", lint: "eslint .", [name]: "run it" });
      const mentions = (n: string[]) => {
        const hits = declarations("package.json", head2, n);
        for (const needle of n) if (text.includes(needle)) hits.set(needle, [...(hits.get(needle) ?? []), { file, line: 5, text }]);
        return hits;
      };
      expect([name, file, inertScriptAddition("package.json", BASE, head2, mentions, isCode)]).toEqual([name, file, null]);
    }
  });

  // Found on a real PR: URL paths such as `/shared-docs/${id}` and a CI
  // ignore pattern `^docs/` matched a middle segment of `user-docs:check`.
  it("does not read a path or a middle segment as a script pattern", () => {
    const head2 = manifest({ test: "vitest run", lint: "eslint .", "user-docs:check": "bun run scripts/docs.ts" });
    const lines: [string, string][] = [
      ["src/api.ts", "  return apiFetch<Doc>(`/shared-docs/${id}`);"],
      ["src/types.d.ts", '  "/api/v1/health-check/{name}": {'],
      [".github/workflows/test-impact.yml", "            ^docs/"],
      ["src/tab.tsx", "  C: 'Tell the user.',"],
    ];
    const mentions = (n: string[]) => {
      const hits = declarations("package.json", head2, n);
      for (const [file, text] of lines) for (const needle of n) if (text.includes(needle)) hits.set(needle, [...(hits.get(needle) ?? []), { file, line: 3, text }]);
      return hits;
    };
    expect(inertScriptAddition("package.json", BASE, head2, mentions, isCode)).toEqual({ why: "only adds scripts nothing runs: user-docs:check", readers: [] });
  });

  it("walks code that concatenates or filters by the name", () => {
    const head2 = manifest({ test: "vitest run", lint: "eslint .", "test:e2e": "playwright test" });
    for (const text of ['  spawnSync("npm", ["run", "test:" + kind]);', "  const all = names.filter((s) => /^test:/.test(s));"]) {
      const mentions = (n: string[]) => {
        const hits = declarations("package.json", head2, n);
        for (const needle of n) if (text.includes(needle)) hits.set(needle, [...(hits.get(needle) ?? []), { file: "src/lib.ts", line: 5, text }]);
        return hits;
      };
      expect(inertScriptAddition("package.json", BASE, head2, mentions, isCode)?.readers).toEqual([{ file: "src/lib.ts", line: 5 }]);
    }
  });

  it("refuses a new script a workflow runs by pattern, and walks code that builds its name", () => {
    const head2 = manifest({ test: "vitest run", lint: "eslint .", "test:e2e": "playwright test" });
    const withLine = (file: string, text: string) => (n: string[]) => {
      const hits = declarations("package.json", head2, n);
      for (const needle of n) if (text.includes(needle)) hits.set(needle, [...(hits.get(needle) ?? []), { file, line: 7, text }]);
      return hits;
    };
    for (const line of ["      - run: npx turbo run test*", "      - run: npx npm-run-all 'test:*'", "      - run: pnpm run /^test:.*/"]) {
      expect(inertScriptAddition("package.json", BASE, head2, withLine(".github/workflows/ci.yml", line), isCode)).toBeNull();
    }
    expect(inertScriptAddition("package.json", BASE, head2, withLine("scripts/run.ts", "  await run(`test:${kind}`);"), isCode)).toEqual({
      why: "only adds scripts: test:e2e; code naming them is walked",
      readers: [{ file: "scripts/run.ts", line: 7 }],
    });
  });

  // Nothing runs either new script, so one calling the other runs nothing.
  it("allows one new script to call another", () => {
    const chained = manifest({ test: "vitest run", lint: "eslint .", "docs:check": "bun run scripts/docs.ts", "docs:all": "bun run docs:check" });
    expect(inertScriptAddition("package.json", BASE, chained, (n) => declarations("package.json", chained, n), isCode)).toEqual({
      why: "only adds scripts nothing runs: docs:all, docs:check",
      readers: [],
    });
  });

  // A helper that spawns the script, or a usage message naming it, is code the
  // graph knows: its dependents are walked. A comment naming it is nothing.
  it("returns code that names a new script as a reader, and skips comments", () => {
    const mentions = (n: string[]) => {
      const hits = declarations("package.json", head, n);
      hits.set("docs:check", [
        ...(hits.get("docs:check") ?? []),
        { file: "scripts/docs.ts", line: 3, text: " *   bun run docs:check   # validate every doc" },
        { file: "scripts/docs.ts", line: 40, text: "  console.error('fix the problems above first (bun run docs:check).');" },
      ]);
      return hits;
    };
    expect(inertScriptAddition("package.json", BASE, head, mentions, isCode)).toEqual({
      why: "only adds scripts: docs:check; code naming them is walked",
      readers: [{ file: "scripts/docs.ts", line: 40 }],
    });
  });
});
