/**
 * Context-aware completion: knows what the field being filled means and
 * offers cross-referenced suggestions instead of a flat field list —
 *
 *   needs:        → release names declared in this state
 *   inherit:      → template declarations
 *   condition:    → `<release>.enabled` / `.Values.<key>.enabled`
 *   kubeContext:  → contexts from $KUBECONFIG / ~/.kube/config
 *   values/secrets (list form), bases, helmfiles, helmfiles[].path
 *                 → files next to the state file
 *   chart: ./…    → local chart directories
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ancestors, mappingGet, nodeAt, parseTree, rootMappings, scalarPathText, type YMapping, type YPair } from './yamlTree';
import { templateDeclarations } from './templates';
import { childKeys, valuesModel, type SourceFile } from './values';

/** Where the caret is: the field key it belongs to and its YAML context. */
export interface FieldContext {
    readonly key: string;
    /** Ancestors of the pair the value belongs to (e.g. ['releases']). */
    readonly path: readonly string[];
    readonly typed: string;
    /** The pair's value is a sequence containing the caret (list entry form). */
    readonly sequenceValue: boolean;
}

/**
 * Resolve the field being filled at `offset`: same-line `key: value`
 * entries and block list items (`- item` under a `key:`) both resolve to
 * the enclosing pair.
 */
export function fieldContextAt(source: SourceFile, offset: number): FieldContext | null {
    const node = nodeAt(source.tree, Math.min(offset, Math.max(0, source.text.length - 1)));
    let current = node;
    while (current) {
        if (current.kind === 'pair') {
            const pair = current as YPair;
            return {
                key: pair.key,
                path: ancestors(pair),
                typed: typedBefore(source.text, offset, pair),
                sequenceValue: pair.value != null && pair.value.kind === 'sequence' && offset > pair.value.start,
            };
        }
        current = current.parent;
    }
    return null;
}

