/**
 * Helmfile project detection, mirroring the CLI's entry resolution
 * (helmfile `pkg/app/app.go` `findDesiredStateFiles`):
 *
 *   1. `helmfile.yaml` wins over `helmfile.yaml.gotmpl`; both present is an
 *      error in helmfile itself.
 *   2. `helmfile.d/` directory: entries are its `*.y*ml` and
 *      `*.y*ml.gotmpl` files, sorted; coexisting with a default file is an
 *      error in helmfile itself.
 *
 * Explicit `--file` / `HELMFILE_FILE_PATHS` always wins in the CLI; the
 * extension cannot know the user's shell invocation, so it resolves the
 * default entry only and keeps `HELMFILE_FILE_PATHS` as a hint for
 * `overrideEntries`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface HelmfileProject {
    /** Directory that contains the entry (file's or helmfile.d's parent). */
    readonly root: string;
    /** Entry state files, sorted the way helmfile would run them. */
    readonly entries: readonly string[];
    readonly kind: 'file' | 'directory';
    /** helmfile would refuse to run this layout; message explains why. */
    readonly conflict: string | null;
}

const HELMFILE = 'helmfile.yaml';
const HELMFILE_GOTMPL = 'helmfile.yaml.gotmpl';
const HELMFILE_D = 'helmfile.d';

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** `*.yaml` / `*.yml` / `*.yaml.gotmpl` / `*.yml.gotmpl` — helmfile.d's glob. */
export function isStateFileName(name: string): boolean {
    return /^.+\.ya?ml(\.gotmpl)?$/.test(name);
}

/**
 * Detect a project in `dir` following the CLI's default lookup. Returns
 * null when the directory holds no helmfile entry.
 */
export function detectProject(dir: string): HelmfileProject | null {
    const helmfile = path.join(dir, HELMFILE);
    const gotmpl = path.join(dir, HELMFILE_GOTMPL);
    const helmfileD = path.join(dir, HELMFILE_D);

    const helmfileExists = isFile(helmfile);
    const gotmplExists = isFile(gotmpl);
    const dirExists = isDirectory(helmfileD);

    let conflict: string | null = null;
    let defaultFile: string | null = null;
    if (helmfileExists && gotmplExists) {
        conflict = `both ${HELMFILE} and ${HELMFILE_GOTMPL} exist in ${dir}: helmfile refuses to run until one is removed`;
    }
    if (helmfileExists) defaultFile = helmfile;
    else if (gotmplExists) defaultFile = gotmpl;

    if (dirExists && defaultFile && !conflict) {
        conflict = `both ${path.basename(defaultFile)} and ${HELMFILE_D}/ exist in ${dir}: helmfile refuses to run until one is removed`;
    }

    if (dirExists) {
        const entries = fs.readdirSync(helmfileD)
            .filter(name => isStateFileName(name))
            .sort()
            .map(name => path.join(helmfileD, name));
        return { root: dir, entries, kind: 'directory', conflict };
    }
    if (defaultFile) return { root: dir, entries: [defaultFile], kind: 'file', conflict };
    return null;
}

/**
 * Nearest project at or above `file`'s directory (an entry in a parent
 * directory governs nested values/sub-states), bounded to `stopAt` when
 * given.
 */
export function projectFor(file: string, stopAt?: string): HelmfileProject | null {
    let dir = path.dirname(file);
    const root = path.parse(dir).root;
    const stop = stopAt && stopAt.length > root.length ? stopAt : root;
    for (let depth = 0; depth < 64; depth++) {
        const project = detectProject(dir);
        if (project) return project;
        if (dir === stop || !dir.startsWith(stop)) return null;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

/** Entries from HELMFILE_FILE_PATHS when set (colon-separated), for display. */
export function overrideEntries(): string[] | null {
    const raw = process.env.HELMFILE_FILE_PATHS;
    if (!raw) return null;
    const parts = raw.split(path.delimiter).filter(Boolean);
    return parts.length ? parts : null;
}

/**
 * The scope key two files share when they belong to the same helmfile
 * project: the project root, or (no entry found) the file's own directory
 * so unrelated state files never share selection state.
 */
export function projectScope(file: string): string {
    return projectFor(file)?.root ?? path.dirname(file);
}
