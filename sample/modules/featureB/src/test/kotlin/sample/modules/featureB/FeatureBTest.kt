package sample.modules.featureB

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals

class FeatureBTest {

    @Test
    fun trivialAdd() {
        assertEquals(2, 1 + 1)
    }

    @Test
    fun trivialMul() {
        assertEquals(6, 2 * 3)
    }
}
