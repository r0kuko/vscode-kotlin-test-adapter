/**
 * Minimal VS Code API mock for unit tests.
 * Only the symbols actually used by the source files under test are provided.
 */

export class Uri {
    readonly fsPath: string;
    readonly scheme: string = 'file';
    readonly authority: string = '';
    readonly path: string;
    readonly query: string = '';
    readonly fragment: string = '';

    private constructor(fsPath: string) {
        this.fsPath = fsPath;
        this.path = fsPath;
    }

    static file(p: string): Uri {
        return new Uri(p);
    }

    static parse(value: string): Uri {
        return new Uri(value);
    }

    with(_change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
        return this;
    }

    toString(): string {
        return `file://${this.fsPath}`;
    }

    toJSON(): object {
        return { fsPath: this.fsPath, scheme: this.scheme };
    }
}

export class RelativePattern {
    constructor(
        public readonly base: string,
        public readonly pattern: string
    ) {}
}

export const workspace = {
    getConfiguration: (_section?: string, _scope?: unknown) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    }),
    findFiles: async (
        _pattern: RelativePattern,
        _exclude?: string
    ): Promise<Uri[]> => [],
    workspaceFolders: undefined as unknown[] | undefined,
    createFileSystemWatcher: (_glob: string) => ({
        onDidCreate: (_fn: (uri: Uri) => void) => ({ dispose: () => {} }),
        onDidChange: (_fn: (uri: Uri) => void) => ({ dispose: () => {} }),
        onDidDelete: (_fn: (uri: Uri) => void) => ({ dispose: () => {} }),
        dispose: () => {},
    }),
    onDidChangeWorkspaceFolders: (_fn: () => void) => ({ dispose: () => {} }),
};

export const Range = class {
    constructor(
        public startLine: number,
        public startChar: number,
        public endLine: number,
        public endChar: number
    ) {}
};

// ── Test API ──────────────────────────────────────────────────────────────────

export class TestMessage {
    constructor(public readonly message: string) {}
}

export enum TestRunProfileKind {
    Run = 1,
    Coverage = 2,
    Debug = 3,
}

/** Lightweight TestItem suitable for unit-testing extension helpers. */
export class TestItem {
    children: TestItemCollection;
    range: InstanceType<typeof Range> | undefined;
    description: string | undefined;
    sortText: string | undefined;

    constructor(
        public readonly id: string,
        public readonly label: string,
        public readonly uri?: Uri
    ) {
        this.children = new TestItemCollection();
    }
}

export class TestItemCollection {
    private _items = new Map<string, TestItem>();

    get size() { return this._items.size; }

    add(item: TestItem) { this._items.set(item.id, item); }
    delete(id: string) { this._items.delete(id); }
    get(id: string) { return this._items.get(id); }
    replace(items: TestItem[]) {
        this._items.clear();
        for (const i of items) { this._items.set(i.id, i); }
    }
    forEach(cb: (item: TestItem) => void) { this._items.forEach(cb); }
    [Symbol.iterator]() { return this._items.values(); }
}

/** Captures calls made on a TestRun for assertion in tests. */
export class MockTestRun {
    readonly passed: Array<{ item: TestItem; ms?: number }> = [];
    readonly failed: Array<{ item: TestItem; msg: TestMessage; ms?: number }> = [];
    readonly skipped: TestItem[] = [];
    readonly errored: Array<{ item: TestItem; msg: TestMessage }> = [];
    readonly started: TestItem[] = [];
    readonly enqueued: TestItem[] = [];
    readonly output: string[] = [];
    ended = false;

    appendOutput(s: string) { this.output.push(s); }
    pass(item: TestItem, ms?: number) { this.passed.push({ item, ms }); }
    fail(item: TestItem, msg: TestMessage, ms?: number) { this.failed.push({ item, msg, ms }); }
    skip(item: TestItem) { this.skipped.push(item); }
    error(item: TestItem, msg: TestMessage) { this.errored.push({ item, msg }); }
    start(item: TestItem) { this.started.push(item); }
    enqueue(item: TestItem) { this.enqueued.push(item); }
    end() { this.ended = true; }
}

/** Minimal TestRun interface matching what applyResults calls. */
export function makeMockTestRun() {
    const r = new MockTestRun();
    return {
        _mock: r,
        appendOutput: (s: string) => r.appendOutput(s),
        passed: (item: TestItem, ms?: number) => r.pass(item, ms),
        failed: (item: TestItem, msg: TestMessage, ms?: number) => r.fail(item, msg, ms),
        skipped: (item: TestItem) => r.skip(item),
        errored: (item: TestItem, msg: TestMessage) => r.error(item, msg),
        started: (item: TestItem) => r.start(item),
        enqueued: (item: TestItem) => r.enqueue(item),
        end: () => r.end(),
    };
}

export class MockTestController {
    items = new TestItemCollection();
    createTestItem(id: string, label: string, uri?: Uri) {
        return new TestItem(id, label, uri);
    }
    createRunProfile(_label: string, _kind: TestRunProfileKind, _handler: unknown, _default?: boolean) {
        return { dispose: () => {} };
    }
    createTestRun(_request: unknown) {
        return makeMockTestRun();
    }
    resolveHandler: ((item?: TestItem) => void) | undefined;
    refreshHandler: (() => void) | undefined;
}

export const tests = {
    createTestController: (_id: string, _label: string) => new MockTestController(),
};

export const window = {
    createOutputChannel: (_name: string) => ({
        appendLine: (_s: string) => {},
        append: (_s: string) => {},
        show: () => {},
        dispose: () => {},
    }),
};

export const commands = {
    registerCommand: (_id: string, _fn: () => void) => ({ dispose: () => {} }),
};

export default { Uri, RelativePattern, workspace, Range, TestMessage, TestRunProfileKind, tests, window, commands };

