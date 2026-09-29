import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReferences } from "./references.js";
import type { Resolution } from "./references.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

/** Source files the graph extracts; anything else has no node, like a real cgraph run. */
const CODE = /\.(ts|js|kt|java|py|go|c)$/;

/** Commit `files` to a fresh repo and resolve `paths` at HEAD. */
function resolveIn(files: Record<string, string>, paths: string[], irrelevant: (p: string) => boolean = () => false): Map<string, Resolution> {
  const root = join(mkdtempSync(join(tmpdir(), "blastline-refs-")), "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: ENV });
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return resolveReferences(git, "HEAD", paths, {
    hasNodes: (p) => CODE.test(p) && p in files,
    irrelevant,
    read: (p) => readFileSync(join(root, p), "utf8"),
  });
}

function readersOf(r: Resolution | undefined): string[] {
  expect(r?.kind).toBe("referenced");
  return r?.kind === "referenced" ? r.readers.map((x) => `${x.file}:${x.lines.join(",")}:${x.rule}`) : [];
}

describe("resolveReferences: plain files", () => {
  it("finds the code that names a file, at the naming line", () => {
    const refs = resolveIn(
      { "data/rows.csv": "a,b\n", "src/rows.test.ts": "import x from 'y';\n\ntest('rows', () => load('rows.csv'));\n" },
      ["data/rows.csv"],
    );
    expect(readersOf(refs.get("data/rows.csv"))).toEqual(["src/rows.test.ts:3:name"]);
  });

  // A comment cannot load anything; counting it would only widen the run, but
  // a file named ONLY in comments must not read as referenced by that code.
  it("does not count a comment as a reader", () => {
    const refs = resolveIn({ "data/rows.csv": "a\n", "src/a.ts": "// see rows.csv\n/* rows.csv */\n * rows.csv\n" }, ["data/rows.csv"]);
    expect(refs.get("data/rows.csv")).toEqual({ kind: "unresolved", why: "no code names it" });
  });

  // These read a file and start like a comment.
  it("counts #include, //go:embed and /// <reference> as readers", () => {
    const refs = resolveIn(
      {
        "native/tables.h": "int t[] = {1};\n",
        "native/codec.c": '#include "tables.h"\nint f(void) { return t[0]; }\n',
        "cmd/golden.json": "{}\n",
        "cmd/golden.go": "package cmd\n\n//go:embed golden.json\nvar golden []byte\n",
        "types/env.d.ts": "declare const x: number;\n",
        "src/app.ts": '/// <reference path="../types/env.d.ts" />\nexport const y = x;\n',
      },
      ["native/tables.h", "cmd/golden.json", "types/env.d.ts"],
    );
    expect(readersOf(refs.get("native/tables.h"))).toEqual(["native/codec.c:1:name"]);
    expect(readersOf(refs.get("cmd/golden.json"))).toEqual(["cmd/golden.go:3:name"]);
    expect(readersOf(refs.get("types/env.d.ts"))).toEqual(["src/app.ts:1:name"]);
  });

  it("counts a list item that opens with a quote as a reader, not a comment", () => {
    const refs = resolveIn({ "data/rows.csv": "a\n", "src/cases.ts": "export const cases = [\n  'rows.csv',\n];\n" }, ["data/rows.csv"]);
    expect(readersOf(refs.get("data/rows.csv"))).toEqual(["src/cases.ts:2:name"]);
  });

  // A loader that walks a folder names none of the files in it; a file that
  // only imports from a folder walks nothing and is not a reader.
  it("finds a loader that names a folder above the file and enumerates it", () => {
    const refs = resolveIn(
      {
        "pkg/golden-cases/deep/t1.txt": "want\n",
        "pkg/walk.test.ts": "const dir = join(__dirname, 'golden-cases');\nfor (const f of readdirSync(dir)) check(f);\n",
        "pkg/uses.ts": "import { helper } from './golden-cases/helper';\n",
      },
      ["pkg/golden-cases/deep/t1.txt"],
    );
    expect(readersOf(refs.get("pkg/golden-cases/deep/t1.txt"))).toEqual(["pkg/walk.test.ts:1:folder"]);
  });

  // An opaque file that can change how tests run hides its effect from any
  // search, so the changed file must fail open.
  it("stays unresolved when build or CI config names it", () => {
    const refs = resolveIn(
      {
        "data/seed.json": "{}\n",
        "src/seed.test.ts": "load('seed.json');\n",
        "package.json": '{ "scripts": { "pretest": "cp data/seed.json build/" } }\n',
      },
      ["data/seed.json"],
    );
    expect(refs.get("data/seed.json")).toEqual({ kind: "unresolved", why: "package.json names it and can change how tests run" });
  });

  // A compose file or alert rule cannot make a test read anything by itself;
  // what matters is who reads IT.
  it("looks through a non-code reader to the code that reads that", () => {
    const refs = resolveIn(
      {
        "config/limits.json": "{}\n",
        "compose.test.yml": "services:\n  api:\n    volumes: [./config/limits.json:/etc/limits.json]\n",
        "src/stack.test.ts": "const env = new DockerComposeEnvironment('.', 'compose.test.yml');\n",
        "ops/alerts.yml": "runbook: check limits.json\n",
      },
      ["config/limits.json"],
    );
    expect(readersOf(refs.get("config/limits.json"))).toEqual(["src/stack.test.ts:1:name"]);
  });

  it("never counts a lockfile as a reader", () => {
    const refs = resolveIn(
      {
        "lib/testdata/rows.csv": "a\n",
        "lib/rows.test.ts": "load(join(__dirname, 'testdata', 'rows.csv'));\n",
        "bun.lock": '"glob": ["glob@10", { "bin": "dist/lib/testdata/rows.csv" }]\n',
      },
      ["lib/testdata/rows.csv"],
    );
    expect(readersOf(refs.get("lib/testdata/rows.csv"))).toEqual(["lib/rows.test.ts:1:name"]);
  });

  it("honours ignore rules for readers", () => {
    const refs = resolveIn(
      { "data/rows.csv": "a\n", "src/rows.test.ts": "load('rows.csv');\n", "tools/ci.ts": "upload('rows.csv');\n" },
      ["data/rows.csv"],
      (p) => p.startsWith("tools/"),
    );
    expect(readersOf(refs.get("data/rows.csv"))).toEqual(["src/rows.test.ts:1:name"]);
  });

  it("never resolves a file loaded by convention", () => {
    const refs = resolveIn({ "src/test/resources/logback-test.xml": "<configuration/>\n", "src/A.kt": 'val f = "logback-test.xml"\n' }, [
      "src/test/resources/logback-test.xml",
    ]);
    expect(refs.get("src/test/resources/logback-test.xml")).toEqual({ kind: "unresolved", why: "loaded by convention, not by name" });
  });
});

describe("resolveReferences: Spring configuration", () => {
  const SPRING = {
    "build.gradle.kts": 'plugins { id("org.springframework.boot") }\n',
    "src/main/kotlin/App.kt": "import org.springframework.boot.autoconfigure.SpringBootApplication\n@SpringBootApplication\nclass App\n",
    "src/main/resources/application.yml": "server:\n  port: 8080\n",
    "src/main/resources/application-production.yml": "management: {}\n",
    "src/main/resources/application-local.yml": "jwt:\n  secret: do-not-use-in-production # production uses a vault\n",
    "src/test/kotlin/ContextTest.kt": '@SpringBootTest\n@ActiveProfiles("test")\nclass ContextTest\n',
    "src/test/kotlin/ProbeTest.kt": 'class ProbeTest {\n  val r = ClassPathResource("application-production.yml")\n}\n',
    "src/test/kotlin/MatrixTest.kt": 'val PROD = listOf("production", "prod")\nfun load(p: String) = flatten("application-$p.yml")\n',
    "src/test/kotlin/ProdTest.kt": '@SpringBootTest\n@ActiveProfiles("production")\nclass ProdTest\n',
    "k8s/configmap.yaml": 'data:\n  SPRING_PROFILES_ACTIVE: "production"\n',
  };
  const PROFILE = "src/main/resources/application-production.yml";

  // The motivating case: a profile file selects the code that names it, builds
  // its name, or activates the profile -- not every context test.
  it("selects what names, templates or activates the profile, and nothing else", () => {
    const refs = resolveIn(SPRING, [PROFILE]);
    expect(readersOf(refs.get(PROFILE))).toEqual([
      "src/test/kotlin/MatrixTest.kt:1:spring-profile",
      "src/test/kotlin/ProbeTest.kt:2:name",
      "src/test/kotlin/ProdTest.kt:2:spring-profile",
    ]);
  });

  // @SpringBootApplication itself reads nothing; the tests that start a context do.
  it("selects every test that starts a context for the base file", () => {
    const refs = resolveIn(SPRING, ["src/main/resources/application.yml"]);
    expect(readersOf(refs.get("src/main/resources/application.yml"))).toEqual([
      "src/test/kotlin/ContextTest.kt:1:spring-context",
      "src/test/kotlin/ProdTest.kt:1:spring-context",
    ]);
  });

  // A profile group turns `staging` into `production` for any run that
  // activates staging -- through nested YAML no single line shows.
  it("stays unresolved when a Spring config's profiles block names the profile", () => {
    const refs = resolveIn(
      { ...SPRING, "src/main/resources/application.yml": "spring:\n  profiles:\n    group:\n      staging: production, staging\n" },
      [PROFILE],
    );
    expect(refs.get(PROFILE)).toEqual({
      kind: "unresolved",
      why: "src/main/resources/application.yml activates profile production in its profiles block",
    });
  });

  it("stays unresolved when a CI workflow runs tests with the profile", () => {
    const refs = resolveIn({ ...SPRING, ".github/workflows/ci.yml": "env:\n  SPRING_PROFILES_ACTIVE: production\n" }, [PROFILE]);
    expect(refs.get(PROFILE)).toEqual({ kind: "unresolved", why: ".github/workflows/ci.yml activates profile production" });
  });

  // Micronaut and Quarkus read application.yml too, by their own rules.
  it("treats application.yml as convention-loaded outside a Spring repository", () => {
    const refs = resolveIn({ "src/main/resources/application.yml": "x: 1\n", "src/A.kt": 'val f = "application.yml"\n' }, [
      "src/main/resources/application.yml",
    ]);
    expect(refs.get("src/main/resources/application.yml")).toEqual({ kind: "unresolved", why: "loaded by convention, not by name" });
  });
});
