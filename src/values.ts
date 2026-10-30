/**
 * Static Helmfile state-values resolution. Port of HelmfileValues from the
 * IntelliJ plugin. No template functions, commands, or secret providers are
 * executed: only literal paths, inline maps, and globs are followed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { YMapping, YNode, YPair, YTree, mappingGet, parseTree, rootMappings, scalarPathText } from './yamlTree';

export const SEPARATOR = '\u001f';
export const STATE_NAMES = ['helmfile.yaml.gotmpl', 'helmfile.yml.gotmpl', 'helmfile.yaml', 'helmfile.yml'];
const ENV_NAME = /\{\{-?\s*\.Environment\.Name\s*-?}}/g;

export interface SourceFile {
    readonly uri: vscode.Uri;
    readonly text: string;
    readonly tree: YTree;
}

export interface ValuesDefinition {
    /** Path segments joined with SEPARATOR. */
    readonly path: string;
    readonly keyStart: number;
    readonly keyEnd: number;
    readonly origin: string;
    readonly originUri: vscode.Uri;
    /** null for state defaults, otherwise the owning environment. */
    readonly environment: string | null;
    readonly valueKind: 'scalar' | 'list' | 'map';
    readonly preview: string;
}

export interface ValuesModel {
    readonly state: SourceFile;
    readonly definitions: Map<string, ValuesDefinition>;
    readonly completionDefinitions: ValuesDefinition[];
    readonly environments: Set<string>;
    readonly skipped: string[];
    readonly stateSources: Set<string>;
}

/* ---------------- content registry and caches ---------------- */

interface FileEntry {
    readonly mtimeMs: number;
    readonly text: string;
    readonly tree: YTree;
}

const openDocuments = new Map<string, { version: number; text: string }>();
const fileCache = new Map<string, FileEntry>();
const modelCache = new Map<string, ValuesModel>();
const allCache = new Map<string, ValuesDefinition[]>();
let contentVersion = 0;

export function contentStamp(): number {
    return contentVersion;
}

export function bumpContentVersion(): void {
    contentVersion++;
    fileCache.clear();
    modelCache.clear();
    allCache.clear();
}

export function setOpenDocument(uri: vscode.Uri, version: number, text: string, changed: boolean): void {
    const key = uri.toString();
    const previous = openDocuments.get(key);
    openDocuments.set(key, { version, text });
    if (changed || !previous || previous.text !== text) bumpContentVersion();
}

export function closeOpenDocument(uri: vscode.Uri): void {
    if (openDocuments.delete(uri.toString())) bumpContentVersion();
}

export function readSource(uri: vscode.Uri): SourceFile | null {
    const open = openDocuments.get(uri.toString());
    if (open) return { uri, text: open.text, tree: parseTree(open.text) };
    try {
        const stat = fs.statSync(uri.fsPath);
        if (!stat.isFile()) return null;
        const key = uri.toString();
        const cached = fileCache.get(key);
        if (cached && cached.mtimeMs === stat.mtimeMs) return { uri, text: cached.text, tree: cached.tree };
        const text = fs.readFileSync(uri.fsPath, 'utf8');
        const entry: FileEntry = { mtimeMs: stat.mtimeMs, text, tree: parseTree(text) };
        fileCache.set(key, entry);
        return { uri, text, tree: entry.tree };
    } catch {
        return null;
    }
}

export function isHelmfileName(name: string): boolean {
    return STATE_NAMES.includes(name) || /\.gotmpl$/.test(name) || /^_.*\.tpl$/.test(name);
}

/* ---------------- state file location ---------------- */

export function stateFor(uri: vscode.Uri): SourceFile | null {
    const self = readSource(uri);
    if (!self) return null;
    if (STATE_NAMES.includes(path.basename(uri.fsPath)) || hasStateRoot(self.tree)) return self;
    let dir = path.dirname(uri.fsPath);
    for (let depth = 0; depth < 64; depth++) {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        for (const name of STATE_NAMES) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) {
                const state = readSource(vscode.Uri.file(candidate));
                if (state) return state;
            }
        }
        dir = parent;
    }
    return self;
}

