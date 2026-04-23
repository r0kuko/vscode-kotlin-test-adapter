import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * A discovered Gradle module (subproject root containing a build script).
 */
export interface GradleModule {
    /** Absolute path to the module directory. */
    rootPath: string;
    /** Gradle project path, e.g. ":core" or ":" for the root project. */
    projectPath: string;
    /** Display name for the module. */
    name: string;
    /** The workspace folder this module belongs to. */
    workspaceFolder: vscode.WorkspaceFolder;
}

/**
 * Discover Gradle modules in a workspace folder by scanning settings.gradle(.kts) and build files.
 *
 * Heuristic:
 *  - The workspace root is treated as the root project if it contains a build/settings file.
 *  - Subdirectories containing a `build.gradle` or `build.gradle.kts` are considered modules.
 *  - We avoid descending into `build/`, `.gradle/`, `node_modules/`, `out/`.
 */
export async function discoverGradleModules(
    folder: vscode.WorkspaceFolder
): Promise<GradleModule[]> {
    const root = folder.uri.fsPath;
    const modules: GradleModule[] = [];

    const rootHasBuild =
        fileExists(path.join(root, 'build.gradle.kts')) ||
        fileExists(path.join(root, 'build.gradle'));
    const rootHasSettings =
        fileExists(path.join(root, 'settings.gradle.kts')) ||
        fileExists(path.join(root, 'settings.gradle'));

    if (!rootHasBuild && !rootHasSettings) {
        return modules;
    }

    // Always include the root project (some single-module projects only have build.gradle.kts).
    if (rootHasBuild) {
        modules.push({
            rootPath: root,
            projectPath: ':',
            name: path.basename(root),
            workspaceFolder: folder,
        });
    }

    // Scan recursively for additional build files.
    const skip = new Set(['build', '.gradle', 'node_modules', 'out', '.git', '.idea']);
    const stack: string[] = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) {
                continue;
            }
            if (skip.has(e.name) || e.name.startsWith('.')) {
                continue;
            }
            const sub = path.join(dir, e.name);
            const hasBuild =
                fileExists(path.join(sub, 'build.gradle.kts')) ||
                fileExists(path.join(sub, 'build.gradle'));
            if (hasBuild && sub !== root) {
                const rel = path.relative(root, sub).split(path.sep).join(':');
                modules.push({
                    rootPath: sub,
                    projectPath: ':' + rel,
                    name: rel || path.basename(sub),
                    workspaceFolder: folder,
                });
            }
            stack.push(sub);
        }
    }

    return modules;
}

function fileExists(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** Resolve the gradle command to use for a workspace folder. */
export function resolveGradleCommand(folder: vscode.WorkspaceFolder): {
    command: string;
    cwd: string;
} {
    const config = vscode.workspace.getConfiguration('kotlinTestAdapter', folder.uri);
    const override = (config.get<string>('gradleCommand') || '').trim();
    const cwd = folder.uri.fsPath;
    if (override) {
        return { command: override, cwd };
    }
    const isWin = process.platform === 'win32';
    const wrapper = isWin ? 'gradlew.bat' : 'gradlew';
    const wrapperPath = path.join(cwd, wrapper);
    if (fileExists(wrapperPath)) {
        // On POSIX use ./gradlew; on Windows the .bat file works directly.
        return { command: isWin ? wrapperPath : './' + wrapper, cwd };
    }
    return { command: 'gradle', cwd };
}
