import { describe, it, expect } from 'vitest';
import { Uri } from './__mocks__/vscode';
import { parseKotlinTests } from '../src/discovery';
import type { GradleModule } from '../src/gradle';

// Minimal GradleModule stub – discovery only reads rootPath and workspaceFolder.
function makeModule(): GradleModule {
    return {
        rootPath: '/project',
        projectPath: ':',
        name: 'test-project',
        workspaceFolder: {
            uri: Uri.file('/project'),
            name: 'test-project',
            index: 0,
        } as any,
    };
}

function parse(content: string, file = '/project/src/test/kotlin/Foo.kt') {
    return parseKotlinTests(makeModule(), Uri.file(file), content);
}

describe('parseKotlinTests', () => {
    it('discovers a simple @Test method', () => {
        const src = `
package sample.core

import org.junit.jupiter.api.Test

class CalculatorTest {
    @Test
    fun addsTwoNumbers() {
        // ...
    }
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].className).toBe('sample.core.CalculatorTest');
        expect(tests[0].methodName).toBe('addsTwoNumbers');
        expect(tests[0].packageName).toBe('sample.core');
        expect(tests[0].line).toBe(6);
    });

    it('discovers multiple test methods in a class', () => {
        const src = `
package sample

class MyTest {
    @Test fun first() {}
    @Test fun second() {}
    @Test fun third() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(3);
        expect(tests.map(t => t.methodName)).toEqual(['first', 'second', 'third']);
    });

    it('ignores non-@Test functions', () => {
        const src = `
package sample
class MyTest {
    private fun helper() {}
    @Test fun realTest() {}
    fun notATest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('realTest');
    });

    it('handles backtick method names', () => {
        const src = `
package sample
class MyTest {
    @Test
    fun \`adds two numbers\`() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('adds two numbers');
    });

    it('handles @ParameterizedTest', () => {
        const src = `
package sample
class MyTest {
    @ParameterizedTest
    fun paramTest(value: Int) {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('paramTest');
    });

    it('handles @TestFactory', () => {
        const src = `
package sample
class MyTest {
    @TestFactory
    fun dynamicTests() = listOf<DynamicTest>()
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
    });

    it('handles nested classes', () => {
        const src = `
package sample
class OuterTest {
    @Nested
    inner class InnerTest {
        @Test fun innerMethod() {}
    }
    @Test fun outerMethod() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(2);
        const inner = tests.find(t => t.methodName === 'innerMethod')!;
        expect(inner.className).toBe('sample.OuterTest$InnerTest');
        const outer = tests.find(t => t.methodName === 'outerMethod')!;
        expect(outer.className).toBe('sample.OuterTest');
    });

    it('returns empty array for file with no tests', () => {
        const src = `
package sample
class Calculator {
    fun add(a: Int, b: Int) = a + b
}
`.trim();
        expect(parse(src)).toHaveLength(0);
    });

    it('returns empty array for empty content', () => {
        expect(parse('')).toHaveLength(0);
    });

    it('ignores // line comments when counting braces', () => {
        const src = `
package sample
class MyTest {
    // fun fakeTest() { }
    @Test
    fun realTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('realTest');
    });

    it('handles no package declaration', () => {
        const src = `
class NoPackageTest {
    @Test fun myTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].className).toBe('NoPackageTest');
        expect(tests[0].packageName).toBe('');
    });

    it('sets correct 0-based line number', () => {
        const src = `package sample\nclass T {\n    @Test\n    fun myTest() {}\n}`;
        const tests = parse(src);
        expect(tests[0].line).toBe(3); // 0-based, line 4 in editor
    });

    // -------------------------------------------------------------------------
    // Bug regression tests
    // -------------------------------------------------------------------------

    // Bug 1: multiple annotations on the same line — only the first was captured,
    // so @Suppress @Test fun foo() would miss @Test.
    it('[Bug 1] multiple annotations on one line — @Test after another annotation', () => {
        const src = `
package sample
class MyTest {
    @Suppress("UNCHECKED_CAST") @Test fun shouldBeFound() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('shouldBeFound');
    });

    // Bug 2: code inside block comments /* ... */ was parsed as real code.
    it('[Bug 2] code inside block comments is not discovered', () => {
        const src = `
package sample
class MyTest {
    /*
    @Test
    fun phantomTest() {}
    */
    @Test fun realTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('realTest');
    });

    // Bug 3: { } inside string literals incorrectly affected brace-depth tracking,
    // which could pop the class frame too early and miss subsequent tests.
    it('[Bug 3] braces inside string literals do not affect class scope tracking', () => {
        const src = `
package sample
class MyTest {
    private val msg = "hello { world }"
    @Test fun afterStringLiteral() {}
    private val unbalanced = "open { brace"
    @Test fun afterUnbalancedString() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(2);
        expect(tests.map(t => t.methodName)).toContain('afterStringLiteral');
        expect(tests.map(t => t.methodName)).toContain('afterUnbalancedString');
    });

    // Bug 4: methods inside `companion object` bodies were attributed to the
    // enclosing class, so a @Test in a companion would be mis-discovered.
    it('[Bug 4] @Test inside companion object is not discovered', () => {
        const src = `
package sample
class MyTest {
    companion object {
        @Test fun companionShouldNotBeTest() {}
    }
    @Test fun realTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('realTest');
    });

    // Bug 5: a stacked multi-annotation block where annotations span multiple
    // lines, interleaved with a non-annotation line, cleared pendingAnnotations
    // before the function declaration.
    it('[Bug 5] stacked annotations with argument on separate line', () => {
        const src = `
package sample
class MyTest {
    @ParameterizedTest
    @ValueSource(ints = [1, 2, 3])
    fun paramTest(v: Int) {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('paramTest');
    });

    // Bug 6: a fun keyword appearing inside a string template was mistakenly
    // matched by the funLine regex.
    it('[Bug 6] fun inside string template is not treated as a function', () => {
        const src = `
package sample
class MyTest {
    private val lambda = "not a fun test("
    @Test fun realTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('realTest');
    });

    // Bug 7: object declarations (singletons) that contain @Test methods
    // should be discovered (Kotlin objects can be test classes with JUnit).
    it('[Bug 7] @Test inside an object declaration is discovered', () => {
        const src = `
package sample
object MyTestObject {
    @Test fun objectTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].className).toBe('sample.MyTestObject');
    });

    // Bug 8: content inside Kotlin raw string literals (""" ... """) must not
    // be parsed as code. A @Test annotation inside a raw string would otherwise
    // be added to pendingAnnotations and cause a phantom test discovery.
    it('[Bug 8] @Test inside raw string literal is not discovered', () => {
        const src = `
package sample
class MyTest {
    @Test fun realTest() {
        val sql = """
            @Test
            fun phantom() {}
        """.trimIndent()
    }
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('realTest');
    });

    // Bug 9: a generic function with complex type bounds like
    // fun <T : Comparable<T>> myTest() was not matched because the funLine regex
    // used [^>]+ which stopped at the first > inside Comparable<T>.
    it('[Bug 9] generic function with complex type bound is discovered', () => {
        const src = `
package sample
class MyTest {
    @Test
    fun <T : Comparable<T>> genericBoundTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('genericBoundTest');
    });

    // Bug 10: a modifier keyword (e.g., override, internal) on a line by itself
    // between @Test and fun must NOT clear pendingAnnotations.
    it('[Bug 10] modifier keyword between @Test and fun does not clear annotations', () => {
        const src = `
package sample
open class BaseTest {
    @Test
    open
    fun overridableTest() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].methodName).toBe('overridableTest');
    });

    // -------------------------------------------------------------------------
    // @Order annotation support
    // -------------------------------------------------------------------------

    it('[Order] captures @Order(n) on test methods', () => {
        const src = `
package sample
class MyTest {
    @Test @Order(2) fun second() {}
    @Test @Order(1) fun first() {}
    @Test fun unordered() {}
}
`.trim();``
        const tests = parse(src);
        const byName = new Map(tests.map(t => [t.methodName, t]));
        expect(byName.get('first')!.order).toBe(1);
        expect(byName.get('second')!.order).toBe(2);
        expect(byName.get('unordered')!.order).toBeUndefined();
    });

    it('[Order] captures @Order on stacked annotation lines', () => {
        const src = `
package sample
class MyTest {
    @Test
    @Order(5)
    fun staggered() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].order).toBe(5);
    });

    it('[Order] captures @Order(value = 7) named-argument form', () => {
        const src = `
package sample
class MyTest {
    @Test @Order(value = 7) fun named() {}
}
`.trim();
        const tests = parse(src);
        expect(tests[0].order).toBe(7);
    });

    it('[Order] captures @Order on the enclosing class as classOrder', () => {
        const src = `
package sample
@Order(10)
class OrderedClass {
    @Test fun a() {}
}
`.trim();
        const tests = parse(src);
        expect(tests).toHaveLength(1);
        expect(tests[0].classOrder).toBe(10);
        // @Order on the class must NOT leak into the method's own order.
        expect(tests[0].order).toBeUndefined();
    });

    it('[Order] @Order on previous method does not leak to the next one', () => {
        const src = `
package sample
class MyTest {
    @Test @Order(1) fun first() {}
    @Test fun second() {}
}
`.trim();
        const tests = parse(src);
        const byName = new Map(tests.map(t => [t.methodName, t]));
        expect(byName.get('first')!.order).toBe(1);
        expect(byName.get('second')!.order).toBeUndefined();
    });
});

