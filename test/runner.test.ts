/**
 * Unit tests for src/runner.ts
 *
 * detectTestTasks uses real filesystem reads.
 * runTests is tested by mocking child_process.spawn to capture the exact
 * arguments that would be sent to Gradle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri } from './__mocks__/vscode';
import { detectTestTasks, runTests } from '../src/runner';
import type { GradleModule } from '../src/gradle';
import type { RunRequest } from '../src/runner';

// Mock child_process at the module level so that ESM exports are replaceable.
vi.mock('child_process', () => ({ spawn: vi.fn() }));
import * as cp from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModule(rootPath: string, projectPath = ':'): GradleModule {
    return {
        rootPath,
        projectPath,
        name: path.basename(rootPath),
        workspaceFolder: {
            uri: Uri.file(rootPath),
            name: path.basename(rootPath),
            index: 0,
        } as any,
    };
}

function touch(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
}

// ---------------------------------------------------------------------------
// detectTestTasks
// ---------------------------------------------------------------------------

describe('detectTestTasks', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-kt-runner-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns ["test"] when no integrationTest source set exists', () => {
        const module = makeModule(tmpDir);
        expect(detectTestTasks(module)).toEqual(['test']);
    });

    it('returns ["test", "integrationTest"] when integrationTest directory exists', () => {
        fs.mkdirSync(path.join(tmpDir, 'src', 'integrationTest'), { recursive: true });
        const module = makeModule(tmpDir);
        expect(detectTestTasks(module)).toEqual(['test', 'integrationTest']);
    });

    // ── BugR1 ────────────────────────────────────────────────────────────────
    // detectTestTasks only checks for a hard-coded "integrationTest" directory.
    // Custom test source sets (e.g. "functionalTest", "e2eTest") are silently
    // ignored, meaning those tests cannot be run from the extension.
    it('[BugR1] custom test source set "functionalTest" is NOT detected (known limitation)', () => {
        fs.mkdirSync(path.join(tmpDir, 'src', 'functionalTest'), { recursive: true });
        const module = makeModule(tmpDir);
        // Current behavior: only 'test' is returned (limitation documented here).
        expect(detectTestTasks(module)).toEqual(['test']);
        // A future improvement would return ['test', 'functionalTest'].
    });
});

// ---------------------------------------------------------------------------
// Gradle argument construction (via runTests spy)
// ---------------------------------------------------------------------------

function makeCancelToken() {
    return {
        isCancellationRequested: false,
        onCancellationRequested: (_fn: () => void) => ({ dispose: () => {} }),
    } as any;
}

describe('Gradle argument construction', () => {
    // We spy on cp.spawn to capture args without actually running Gradle.

    beforeEach(() => {
        vi.mocked(cp.spawn).mockImplementation((_cmd, _args) => {
            const EventEmitter = require('events');
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            process.nextTick(() => child.emit('close', 0));
            return child as any;
        });
    });

    afterEach(() => {
        vi.mocked(cp.spawn).mockReset();
    });

    function capturedArgs(): string[] {
        const calls = vi.mocked(cp.spawn).mock.calls;
        return calls[0]?.[1] as string[] ?? [];
    }

    it('generates :test for the root project (:)', async () => {
        const req: RunRequest = {
            module: makeModule('/proj', ':'),
            tasks: ['test'],
            filters: [],
        };
        await runTests(req, makeCancelToken(), () => {});
        const args = capturedArgs();
        expect(args).toContain(':test');
        // Must NOT produce '::test' (double colon) — regression for root-project path.
        expect(args).not.toContain('::test');
    });

    it('generates :core:test for subproject :core', async () => {
        const req: RunRequest = {
            module: makeModule('/proj/core', ':core'),
            tasks: ['test'],
            filters: [],
        };
        await runTests(req, makeCancelToken(), () => {});
        expect(capturedArgs()).toContain(':core:test');
    });

    it('adds --tests filter for each filter entry', async () => {
        const req: RunRequest = {
            module: makeModule('/proj', ':'),
            tasks: ['test'],
            filters: ['sample.MyTest.myMethod'],
        };
        await runTests(req, makeCancelToken(), () => {});
        const args = capturedArgs();
        expect(args).toContain('--tests');
        expect(args).toContain('sample.MyTest.myMethod');
    });

    // ── BugR2 ────────────────────────────────────────────────────────────────
    // --rerun-tasks must always be included so that Gradle re-executes tests even
    // when the source has not changed (otherwise the task is UP-TO-DATE and no
    // XML results are written).
    it('[BugR2] --rerun-tasks is always included in Gradle args', async () => {
        const req: RunRequest = {
            module: makeModule('/proj', ':'),
            tasks: ['test'],
            filters: [],
        };
        await runTests(req, makeCancelToken(), () => {});
        expect(capturedArgs()).toContain('--rerun-tasks');
    });

    // ── BugR3 ────────────────────────────────────────────────────────────────
    // --continue is always included so that Gradle does not abort on first failure.
    // Without it, a failing test in module A prevents module B from running at all.
    it('[BugR3] --continue is always included so all tests run despite failures', async () => {
        const req: RunRequest = {
            module: makeModule('/proj', ':'),
            tasks: ['test'],
            filters: [],
        };
        await runTests(req, makeCancelToken(), () => {});
        expect(capturedArgs()).toContain('--continue');
    });

    // ── BugR4 ────────────────────────────────────────────────────────────────
    // Multiple task names (e.g. 'test' and 'integrationTest') must each produce
    // a separate :<task> argument, NOT be merged into a single string.
    it('[BugR4] multiple tasks each get their own :task argument', async () => {
        const req: RunRequest = {
            module: makeModule('/proj', ':core'),
            tasks: ['test', 'integrationTest'],
            filters: [],
        };
        await runTests(req, makeCancelToken(), () => {});
        const args = capturedArgs();
        expect(args).toContain(':core:test');
        expect(args).toContain(':core:integrationTest');
    });

    it('calls onOutput with Gradle stdout chunks', async () => {
        vi.mocked(cp.spawn).mockReset();
        vi.mocked(cp.spawn).mockImplementation(() => {
            const EventEmitter = require('events');
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            process.nextTick(() => {
                child.stdout.emit('data', Buffer.from('BUILD SUCCESSFUL'));
                child.emit('close', 0);
            });
            return child as any;
        });

        const chunks: string[] = [];
        await runTests(
            { module: makeModule('/proj', ':'), tasks: ['test'], filters: [] },
            makeCancelToken(),
            s => chunks.push(s)
        );
        expect(chunks.some(c => c.includes('BUILD SUCCESSFUL'))).toBe(true);
    });
});

