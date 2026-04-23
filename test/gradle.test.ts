/**
 * Unit tests for src/gradle.ts
 *
 * discoverGradleModules uses real filesystem reads, so we create temporary
 * directories with fake build scripts and assert the discovered module list.
 * resolveGradleCommand is tested by controlling which wrapper file exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri } from './__mocks__/vscode';
import * as vscodeMock from './__mocks__/vscode';
import { discoverGradleModules, resolveGradleCommand } from '../src/gradle';
import type { GradleModule } from '../src/gradle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFolder(dir: string) {
    return {
        uri: Uri.file(dir),
        name: path.basename(dir),
        index: 0,
    } as any;
}

/** Write an empty file, creating parent directories as needed. */
function touch(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
}

// ---------------------------------------------------------------------------
// discoverGradleModules
// ---------------------------------------------------------------------------

describe('discoverGradleModules', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-kt-gradle-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── BugG1 ────────────────────────────────────────────────────────────────
    // A workspace with no build files at all should return an empty array.
    // (Not a Gradle project — extension should not activate for it.)
    it('[BugG1] returns empty array when no Gradle files exist', async () => {
        const modules = await discoverGradleModules(makeFolder(tmpDir));
        expect(modules).toHaveLength(0);
    });

    it('discovers root module when build.gradle.kts exists', async () => {
        touch(path.join(tmpDir, 'build.gradle.kts'));
        const modules = await discoverGradleModules(makeFolder(tmpDir));
        expect(modules).toHaveLength(1);
        expect(modules[0].projectPath).toBe(':');
        expect(modules[0].rootPath).toBe(tmpDir);
        expect(modules[0].name).toBe(path.basename(tmpDir));
    });

    it('discovers root module when build.gradle (groovy) exists', async () => {
        touch(path.join(tmpDir, 'build.gradle'));
        const modules = await discoverGradleModules(makeFolder(tmpDir));
        expect(modules).toHaveLength(1);
        expect(modules[0].projectPath).toBe(':');
    });

    it('discovers submodules in a multi-module build', async () => {
        touch(path.join(tmpDir, 'build.gradle.kts'));
        touch(path.join(tmpDir, 'settings.gradle.kts'));
        touch(path.join(tmpDir, 'core', 'build.gradle.kts'));
        touch(path.join(tmpDir, 'app', 'build.gradle.kts'));

        const modules = await discoverGradleModules(makeFolder(tmpDir));
        const paths = modules.map(m => m.projectPath).sort();
        expect(paths).toEqual([':', ':app', ':core']);
    });

    it('submodule has correct rootPath and name', async () => {
        touch(path.join(tmpDir, 'build.gradle.kts'));
        touch(path.join(tmpDir, 'core', 'build.gradle.kts'));

        const modules = await discoverGradleModules(makeFolder(tmpDir));
        const core = modules.find(m => m.projectPath === ':core')!;
        expect(core.rootPath).toBe(path.join(tmpDir, 'core'));
        expect(core.name).toBe('core');
    });

    // ── BugG2 ────────────────────────────────────────────────────────────────
    // A root with settings.gradle but NO build.gradle must NOT add the root as a
    // module — it's an aggregator-only root. Submodules are still discovered.
    it('[BugG2] root with only settings.gradle is not added as a module', async () => {
        touch(path.join(tmpDir, 'settings.gradle.kts'));
        touch(path.join(tmpDir, 'lib', 'build.gradle.kts'));

        const modules = await discoverGradleModules(makeFolder(tmpDir));
        const rootModule = modules.find(m => m.projectPath === ':');
        expect(rootModule).toBeUndefined();
        expect(modules).toHaveLength(1);
        expect(modules[0].projectPath).toBe(':lib');
    });

    it('skips build/, .gradle/, and node_modules/ directories', async () => {
        touch(path.join(tmpDir, 'build.gradle.kts'));
        // These should be skipped:
        touch(path.join(tmpDir, 'build', 'classes', 'build.gradle.kts'));
        touch(path.join(tmpDir, '.gradle', 'build.gradle.kts'));
        touch(path.join(tmpDir, 'node_modules', 'some-pkg', 'build.gradle.kts'));
        // This should be found:
        touch(path.join(tmpDir, 'feature', 'build.gradle.kts'));

        const modules = await discoverGradleModules(makeFolder(tmpDir));
        const paths = modules.map(m => m.projectPath).sort();
        expect(paths).toEqual([':', ':feature']);
    });

    it('handles deeply nested submodules', async () => {
        touch(path.join(tmpDir, 'build.gradle.kts'));
        touch(path.join(tmpDir, 'services', 'auth', 'build.gradle.kts'));

        const modules = await discoverGradleModules(makeFolder(tmpDir));
        const paths = modules.map(m => m.projectPath).sort();
        expect(paths).toContain(':services:auth');
    });

    // ── BugG3 ────────────────────────────────────────────────────────────────
    // The workspaceFolder reference on each module must point back to the folder
    // that was passed in, not some derived value.
    it('[BugG3] each module carries the correct workspaceFolder reference', async () => {
        touch(path.join(tmpDir, 'build.gradle.kts'));
        touch(path.join(tmpDir, 'lib', 'build.gradle.kts'));

        const folder = makeFolder(tmpDir);
        const modules = await discoverGradleModules(folder);
        for (const m of modules) {
            expect(m.workspaceFolder).toBe(folder);
        }
    });
});

