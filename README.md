# Kotlin Test Adapter for VS Code

<p align="center">
  <img src="images/icon.png" alt="Kotlin Test Adapter" width="128" />
</p>

<p align="center">
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.80-007ACC?logo=visualstudiocode&logoColor=white" />
  <img alt="Kotlin" src="https://img.shields.io/badge/Kotlin-2.x-7F52FF?logo=kotlin&logoColor=white" />
  <img alt="JUnit 5" src="https://img.shields.io/badge/JUnit-5-25A162?logo=junit5&logoColor=white" />
  <img alt="Gradle" src="https://img.shields.io/badge/Gradle-multi--module-02303A?logo=gradle&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
  <img alt="CI" src="https://github.com/rokuko/vscode-kotlin-test-adapter/actions/workflows/ci.yml/badge.svg" />
</p>

A Visual Studio Code extension that discovers, runs and reports **Kotlin** unit
tests authored with **JUnit 5** in **Gradle** projects (single- or multi-module).

It uses VS Code's native [Testing API](https://code.visualstudio.com/api/extension-guides/testing),
so tests show up in the built-in **Test Explorer** view automatically. To use
the legacy [`hbenl.vscode-test-explorer`](https://marketplace.visualstudio.com/items?itemName=hbenl.vscode-test-explorer)
UI, install the [`ms-vscode.test-adapter-converter`](https://marketplace.visualstudio.com/items?itemName=ms-vscode.test-adapter-converter)
extension which adapts the native API to the Test Adapter protocol.

## Status

This is an MVP focused on:

- ✅ Kotlin + JUnit 5 test discovery (regex-based, no LSP required)
- ✅ Gradle multi-module support (auto-discovers subprojects)
- ✅ Run via Gradle (`./gradlew :module:test --tests ...`)
- ✅ JUnit XML result parsing (pass / fail / skipped, durations, messages)
- ✅ Refresh on file save / via command
- ⏳ Debug support (currently falls back to Run; planned)
- ⏳ Kotest / Spek (planned)
- ⏳ kotlin-lsp powered semantic discovery (planned)

## How discovery works

1. The extension scans each workspace folder for Gradle build scripts
   (`build.gradle`, `build.gradle.kts`, `settings.gradle*`).
2. Every directory containing a build script becomes a **module** in the test
   tree.
3. For each module, files matching `kotlinTestAdapter.testSourceGlobs` are
   scanned with a lightweight Kotlin tokenizer that recognises:
   - the `package` declaration,
   - top-level `class` / `object` declarations,
   - functions annotated with `@Test`, `@ParameterizedTest`, `@RepeatedTest` or
     `@TestFactory`.
4. Results are grouped by class and surfaced in the Test Explorer.

## Running tests

When you click ▶ on an item, the extension invokes Gradle in the workspace
folder for the corresponding module:

```
./gradlew :module:test --tests "fq.ClassName.methodName" --rerun-tasks --continue
```

Reports are read from `build/test-results/<task>/*.xml` and applied back to
each `TestItem`.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `kotlinTestAdapter.gradleCommand` | _(auto)_ | Override the Gradle command. Falls back to `./gradlew` (or `gradlew.bat`) if a wrapper exists, otherwise `gradle`. |
| `kotlinTestAdapter.gradleExtraArgs` | `[]` | Extra arguments appended to every Gradle invocation. |
| `kotlinTestAdapter.testSourceGlobs` | _src/test/kotlin/**/*.kt, …_ | Globs (relative to each module) used to find test files. |
| `kotlinTestAdapter.excludeGlobs` | `**/build/**, **/.gradle/**, **/node_modules/**` | Globs excluded from discovery. |

## Sample project

The repository ships with a multi-module Gradle Kotlin sample under
[`sample/`](sample) that you can use to try the extension:

```
sample/
├── settings.gradle.kts        # includes :core and :app
├── build.gradle.kts
├── core/
│   ├── build.gradle.kts
│   └── src/{main,test}/kotlin/sample/core/
└── app/
    ├── build.gradle.kts
    └── src/test/kotlin/sample/app/
```

Press `F5` in this repository to launch a new Extension Development Host
already opened on the `sample/` folder.

## Building the extension

```bash
bun install
bun run compile
```

Then either press `F5` or package with `vsce package`.

## License

MIT
