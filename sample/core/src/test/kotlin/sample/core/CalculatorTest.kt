package sample.core

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals

class CalculatorTest {

    private val calc = Calculator()

    @Test
    fun addsTwoNumbers() {
        assertEquals(5, calc.add(2, 3))
    }

    @Test
    fun subtractsTwoNumbers() {
        assertEquals(1, calc.sub(3, 2))
    }

    @Test
    fun failingExample() {
        assertEquals(42, calc.add(1, 1))
    }
}
