import { describe, it, expect } from 'vitest';
import { parseJUnitXml } from '../src/junitParser';

describe('parseJUnitXml', () => {
    it('parses a passing test case', () => {
        const xml = `
<testsuite>
  <testcase classname="sample.core.CalculatorTest" name="addsTwoNumbers" time="0.012" />
</testsuite>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases).toHaveLength(1);
        expect(cases[0].classname).toBe('sample.core.CalculatorTest');
        expect(cases[0].name).toBe('addsTwoNumbers');
        expect(cases[0].timeMs).toBe(12);
        expect(cases[0].failure).toBeUndefined();
        expect(cases[0].skipped).toBeUndefined();
    });

    it('parses a failing test case with message', () => {
        const xml = `
<testsuite>
  <testcase classname="sample.MyTest" name="fails" time="0.005">
    <failure message="expected 1 but was 2" type="AssertionError">stack trace here</failure>
  </testcase>
</testsuite>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases).toHaveLength(1);
        expect(cases[0].failure).toBeDefined();
        expect(cases[0].failure!.message).toBe('expected 1 but was 2');
        expect(cases[0].failure!.type).toBe('AssertionError');
        expect(cases[0].failure!.details).toBe('stack trace here');
    });

    it('parses a skipped test case', () => {
        const xml = `
<testsuite>
  <testcase classname="sample.MyTest" name="skipped" time="0">
    <skipped message="not yet implemented"/>
  </testcase>
</testsuite>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases).toHaveLength(1);
        expect(cases[0].skipped).toBeDefined();
        expect(cases[0].skipped!.message).toBe('not yet implemented');
        expect(cases[0].failure).toBeUndefined();
    });

    it('parses an error (as failure)', () => {
        const xml = `
<testsuite>
  <testcase classname="sample.MyTest" name="throws" time="0.001">
    <error message="NullPointerException" type="java.lang.NullPointerException">npe trace</error>
  </testcase>
</testsuite>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases).toHaveLength(1);
        expect(cases[0].failure).toBeDefined();
        expect(cases[0].failure!.message).toBe('NullPointerException');
    });

    it('handles XML entity decoding', () => {
        const xml = `
<testsuite>
  <testcase classname="sample.MyTest" name="test" time="0">
    <failure message="expected &lt;1&gt; but was &lt;2&gt;" type="AssertionError"></failure>
  </testcase>
</testsuite>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases[0].failure!.message).toBe('expected <1> but was <2>');
    });

    it('handles multiple test cases in one file', () => {
        const xml = `
<testsuite>
  <testcase classname="sample.MyTest" name="first" time="0.001" />
  <testcase classname="sample.MyTest" name="second" time="0.002" />
  <testcase classname="sample.MyTest" name="third" time="0.003">
    <failure message="boom" type="AssertionError"></failure>
  </testcase>
</testsuite>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases).toHaveLength(3);
        expect(cases[2].failure).toBeDefined();
    });

    it('returns empty array for empty xml', () => {
        expect(parseJUnitXml('')).toHaveLength(0);
        expect(parseJUnitXml('<testsuite/>')).toHaveLength(0);
    });

    it('rounds time to milliseconds', () => {
        const xml = `<testcase classname="A" name="b" time="1.2345" />`;
        const cases = parseJUnitXml(xml);
        expect(cases[0].timeMs).toBe(1235);
    });

    it('handles missing time attribute gracefully', () => {
        const xml = `<testcase classname="A" name="b" />`;
        const cases = parseJUnitXml(xml);
        expect(cases[0].timeMs).toBe(0);
    });

    it('handles self-closing failure tag', () => {
        const xml = `
<testcase classname="A" name="b" time="0">
  <failure message="oops" type="Error"/>
</testcase>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases[0].failure!.message).toBe('oops');
        expect(cases[0].failure!.details).toBe('');
    });

    // -------------------------------------------------------------------------
    // Bug regression tests
    // -------------------------------------------------------------------------

    // Bug 8: &amp; must be decoded LAST. &amp;lt; should decode to &lt;, not <.
    it('[Bug 8] &amp; decoded last — &amp;lt; becomes &lt; not <', () => {
        const xml = `<testcase classname="A" name="b" time="0">
  <failure message="a &amp;lt; b" type="E"></failure>
</testcase>`;
        const cases = parseJUnitXml(xml);
        expect(cases[0].failure!.message).toBe('a &lt; b');
    });

    // Bug 9: a testcase name containing parentheses (JUnit 4 style "method()")
    // must still be matched when stripParens is applied in applyResults.
    // The raw name in XML is "myTest()" and meta has "myTest" — the match must work.
    it('[Bug 9] testcase name with () suffix is parsed correctly', () => {
        const xml = `<testcase classname="sample.MyTest" name="myTest()" time="0.001" />`;
        const cases = parseJUnitXml(xml);
        expect(cases[0].name).toBe('myTest()');
    });

    // Bug 10: parameterized test names contain brackets, e.g. "test(1)[1]".
    // The name stored in XML is "test(1)[1]" and stripParens gives "test".
    // Ensure the parser doesn't choke on such names.
    it('[Bug 10] parameterized test name with brackets is parsed', () => {
        const xml = `<testcase classname="sample.MyTest" name="test(1)[1]" time="0.002" />`;
        const cases = parseJUnitXml(xml);
        expect(cases[0].name).toBe('test(1)[1]');
        expect(cases).toHaveLength(1);
    });

    // Bug 11: a <testcase> attribute value containing > (as &gt;) must not
    // cause the regex to stop early.
    it('[Bug 11] attribute value with &gt; entity does not break parsing', () => {
        const xml = `<testcase classname="sample.MyTest" name="a &gt; b" time="0" />`;
        const cases = parseJUnitXml(xml);
        expect(cases[0].name).toBe('a > b');
    });

    // Bug 12: skipped element with no message attribute should not crash.
    it('[Bug 12] skipped with no message attribute does not crash', () => {
        const xml = `<testcase classname="A" name="b" time="0"><skipped/></testcase>`;
        const cases = parseJUnitXml(xml);
        expect(cases[0].skipped).toBeDefined();
        expect(cases[0].skipped!.message).toBe('');
    });

    // Bug 13: XML attribute values enclosed in single quotes (valid XML) were
    // silently dropped because parseAttrs only handled double-quoted values.
    it('[Bug 13] single-quoted XML attribute values are parsed', () => {
        const xml = `<testcase classname='sample.MyTest' name='myTest' time='0.001' />`;
        const cases = parseJUnitXml(xml);
        expect(cases).toHaveLength(1);
        expect(cases[0].classname).toBe('sample.MyTest');
        expect(cases[0].name).toBe('myTest');
        expect(cases[0].timeMs).toBe(1);
    });

    // Bug 14: the <skipped> element may carry its reason in the element body
    // text rather than (or in addition to) the `message` attribute.
    // The parser must fall back to the body text when the message attribute is absent.
    it('[Bug 14] skipped body text used as message when attribute is absent', () => {
        const xml = `
<testcase classname="A" name="b" time="0">
  <skipped>This test is not implemented yet</skipped>
</testcase>`.trim();
        const cases = parseJUnitXml(xml);
        expect(cases[0].skipped).toBeDefined();
        expect(cases[0].skipped!.message).toBe('This test is not implemented yet');
    });
});

