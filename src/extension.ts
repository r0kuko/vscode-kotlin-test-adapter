import * as vscode from 'vscode';
import * as path from 'path';
import {
    GradleModule,
    discoverGradleModules,
} from './gradle';
import {
    DiscoveredTest,
    findTestFiles,
    parseKotlinTests,
} from './discovery';
import { detectTestTasks, runTests } from './runner';
import { JUnitTestCase } from './junitParser';

let controller: vscode.TestController;
let output: vscode.OutputChannel;

/**
 * Per-test-item metadata, keyed by TestItem.id.
 * We avoid putting non-serialisable data on the TestItem itself.
 */
export interface ItemMeta {
    kind: 'workspace' | 'module' | 'class' | 'method';
    module?: GradleModule;
    /** For classes/methods: the fully-qualified class name. */
    className?: string;
    /** For methods: the test method name. */
    methodName?: string;
}
const meta = new Map<string, ItemMeta>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    output = vscode.window.createOutputChannel('Kotlin Test Adapter');
    context.subscriptions.push(output);

    controller = vscode.tests.createTestController(
        'kotlinTestAdapter',
        'Kotlin Tests'
    );
    context.subscriptions.push(controller);

    controller.refreshHandler = async () => {
        await refreshAll();
    };

    controller.resolveHandler = async item => {
        if (!item) {
            await refreshAll();
        }
    };

    controller.createRunProfile(
        'Run',
        vscode.TestRunProfileKind.Run,
        (request, token) => runHandler(request, token, false),
        true
    );
    controller.createRunProfile(
        'Debug',
        vscode.TestRunProfileKind.Debug,
        (request, token) => runHandler(request, token, true),
        false
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('kotlinTestAdapter.refresh', () =>
            refreshAll()
        )
    );

    // Re-discover when Kotlin test files are saved.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.kt');
    context.subscriptions.push(watcher);
    watcher.onDidCreate(uri => onFileChanged(uri));
    watcher.onDidChange(uri => onFileChanged(uri));
    watcher.onDidDelete(uri => onFileDeleted(uri));

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAll())
    );

    // Initial discovery.
    refreshAll().catch(err => {
        output.appendLine(`Initial discovery failed: ${err}`);
    });
}

export function deactivate(): void {
    if (pending) {
        clearTimeout(pending);
        pending = undefined;
    }
}

// ---------------------------------------------------------------------------
// Discovery / tree management
// ---------------------------------------------------------------------------

let refreshing = false;

async function refreshAll(): Promise<void> {
    if (refreshing) {
        return;
    }
    refreshing = true;
    try {
        const folders = vscode.workspace.workspaceFolders ?? [];
        // Replace top-level items.
        controller.items.replace([]);
        meta.clear();

        for (const folder of folders) {
            const modules = await discoverGradleModules(folder);
            if (modules.length === 0) {
                continue;
            }
            const folderItem = controller.createTestItem(
                `ws:${folder.uri.toString()}`,
                folder.name,
                folder.uri
            );
            meta.set(folderItem.id, { kind: 'workspace' });
            controller.items.add(folderItem);

            for (const module of modules) {
                const moduleItem = controller.createTestItem(
                    `mod:${folder.uri.toString()}::${module.projectPath}`,
                    module.projectPath === ':' ? '(root)' : module.projectPath,
                    vscode.Uri.file(module.rootPath)
                );
                moduleItem.description = path.relative(folder.uri.fsPath, module.rootPath) || '.';
                meta.set(moduleItem.id, { kind: 'module', module });
                folderItem.children.add(moduleItem);

                await discoverModuleTests(moduleItem, module);
            }
        }
    } finally {
        refreshing = false;
    }
}

async function discoverModuleTests(
    moduleItem: vscode.TestItem,
    module: GradleModule
): Promise<void> {
    const files = await findTestFiles(module);
    const allTests: DiscoveredTest[] = [];
    for (const f of files) {
        allTests.push(...parseKotlinTests(module, f));
    }
    populateModuleItem(moduleItem, module, allTests);
}

