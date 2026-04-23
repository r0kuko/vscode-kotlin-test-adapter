import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { GradleModule, resolveGradleCommand } from './gradle';
import { JUnitTestCase, parseJUnitResultsDir } from './junitParser';

export interface RunRequest {
    module: GradleModule;
    /** Gradle test task names to invoke, e.g. ["test"]. */
    tasks: string[];
    /** Optional `--tests` filters (fully-qualified, may include method names). */
    filters: string[];
    /** When true, pass `--debug-jvm` so Gradle suspends waiting for a JDWP debugger. */
    debug?: boolean;
}

export interface RunResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cases: JUnitTestCase[];
    /** The directories that were inspected for JUnit XML. */
    resultsDirs: string[];
}

/**
 * Execute Gradle for the given request and parse the resulting JUnit XML.
 *
 * Gradle is invoked with `--rerun-tasks` so that test results are always
 * regenerated even when sources have not changed (otherwise the `test` task is
 * UP-TO-DATE and produces no XML).
 */
export async function runTests(
    req: RunRequest,
    token: vscode.CancellationToken,
    onOutput: (chunk: string) => void
): Promise<RunResult> {
    const { command, cwd } = resolveGradleCommand(req.module.workspaceFolder);
    const config = vscode.workspace.getConfiguration(
        'kotlinTestAdapter',
        req.module.workspaceFolder.uri
    );
    const extraArgs = config.get<string[]>('gradleExtraArgs') ?? [];

    const args: string[] = [];
    for (const task of req.tasks) {
        const projectPath = req.module.projectPath === ':' ? '' : req.module.projectPath;
        args.push(`${projectPath}:${task}`.replace(/^:+/, ':'));
    }
    for (const f of req.filters) {
        args.push('--tests', f);
    }
    if (req.debug) {
        // Suspend the JVM immediately on start and wait for a JDWP debugger to
        // attach on port 5005 (Gradle's default debug port).
        args.push('--debug-jvm');
    }
    args.push('--rerun-tasks');
    args.push('--continue');
    args.push(...extraArgs);

    onOutput(`> ${command} ${args.join(' ')}\n`);

    const result = await spawnPromise(command, args, cwd, token, onOutput);

    // Collect results from every test task we ran.
    const resultsDirs: string[] = [];
    const allCases: JUnitTestCase[] = [];
    for (const task of req.tasks) {
        const dir = path.join(req.module.rootPath, 'build', 'test-results', task);
        resultsDirs.push(dir);
        allCases.push(...parseJUnitResultsDir(dir));
    }

    return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        cases: allCases,
        resultsDirs,
    };
}

interface SpawnResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

function spawnPromise(
    command: string,
    args: string[],
    cwd: string,
    token: vscode.CancellationToken,
    onOutput: (chunk: string) => void
): Promise<SpawnResult> {
    // Cap in-memory buffering to avoid OOM on very verbose Gradle output.
    const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB per stream
    return new Promise<SpawnResult>(resolve => {
        const child = cp.spawn(command, args, {
            cwd,
            shell: process.platform === 'win32',
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        const cancel = token.onCancellationRequested(() => {
            try {
                child.kill('SIGTERM');
            } catch {
                /* ignore */
            }
        });
        child.stdout.on('data', (b: Buffer) => {
            const s = b.toString();
            if (stdout.length < MAX_BUFFER) {
                stdout += s;
            }
            onOutput(s);
        });
        child.stderr.on('data', (b: Buffer) => {
            const s = b.toString();
            if (stderr.length < MAX_BUFFER) {
                stderr += s;
            }
            onOutput(s);
        });
        child.on('error', err => {
            onOutput(`\n[ERROR] Failed to spawn ${command}: ${err.message}\n`);
            cancel.dispose();
            resolve({ exitCode: -1, stdout, stderr: stderr + err.message });
        });
        child.on('close', code => {
            cancel.dispose();
            resolve({ exitCode: code, stdout, stderr });
        });
    });
}

/** Best-effort detection of which Gradle test tasks exist for a module. */
export function detectTestTasks(module: GradleModule): string[] {
    // Standard tasks. Heuristic: include "integrationTest" if the source set folder exists.
    const tasks = ['test'];
    const integration = path.join(module.rootPath, 'src', 'integrationTest');
    if (fs.existsSync(integration)) {
        tasks.push('integrationTest');
    }
    return tasks;
}
