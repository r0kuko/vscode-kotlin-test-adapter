import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
    kind: 'workspace' | 'group' | 'module' | 'class' | 'method';
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

    // Re-discover when Kotlin test files are saved. We narrow the watcher to the
    // configured testSourceGlobs (per workspace folder) and skip noisy build
    // output directories. Without this, generated files under build/ caused the
    // tree to be torn down and rebuilt on every Gradle invocation.
    setupFileWatchers(context);

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

function setupFileWatchers(context: vscode.ExtensionContext): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
        const config = vscode.workspace.getConfiguration('kotlinTestAdapter', folder.uri);
        const globs = config.get<string[]>('testSourceGlobs') ?? ['**/src/test/kotlin/**/*.kt'];
        for (const g of globs) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, g)
            );
            context.subscriptions.push(watcher);
            watcher.onDidCreate(uri => onFileChanged(uri));
            watcher.onDidChange(uri => onFileChanged(uri));
            watcher.onDidDelete(uri => onFileDeleted(uri));
        }
    }
}

/** Returns true if the path lives inside a Gradle build/ output directory or similar. */
function isBuildArtifact(fsPath: string): boolean {
    const norm = fsPath.replace(/\\/g, '/');
    return /\/(?:build|\.gradle|out|node_modules|\.idea|\.git)\//.test(norm);
}

// ---------------------------------------------------------------------------
// Discovery / tree management
// ---------------------------------------------------------------------------

let refreshing = false;
/** Cache: workspaceFolder URI string → discovered modules (for incremental updates). */
const moduleCache = new Map<string, GradleModule[]>();
/** Cache: TestItem.id → GradleModule (used to find which item to update on file change). */
const moduleItemIndex = new Map<string, vscode.TestItem>();

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
        moduleCache.clear();
        moduleItemIndex.clear();

        for (const folder of folders) {
            const modules = await discoverGradleModules(folder);
            if (modules.length === 0) {
                continue;
            }
            moduleCache.set(folder.uri.toString(), modules);
            await buildModuleTree(folder, modules);
        }
    } finally {
        refreshing = false;
    }
}

/**
 * Pure helper: compute the desired tree shape for a list of Gradle modules.
 * Returned nodes are sorted by `projectPath`. Used by `buildModuleTree` and
 * exposed for unit tests.
 */
export interface ModuleTreeNode {
    projectPath: string;
    /** Last segment of `projectPath` (e.g. `featureA` for `:modules:featureA`). */
    name: string;
    /** Whether this node is a real Gradle module (has a build file) vs. a virtual group. */
    isModule: boolean;
    /** The owning module, when `isModule` is true. */
    module?: GradleModule;
    children: ModuleTreeNode[];
}

export function buildModuleTreeShape(modules: GradleModule[]): ModuleTreeNode {
    const root = modules.find(m => m.projectPath === ':');
    const rootNode: ModuleTreeNode = {
        projectPath: ':',
        name: root ? root.name : '',
        isModule: !!root,
        module: root,
        children: [],
    };
    const byPath = new Map<string, ModuleTreeNode>();
    byPath.set(':', rootNode);

    function ensure(projectPath: string): ModuleTreeNode {
        const existing = byPath.get(projectPath);
        if (existing) {
            return existing;
        }
        const lastColon = projectPath.lastIndexOf(':');
        const parentPath = lastColon === 0 ? ':' : projectPath.slice(0, lastColon);
        const segName = projectPath.slice(lastColon + 1);
        const parent = ensure(parentPath);
        const matching = modules.find(m => m.projectPath === projectPath);
        const node: ModuleTreeNode = {
            projectPath,
            name: segName,
            isModule: !!matching,
            module: matching,
            children: [],
        };
        parent.children.push(node);
        byPath.set(projectPath, node);
        return node;
    }

    const subs = modules
        .filter(m => m.projectPath !== ':')
        .sort((a, b) => a.projectPath.length - b.projectPath.length);
    for (const m of subs) {
        ensure(m.projectPath);
    }
    // Sort siblings alphabetically.
    const sortRec = (n: ModuleTreeNode) => {
        n.children.sort((a, b) => a.name.localeCompare(b.name));
        n.children.forEach(sortRec);
    };
    sortRec(rootNode);
    return rootNode;
}

