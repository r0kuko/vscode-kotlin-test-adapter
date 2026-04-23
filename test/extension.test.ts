/**
 * Unit tests for src/extension.ts
 *
 * We test the exported pure/semi-pure helpers:
 *   - simpleName(fq)           — display name from a fully-qualified class name
 *   - makeClassId / makeMethodId — deterministic item IDs
 *   - buildGradleFilters        — converts TestItems + meta to --tests arguments
 *   - applyResults              — maps JUnit XML results back to TestRun calls
 */
import { describe, it, expect } from 'vitest';
import { Uri, TestItem, TestMessage, makeMockTestRun } from './__mocks__/vscode';
import {
    simpleName,
    makeClassId,
    makeMethodId,
    buildGradleFilters,
    applyResults,
    type ItemMeta,
} from '../src/extension';
import type { GradleModule } from '../src/gradle';
import type { JUnitTestCase } from '../src/junitParser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModule(projectPath = ':', rootPath = '/proj'): GradleModule {
    return {
        rootPath,
        projectPath,
        name: 'test-proj',
        workspaceFolder: {
            uri: Uri.file(rootPath),
            name: 'test-proj',
            index: 0,
        } as any,
    };
}

function makeMethodItem(id: string): TestItem {
    return new TestItem(id, 'label', Uri.file('/test'));
}

function makeMetaMap(entries: Array<[string, ItemMeta]>): Map<string, ItemMeta> {
    return new Map(entries);
}

// ---------------------------------------------------------------------------
// simpleName
// ---------------------------------------------------------------------------

describe('simpleName', () => {
    it('returns the class name for a top-level class', () => {
        expect(simpleName('sample.core.CalculatorTest')).toBe('CalculatorTest');
    });

    it('returns the name when there is no package', () => {
        expect(simpleName('CalculatorTest')).toBe('CalculatorTest');
    });

    // ── BugE1 ─────────────────────────────────────────────────────────────────
    // simpleName used to return "OuterTest$InnerTest" for nested classes.
    // The label in the Test Explorer should show only the innermost class name.
    it('[BugE1] nested class shows only the innermost name (not Outer$Inner)', () => {
        expect(simpleName('sample.OuterTest$InnerTest')).toBe('InnerTest');
    });

    it('handles multiple nesting levels', () => {
        expect(simpleName('a.b.Outer$Middle$Inner')).toBe('Inner');
    });

    it('handles nested class without package', () => {
        expect(simpleName('Outer$Inner')).toBe('Inner');
    });
});

// ---------------------------------------------------------------------------
// makeClassId / makeMethodId
// ---------------------------------------------------------------------------

describe('makeClassId', () => {
    it('produces a stable ID from module and class name', () => {
        const mod = makeModule(':core');
        const id = makeClassId(mod, 'sample.core.CalculatorTest');
        expect(id).toBe(
            `cls:${mod.workspaceFolder.uri.toString()}::${mod.projectPath}::sample.core.CalculatorTest`
        );
    });

    it('different modules produce different IDs for the same class', () => {
        const modA = makeModule(':core', '/proj/core');
        const modB = makeModule(':app', '/proj/app');
        expect(makeClassId(modA, 'Foo')).not.toBe(makeClassId(modB, 'Foo'));
    });
});

describe('makeMethodId', () => {
    it('produces a stable ID from module, class, and method', () => {
        const mod = makeModule(':');
        const id = makeMethodId(mod, 'MyTest', 'myMethod');
        expect(id).toContain('MyTest');
        expect(id).toContain('myMethod');
    });

    it('different methods in the same class produce different IDs', () => {
        const mod = makeModule(':');
        expect(makeMethodId(mod, 'MyTest', 'a')).not.toBe(makeMethodId(mod, 'MyTest', 'b'));
    });
});

// ---------------------------------------------------------------------------
// buildGradleFilters
// ---------------------------------------------------------------------------

describe('buildGradleFilters', () => {
    it('returns empty array when no items have method meta', () => {
        const item = makeMethodItem('x');
        const m = makeMetaMap([['x', { kind: 'class', className: 'MyTest' }]]);
        expect(buildGradleFilters([item], m)).toEqual([]);
    });

    it('builds a filter string for a single method', () => {
        const item = makeMethodItem('id1');
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.MyTest', methodName: 'myMethod' }]]);
        expect(buildGradleFilters([item], m)).toEqual(['sample.MyTest.myMethod']);
    });

    it('flattens nested class $ to . in filter', () => {
        const item = makeMethodItem('id1');
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.Outer$Inner', methodName: 'test' }]]);
        // Gradle --tests uses . not $ for nested classes.
        expect(buildGradleFilters([item], m)).toEqual(['sample.Outer.Inner.test']);
    });

    it('deduplicates methods from the same class into separate filter entries', () => {
        const a = makeMethodItem('a');
        const b = makeMethodItem('b');
        const m = makeMetaMap([
            ['a', { kind: 'method', className: 'MyTest', methodName: 'test1' }],
            ['b', { kind: 'method', className: 'MyTest', methodName: 'test2' }],
        ]);
        const filters = buildGradleFilters([a, b], m);
        expect(filters).toHaveLength(2);
        expect(filters).toContain('MyTest.test1');
        expect(filters).toContain('MyTest.test2');
    });

    it('deduplicates the same method if included twice', () => {
        const item = makeMethodItem('id1');
        const m = makeMetaMap([['id1', { kind: 'method', className: 'MyTest', methodName: 'test1' }]]);
        // Pass the same item twice — should only produce one filter.
        expect(buildGradleFilters([item, item], m)).toHaveLength(1);
    });

    // ── BugE2 ─────────────────────────────────────────────────────────────────
    // Backtick method names with spaces (e.g. `adds two numbers`) are valid in
    // Kotlin and must be passed as-is to Gradle's --tests filter.
    // The space is preserved in the filter string because cp.spawn does not
    // invoke a shell on POSIX, so spaces in arg values are safe.
    it('[BugE2] backtick method name with spaces is preserved in filter', () => {
        const item = makeMethodItem('id1');
        const m = makeMetaMap([['id1', { kind: 'method', className: 'MyTest', methodName: 'adds two numbers' }]]);
        expect(buildGradleFilters([item], m)).toEqual(['MyTest.adds two numbers']);
    });
});

