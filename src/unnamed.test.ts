import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ignorePatternFor, unnamedFiles } from "./unnamed.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

/** A committed repo holding `files`; `git` runs in it the way run.ts does. */
function repo(files: Record<string, string>): { root: string; git: (...a: string[]) => string } {
  const root = join(mkdtempSync(join(tmpdir(), "blastline-unnamed-")), "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: ENV });
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { root, git };
}

describe("unnamedFiles", () => {
  // The shape of a real fail-open PR on a Spring service: the compose files and
  // the openspec metadata are named by nothing (Markdown does not count), the
  // Dockerfile is named by compose, and the profile file is named by nothing
  // yet loaded by Spring's convention.
  it("offers only files no code names and no convention loads", () => {
    const { git } = repo({
      "docker-compose.yml": "services:\n  api:\n    build:\n      dockerfile: Dockerfile\n",
      "docker-compose.prod.yml": "services: {}\n",
      "api/Dockerfile": "FROM eclipse-temurin:21\n",
      "api/src/main/resources/application-production.yml": "management: {}\n",
      "openspec/changes/retry-policy/.openspec.yaml": "schema: spec-driven\n",
      "openspec/changes/retry-policy/design.md": "Uses docker-compose.prod.yml and .openspec.yaml\n",
      "README.md": "Run docker-compose.prod.yml in prod.\n",
      "api/src/Main.kt": "fun main() {}\n",
    });
    const unmapped = [
      "docker-compose.yml",
      "docker-compose.prod.yml",
      "api/Dockerfile",
      "api/src/main/resources/application-production.yml",
      "openspec/changes/retry-policy/.openspec.yaml",
    ];
    expect([...unnamedFiles(git, "HEAD", unmapped)].sort()).toEqual([
      "docker-compose.prod.yml",
      "docker-compose.yml",
      "openspec/changes/retry-policy/.openspec.yaml",
    ]);
  });

  // A loader that walks a folder names no single file in it. Offering a new
  // migration for `ignore` would hide it from the test that applies it.
  it("treats a file as named when code names its directory", () => {
    const { git } = repo({
      "db/seeds/047-new.sql": "INSERT 1;\n",
      "src/test/MigrationTest.kt": 'val dir = Paths.get("db/seeds") // walks every .sql\n',
    });
    expect(unnamedFiles(git, "HEAD", ["db/seeds/047-new.sql"]).size).toBe(0);
  });

  // Found in review: only the parent folder used to count, so a glob or walk
  // naming a folder higher up read as "unnamed" and the files were offered.
  it("treats a file as named when code names any folder above it", () => {
    const { git } = repo({
      "test/cases/users/alice.json": "{}\n",
      "test/load.ts": 'glob.sync("cases/**/*.json");\n',
      "pkg/parse/golden-cases/deep/t1.txt": "want\n",
      "pkg/parse/parse_test.go": 'filepath.WalkDir("golden-cases", visit)\n',
    });
    expect(unnamedFiles(git, "HEAD", ["test/cases/users/alice.json", "pkg/parse/golden-cases/deep/t1.txt"]).size).toBe(0);
  });

  it("ignores case, since lookups on case-insensitive filesystems still find the file", () => {
    const { git } = repo({ "assets/logo.png.txt": "x\n", "src/ui.ts": 'load("Logo.PNG.txt");\n' });
    expect(unnamedFiles(git, "HEAD", ["assets/logo.png.txt"]).size).toBe(0);
  });

  // Test runners read these by convention: a snapshot, a folder of cases, and
  // toolchain or build files that shape every test. Nothing names any of them.
  it("never offers snapshots, fixture folders, or toolchain and build files", () => {
    const conventional = [
      "src/__snapshots__/foo.test.ts.snap",
      "src/bar.test.ts.snap",
      "test/fixtures/users/alice.json",
      "pkg/parse/testdata/cases/t1.golden",
      ".babelrc.json",
      "Makefile",
      "rust-toolchain.toml",
      ".cargo/config.toml",
      "phpunit.xml",
      "pubspec.yaml",
      "Package.resolved",
      ".rspec",
      ".coveragerc",
    ];
    const { git } = repo(Object.fromEntries(conventional.map((p) => [p, "x\n"])));
    expect([...unnamedFiles(git, "HEAD", conventional)]).toEqual([]);
  });

  // Named by nothing, yet read on every run: Spring picks up ./config/application.yml
  // by location, and a Thymeleaf view is loaded as "welcome", never "welcome.html".
  it("never offers a file a framework loads by convention", () => {
    const { git } = repo({
      "config/application.yml": "server: {}\n",
      "app/src/main/resources/templates/welcome.html": "<p>hi</p>\n",
      "app/src/main/kotlin/Views.kt": 'fun home() = "welcome"\n',
    });
    const conventional = ["config/application.yml", "app/src/main/resources/templates/welcome.html"];
    expect(unnamedFiles(git, "HEAD", conventional).size).toBe(0);
  });

  it("does not let a file's mention of itself count as a reference", () => {
    const { git } = repo({ "tools/lint.yml": "# lint.yml: config for the lint job in tools\n" });
    expect([...unnamedFiles(git, "HEAD", ["tools/lint.yml"])]).toEqual(["tools/lint.yml"]);
  });

  // `git grep -o` reports one match per position, so the line below would
  // surface only "conf.yml" and hide "conf", marking conf/a.json unnamed.
  it("counts every name on a line, including one inside another", () => {
    const { git } = repo({
      "conf/a.json": "{}\n",
      "conf.yml": "a: 1\n",
      "src/load.ts": 'read("conf.yml");\n',
    });
    expect(unnamedFiles(git, "HEAD", ["conf/a.json", "conf.yml"]).size).toBe(0);
  });

  it("searches the given revision, not the working tree", () => {
    const { root, git } = repo({ "sample/rows.csv": "a,b\n", "src/app.ts": "export {};\n" });
    // The only reference is in a file that is not committed, nor even tracked.
    writeFileSync(join(root, "src/new.ts"), 'load("rows.csv");\n');
    expect([...unnamedFiles(git, "HEAD", ["sample/rows.csv"])]).toEqual(["sample/rows.csv"]);
    // Without a revision the working tree is searched, untracked files included.
    expect(unnamedFiles(git, undefined, ["sample/rows.csv"]).size).toBe(0);
  });

  it("propagates a search that could not run instead of calling everything unnamed", () => {
    const { git } = repo({ "a.txt": "x\n" });
    expect(() => unnamedFiles(git, "no-such-rev", ["a.txt"])).toThrow();
  });
});

describe("ignorePatternFor", () => {
  it("anchors and escapes, so the pattern matches exactly the one path", () => {
    const pattern = new RegExp(ignorePatternFor("openspec/changes/x/.openspec.yaml"));
    expect(pattern.test("openspec/changes/x/.openspec.yaml")).toBe(true);
    expect(pattern.test("openspec/changes/x/-openspec-yaml")).toBe(false);
    expect(pattern.test("vendor/openspec/changes/x/.openspec.yaml")).toBe(false);
  });
});
