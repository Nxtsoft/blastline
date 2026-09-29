import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReferences } from "./references.js";
import type { Resolution } from "./references.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

/** Source files the graph extracts; anything else has no node, like a real cgraph run. */
const CODE = /\.(ts|js|kt|java|py|go|c|rs|rb)$/;

/** Commit `files` to a fresh repo and resolve `paths` at HEAD. */
function resolveIn(files: Record<string, string>, paths: string[]): Map<string, Resolution> {
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
    read: (p) => readFileSync(join(root, p), "utf8"),
  });
}

function readersOf(r: Resolution | undefined): string[] {
  return (r?.readers ?? []).map((x) => `${x.file}:${x.lines.join(",")}:${x.rule}`);
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
    expect(readersOf(refs.get("data/rows.csv"))).toEqual([]);
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
    expect(readersOf(refs.get("pkg/golden-cases/deep/t1.txt"))).toEqual(["pkg/walk.test.ts:1:path-part"]);
  });

  // An opaque file that can change how tests run hides its effect from any
  // search, so the changed file must fail open.
  it("notes a caveat when build or CI config names it", () => {
    const refs = resolveIn(
      {
        "data/seed.json": "{}\n",
        "src/seed.test.ts": "load('seed.json');\n",
        "package.json": '{ "scripts": { "pretest": "cp data/seed.json build/" } }\n',
      },
      ["data/seed.json"],
    );
    expect(refs.get("data/seed.json")?.caveats).toContain("package.json mentions it and can change how tests run");
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

  // `ignore` says a change to tools/ cannot matter, not that tools/ cannot read this file.
  // A runbook names the file, dependabot config names the runbook's folder, and
  // review-bot config names .github: no test process reads any of them.
  // Found on a real PR: every module importing a sibling of the fixture's
  // folder counted, because only the first segment after a folder was checked.
  it("does not count a path that turns off the file's path", () => {
    const refs = resolveIn(
      {
        "lib/upload/testdata/band.csv": "a\n",
        "lib/upload/grid.test.ts": "const band = fixture('band.csv');\n",
        "app/wizard.tsx": "import { csvToGrid } from '@/lib/upload/grid';\n",
        "app/types.ts": "export type { Row } from '@/lib/upload/types';\n",
        "lib/upload/loader.ts": "export const all = () => readdirSync(join(ROOT, 'lib/upload/testdata'));\n",
      },
      ["lib/upload/testdata/band.csv"],
    );
    expect(readersOf(refs.get("lib/upload/testdata/band.csv"))).toEqual(["lib/upload/grid.test.ts:1:name", "lib/upload/loader.ts:1:path-part"]);
  });

  // Review of #51: a template or an app-router folder used to end the
  // comparison and count at once, so every route under `[uuid]` was a reader.
  it("keeps comparing past a template, and matches [param] and (group) folders as written", () => {
    const fixture = "app/(shop)/new/testdata/band.csv";
    const refs = resolveIn(
      {
        [fixture]: "a\n",
        "app/(shop)/new/loader.ts": 'export const read = (n: string) => load(join(dir, "testdata/", n));\n',
        "app/page.tsx": "import { Badge } from '@/app/(shop)/[id]/new/badge';\n",
        "app/nav.ts": "router.push(`/app/${section}/new/checkout`);\n",
        "app/all.test.ts": 'const cases = globSync("app/(shop)/**/*.csv");\n',
        "app/kind.test.ts": "const rows = read(`app/(shop)/${kind}/testdata/band.csv`);\n",
        "app/other.test.ts": "const rows = read(`app/(shop)/${kind}/testdata/other.csv`);\n",
      },
      [fixture],
    );
    expect(readersOf(refs.get(fixture))).toEqual([
      "app/kind.test.ts:1:name",
      "app/(shop)/new/loader.ts:1:path-part",
      "app/all.test.ts:1:path-part",
    ]);
  });

  // Review: every file mentioning a parent folder was read to see whether it
  // walks directories -- 5,000 git shows to find nothing on a large repo.
  it("reads no file when no mention needs to know whether it walks", () => {
    const files: Record<string, string> = { "src/data/config.json": "{}\n" };
    for (let n = 0; n < 200; n++) files[`src/lib${n}.test.ts`] = `import { f } from "../src/lib${n}";\n`;
    const root = join(mkdtempSync(join(tmpdir(), "blastline-refs-")), "repo");
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: ENV });
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    let reads = 0;
    const refs = resolveReferences(git, "HEAD", ["src/data/config.json"], {
      hasNodes: (p) => CODE.test(p),
      read: (p) => {
        reads++;
        return readFileSync(join(root, p), "utf8");
      },
    });
    expect(readersOf(refs.get("src/data/config.json"))).toEqual([]);
    expect(reads).toBe(0);
  });

  it("does not count a higher folder named on its own", () => {
    const refs = resolveIn(
      {
        "api/config/limits.yml": "x: 1\n",
        "api/src/limits.test.ts": "load('limits.yml');\n",
        "tools/run.ts": 'exec("gradle test", { cwd: "api" });\n',
        "tools/scan.ts": 'for (const f of globSync("api")) check(f);\n',
      },
      ["api/config/limits.yml"],
    );
    // run.ts only works in api/; scan.ts walks it.
    expect(readersOf(refs.get("api/config/limits.yml"))).toEqual(["api/src/limits.test.ts:1:name", "tools/scan.ts:1:path-part"]);
  });

  it("does not follow repository metadata only hosted services read", () => {
    const refs = resolveIn(
      {
        "config/limits.yml": "x: 1\n",
        "src/limits.test.ts": "load('limits.yml');\n",
        "ops/alerts.yml": "runbook: tune config/limits.yml\n",
        ".github/dependabot.yml": 'updates:\n  - directory: "/ops"\n',
        ".coderabbit.yaml": "path_filters: ['.github/**']\n",
        CODEOWNERS: "config/limits.yml @team\n",
        ".github/workflows/lint.yml": "run: coderabbit --config .coderabbit.yaml\n",
      },
      ["config/limits.yml"],
    );
    expect(readersOf(refs.get("config/limits.yml"))).toEqual(["src/limits.test.ts:1:name"]);
    // Followed, the review-bot config would lead to the workflow naming it.
    expect(refs.get("config/limits.yml")?.caveats).toEqual(["ops/alerts.yml mentions it; nothing found runs it"]);
  });

  it("counts readers the ignore list covers", () => {
    const refs = resolveIn(
      { "data/rows.csv": "a\n", "src/rows.test.ts": "load('rows.csv');\n", "tools/ci.ts": "upload('rows.csv');\n" },
      ["data/rows.csv"],
    );
    expect(readersOf(refs.get("data/rows.csv"))).toEqual(["src/rows.test.ts:1:name", "tools/ci.ts:1:name"]);
  });

  it("never resolves a file loaded by convention", () => {
    const refs = resolveIn({ "src/test/resources/logback-test.xml": "<configuration/>\n", "src/A.kt": 'val f = "logback-test.xml"\n' }, [
      "src/test/resources/logback-test.xml",
    ]);
    expect(refs.has("src/test/resources/logback-test.xml")).toBe(false);
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
      "src/test/kotlin/ProbeTest.kt:2:name",
      "src/test/kotlin/MatrixTest.kt:1:spring-profile",
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
  it("notes a caveat when a Spring config's profiles block names the profile", () => {
    const refs = resolveIn(
      { ...SPRING, "src/main/resources/application.yml": "spring:\n  profiles:\n    group:\n      staging: production, staging\n" },
      [PROFILE],
    );
    expect(refs.get(PROFILE)?.caveats).toContain("src/main/resources/application.yml activates profile production in its profiles block");
  });

  it("notes a caveat when a CI workflow runs tests with the profile", () => {
    const refs = resolveIn({ ...SPRING, ".github/workflows/ci.yml": "env:\n  SPRING_PROFILES_ACTIVE: production\n" }, [PROFILE]);
    expect(refs.get(PROFILE)?.caveats).toContain(".github/workflows/ci.yml activates profile production");
  });

  // Micronaut and Quarkus read application.yml too, by their own rules.
  it("treats application.yml as convention-loaded outside a Spring repository", () => {
    const refs = resolveIn({ "src/main/resources/application.yml": "x: 1\n", "src/A.kt": 'val f = "application.yml"\n' }, [
      "src/main/resources/application.yml",
    ]);
    expect(refs.has("src/main/resources/application.yml")).toBe(false);
  });
});

