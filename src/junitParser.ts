import * as fs from 'fs';
import * as path from 'path';

export interface JUnitTestCase {
    classname: string;
    name: string;
    timeMs: number;
    /** undefined => passed; otherwise either a failure or an error. */
    failure?: { message: string; type?: string; details?: string };
    skipped?: { message?: string };
}

/**
 * Parse all JUnit XML reports under a `build/test-results/<task>/` directory.
 *
 * We use a tiny regex-based parser instead of pulling in an XML dependency – the
 * JUnit XML format produced by Gradle is well-defined and shallow.
 */
export function parseJUnitResultsDir(dir: string): JUnitTestCase[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const out: JUnitTestCase[] = [];
    for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.xml')) {
            continue;
        }
        const full = path.join(dir, entry);
        try {
            const xml = fs.readFileSync(full, 'utf8');
            out.push(...parseJUnitXml(xml));
        } catch {
            // ignore unreadable files
        }
    }
    return out;
}

export function parseJUnitXml(xml: string): JUnitTestCase[] {
    const cases: JUnitTestCase[] = [];
    // Match <testcase ... /> or <testcase ...>...</testcase>
    const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    let m: RegExpExecArray | null;
    while ((m = caseRe.exec(xml)) !== null) {
        const attrs = parseAttrs(m[1]);
        const body = m[3] ?? '';
        const tc: JUnitTestCase = {
            classname: attrs['classname'] ?? '',
            name: attrs['name'] ?? '',
            timeMs: Math.round((parseFloat(attrs['time'] ?? '0') || 0) * 1000),
        };
        const failureMatch =
            body.match(/<failure\b([^>]*?)(\/>|>([\s\S]*?)<\/failure>)/) ||
            body.match(/<error\b([^>]*?)(\/>|>([\s\S]*?)<\/error>)/);
        if (failureMatch) {
            const fAttrs = parseAttrs(failureMatch[1]);
            tc.failure = {
                message: decodeXml(fAttrs['message'] ?? ''),
                type: fAttrs['type'],
                details: decodeXml((failureMatch[3] ?? '').trim()),
            };
        }
        const skippedMatch = body.match(/<skipped\b([^>]*?)(\/>|>([\s\S]*?)<\/skipped>)/);
        if (skippedMatch) {
            const sAttrs = parseAttrs(skippedMatch[1]);
            tc.skipped = { message: decodeXml(sAttrs['message'] ?? '') };
        }
        cases.push(tc);
    }
    return cases;
}

function parseAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /(\w[\w.-]*)\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
        out[m[1]] = decodeXml(m[2]);
    }
    return out;
}

function decodeXml(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#10;/g, '\n')
        .replace(/&#13;/g, '\r')
        .replace(/&#9;/g, '\t')
        .replace(/&amp;/g, '&');
}
