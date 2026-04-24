package sample.modules.featureA

import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestMethodOrder
import org.junit.jupiter.api.Assertions.assertTrue
import sample.core.Calculator

/**
 * Demonstrates `@Order` sorting in the Test Explorer.
 *
 * The method names are intentionally chosen so that @Order order ≠ alphabetical:
 *
 *   @Order display (what you SHOULD see in the sidebar):
 *     1. zFirstByOrder   ← @Order(1), but "z" is last alphabetically
 *     2. aSecondByOrder  ← @Order(2), but "a" is first alphabetically
 *     3. mThirdByOrder   ← @Order(3), "m" is in the middle
 *     4. gNoOrder        ← no @Order, should appear last
 *
 *   Alphabetical display (what you would see if @Order is IGNORED):
 *     aSecondByOrder → gNoOrder → mThirdByOrder → zFirstByOrder
 *
 * Seeing "zFirstByOrder" at the TOP of the list proves @Order is working.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class FeatureATest {

    private val calc = Calculator()

    @Test
    @Order(1)
    fun zFirstByOrder() {
        // @Order(1): appears FIRST despite "z" being last alphabetically
        assertTrue(calc.add(3, 3) == 6)
    }

    @Test
    @Order(2)
    fun aSecondByOrder() {
        // @Order(2): appears SECOND despite "a" being first alphabetically
        assertTrue(calc.add(1, 1) == 2)
    }

    @Test
    @Order(3)
    fun mThirdByOrder() {
        // @Order(3): appears THIRD
        assertTrue(calc.sub(5, 2) == 3)
    }

    @Test
    fun gNoOrder() {
        // No @Order: appears LAST, after all @Order-annotated methods
        assertTrue(true)
    }
}