// Each case below was a reader the first version missed, found in review: the
// file resolved, and a test that reads it silently stopped running.
describe("resolveReferences: readers that build the path", () => {
  it("finds a stem, a folder joined in code, and an extensionless require", () => {
    const refs = resolveIn(
      {
        "test/fixtures/rows.json": "[]\n",
        "test/a.test.ts": "import rows from '../fixtures/rows.json';\n",
        "test/helper.ts": 'export const loadFixture = (name: string) => read(join(__dirname, "../fixtures", name + ".json"));\n',
        "test/b.test.ts": 'test("b", () => loadFixture("rows"));\n',
        "test/c.test.js": 'const rows = require("../fixtures/rows");\n',
        "test/d.test.ts": 'import raw from "../fixtures/rows?raw";\n',
        "test/e.test.ts": 'const data = read(`../fixtures/rows.${ext}`);\n',
        "test/f_test.py": 'SCRIPT = """\n    cd test && cat fixtures/rows | jq .\n"""\n',
        "src/unrelated.ts": 'import { x } from "../lib/fixtures-free";\n',
      },
      ["test/fixtures/rows.json"],
    );
    expect(readersOf(refs.get("test/fixtures/rows.json"))).toEqual([
      "test/a.test.ts:1:name",
      "test/b.test.ts:1:path-part",
      "test/c.test.js:1:path-part",
      "test/d.test.ts:1:path-part",
      "test/e.test.ts:1:path-part",
      "test/f_test.py:2:path-part",
      "test/helper.ts:1:path-part",
    ]);
  });

  it("finds directory walkers in Go, Kotlin, Java, Ruby and go:embed", () => {
    const refs = resolveIn(
      {
        "pkg/testdata/case1.json": "{}\n",
        "pkg/walk_test.go": 'entries, _ := os.ReadDir("testdata")\n',
        "app/src/test/resources/cases/c.yml": "x: 1\n",
        "app/src/test/kotlin/CasesTest.kt": 'val all = File("src/test/resources/cases").walk().toList()\n',
        "app/src/test/java/ListTest.java": 'String[] names = new File("app/src/test/resources/cases").list();\n',
        "spec/fixtures/users.yml": "- a\n",
        "spec/users_test.rb": "Dir[File.join(__dir__, 'fixtures', '*.yml')].each { |f| load f }\n",
        "cmd/static/app.css": "body{}\n",
        "cmd/server.go": "package cmd\n\n//go:embed static\nvar assets embed.FS\n",
      },
      ["pkg/testdata/case1.json", "app/src/test/resources/cases/c.yml", "spec/fixtures/users.yml", "cmd/static/app.css"],
    );
    expect(readersOf(refs.get("pkg/testdata/case1.json"))).toEqual(["pkg/walk_test.go:1:path-part"]);
    // The Ruby glob over `*.yml` counts too: a glob over the extension is not
    // checked against the folder, which only ever adds readers.
    expect(readersOf(refs.get("app/src/test/resources/cases/c.yml"))).toEqual([
      "app/src/test/java/ListTest.java:1:path-part",
      "app/src/test/kotlin/CasesTest.kt:1:path-part",
      "spec/users_test.rb:1:path-part",
    ]);
    expect(readersOf(refs.get("spec/fixtures/users.yml"))).toEqual(["spec/users_test.rb:1:path-part"]);
    expect(readersOf(refs.get("cmd/static/app.css"))).toEqual(["cmd/server.go:3:path-part"]);
  });

  it("reads Rust attributes, which start like a comment", () => {
    const refs = resolveIn(
      {
        "tests/resources/one.txt": "1\n",
        "tests/all.rs": '#[rstest]\nfn each(#[files("tests/resources/*.txt")] p: PathBuf) {}\n',
        "migrations/fixtures/users.sql": "insert;\n",
        "tests/db.rs": '#[sqlx::test(fixtures("../migrations/fixtures/users.sql"))]\nasync fn t() {}\n',
      },
      ["tests/resources/one.txt", "migrations/fixtures/users.sql"],
    );
    expect(readersOf(refs.get("tests/resources/one.txt"))).toEqual(["tests/all.rs:2:path-part"]);
    expect(readersOf(refs.get("migrations/fixtures/users.sql"))).toEqual(["tests/db.rs:1:name"]);
  });

  it("finds a folder named as the tail of a bare relative path", () => {
    const refs = resolveIn(
      { "test/cli/rows.bats": "@test rows { true; }\n", "test/run.sh": "cd test && bats ./cli\n", "test/run.py": 'subprocess.run(["sh", "run.sh"])\n' },
      ["test/cli/rows.bats"],
    );
    expect(readersOf(refs.get("test/cli/rows.bats"))).toEqual(["test/run.py:1:name"]);
  });

  // bats runs the folder the Makefile names, which no name search finds.
  it("notes a caveat when nothing found runs a non-code reader", () => {
    const refs = resolveIn(
      {
        "test/fixtures/rows.json": "[]\n",
        "test/cli/rows.bats": "@test rows { run jq length test/fixtures/rows.json; }\n",
        Makefile: "cli-test:\n\tbats test/cli\n",
      },
      ["test/fixtures/rows.json"],
    );
    expect(refs.get("test/fixtures/rows.json")?.caveats).toContain("test/cli/rows.bats mentions it; nothing found runs it");
  });
});

