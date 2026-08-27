/**
 * Recognize a CMake change that does nothing but register new test targets.
 *
 * A build file has no graph node, so any diff touching one fails the whole
 * selection open (`unmapped-file`). That is right in general — nothing in the
 * graph can say what depends on a CMakeLists — but it makes selection blind on
 * exactly the pull requests that ADD tests, because registering a test means
 * editing the file that declares it (issue #22).
 *
 * The narrow case this closes: a purely additive hunk that declares new test
 * executables and registers them with `add_test`. Then the file is not opaque
 * at all — it says precisely which tests appeared, and their sources can seed
 * the walk like any other changed test file.
 *
 * Everything else still fails open. A CMakeLists edit can change a compile
 * flag, a link library, or a helper macro in ways that affect every target in
 * the file, and no line-level rule can tell that apart from a registration. So
 * this parser is written to REFUSE on anything it does not fully understand:
 * any removed line, any command it cannot attribute to a newly declared
 * target, any stray text outside a command.
 */

/** One parsed CMake command invocation: `name(arg arg ...)`. */
interface Command {
  name: string;
  args: string[];
}

/** A test target declared by an added `add_executable` + `add_test` pair. */
export interface DeclaredTest {
  target: string;
  /** Source paths as spelled in `add_executable`, relative to the CMake file. */
  sources: string[];
}

/** `CMakeLists.txt`, or a `*.cmake` module. */
export function isCMakePath(path: string): boolean {
  return /(^|\/)CMakeLists\.txt$/.test(path) || /\.cmake$/.test(path);
}

/**
 * Tokenize CMake source into complete commands. Returns null when the text
 * contains anything outside a well-formed `name(...)` invocation — an
 * unbalanced paren from a partial hunk, or a bare word. Comments and blank
 * lines are ignored. Quoted arguments are kept whole so a path with a space
 * survives, and `$`-expansions are left verbatim for the caller to reject.
 */
function parseCommands(text: string): Command[] | null {
  const commands: Command[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i] as string;
    if (ch === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // A command name: identifier characters up to the opening paren.
    const nameStart = i;
    while (i < n && /[A-Za-z0-9_]/.test(text[i] as string)) i++;
    const name = text.slice(nameStart, i);
    if (name.length === 0) return null; // stray punctuation outside a command
    while (i < n && /\s/.test(text[i] as string)) i++;
    if (text[i] !== "(") return null; // a bare word is not a command
    i++;

    const args: string[] = [];
    let current = "";
    let depth = 1;
    let quoted = false;
    let closed = false;
    for (; i < n; i++) {
      const c = text[i] as string;
      if (quoted) {
        if (c === "\\" && i + 1 < n) {
          current += text[i + 1];
          i++;
          continue;
        }
        if (c === '"') {
          quoted = false;
          continue;
        }
        current += c;
        continue;
      }
      if (c === '"') {
        quoted = true;
        continue;
      }
      if (c === "#") {
        while (i < n && text[i] !== "\n") i++;
        continue;
      }
      if (c === "(") {
        depth++;
        current += c;
        continue;
      }
      if (c === ")") {
        depth--;
        if (depth === 0) {
          if (current.length > 0) args.push(current);
          i++;
          closed = true;
          break;
        }
        current += c;
        continue;
      }
      if (/\s/.test(c)) {
        if (current.length > 0) {
          args.push(current);
          current = "";
        }
        continue;
      }
      current += c;
    }
    if (!closed || quoted) return null; // ran off the end mid-command
    commands.push({ name: name.toLowerCase(), args });
  }
  return commands;
}

/** `add_test(NAME <target> COMMAND ...)` — the keyword form CTest registers by. */
function addTestTarget(cmd: Command): string | null {
  const nameIdx = cmd.args.findIndex((a) => a === "NAME");
  if (nameIdx === -1) return null;
  return cmd.args[nameIdx + 1] ?? null;
}

/**
 * Read a purely-additive CMake hunk as a set of newly registered tests, or
 * return null to mean "fail open" — which is the answer for every input this
 * cannot prove is nothing but test registration.
 *
 * Accepted shape: at least one `add_test(NAME t ...)`, an `add_executable(t
 * src...)` for every such `t`, and NO other command that touches anything but
 * those targets. `target_link_libraries(t ...)`, `set_tests_properties(t ...)`
 * and project helper macros like `cgraph_set_warnings(t)` all pass on the
 * strength of naming a declared target first; a command naming an existing
 * target, or none at all, fails the whole file open.
 */
export function declaredTests(added: string[], removed: string[]): DeclaredTest[] | null {
  // Any removal can retire or rewire a target. Additive-only, to start.
  if (removed.some((l) => l.trim().length > 0)) return null;
  const text = added.join("\n");
  if (text.trim().length === 0) return null;
  // A generator expression or variable could name anything at configure time.
  if (text.includes("${") || text.includes("$<")) return null;

  const commands = parseCommands(text);
  if (commands === null) return null;

  const executables = new Map<string, string[]>();
  for (const cmd of commands) {
    if (cmd.name !== "add_executable") continue;
    const target = cmd.args[0];
    if (target === undefined) return null;
    // `add_executable(name IMPORTED)` / `ALIAS` declare no sources of our kind.
    const sources = cmd.args.slice(1).filter((a) => !/^[A-Z_]+$/.test(a));
    if (sources.length === 0) return null;
    executables.set(target, sources);
  }

  const targets = new Set<string>();
  for (const cmd of commands) {
    if (cmd.name !== "add_test") continue;
    const target = addTestTarget(cmd);
    // Only the NAME keyword form is understood; the legacy positional form
    // `add_test(<name> <exe> ...)` is not, so it fails open.
    if (target === null || !executables.has(target)) return null;
    targets.add(target);
  }
  if (targets.size === 0) return null;

  // Every command must be attributable to one of the newly declared targets.
  for (const cmd of commands) {
    if (cmd.name === "add_test") continue; // already checked via NAME
    const first = cmd.args[0];
    if (first === undefined || !targets.has(first)) return null;
  }

  return [...targets].sort().map((target) => ({
    target,
    sources: executables.get(target) as string[],
  }));
}