/**
 * Build a hierarchical TestItem tree for one workspace folder.
 *
 * Rules:
 *  - The workspace folder TestItem represents the Gradle root project (`:`).
 *    If the root has a build file, its tests are placed directly under it.
 *  - Subprojects are nested by their `:a:b:c` path segments. Intermediate
 *    segments that are not themselves Gradle modules become "group" items.
 */
async function buildModuleTree(
    folder: vscode.WorkspaceFolder,
    modules: GradleModule[]
): Promise<void> {
    const wsKey = folder.uri.toString();
    const shape = buildModuleTreeShape(modules);

    const wsItem = controller.createTestItem(
        `ws:${wsKey}`,
        folder.name,
        folder.uri
    );
    controller.items.add(wsItem);
    if (shape.isModule && shape.module) {
        meta.set(wsItem.id, { kind: 'module', module: shape.module });
        moduleItemIndex.set(wsItem.id, wsItem);
    } else {
        meta.set(wsItem.id, { kind: 'workspace' });
    }

    // Index of projectPath → TestItem so the test-discovery pass below can
    // find the right item for each module.
    const itemsByPath = new Map<string, vscode.TestItem>();
    itemsByPath.set(':', wsItem);

    const addNode = (node: ModuleTreeNode, parent: vscode.TestItem) => {
        let item: vscode.TestItem;
        if (node.isModule && node.module) {
            item = controller.createTestItem(
                `mod:${wsKey}::${node.projectPath}`,
                node.name,
                vscode.Uri.file(node.module.rootPath)
            );
            meta.set(item.id, { kind: 'module', module: node.module });
            moduleItemIndex.set(item.id, item);
        } else {
            item = controller.createTestItem(
                `grp:${wsKey}::${node.projectPath}`,
                node.name
            );
            meta.set(item.id, { kind: 'group' });
        }
        parent.children.add(item);
        itemsByPath.set(node.projectPath, item);
        for (const child of node.children) {
            addNode(child, item);
        }
    };

    for (const child of shape.children) {
        addNode(child, wsItem);
    }

    // Discover tests for every actual module (including root, if any).
    for (const m of modules) {
        const item = m.projectPath === ':' ? wsItem : itemsByPath.get(m.projectPath);
        if (item) {
            await discoverModuleTests(item, m);
        }
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
    // Preserve any existing non-class children (e.g. nested module/group items)
    // so that we only swap out the test classes, not the whole module subtree.
    const preserved: vscode.TestItem[] = [];
    moduleItem.children.forEach(child => {
        const m = meta.get(child.id);
        if (m?.kind === 'module' || m?.kind === 'group') {
            preserved.push(child);
        } else if (m?.kind === 'class') {
            meta.delete(child.id);
            // Methods under it will be GC'd via .replace below.
            child.children.forEach(grand => meta.delete(grand.id));
        }
    });
    moduleItem.children.replace(preserved);

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

    // Sort classes by @Order on the class declaration first (lower = earlier),
    // then by fully-qualified name. Classes without an @Order go after ordered
    // ones, preserving alphabetical stability.
    const sortedClasses = Array.from(byClass.keys()).sort((a, b) => {
        const aOrder = byClass.get(a)![0].classOrder ?? Number.POSITIVE_INFINITY;
        const bOrder = byClass.get(b)![0].classOrder ?? Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder) {
            return aOrder - bOrder;
        }
        return a.localeCompare(b);
    });
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
        classItem.sortText = sortKey(first.classOrder, simpleName(fqClass));
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

        // Sort methods by @Order first (ascending), then by name for stability.
        const sortedMethods = methods.slice().sort((a, b) => {
            const ao = a.order ?? Number.POSITIVE_INFINITY;
            const bo = b.order ?? Number.POSITIVE_INFINITY;
            if (ao !== bo) {
                return ao - bo;
            }
            return a.methodName.localeCompare(b.methodName);
        });
        for (const m of sortedMethods) {
            const id = makeMethodId(module, fqClass, m.methodName);
            const item = controller.createTestItem(
                id,
                m.methodName,
                vscode.Uri.file(m.file)
            );
            item.range = new vscode.Range(m.line, 0, m.line, 0);
            item.sortText = sortKey(m.order, m.methodName);
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

/**
 * Build a `sortText` value so the VS Code Test Explorer (which sorts items by
 * label/sortText alphabetically) honors `@Order` annotations.
 *
 * Items with an explicit order are bucketed before unordered items. The order
 * value is offset and zero-padded so that negative values and lexical compare
 * still produce ascending numeric ordering.
 */
export function sortKey(order: number | undefined, name: string): string {
    if (order === undefined || Number.isNaN(order)) {
        return `1_${name}`;
    }
    const shifted = Math.trunc(order) + 1_000_000_000;
    const padded = shifted.toString().padStart(11, '0');
    return `0_${padded}_${name}`;
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
/** URIs queued for incremental refresh (debounced). */
const pendingUris = new Set<string>();

function onFileChanged(uri: vscode.Uri): void {
    // Ignore changes inside Gradle build/output directories. The default
    // `**/*.kt` watcher used to trigger a full reload every time Gradle
    // touched a generated source file, which made the tree blink and reset
    // the user's selection in larger projects.
    if (isBuildArtifact(uri.fsPath)) {
        return;
    }
    pendingUris.add(uri.toString());
    if (pending) {
        clearTimeout(pending);
    }
    pending = setTimeout(() => {
        pending = undefined;
        const uris = Array.from(pendingUris);
        pendingUris.clear();
        processFileChanges(uris).catch(err =>
            output.appendLine(`Incremental refresh failed: ${err}`)
        );
    }, 500);
}
function onFileDeleted(uri: vscode.Uri): void {
    onFileChanged(uri);
}

/**
 * Re-discover only the modules whose source roots contain at least one
 * changed file. Falls back to a full refresh if we can't map the file to a
 * known module (e.g. a brand-new module added to settings.gradle).
 */
async function processFileChanges(uris: string[]): Promise<void> {
    if (refreshing) {
        return;
    }
    if (uris.length === 0) {
        return;
    }
    const toRefresh = new Set<vscode.TestItem>();
    let unknownFile = false;

    for (const uriStr of uris) {
        const fsPath = vscode.Uri.parse(uriStr).fsPath;
        const hit = findOwningModule(fsPath);
        if (!hit) {
            unknownFile = true;
            break;
        }
        toRefresh.add(hit.item);
    }

    if (unknownFile) {
        await refreshAll();
        return;
    }

    for (const item of toRefresh) {
        const m = meta.get(item.id);
        if (m?.kind === 'module' && m.module) {
            await discoverModuleTests(item, m.module);
        }
    }
}

/** Locate which discovered module a given file path belongs to. */
function findOwningModule(
    fsPath: string
): { module: GradleModule; item: vscode.TestItem } | undefined {
    let best: { module: GradleModule; item: vscode.TestItem } | undefined;
    for (const [, item] of moduleItemIndex) {
        const m = meta.get(item.id);
        if (m?.kind !== 'module' || !m.module) {
            continue;
        }
        const root = m.module.rootPath;
        if (fsPath === root || fsPath.startsWith(root + path.sep)) {
            // Prefer the deepest (most specific) match in case of nested modules.
            if (!best || m.module.rootPath.length > best.module.rootPath.length) {
                best = { module: m.module, item };
            }
        }
    }
    return best;
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
                    `\r\n[Debug] Starting Gradle with --debug-jvm. Waiting for debugger to attach...\r\n`
                );
            }

            // When debugging, intercept output to detect the JDWP listening port
            // and automatically attach VS Code's Java debugger.
            let debugAttached = false;
            const onOutput = (chunk: string) => {
                run.appendOutput(chunk.replace(/\r?\n/g, '\r\n'));
                if (debug && !debugAttached) {
                    // JDK 8:  "address: 5005"
                    // JDK 9+: "address: *:5005" or "address: localhost:5005"
                    const m = chunk.match(/Listening for transport dt_socket at address:\s*(?:[^:\s]+:)?(\d+)/i);
                    if (m) {
                        debugAttached = true;
                        const port = parseInt(m[1], 10);
                        const allModules = Array.from(byModule.values()).map(g => g.module);
                        // Only pass directories that actually exist on disk.
                        // Non-existent paths cause the Java debugger to abandon source
                        // lookup and fall back to showing decompiled .class bytecode.
                        const sourcePaths = collectSourcePaths(allModules);
                        output.appendLine(`[Debug] port=${port} sourcePaths=${JSON.stringify(sourcePaths)}`);
                        run.appendOutput(`\r\n[Debug] Attaching to port ${port}\r\n`);

                        // Pick the best available debug adapter:\n                        //  type:'java' works with vscjava.vscode-java-debug (the standalone\n                        //  debugger, no need for the full Extension Pack for Java).
                        const hasJavaDebugger =
                            !!vscode.extensions.getExtension('vscjava.vscode-java-debug') ||
                            !!vscode.extensions.getExtension('redhat.java');

                        if (!hasJavaDebugger) {
                            const msg = 'No JVM debug adapter found. Install ' +
                                '"Debugger for Java" (vscjava.vscode-java-debug) to enable debugging.';
                            output.appendLine(`[Debug] ${msg}`);
                            run.appendOutput(`\r\n[Debug] ${msg}\r\n`);
                            return;
                        }

                        const debugConfig: vscode.DebugConfiguration = {
                            type: 'java',
                            request: 'attach',
                            name: 'Kotlin Test Debugger',
                            hostName: 'localhost',
                            port,
                            sourcePaths,
                        };

                        vscode.debug.startDebugging(module.workspaceFolder, debugConfig)
                            .then(undefined, err => {
                                output.appendLine(`Failed to attach debugger: ${err}`);
                                run.appendOutput(`\r\n[Debug] Failed to attach debugger: ${err}\r\n`);
                            });
                    }
                }
            };

            run.appendOutput(`\r\n=== ${module.projectPath} ===\r\n`);
            const result = await runTests(
                { module, tasks, filters, debug },
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

/**
 * Return the list of source root directories for the given modules.
 * These are passed as `sourcePaths` to the Java debugger so it can map
 * compiled class files back to `.kt` / `.java` source files instead of
 * showing decompiled bytecode.
 */
function collectSourcePaths(modules: GradleModule[]): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    const add = (p: string) => {
        if (!seen.has(p) && fs.existsSync(p)) {
            seen.add(p);
            paths.push(p);
        }
    };
    for (const mod of modules) {
        // Standard Gradle source-set directories for Kotlin and Java.
        // Only include directories that actually exist — passing non-existent
        // paths causes the Java debugger to abandon source lookup entirely and
        // fall back to showing decompiled class-file bytecode.
        for (const sourceSet of ['main', 'test']) {
            add(path.join(mod.rootPath, 'src', sourceSet, 'kotlin'));
            add(path.join(mod.rootPath, 'src', sourceSet, 'java'));
        }
    }
    return paths;
}

/**
 * Return compiled class output directories for the given modules.
 * Providing these alongside `sourcePaths` lets the Java debugger correlate
 * `.class` files (and their `SourceFile` debug attributes) with `.kt` sources.
 */
function collectClassPaths(modules: GradleModule[]): string[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    const add = (p: string) => {
        if (!seen.has(p) && fs.existsSync(p)) {
            seen.add(p);
            paths.push(p);
        }
    };
    for (const mod of modules) {
        for (const sourceSet of ['main', 'test']) {
            // Kotlin compiler output
            add(path.join(mod.rootPath, 'build', 'classes', 'kotlin', sourceSet));
            // Java compiler output (mixed Kotlin/Java projects)
            add(path.join(mod.rootPath, 'build', 'classes', 'java', sourceSet));
        }
    }
    return paths;
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