function hasStateRoot(tree: YTree): boolean {
    for (const root of rootMappings(tree)) {
        const keys = root.pairs.map(pair => pair.key);
        if (keys.includes('releases') || keys.includes('bases')) return true;
    }
    return false;
}

/* ---------------- values model ---------------- */

export function valuesModel(uri: vscode.Uri, environment: string): ValuesModel | null {
    const source = readSource(uri);
    if (!source) return null;
    const cacheKey = `${source.uri.toString()}|${environment}|${contentVersion}`;
    const cached = modelCache.get(cacheKey);
    if (cached) return cached;
    const model = new Builder(source, environment).build();
    modelCache.set(cacheKey, model);
    return model;
}

/** Reverse lookup following every discovered environment. */
export function allDefinitions(uri: vscode.Uri, selectedEnvironment: string): ValuesDefinition[] {
    const source = readSource(uri);
    if (!source) return [];
    const cacheKey = `${source.uri.toString()}|${contentVersion}`;
    const cached = allCache.get(cacheKey);
    if (cached) return cached;
    const state = stateFor(uri) ?? source;
    const pending = new Set<string>(['default', selectedEnvironment]);
    const visited = new Set<string>();
    const definitions: ValuesDefinition[] = [];
    while (pending.size > 0) {
        const environment = pending.values().next().value!;
        pending.delete(environment);
        if (visited.has(environment)) continue;
        visited.add(environment);
        const builder = new Builder(source, environment);
        builder.resolveState(state);
        for (const definition of builder.values.values()) {
            if (!definitions.some(existing => sameDefinition(existing, definition))) definitions.push(definition);
        }
        for (const name of builder.environments) if (!visited.has(name)) pending.add(name);
    }
    allCache.set(cacheKey, definitions);
    return definitions;
}

function sameDefinition(a: ValuesDefinition, b: ValuesDefinition): boolean {
    return (
        a.originUri.toString() === b.originUri.toString() &&
        a.keyStart === b.keyStart &&
        a.keyEnd === b.keyEnd &&
        a.path === b.path &&
        a.environment === b.environment
    );
}

export function isStateSource(uri: vscode.Uri): boolean {
    const state = stateFor(uri);
    if (!state) return false;
    const model = valuesModel(uri, 'default');
    return !!model && model.stateSources.has(state.uri.toString());
}

export function valuesKeyPath(segments: string[]): string {
    return segments.join(SEPARATOR);
}

/* ---------------- file resolution ---------------- */

export function resolveValueFiles(source: SourceFile, rawPath: string, environment: string): vscode.Uri[] {
    if (!rawPath) return [];
    const substituted = rawPath.replace(ENV_NAME, environment);
    if (substituted.includes('{{') || substituted.includes('://') || substituted.startsWith('ref+')) return [];
    const baseDir = path.dirname(source.uri.fsPath);
    if (!/.*[?*[{].*/.test(substituted)) {
        const target = substituted.startsWith('/') ? vscode.Uri.file(substituted) : vscode.Uri.file(path.resolve(baseDir, substituted));
        try {
            return fs.statSync(target.fsPath).isFile() ? [target] : [];
        } catch {
            return [];
        }
    }
    let wildcard = 0;
    while (wildcard < substituted.length && '*?[{'.indexOf(substituted.charAt(wildcard)) < 0) wildcard++;
    const slash = substituted.lastIndexOf('/', wildcard);
    const directory = slash >= 0 ? substituted.substring(0, slash + 1) : '';
    const directoryPath = directory.startsWith('/') ? directory : path.resolve(baseDir, directory);
    let directoryFile: string;
    try {
        directoryFile = fs.statSync(directoryPath).isDirectory() ? directoryPath : '';
    } catch {
        return [];
    }
    if (!directoryFile) return [];
    try {
        const matcher = globMatcher(substituted.substring(slash + 1));
        const result: vscode.Uri[] = [];
        collectGlob(directoryFile, '', matcher, result, { count: 0 });
        result.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        return result;
    } catch {
        return [];
    }
}

function collectGlob(directory: string, prefix: string, matcher: (relative: string) => boolean, result: vscode.Uri[], budget: { count: number }): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (++budget.count > 5000) return;
        const relative = prefix + entry.name;
        if (entry.isDirectory()) {
            let real: fs.Stats | null = null;
            try {
                real = fs.lstatSync(path.join(directory, entry.name));
            } catch {
                real = null;
            }
            if (!real?.isSymbolicLink()) collectGlob(path.join(directory, entry.name), relative + '/', matcher, result, budget);
        } else if (matcher(relative)) {
            result.push(vscode.Uri.file(path.join(directory, entry.name)));
        }
    }
}