function populateModuleItem(
    moduleItem: vscode.TestItem,
    module: GradleModule,
    tests: DiscoveredTest[]
): void {
    moduleItem.children.replace([]);

    // Group by class.
    const byClass = new Map<string, DiscoveredTest[]>();
    for (const t of tests) {
        const list = byClass.get(t.className) ?? [];
        list.push(t);
        byClass.set(t.className, list);
    }

    // Keep a fqClass → TestItem map so nested classes can be attached as children
    // of their parent class item rather than siblings under the module.
    const classItems = new Map<string, vscode.TestItem>();

    const sortedClasses = Array.from(byClass.keys()).sort();
    for (const fqClass of sortedClasses) {
        const methods = byClass.get(fqClass)!;
        const first = methods[0];
        const classId = makeClassId(module, fqClass);
        const classItem = controller.createTestItem(
            classId,
            simpleName(fqClass),
            vscode.Uri.file(first.file)
        );
        // Set range to the class declaration line so clicking the gutter button
        // next to the class only triggers the class run, not a method-level run.
        // Using classLine (not first.line) avoids the gutter range overlapping
        // with the first method item's own range.
        classItem.range = new vscode.Range(first.classLine, 0, first.classLine, 0);
        meta.set(classItem.id, {
            kind: 'class',
            module,
            className: fqClass,
        });
        classItems.set(fqClass, classItem);

        // Nested classes (className contains `$`) are placed under their parent
        // class item; top-level classes go under the module item.
        const dollarIdx = fqClass.lastIndexOf('$');
        if (dollarIdx !== -1) {
            const parentFq = fqClass.slice(0, dollarIdx);
            const parentItem = classItems.get(parentFq);
            if (parentItem) {
                parentItem.children.add(classItem);
            } else {
                // Parent has no tests of its own (no class item created yet).
                classItem.description = first.packageName || undefined;
                moduleItem.children.add(classItem);
            }
        } else {
            classItem.description = first.packageName || undefined;
            moduleItem.children.add(classItem);
        }

        for (const m of methods.sort((a, b) => a.methodName.localeCompare(b.methodName))) {
            const id = makeMethodId(module, fqClass, m.methodName);
            const item = controller.createTestItem(
                id,
                m.methodName,
                vscode.Uri.file(m.file)
            );
            item.range = new vscode.Range(m.line, 0, m.line, 0);
            meta.set(item.id, {
                kind: 'method',
                module,
                className: fqClass,
                methodName: m.methodName,
            });
            classItem.children.add(item);
        }
    }
}

export function makeClassId(module: GradleModule, fqClass: string): string {
    return `cls:${module.workspaceFolder.uri.toString()}::${module.projectPath}::${fqClass}`;
}

export function makeMethodId(module: GradleModule, fqClass: string, method: string): string {
    return `mth:${module.workspaceFolder.uri.toString()}::${module.projectPath}::${fqClass}::${method}`;
}

/**
 * Return the display name for a class: the innermost simple name.
 * For nested classes like `sample.OuterTest$InnerTest` this returns `InnerTest`
 * rather than the full `OuterTest$InnerTest` string.
 */
export function simpleName(fq: string): string {
    const dot = fq.lastIndexOf('.');
    const short = dot === -1 ? fq : fq.slice(dot + 1);
    // For nested classes separated by `$`, show only the innermost segment.
    const dollar = short.lastIndexOf('$');
    return dollar === -1 ? short : short.slice(dollar + 1);
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

let pending: NodeJS.Timeout | undefined;
function onFileChanged(_uri: vscode.Uri): void {
    if (pending) {
        clearTimeout(pending);
    }
    pending = setTimeout(() => {
        pending = undefined;
        refreshAll().catch(err => output.appendLine(`Refresh failed: ${err}`));
    }, 500);
}
function onFileDeleted(_uri: vscode.Uri): void {
    onFileChanged(_uri);
}

// ---------------------------------------------------------------------------
// Run handler
// ---------------------------------------------------------------------------

async function runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    debug: boolean
): Promise<void> {
    const run = controller.createTestRun(request);
    try {
        // Compute the set of leaf TestItems to run, respecting `request.exclude`.
        const leaves = collectLeaves(request);
        if (leaves.length === 0) {
            run.appendOutput('No tests selected.\r\n');
            return;
        }

        // Mark all enqueued.
        for (const item of leaves) {
            run.enqueued(item);
        }

        // Group by module, then build Gradle filters.
        const byModule = groupByModule(leaves);
        for (const [_moduleKey, group] of byModule) {
            if (token.isCancellationRequested) {
                break;
            }
            const { module, items } = group;
            const filters = buildGradleFilters(items);
            const tasks = detectTestTasks(module);

            for (const item of items) {
                run.started(item);
            }

            if (debug) {
                run.appendOutput(
                    `\r\n[Debug] Debugging Kotlin tests is not yet supported – running instead.\r\n`
                );
            }

            const onOutput = (chunk: string) => {
                run.appendOutput(chunk.replace(/\r?\n/g, '\r\n'));
            };

            run.appendOutput(`\r\n=== ${module.projectPath} ===\r\n`);
            const result = await runTests(
                { module, tasks, filters },
                token,
                onOutput
            );

            applyResults(run, items, result.cases);

            if (result.exitCode !== 0 && result.cases.length === 0) {
                // Gradle failed without producing reports – mark everything as errored.
                for (const item of items) {
                    run.errored(
                        item,
                        new vscode.TestMessage(
                            `Gradle exited with code ${result.exitCode}. See output for details.`
                        )
                    );
                }
            }
        }
    } catch (err) {
        output.appendLine(`Run failed: ${err}`);
    } finally {
        run.end();
    }
}