describe("resolveReferences: Spring tests found through inheritance", () => {
  const BASE = {
    "pom.xml": "<groupId>org.springframework.boot</groupId>\n",
    "src/main/resources/application.yml": "server: {}\n",
    "src/main/resources/application-production.yml": "x: 1\n",
    "src/test/java/BaseIT.java": '@SpringBootTest\n@ActiveProfiles("production")\npublic abstract class BaseIT {}\n',
    "src/test/java/OrderIT.java": "class OrderIT extends BaseIT {\n  @Test void t() {}\n}\n",
    "src/test/java/IntegrationTest.java": "@SpringBootTest\n@Retention(RUNTIME)\npublic @interface IntegrationTest {}\n",
    "src/test/java/PaymentTest.java": "@IntegrationTest\nclass PaymentTest {}\n",
    "src/test/kotlin/RefundIT.kt": "class RefundIT : BaseIT() {\n}\n",
  };

  it("selects subclasses and annotated classes for the base file", () => {
    const refs = resolveIn(BASE, ["src/main/resources/application.yml"]);
    expect(readersOf(refs.get("src/main/resources/application.yml")).map((r) => r.split(":")[0])).toEqual([
      "src/test/java/BaseIT.java",
      "src/test/java/IntegrationTest.java",
      "src/test/java/OrderIT.java",
      "src/test/java/PaymentTest.java",
      "src/test/kotlin/RefundIT.kt",
    ]);
  });

  it("selects subclasses of a class that activates the profile", () => {
    const refs = resolveIn(BASE, ["src/main/resources/application-production.yml"]);
    expect(readersOf(refs.get("src/main/resources/application-production.yml")).map((r) => r.split(":")[0])).toEqual([
      "src/test/java/BaseIT.java",
      "src/test/java/OrderIT.java",
      "src/test/kotlin/RefundIT.kt",
    ]);
  });

  it("notes a caveat when a profile is activated through a constant", () => {
    const refs = resolveIn(
      { ...BASE, "src/test/java/ProdTest.java": "@SpringBootTest\n@ActiveProfiles(Profiles.PRODUCTION)\nclass ProdTest {}\n" },
      ["src/main/resources/application-production.yml"],
    );
    expect(refs.get("src/main/resources/application-production.yml")?.caveats).toContain("src/test/java/ProdTest.java activates profiles through an expression, not a literal");
  });

  // A compose file activating the profile matters only through whatever runs it.
  it("follows a non-code activator to the code that runs it, and notes build config as a caveat", () => {
    const compose = {
      ...BASE,
      "docker-compose.test.yml": "services:\n  api:\n    environment:\n      - SPRING_PROFILES_ACTIVE=production\n",
      "src/test/java/E2ETest.java": 'class E2ETest { Compose c = new Compose(new File("docker-compose.test.yml")); }\n',
    };
    const viaCompose = resolveIn(compose, ["src/main/resources/application-production.yml"]);
    expect(readersOf(viaCompose.get("src/main/resources/application-production.yml")).map((r) => r.split(":")[0])).toContain(
      "src/test/java/E2ETest.java",
    );
    const viaMaven = resolveIn({ ...BASE, ".mvn/maven.config": "-Dspring.profiles.active=production\n" }, [
      "src/main/resources/application-production.yml",
    ]);
    expect(viaMaven.get("src/main/resources/application-production.yml")?.caveats).toContain(".mvn/maven.config activates profile production");
  });
});