/** Text typed after the key/colon (or after the list dash) up to the caret. */
function typedBefore(text: string, offset: number, pair: YPair): string {
    const valueStart = Math.max(pair.keyEnd, pair.valueStart);
    const raw = text.slice(Math.min(valueStart, offset), offset);
    const dash = /^([ \t]*(?:-\s*))/.exec(raw);
    const stripped = dash ? raw.slice(dash[0].length) : raw;
    const cut = Math.max(stripped.lastIndexOf('['), stripped.lastIndexOf(','));
    return (cut >= 0 ? stripped.slice(cut + 1) : stripped).trim().replace(/^['"]/, '');
}

/** Release names declared in this state file (static, non-template names). */
export function releaseNames(source: SourceFile): string[] {
    const names: string[] = [];
    for (const root of rootMappings(source.tree)) {
        const releases = mappingGet(root, 'releases');
        const sequence = releases && releases.value && releases.value.kind === 'sequence' ? releases.value : null;
        if (!sequence) continue;
        for (const item of sequence.items) {
            if (item.kind !== 'mapping') continue;
            const name = mappingGet(item, 'name');
            if (!name || !name.value || name.value.kind !== 'scalar') continue;
            const text = scalarPathText(name.value);
            if (text && !text.includes('{{') && !names.includes(text)) names.push(text);
        }
    }
    return names;
}

/** Top-level values keys of the selected environment (for `condition:`). */
export function topLevelValueKeys(source: SourceFile, environment: string): string[] {
    const keys = new Set<string>();
    for (const doc of source.tree.docs) {
        if (!doc.root || doc.root.kind !== 'mapping') continue;
        for (const pair of (doc.root as YMapping).pairs) {
            if (pair.key === 'values' && pair.value && pair.value.kind === 'mapping') {
                for (const child of pair.value.pairs) keys.add(child.key);
            }
            if (pair.key === 'environments' && pair.value && pair.value.kind === 'mapping') {
                for (const env of pair.value.pairs) {
                    if (env.key !== environment || !env.value || env.value.kind !== 'mapping') continue;
                    const values = mappingGet(env.value, 'values');
                    if (values && values.value && values.value.kind === 'mapping') {
                        for (const child of values.value.pairs) keys.add(child.key);
                    }
                }
            }
        }
    }
    return [...keys];
}

/** Contexts parsed from $KUBECONFIG (path-delimited) or ~/.kube/config. */
export function kubeContexts(configPaths?: string[]): string[] {
    const paths = configPaths ?? kubeConfigPaths();
    const contexts = new Set<string>();
    for (const configPath of paths) {
        let text: string;
        try {
            text = fs.readFileSync(configPath, 'utf8');
        } catch {
            continue;
        }
        for (const root of rootMappings(parseTree(text))) {
            const entry = mappingGet(root, 'contexts');
            const sequence = entry && entry.value && entry.value.kind === 'sequence' ? entry.value : null;
            if (!sequence) continue;
            for (const item of sequence.items) {
                if (item.kind !== 'mapping') continue;
                const name = mappingGet(item, 'name');
                if (name && name.value && name.value.kind === 'scalar' && name.value.value) contexts.add(name.value.value);
            }
        }
    }
    return [...contexts].sort();
}

function kubeConfigPaths(): string[] {
    const override = process.env.KUBECONFIG;
    if (override) return override.split(path.delimiter).filter(Boolean);
    return [path.join(os.homedir(), '.kube', 'config')];
}

const YAML_EXTENSIONS = ['.yaml', '.yml', '.yaml.gotmpl', '.yml.gotmpl'];

interface FileSuggestion {
    readonly relative: string;
    readonly directory: boolean;
}

/** Files and directories next to the state file, depth-limited and extension-filtered. */
export function stateRelativeFiles(statePath: string, extensions: readonly string[], prefix: string): FileSuggestion[] {
    const baseDir = path.dirname(statePath);
    const startDir = path.posix.dirname(prefix === '' || prefix === './' ? './x' : prefix.endsWith('/') ? prefix + 'x' : prefix);
    const absolute = path.resolve(baseDir, startDir === '.' ? '.' : startDir);
    if (absolute !== baseDir && !absolute.startsWith(baseDir + path.sep)) return [];
    const results: FileSuggestion[] = [];
    const depth = prefix.split('/').filter(Boolean).length;
    collectFiles(absolute, baseDir, extensions, 0, Math.min(3, Math.max(2, 4 - depth)), results);
    return results;
}

function collectFiles(dir: string, base: string, extensions: readonly string[], depth: number, maxDepth: number, out: FileSuggestion[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
            out.push({ relative: relPath(dir, base, entry.name), directory: true });
            if (depth + 1 < maxDepth) collectFiles(path.join(dir, entry.name), base, extensions, depth + 1, maxDepth, out);
        } else if (entry.isFile()) {
            if (!extensions.some(ext => entry.name.endsWith(ext))) continue;
            out.push({ relative: relPath(dir, base, entry.name), directory: false });
        }
    }
}

function relPath(dir: string, base: string, name: string): string {
    return path.relative(base, path.join(dir, name)).split(path.sep).join('/');
}

function item(label: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
    const result = new vscode.CompletionItem(label, kind);
    result.detail = detail;
    return result;
}

/**
 * Smart suggestions for the field value being typed; null when the field
 * is not context-aware (falls through to schema/repository completion).
 */
export function contextualCompletions(source: SourceFile, offset: number, environment: string): vscode.CompletionList | null {
    const field = fieldContextAt(source, offset);
    if (!field) return null;
    const typed = field.typed;
    if (typed.includes('{{')) return null;
    const within = (...keys: string[]): boolean => keys.some(key => field.path.includes(key));
    const atRoot = field.path.length === 0;

    switch (field.key) {
        case 'needs': {
            if (!within('releases', 'templates')) return null;
            return new vscode.CompletionList(releaseNames(source).map(name => item(name, vscode.CompletionItemKind.Reference, 'release in this state')), false);
        }
        case 'inherit': {
            if (!within('releases', 'templates')) return null;
            return new vscode.CompletionList([...templateDeclarations(source.uri, environment).keys()].map(name => item(name, vscode.CompletionItemKind.Reference, 'template')), false);
        }
        case 'condition': {
            if (!within('releases', 'templates')) return null;
            const items = releaseNames(source).map(name => item(`${name}.enabled`, vscode.CompletionItemKind.Reference, 'enabled flag of a release'));
            const seen = new Set<string>();
            for (const key of topLevelValueKeys(source, environment)) {
                seen.add(key);
                items.push(item(`.Values.${key}.enabled`, vscode.CompletionItemKind.Reference, 'values flag'));
            }
            // Keys merged from values files of the selected environment (the
            // common real-world shape — env `values:` entries are file lists).
            const model = valuesModel(source.uri, environment);
            for (const definition of model ? childKeys(model, '') : []) {
                if (seen.has(definition.path)) continue;
                seen.add(definition.path);
                items.push(item(`.Values.${definition.path}.enabled`, vscode.CompletionItemKind.Reference, 'values flag'));
            }
            return new vscode.CompletionList(items, false);
        }
        case 'kubeContext': {
            if (!within('releases', 'templates', 'environments') && !atRoot) return null;
            return new vscode.CompletionList(kubeContexts().map(name => item(name, vscode.CompletionItemKind.EnumMember, 'kubeconfig context')), false);
        }
        case 'values':
        case 'secrets': {
            // List entries only: release/template/environment lists and the
            // root `values:`/`secrets:` file lists (mirrors HelmfileReferences:
            // ancestors of size 1 in {values, bases, helmfiles}). Inline root
            // mappings are key/value, not files — schema keys cover those.
            if (!within('releases', 'templates', 'environments') && !(atRoot && field.sequenceValue)) return null;
            return fileCompletions(source, typed, YAML_EXTENSIONS, 'values file', false);
        }
        case 'bases': {
            if (!atRoot) return null;
            return fileCompletions(source, typed, YAML_EXTENSIONS, 'base state', false);
        }
        case 'helmfiles': {
            if (!atRoot) return null;
            return fileCompletions(source, typed, YAML_EXTENSIONS, 'state file', false);
        }
        case 'path': {
            if (field.path[0] !== 'helmfiles') return null;
            return fileCompletions(source, typed, YAML_EXTENSIONS, 'state file', false);
        }
        case 'chart': {
            if (!within('releases', 'dependencies', 'templates')) return null;
            if (!typed.startsWith('.')) return null;
            return localChartCompletions(source, typed);
        }
        default:
            return null;
    }
}

/** Directory suggestions for `chart: ./…` local chart references. */
export function localChartCompletions(source: SourceFile, typed: string): vscode.CompletionList {
    return fileCompletions(source, typed, YAML_EXTENSIONS, 'local chart directory', true);
}

function fileCompletions(source: SourceFile, typed: string, extensions: readonly string[], label: string, directoriesOnly: boolean): vscode.CompletionList {
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();
    for (const suggestion of stateRelativeFiles(source.uri.fsPath, extensions, typed)) {
        const insert = suggestion.directory ? suggestion.relative + '/' : suggestion.relative;
        if (seen.has(insert)) continue;
        // Filter by the typed prefix: either the whole path or its last
        // segment (typing `common` still finds `values/common.yaml`).
        if (typed) {
            const lastSegment = insert.slice(insert.lastIndexOf('/') + 1);
            if (!insert.startsWith(typed) && !lastSegment.startsWith(typed)) continue;
        }
        seen.add(insert);
        items.push(item(insert, suggestion.directory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File, suggestion.directory ? 'directory' : label));
    }
    return new vscode.CompletionList(items, false);
}