function collectLeaves(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set((request.exclude ?? []).map(i => i.id));
    const result: vscode.TestItem[] = [];
    const visit = (item: vscode.TestItem) => {
        if (excluded.has(item.id)) {
            return;
        }
        if (item.children.size === 0) {
            const m = meta.get(item.id);
            if (m?.kind === 'method') {
                result.push(item);
            }
            return;
        }
        item.children.forEach(visit);
    };

    if (request.include && request.include.length > 0) {
        for (const item of request.include) {
            if (excluded.has(item.id)) {
                continue;
            }
            const m = meta.get(item.id);
            if (m?.kind === 'method') {
                result.push(item);
            } else {
                item.children.forEach(visit);
            }
        }
    } else {
        controller.items.forEach(visit);
    }
    return result;
}

interface ModuleGroup {
    module: GradleModule;
    items: vscode.TestItem[];
}

function groupByModule(items: vscode.TestItem[]): Map<string, ModuleGroup> {
    const groups = new Map<string, ModuleGroup>();
    for (const item of items) {
        const m = meta.get(item.id);
        if (!m?.module) {
            continue;
        }
        const key = `${m.module.workspaceFolder.uri.toString()}::${m.module.projectPath}`;
        const g = groups.get(key) ?? { module: m.module, items: [] };
        g.items.push(item);
        groups.set(key, g);
    }
    return groups;
}

export function buildGradleFilters(
    items: vscode.TestItem[],
    metaIn: ReadonlyMap<string, ItemMeta> = meta
): string[] {
    // Group methods by class to keep the filter list compact.
    const byClass = new Map<string, Set<string>>();
    for (const item of items) {
        const m = metaIn.get(item.id);
        if (!m || m.kind !== 'method' || !m.className || !m.methodName) {
            continue;
        }
        // Gradle `--tests` does not support nested-class `$` separators; use `.` instead.
        const cls = m.className.replace(/\$/g, '.');
        const set = byClass.get(cls) ?? new Set<string>();
        set.add(m.methodName);
        byClass.set(cls, set);
    }
    const out: string[] = [];
    for (const [cls, methods] of byClass) {
        for (const method of methods) {
            out.push(`${cls}.${method}`);
        }
    }
    return out;
}

export function applyResults(
    run: vscode.TestRun,
    items: vscode.TestItem[],
    cases: JUnitTestCase[],
    metaIn: ReadonlyMap<string, ItemMeta> = meta
): void {
    // Index test cases by `class.method` (with nested `$` flattened to `.`).
    const caseIndex = new Map<string, JUnitTestCase>();
    for (const c of cases) {
        const cls = c.classname.replace(/\$/g, '.');
        caseIndex.set(`${cls}.${stripParens(c.name)}`, c);
    }

    for (const item of items) {
        const m = metaIn.get(item.id);
        if (!m || m.kind !== 'method' || !m.className || !m.methodName) {
            continue;
        }
        const cls = m.className.replace(/\$/g, '.');
        const key = `${cls}.${m.methodName}`;
        const tc = caseIndex.get(key);
        if (!tc) {
            // Test ran but produced no XML result — this can happen when a test is
            // disabled via @Disabled or when a compile error prevents the run.
            // Mark as skipped rather than errored to avoid false-alarm noise.
            run.skipped(item);
            continue;
        }
        if (tc.skipped) {
            run.skipped(item);
        } else if (tc.failure) {
            const msg = new vscode.TestMessage(
                tc.failure.message + (tc.failure.details ? `\n${tc.failure.details}` : '')
            );
            run.failed(item, msg, tc.timeMs);
        } else {
            run.passed(item, tc.timeMs);
        }
    }
}

function stripParens(name: string): string {
    const idx = name.indexOf('(');
    return idx === -1 ? name : name.slice(0, idx);
}
