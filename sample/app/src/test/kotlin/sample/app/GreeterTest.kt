package sample.app

import sample.core.Calculator
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertTrue

class GreeterTest {

    @Test
    fun greetsByName() {
        val msg = "Hello, world!"
        assertTrue(msg.contains("world"))
    }

    @Test
    fun usesCalculator() {
        assertTrue(Calculator().add(2, 2) == 4)
    }
}
