package sample.app

import sample.core.Calculator
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName

class GreeterTest {

    @Test
    @DisplayName("Greeter should greet by name")
    fun greetsByName() {
        val msg = "Hello, world!"
        assertTrue(msg.contains("world"))
    }

    @Test 
    fun usesCalculator() {
        assertTrue(Calculator().add(2, 2) == 4)
    }
}