/** Java PathMatcher "glob:" semantics: **, *, ?, [...], {a,b}. */
function globMatcher(pattern: string): (relative: string) => boolean {
    const regex = globToRegExp(pattern);
    const compiled = new RegExp(`^(?:${regex})$`);
    return relative => compiled.test(relative);
}

function globToRegExp(pattern: string): string {
    let regex = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '\\') {
            if (i + 1 < pattern.length) regex += escapeRegExp(pattern[++i]);
        } else if (c === '*') {
            if (pattern[i + 1] === '*') {
                i++;
                regex += '.*';
            } else {
                regex += '[^/]*';
            }
        } else if (c === '?') {
            regex += '[^/]';
        } else if (c === '[') {
            let class_ = '[';
            let j = i + 1;
            if (pattern[j] === '!' || pattern[j] === '^') {
                class_ += '^';
                j++;
            }
            while (j < pattern.length && pattern[j] !== ']') class_ += pattern[j++] === '\\' ? '\\\\' : pattern[j - 1];
            if (j >= pattern.length) {
                regex += escapeRegExp('[');
                continue;
            }
            i = j;
            regex += class_ + ']';
        } else if (c === '{') {
            const alternatives: string[] = [];
            let current = '';
            let j = i + 1;
            for (; j < pattern.length && pattern[j] !== '}'; j++) {
                if (pattern[j] === ',' && !current.includes('\\')) {
                    alternatives.push(current);
                    current = '';
                } else {
                    current += pattern[j];
                }
            }
            if (j >= pattern.length) {
                regex += escapeRegExp('{');
                continue;
            }
            i = j;
            regex += '(?:' + alternatives.map(alt => globToRegExp(alt)).join('|') + ')';
        } else {
            regex += escapeRegExp(c);
        }
    }
    return regex;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------------- builder ---------------- */

class Builder {
    readonly values = new Map<string, ValuesDefinition>();
    readonly environments = new Set<string>();
    readonly skipped: string[] = [];
    private readonly visiting = new Set<string>();
    private readonly stateSources = new Set<string>();

    constructor(private readonly context: SourceFile, private readonly environment: string) {}

    build(): ValuesModel {
        const state = stateFor(this.context.uri) ?? this.context;
        this.resolveState(state);
        const completions: ValuesDefinition[] = [...this.values.values()];
        // Files without the current environment still need discoverable keys.
        // Each environment resolves separately so overrides never mix.
        if (!this.environments.has(this.environment)) {
            for (const name of this.environments) {
                const candidate = new Builder(this.context, name);
                candidate.resolveState(state);
                for (const definition of candidate.values.values()) {
                    const current = this.values.get(definition.path);
                    if (current && current.originUri.toString() === definition.originUri.toString() && current.keyStart === definition.keyStart && definition.environment === null) {
                        continue;
                    }
                    completions.push({ ...definition, environment: name });
                }
            }
        }
        const choices = new Set(this.environments);
        choices.add('default');
        return {
            state,
            definitions: new Map(this.values),
            completionDefinitions: completions,
            environments: choices,
            skipped: [...this.skipped],
            stateSources: new Set(this.stateSources),
        };
    }

    resolveState(state: SourceFile | null): void {
        // Defaults across all bases first, then environment overrides.
        this.state(state, false, 0);
        this.state(state, true, 0);
    }

