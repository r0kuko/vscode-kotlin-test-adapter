/**
 * Generate the extension icon by overlaying the Kotlin logo (scaled to 25%)
 * onto the bottom-right of the Test Explorer logo.
 *
 * Usage:
 *   node scripts/generate_icon.js
 *
 * Output: images/icon.png (256x256)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const TEST_EXPLORER_URL =
    'https://github.com/hbenl/vscode-test-explorer/raw/refs/heads/master/icon.png';
const KOTLIN_LOGO_URL = 'https://kotlinlang.org/assets/images/favicon.svg?v2';

const OUT_DIR = path.resolve(__dirname, '..', 'images');
const OUT_FILE = path.join(OUT_DIR, 'icon.png');
const CACHE_DIR = path.resolve(__dirname, '.cache');

/** Final canvas size. VS Code recommends 128x128+ for marketplace icons. */
const SIZE = 256;
/** Kotlin logo size relative to the canvas. */
const OVERLAY_RATIO = 0.50;
/** Padding from the bottom-right edge, relative to canvas. */
const PADDING_RATIO = 0.04;

async function main() {
    let sharp;
    try {
        sharp = require('sharp');
    } catch {
        console.error(
            "Missing dependency 'sharp'. Install it first:\n" +
            '  npm install --save-dev sharp\n'
        );
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const basePath = path.join(CACHE_DIR, 'test-explorer.png');
    const overlayPath = path.join(CACHE_DIR, 'kotlin.svg');

    console.log('→ Downloading Test Explorer icon…');
    await download(TEST_EXPLORER_URL, basePath);
    console.log('→ Downloading Kotlin logo…');
    await download(KOTLIN_LOGO_URL, overlayPath);

    const overlaySize = Math.round(SIZE * OVERLAY_RATIO);
    const padding = Math.round(SIZE * PADDING_RATIO);

    // Resize the base icon to SIZE x SIZE (preserving aspect via 'contain').
    const base = await sharp(basePath)
        .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

    // Render the Kotlin SVG. The official favicon contains transparent padding
    // around the diamond, so trim() it first — otherwise the visible logo would
    // not actually sit flush in the bottom-right corner.
    const trimmedOverlay = await sharp(overlayPath, { density: 384 })
        .trim()
        .png()
        .toBuffer();
    const overlay = await sharp(trimmedOverlay)
        .resize(overlaySize, overlaySize, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();

    const left = SIZE - overlaySize - padding;
    const top = SIZE - overlaySize - padding;

    await sharp(base)
        .composite([{ input: overlay, left, top }])
        .png()
        .toFile(OUT_FILE);

    console.log(`✓ Wrote ${path.relative(process.cwd(), OUT_FILE)} (${SIZE}x${SIZE})`);
}

function download(url, destPath, redirects = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(
                url,
                {
                    headers: {
                        'User-Agent': 'vscode-kotlin-test-adapter/icon-generator',
                        Accept: '*/*',
                    },
                },
                res => {
                    if (
                        res.statusCode &&
                        res.statusCode >= 300 &&
                        res.statusCode < 400 &&
                        res.headers.location
                    ) {
                        if (redirects <= 0) {
                            return reject(new Error(`Too many redirects for ${url}`));
                        }
                        const next = new URL(res.headers.location, url).toString();
                        res.resume();
                        return resolve(download(next, destPath, redirects - 1));
                    }
                    if (res.statusCode !== 200) {
                        return reject(
                            new Error(`GET ${url} failed: HTTP ${res.statusCode}`)
                        );
                    }
                    const file = fs.createWriteStream(destPath);
                    res.pipe(file);
                    file.on('finish', () => file.close(() => resolve(undefined)));
                    file.on('error', reject);
                }
            )
            .on('error', reject);
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
