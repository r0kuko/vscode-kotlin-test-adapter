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
    /** 0-based line number of the enclosing class/object declaration. */
    classLine: number;
    /** Whether the enclosing class is annotated with @Nested (kept for future use). */
    nested: boolean;
    /** Optional order from `@Order(n)` on the test method. Lower runs/displays first. */
    order?: number;
    /** Optional order from `@Order(n)` on the enclosing class. */
    classOrder?: number;
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
    let inBlockComment = false;
    let inRawString = false;

    type ClassFrame = {
        name: string;
        line: number;
        braceDepth: number; // brace depth at which this class lives
        nested: boolean;
        hasNestedAnnotation: boolean;
        order?: number;
    };
    const classStack: ClassFrame[] = [];
    let braceDepth = 0;
    let pendingAnnotations: string[] = [];
    let pendingOrder: number | undefined;

    const tests: DiscoveredTest[] = [];

    const annotationLine = /^\s*@([A-Za-z_][\w.]*)/;
    const allAnnotationsOnLine = /@([A-Za-z_][\w.]*)/g;
    const packageLine = /^\s*package\s+([\w.]+)/;
    const classLine =
        /^\s*(?:(?:public|internal|private|protected|open|abstract|sealed|final|inner|data|enum|annotation|companion)\s+)*(?:class|object)\s+([A-Za-z_][\w]*)/;
    // companion object without a name — push a synthetic frame so its body
    // is isolated from the enclosing class.
    const companionObjectLine =
        /^\s*(?:(?:public|internal|private|protected)\s+)?companion\s+object\s*[^A-Za-z_]/;
    // (?:<[^(]+>\s+)? handles generic type params including nested bounds like
    // <T : Comparable<T>>. Using [^(]+ instead of [^>]+ avoids stopping at the
    // first > in a nested generic.
    const funLine =
        /(?:^|(?<=\s))fun\s+(?:<[^(]+>\s+)?([A-Za-z_][\w]*|`[^`]+`)\s*\(/;

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
    // `@Order(5)` — JUnit 5's org.junit.jupiter.api.Order. Captures the integer.
    const orderAnnotationRegex = /@Order\s*\(\s*(?:value\s*=\s*)?(-?\d+)\s*\)/;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];

        // ── Block comment tracking ────────────────────────────────────────────
        // Strip any block-comment regions before further processing.
        let line = stripLineComment(raw);

        // ── Raw string (triple-quoted) tracking ──────────────────────────────────
        // Count """ occurrences on the processed line to track multi-line raw
        // strings.  Lines inside """...""" must not be parsed as code.
        const rawQuoteCount = (line.match(/"""/g) ?? []).length;
        const wasInRawString = inRawString;
        if (rawQuoteCount % 2 !== 0) {
            inRawString = !inRawString;
        }
        if (wasInRawString || (inRawString && rawQuoteCount > 0)) {
            // Either fully inside a raw string, or on the opening/closing delimiter
            // line.  Skip all further processing (including brace counting).
            continue;
        }
        if (inBlockComment) {
            const endIdx = line.indexOf('*/');
            if (endIdx === -1) {
                // Entire line is inside a block comment.
                continue;
            }
            // Rest of the line after the block comment end.
            line = line.slice(endIdx + 2);
            inBlockComment = false;
        }
        // Check for a block comment starting on this line.
        const blockStart = line.indexOf('/*');
        if (blockStart !== -1) {
            const blockEnd = line.indexOf('*/', blockStart + 2);
            if (blockEnd === -1) {
                // Block comment opens but doesn't close on this line.
                line = line.slice(0, blockStart);
                inBlockComment = true;
            } else {
                // Block comment opens and closes on same line — remove it.
                line = line.slice(0, blockStart) + line.slice(blockEnd + 2);
            }
        }

        const pkgMatch = line.match(packageLine);
        if (pkgMatch && !pkg) {
            pkg = pkgMatch[1];
        }

        // Collect ALL annotations on this line (e.g. `@Suppress @Test fun foo()`).
        const annMatch = line.match(annotationLine);
        if (annMatch) {
            let am: RegExpExecArray | null;
            allAnnotationsOnLine.lastIndex = 0;
            while ((am = allAnnotationsOnLine.exec(line)) !== null) {
                pendingAnnotations.push(am[1]);
            }
            const orderMatch = line.match(orderAnnotationRegex);
            if (orderMatch) {
                pendingOrder = parseInt(orderMatch[1], 10);
            }
        }

        // companion object without a name — push a synthetic frame so its body
        // is NOT attributed to the enclosing class.
        const companionMatch = line.match(companionObjectLine);
        if (companionMatch) {
            classStack.push({
                name: '$Companion',
                line: i,
                braceDepth,
                nested: classStack.length > 0,
                hasNestedAnnotation: false,
            });
            pendingAnnotations = [];
            pendingOrder = undefined;
        }

        const classMatch = !companionMatch && line.match(classLine);
        if (classMatch) {
            const isNested = pendingAnnotations.some(a => nestedAnnotationNames.has(a));
            classStack.push({
                name: classMatch[1],
                line: i,
                braceDepth,
                nested: classStack.length > 0,
                hasNestedAnnotation: isNested,
                order: pendingOrder,
            });
            // Annotations have been consumed by this class declaration.
            pendingAnnotations = [];
            pendingOrder = undefined;
        }

        const funMatch = line.match(funLine);
        if (funMatch && classStack.length > 0) {
            // Skip methods inside companion objects — they are not test methods.
            const topFrame = classStack[classStack.length - 1];
            const insideCompanion = topFrame.name === '$Companion';
            const isTest = !insideCompanion && pendingAnnotations.some(a => testAnnotationNames.has(a));
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
                    classLine: cls.line,
                    nested: cls.hasNestedAnnotation,
                    order: pendingOrder,
                    classOrder: cls.order,
                });
            }
            // Annotations have been consumed by this function declaration.
            pendingAnnotations = [];
            pendingOrder = undefined;
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

        // Reset pending annotations only when we encounter a line that is not
        // - an annotation line, AND
        // - not a pure modifier keyword line (override, internal, open, etc.)
        // A pure modifier line can legally appear between @Test and fun.
        const MODIFIER_WORDS = new Set([
            'public', 'internal', 'private', 'protected', 'open', 'abstract',
            'sealed', 'final', 'inner', 'data', 'enum', 'annotation', 'override',
            'external', 'expect', 'actual', 'tailrec', 'inline', 'noinline',
            'crossinline', 'suspend', 'operator', 'infix', 'lateinit',
        ]);
        const trimmed = line.trim();
        const isModifierOnly =
            !annMatch &&
            trimmed.length > 0 &&
            trimmed.split(/\s+/).every(w => MODIFIER_WORDS.has(w));
        if (trimmed && !annMatch && !isModifierOnly) {
            // Reset pending annotations once we hit a non-annotation, non-modifier, non-empty line.
            pendingAnnotations = [];
            pendingOrder = undefined;
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
