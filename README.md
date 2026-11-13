# dsh-svn-review

Two things a code review needs before it can be right: **which files actually changed**, and **what kind of project this is**.

This plugin answers both, offline, with no `svn.exe` and no arguments.

## Why

**Scope.** SVN hides its change set behind a GUI on most machines — the TortoiseSVN commit dialog, the "Check for modifications" menu item. `svn status` gives the same answer, but plenty of installs only ship the GUI shell. The agent is exactly the party that needs that list. Without it you re-paste the rules every time and hope it stays in scope; with it, going out of scope becomes something a tool can check.

**Language.** "This could be a null pointer" is a real defect in Java and a false positive in TypeScript that already uses `?.`. "Add a lock" is good advice in a multi-threaded Java service and meaningless in a single-threaded JavaScript process. A reviewer that does not know the language produces confident nonsense — so this plugin pins down the language and version first, then hands over the matching rule file.

## Install

```sh
dsh plugin --profile web add dsh-svn-review
```

Refresh the page afterwards; a restart is usually not needed.

## What you get

| Name | Kind | Description |
|---|---|---|
| `svn_change_set` | tool | The working copy's change set: `M` modified, `A` added, `D` deleted, `!` missing, `C` conflicted — plus a summary of the detected stack |
| `project_profile` | tool | Language, version, build system, test infrastructure, and **which rule file to load** |

Both take one optional `path` (any directory inside the working copy; it walks up to `.svn/wc.db`).

### `project_profile`

| Field | Meaning |
|---|---|
| `languages[].language` / `.version` | Detected stack. `version: null` means *detected but undeclared* — never a guessed default |
| `languages[].file` | Absolute path to the language rule file. Read this before writing any finding |
| `languages[].available` | `false` when no rule file covers that language/version, with a `reason` |
| `languages[].evidence` | The exact build-file line the detection came from, so you can check it |
| `projectName` | Detected project name, used to look up `projects/<name>.md` |
| `build` | `gradle` / `maven` / `cmake` / `msbuild` / `npm` / `cargo` / … |
| `testInfra` | Test framework and version, if any. Empty means "add a unit test" is not an actionable suggestion |
| `concurrencyHints` | Concurrency-related dependencies found in build files. A hint, never a verdict |
| `rules` | Paths to the common rule files and to the project profile, if one exists |

Detected from build and project files:

| Language | Markers | Version source |
|---|---|---|
| Java | `build.gradle`, `pom.xml`, `*.java` | `sourceCompatibility`, `maven.compiler.source`, `java.version` |
| C / C++ | `CMakeLists.txt`, `Makefile`, `*.vcxproj` | `CMAKE_CXX_STANDARD`, `-std=c++NN`, `LanguageStandard` |
| C# | `*.csproj` | `TargetFramework`, `LangVersion` |
| JavaScript / TypeScript | `package.json`, `tsconfig.json` | `engines.node`, `typescript` version |
| Go | `go.mod` | `go` directive |
| Rust | `Cargo.toml` | `edition` |
| Python | `pyproject.toml`, `.python-version` | `requires-python` |
| Kotlin | `build.gradle(.kts)` kotlin plugin, `*.kt` | plugin version |
| HarmonyOS ArkTS | `build-profile.json5`, `module.json5`, `*.ets` | `compatibleSdkVersion` |
| Swift | `Package.swift`, `*.xcodeproj` | `swift-tools-version` |
| Dart / Flutter | `pubspec.yaml` | `sdk` constraint |
| PHP / Ruby / Scala | `composer.json`, `Gemfile`, `build.sbt` | `require.php`, `ruby`, `scalaVersion` |
| **anything else** | source file extensions | none — falls back to `generic.md` |

Detection runs two passes: build files give an authoritative **version**, and an extension census
(3000 files, 6 levels, skipping vendored directories) catches languages that ship no build file at
all — a Lua or Elixir repo still lands on a profile instead of "unknown".

Build scripts are often GBK-encoded, so matching happens on the raw bytes rather than a decoded string — the ASCII directives survive either way.

## Language rule files

The package ships a rule set under `rules/`:

```
rules/
├─ REVIEW_RULES.md          methodology: scope, severity, evidence, verdict
├─ SVN_WORKFLOW.md          what counts as in-scope for edits
├─ PROMPT.md                ready-to-paste commands
├─ languages/
│  ├─ java8.md              Java 8
│  ├─ kotlin.md             Kotlin
│  ├─ cpp.md                C / C++
│  ├─ csharp.md             C#
│  ├─ javascript.md         JavaScript / TypeScript
│  ├─ rust.md               Rust
│  ├─ go.md                 Go
│  ├─ python.md             Python
│  ├─ arkts.md              HarmonyOS ArkTS
│  └─ generic.md            fallback for any other language
└─ projects/_template.md    template for a project-specific profile
```

Each language file has the same shape: version constraints, idioms, real defects, and — the part that matters most — **a false-positive list**, meaning the findings that are wrong in that language specifically.

To use your own rule set instead of the bundled one, either set `DSH_SVN_REVIEW_RULES` or drop a `rules/local.json` (git- and npm-ignored) next to the package:

```json
{ "rulesRoot": "E:\\rules\\ai_code_review_files" }
```

`node tools/sync-rules.mjs` copies the shared rule files from a local rule set into the package before publishing.

## How the change set is decided

`NODES` records a base checksum and a commit-time snapshot (size, mtime) for every versioned file.

1. File gone → `!`
2. Size differs from the snapshot → `M`, decided without reading the file
3. Size and mtime both match the snapshot → skip, considered untouched
4. Same size, different mtime → SHA-1 the file and compare against the base checksum before calling it `M`

Step 3 matters: hashing every file in a several-thousand-file working copy takes a dozen seconds, while the fast path lands under one. Step 4 makes sure an edit that kept the length is still caught.

`A` / `D` come from nodes with `op_depth > 0`; conflicts come from `ACTUAL_NODE`.

## Limits

- No `?` (unversioned files). They cannot enter this commit, so they are not part of the change scope.
- No diff. Once you have the file list, the agent's own file-reading tool is a better fit than a diff grown inside the plugin.
- Requires Node's built-in `node:sqlite` (Node 22.5+; unflagged since 23.4). On an older host the tool says so instead of throwing a SQLite stack.
- Opens `.svn/wc.db` read-only and writes nothing into the working copy.
- Language detection reads build and project files only. It cannot infer a concurrency model — that belongs in a project profile.

## License

MIT