// ---------------------------------------------------------------------------
// applyResults
// ---------------------------------------------------------------------------

describe('applyResults', () => {
    function makeCase(overrides: Partial<JUnitTestCase>): JUnitTestCase {
        return {
            classname: 'sample.MyTest',
            name: 'myMethod',
            timeMs: 10,
            ...overrides,
        };
    }

    it('marks a passing test as passed', () => {
        const item = makeMethodItem('id1');
        const run = makeMockTestRun();
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.MyTest', methodName: 'myMethod' }]]);
        applyResults(run as any, [item], [makeCase({})], m);
        expect(run._mock.passed).toHaveLength(1);
        expect(run._mock.passed[0].item).toBe(item);
        expect(run._mock.passed[0].ms).toBe(10);
    });

    it('marks a failing test as failed with message', () => {
        const item = makeMethodItem('id1');
        const run = makeMockTestRun();
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.MyTest', methodName: 'myMethod' }]]);
        applyResults(
            run as any,
            [item],
            [makeCase({ failure: { message: 'expected 1 but was 2', type: 'AssertionError', details: 'stack trace' } })],
            m
        );
        expect(run._mock.failed).toHaveLength(1);
        expect(run._mock.failed[0].item).toBe(item);
        expect(run._mock.failed[0].msg.message).toContain('expected 1 but was 2');
        expect(run._mock.failed[0].msg.message).toContain('stack trace');
    });

    it('marks a skipped test as skipped', () => {
        const item = makeMethodItem('id1');
        const run = makeMockTestRun();
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.MyTest', methodName: 'myMethod' }]]);
        applyResults(run as any, [item], [makeCase({ skipped: { message: 'disabled' } })], m);
        expect(run._mock.skipped).toHaveLength(1);
        expect(run._mock.skipped[0]).toBe(item);
    });

    it('marks test as skipped when no XML result is found', () => {
        const item = makeMethodItem('id1');
        const run = makeMockTestRun();
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.MyTest', methodName: 'myMethod' }]]);
        // Empty cases list — no match found.
        applyResults(run as any, [item], [], m);
        expect(run._mock.skipped).toHaveLength(1);
    });

    // ── BugE3 ─────────────────────────────────────────────────────────────────
    // JUnit XML may report method names with () appended (e.g. "myMethod()").
    // applyResults uses stripParens to normalize this, so the test item keyed by
    // plain "myMethod" must still match.
    it('[BugE3] matches XML name "myMethod()" to item with name "myMethod"', () => {
        const item = makeMethodItem('id1');
        const run = makeMockTestRun();
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.MyTest', methodName: 'myMethod' }]]);
        applyResults(run as any, [item], [makeCase({ name: 'myMethod()' })], m);
        expect(run._mock.passed).toHaveLength(1);
    });

    // ── BugE4 ─────────────────────────────────────────────────────────────────
    // Nested class names use `$` in discovery (e.g. OuterTest$InnerTest) but
    // JUnit XML uses `.` (OuterTest.InnerTest). The flattening must work both ways.
    it('[BugE4] nested class $ in meta matches . in XML classname', () => {
        const item = makeMethodItem('id1');
        const run = makeMockTestRun();
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.Outer$Inner', methodName: 'test' }]]);
        applyResults(
            run as any,
            [item],
            [makeCase({ classname: 'sample.Outer.Inner', name: 'test' })],
            m
        );
        expect(run._mock.passed).toHaveLength(1);
    });

    it('includes failure details in the test message', () => {
        const item = makeMethodItem('id1');
        const run = makeMockTestRun();
        const m = makeMetaMap([['id1', { kind: 'method', className: 'sample.MyTest', methodName: 'myMethod' }]]);
        applyResults(
            run as any,
            [item],
            [makeCase({ name: 'myMethod', failure: { message: 'boom', type: 'Error', details: 'at line 42' } })],
            m
        );
        expect(run._mock.failed[0].msg.message).toMatch(/boom/);
        expect(run._mock.failed[0].msg.message).toMatch(/at line 42/);
    });

    it('skips items whose meta is missing (orphaned items)', () => {
        const item = makeMethodItem('orphan');
        const run = makeMockTestRun();
        const m = makeMetaMap([]); // no entry for 'orphan'
        applyResults(run as any, [item], [makeCase({})], m);
        // Item not in meta → silently skipped, no assertion on run state.
        expect(run._mock.passed).toHaveLength(0);
        expect(run._mock.failed).toHaveLength(0);
        expect(run._mock.skipped).toHaveLength(0);
    });
});
