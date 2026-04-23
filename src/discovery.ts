import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GradleModule } from './gradle';

/** A single test method discovered in a Kotlin source file. */
export interface DiscoveredTest {
    module: GradleModule;
    file: string;
    /** Fully qualified class name (with package). */
    className: string;
    /** Simple class name (no package). */
    simpleClassName: string;
    packageName: string;
    /** Test method name (without `()`). */
    methodName: string;
    /** 0-based line number of the test method declaration. */
    line: number;
    /** Whether the enclosing class is annotated with @Nested (kept for future use). */
    nested: boolean;
}

/** Find all Kotlin test files for a module honoring user globs. */
export async function findTestFiles(module: GradleModule): Promise<vscode.Uri[]> {
    const config = vscode.workspace.getConfiguration(
        'kotlinTestAdapter',
        module.workspaceFolder.uri
    );
    const globs = config.get<string[]>('testSourceGlobs') ?? [];
    const excludes = config.get<string[]>('excludeGlobs') ?? [];

    const results: vscode.Uri[] = [];
    const seen = new Set<string>();
    for (const g of globs) {
        // Make the glob relative to the module root.
        const rel = stripLeadingGlob(g);
        const pattern = new vscode.RelativePattern(module.rootPath, rel);
        const excludePattern = excludes.length
            ? `{${excludes.join(',')}}`
            : undefined;
        const found = await vscode.workspace.findFiles(pattern, excludePattern);
        for (const uri of found) {
            if (!seen.has(uri.fsPath)) {
                seen.add(uri.fsPath);
                results.push(uri);
            }
        }
    }
    return results;
}

function stripLeadingGlob(g: string): string {
    // Convert leading `**/` so that the pattern is rooted at the module directory.
    return g.replace(/^\*\*\//, '');
}

/**
 * Parse a Kotlin file and extract JUnit-style test methods.
 *
 * This is a deliberately lightweight scanner – not a full Kotlin parser.
 * It recognises:
 *   - `package x.y.z` declaration
 *   - top-level and nested `class` / `object` declarations
 *   - functions annotated with `@Test` (and a few common JUnit 5 variants)
 *
 * Limitations: it does not understand `typealias`, generics-heavy edge cases or
 * complex multi-line annotation expressions. Good enough for the vast majority
 * of unit-test files and intentionally LSP-free for fast first delivery.
 */
export function parseKotlinTests(
    module: GradleModule,
    fileUri: vscode.Uri,
    content?: string
): DiscoveredTest[] {
    const filePath = fileUri.fsPath;
    const text = content ?? safeRead(filePath);
    if (!text) {
        return [];
    }

    const lines = text.split(/\r?\n/);
    let pkg = '';

    type ClassFrame = {
        name: string;
        line: number;
        braceDepth: number; // brace depth at which this class lives
        nested: boolean;
        hasNestedAnnotation: boolean;
    };
    const classStack: ClassFrame[] = [];
    let braceDepth = 0;
    let pendingAnnotations: string[] = [];

    const tests: DiscoveredTest[] = [];

    const annotationLine = /^\s*@([A-Za-z_][\w.]*)/;
    const packageLine = /^\s*package\s+([\w.]+)/;
    const classLine =
        /^\s*(?:(?:public|internal|private|protected|open|abstract|sealed|final|inner|data|enum|annotation|companion)\s+)*(?:class|object)\s+([A-Za-z_][\w]*)/;
    const funLine =
        /^\s*(?:(?:public|internal|private|protected|open|override|suspend|inline|operator|infix|tailrec|external|final)\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z_][\w]*|`[^`]+`)\s*\(/;

    const testAnnotationNames = new Set([
        'Test',
        'org.junit.Test',
        'org.junit.jupiter.api.Test',
        'ParameterizedTest',
        'org.junit.jupiter.params.ParameterizedTest',
        'RepeatedTest',
        'org.junit.jupiter.api.RepeatedTest',
        'TestFactory',
        'org.junit.jupiter.api.TestFactory',
    ]);
    const nestedAnnotationNames = new Set([
        'Nested',
        'org.junit.jupiter.api.Nested',
    ]);

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = stripLineComment(raw);

        const pkgMatch = line.match(packageLine);
        if (pkgMatch && !pkg) {
            pkg = pkgMatch[1];
        }

        const annMatch = line.match(annotationLine);
        if (annMatch) {
            pendingAnnotations.push(annMatch[1]);
            // Annotations may be the only thing on the line; continue scanning the same line for declarations.
        }

        const classMatch = line.match(classLine);
        if (classMatch) {
            const isNested = pendingAnnotations.some(a => nestedAnnotationNames.has(a));
            classStack.push({
                name: classMatch[1],
                line: i,
                braceDepth,
                nested: classStack.length > 0,
                hasNestedAnnotation: isNested,
            });
        }

        const funMatch = line.match(funLine);
        if (funMatch && classStack.length > 0) {
            const isTest = pendingAnnotations.some(a => testAnnotationNames.has(a));
            if (isTest) {
                const cls = classStack[classStack.length - 1];
                const fqClass = buildClassName(pkg, classStack);
                tests.push({
                    module,
                    file: filePath,
                    className: fqClass,
                    simpleClassName: cls.name,
                    packageName: pkg,
                    methodName: funMatch[1].replace(/^`|`$/g, ''),
                    line: i,
                    nested: cls.hasNestedAnnotation,
                });
            }
        }

        // Track braces AFTER inspecting the line so the class's own opening brace
        // counts toward the body depth.
        const opens = countChar(line, '{');
        const closes = countChar(line, '}');
        braceDepth += opens - closes;
        // Pop any classes whose scope has closed.
        while (
            classStack.length > 0 &&
            braceDepth <= classStack[classStack.length - 1].braceDepth
        ) {
            classStack.pop();
        }

        if (line.trim() && !annMatch) {
            // Reset pending annotations once we hit a non-annotation, non-empty line.
            pendingAnnotations = [];
        }
    }

    return tests;
}

function buildClassName(pkg: string, stack: { name: string }[]): string {
    const inner = stack.map(s => s.name).join('$');
    return pkg ? `${pkg}.${inner}` : inner;
}

function countChar(s: string, ch: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ch) {
            n++;
        }
    }
    return n;
}

function stripLineComment(line: string): string {
    const idx = line.indexOf('//');
    if (idx === -1) {
        return line;
    }
    // Avoid stripping `//` inside a string literal in trivial cases.
    const before = line.slice(0, idx);
    const quotes = (before.match(/"/g) || []).length;
    if (quotes % 2 === 1) {
        return line; // inside a string – leave alone
    }
    return before;
}

function safeRead(p: string): string | undefined {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return undefined;
    }
}

/** Group discovered tests by class for building a tree. */
export function groupByClass(tests: DiscoveredTest[]): Map<string, DiscoveredTest[]> {
    const m = new Map<string, DiscoveredTest[]>();
    for (const t of tests) {
        const list = m.get(t.className) ?? [];
        list.push(t);
        m.set(t.className, list);
    }
    return m;
}

export function relativeToModule(module: GradleModule, file: string): string {
    return path.relative(module.rootPath, file);
}