    private state(source: SourceFile | null, environmentPass: boolean, depth: number): void {
        if (!source || depth > 40) return;
        const id = source.uri.toString();
        if (this.visiting.has(id)) return;
        this.visiting.add(id);
        try {
            this.stateSources.add(id);
            for (const root of rootMappings(source.tree)) {
                const bases = valueOf(root, 'bases');
                if (bases?.value && bases.value.kind === 'sequence') {
                    for (const item of bases.value.items) {
                        if (item.kind === 'scalar') {
                            for (const base of resolveValueFiles(source, scalarPathText(item), this.environment)) {
                                this.state(readSource(base), environmentPass, depth + 1);
                            }
                        }
                    }
                }
                const envs = valueOf(root, 'environments');
                if (envs?.value && envs.value.kind === 'mapping') {
                    for (const pair of envs.value.pairs) if (pair.key) this.environments.add(pair.key);
                    if (environmentPass) {
                        const selected = envs.value.pairs.find(pair => pair.key === this.environment);
                        if (selected?.value && selected.value.kind === 'mapping') {
                            this.entries(source, mappingGet(selected.value, 'values'), this.environment);
                        }
                    }
                }
                if (!environmentPass) this.entries(source, valueOf(root, 'values'), null);
            }
        } finally {
            this.visiting.delete(id);
        }
    }

    private entries(source: SourceFile, entry: YPair | null, scope: string | null): void {
        if (!entry?.value || entry.value.kind !== 'sequence') return;
        for (const item of entry.value.items) {
            if (item.kind === 'mapping') {
                this.merge(item, '', path.basename(source.uri.fsPath), scope, source.uri);
            } else if (item.kind === 'scalar') {
                const rawPath = scalarPathText(item);
                const resolved = resolveValueFiles(source, rawPath, this.environment);
                if (resolved.length === 0) {
                    this.skipped.push(rawPath);
                    continue;
                }
                for (const uri of resolved) {
                    const target = readSource(uri);
                    if (!target) continue;
                    for (const root of rootMappings(target.tree)) {
                        this.merge(root, '', path.basename(uri.fsPath), scope, uri);
                    }
                }
            }
        }
    }

    private merge(mapping: YMapping, prefix: string, origin: string, scope: string | null, originUri: vscode.Uri): void {
        for (const pair of mapping.pairs) {
            const nodePath = prefix + pair.key;
            const previous = this.values.get(nodePath);
            const isMap = !!pair.value && pair.value.kind === 'mapping';
            const previousIsMap = previous ? previous.valueKind === 'map' : false;
            if (!isMap || (previous && !previousIsMap)) {
                for (const key of [...this.values.keys()]) {
                    if (key.startsWith(nodePath + SEPARATOR)) this.values.delete(key);
                }
            }
            this.values.set(nodePath, {
                path: nodePath,
                keyStart: pair.keyStart,
                keyEnd: pair.keyEnd,
                origin,
                originUri,
                environment: scope,
                valueKind: pair.value ? (pair.value.kind === 'mapping' ? 'map' : pair.value.kind === 'sequence' ? 'list' : 'scalar') : 'scalar',
                preview: previewOf(pair.value),
            });
            if (pair.value && pair.value.kind === 'mapping') {
                this.merge(pair.value, nodePath + SEPARATOR, origin, scope, originUri);
            }
        }
    }
}

function valueOf(mapping: YMapping, key: string): YPair | null {
    for (const pair of mapping.pairs) if (pair.key === key) return pair;
    return null;
}

function previewOf(value: YNode | null): string {
    if (!value) return '';
    if (value.kind === 'mapping') return 'map';
    if (value.kind === 'sequence') return 'list';
    return scalarPathText(value);
}

/* Completion keys for a parent path (direct children). */
/** Declared environment names for a state file (including inherited bases), always containing 'default'. */
export function environmentNames(uri: vscode.Uri, environment: string): string[] {
    const state = stateFor(uri);
    if (!state) return ['default'];
    const model = valuesModel(state.uri, environment);
    const names = new Set<string>(['default']);
    if (model) {
        for (const name of model.environments) names.add(name);
    }
    return [...names];
}

export function childKeys(model: ValuesModel, parentPath: string): ValuesDefinition[] {
    const prefix = parentPath ? parentPath + SEPARATOR : '';
    const children: ValuesDefinition[] = [];
    const seen = new Set<string>();
    for (const definition of model.completionDefinitions) {
        if (!definition.path.startsWith(prefix)) continue;
        const rest = definition.path.substring(prefix.length);
        if (!rest) continue;
        const segment = rest.split(SEPARATOR)[0];
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) continue;
        if (seen.has(segment)) continue;
        seen.add(segment);
        children.push(definition);
    }
    return children;
}
