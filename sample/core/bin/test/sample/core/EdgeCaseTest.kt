package sample.core

import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull

/**
 * Edge-case test class for vscode-kotlin-test-adapter.
 *
 * Each test or scenario here corresponds to a specific regression case that is
 * covered by test/discovery.test.ts. The comment on each item describes which
 * parser case it exercises and what bug it originally exposed.
 *
 * This file is intentionally kept in the sample project so that CI can verify
 * the extension actually discovers AND runs these tests end-to-end.
 */
@Suppress("UnnecessaryVariable")
class EdgeCaseTest {

    private val calc = Calculator()

    // ── Case 1: Multiple annotations on the same line ─────────────────────────
    // The parser used to capture only the FIRST annotation on a line.
    // So `@Suppress("X") @Test fun foo()` would miss the @Test and skip discovery.
    // Fix: use allAnnotationsOnLine loop instead of a single match.
    @Suppress("UNCHECKED_CAST") @Test fun multiAnnotationSameLine() {
        assertEquals(4, calc.add(2, 2))
    }

    // ── Case 2: Compact inline-annotation style ────────────────────────────────
    // `@Test fun name()` written on a single line with no newline between them.
    // Exercises the same fix as Case 1 but as the most common compact form.
    @Test fun inlineAnnotated() = assertEquals(0, calc.add(0, 0))

    // ── Case 3: Stacked annotations with arguments across lines ───────────────
    // A @ParameterizedTest followed by @ValueSource — each annotation is on its
    // own line. The parser must accumulate both before encountering `fun`.
    @ParameterizedTest
    @ValueSource(ints = [1, 2, 3])
    fun stackedAnnotationsWithArguments(value: Int) {
        assert(value in 1..3)
    }

    // ── Case 4: Backtick method name with spaces ────────────────────────────────
    // Kotlin allows spaces in function names when wrapped in backticks.
    // The parser's funLine regex must handle `` `method name` `` as a valid name.
    @Test
    fun `adds two numbers`() {
        assertEquals(5, calc.add(2, 3))
    }

    // ── Case 5: Code inside block comments must NOT be discovered ──────────────
    // The block comment below contains a syntactically valid @Test declaration.
    // A parser that doesn't strip block comments would add "phantomInComment" as
    // a test, creating phantom entries in the test explorer.
    /*
     * @Test
     * fun phantomInBlockComment() {}
     */
    @Test fun afterBlockComment() = assertEquals(1, calc.sub(3, 2))

    // ── Case 6: Braces inside string literals must not affect brace-depth ──────
    // If `{` and `}` inside a string literal were counted, the brace-depth tracker
    // might close the class scope too early, causing tests further down to be missed.
    @Test fun bracesInsideStringLiteral() {
        val template = "INSERT INTO t (a, b) VALUES {1, 2}"
        assertNotNull(template)
    }

    // ── Case 7: companion object — @Test inside must NOT be discovered ──────────
    // JUnit 5 cannot instantiate a companion object as a test class.
    // The parser must isolate the companion's body and ignore any @Test inside.
    // (The @JvmStatic factory below has no @Test — just to show the companion exists.)
    companion object {
        @JvmStatic
        fun create() = EdgeCaseTest()
    }

    // ── Case 8: Nested @Nested class ───────────────────────────────────────────
    // The parser must detect inner class declarations and build the correct
    // fully-qualified className: OuterTest$InnerTest.
    @Nested
    inner class NestedArithmetic {

        @Test fun nestedAdd() = assertEquals(10, calc.add(4, 6))

        @Test fun nestedSub() = assertEquals(2, calc.sub(5, 3))
    }
}

// ── Case 9: Kotlin `object` declaration as a test class ───────────────────────
// `object` declarations are singletons. The parser must discover @Test methods
// inside them, treating `object Foo` the same as `class Foo` for discovery.
// The JUnit 5 Kotlin extension supports running @Test in object declarations.
object EdgeCaseSingletonTest {

    private val calc = Calculator()

    @Test fun objectLevelAdd() = assertEquals(7, calc.add(3, 4))
}