// ---------------------------------------------------------------------------
// resolveGradleCommand
// ---------------------------------------------------------------------------

describe('resolveGradleCommand', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-kt-gradle-cmd-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('falls back to system gradle when no wrapper exists', () => {
        const folder = makeFolder(tmpDir);
        const { command, cwd } = resolveGradleCommand(folder);
        expect(command).toBe('gradle');
        expect(cwd).toBe(tmpDir);
    });

    it('uses ./gradlew when the wrapper is present (POSIX)', () => {
        if (process.platform === 'win32') return; // skip on Windows
        touch(path.join(tmpDir, 'gradlew'));
        const folder = makeFolder(tmpDir);
        const { command } = resolveGradleCommand(folder);
        expect(command).toBe('./gradlew');
    });

    it('uses gradlew.bat when the bat wrapper is present (Windows)', () => {
        if (process.platform !== 'win32') return; // skip on POSIX
        touch(path.join(tmpDir, 'gradlew.bat'));
        const folder = makeFolder(tmpDir);
        const { command } = resolveGradleCommand(folder);
        expect(command).toContain('gradlew.bat');
    });

    // ── BugG4 ────────────────────────────────────────────────────────────────
    // A config override (kotlinTestAdapter.gradleCommand) must take priority over
    // any auto-detection, even when a gradlew wrapper exists.
    it('[BugG4] config override takes priority over wrapper auto-detection', () => {
        touch(path.join(tmpDir, 'gradlew')); // wrapper exists but should be ignored
        const folder = makeFolder(tmpDir);

        // Patch the mock workspace config to return a non-empty gradleCommand override.
        const origGetConfig = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key: string) => key === 'gradleCommand' ? './custom-gradle' : undefined,
        });
        try {
            const { command } = resolveGradleCommand(folder);
            expect(command).toBe('./custom-gradle');
        } finally {
            vscodeMock.workspace.getConfiguration = origGetConfig;
        }
    });

    // ── BugG5 ────────────────────────────────────────────────────────────────
    // On Windows, if gradlew.bat resides in a path that contains spaces, the command
    // must be an absolute path (not just relative). resolveGradleCommand already
    // returns the absolute path on Windows — this test verifies the behavior.
    it('[BugG5] Windows gradlew.bat command is an absolute path (not ./gradlew.bat)', () => {
        if (process.platform !== 'win32') return; // Windows-only
        touch(path.join(tmpDir, 'gradlew.bat'));
        const folder = makeFolder(tmpDir);
        const { command } = resolveGradleCommand(folder);
        expect(path.isAbsolute(command)).toBe(true);
    });
});
