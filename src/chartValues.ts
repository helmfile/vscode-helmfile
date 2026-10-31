import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { chartValuesFile } from './chartNavigation';
import { chart as chartOf, query as repositoryQuery } from './repositories';
import { contentStamp, resolveValueFiles, stateFor, type SourceFile } from './values';
import { mappingGet, parseTree, scalarPathText, walkAll, type YMapping, type YPair, type YScalar, type YSequence, type YTree } from './yamlTree';

/**
 * Chart-aware values assistance: when the document being edited is a values
 * file referenced by a release or template, keys are completed from the
 * chart's own `values.yaml` defaults — local charts read from disk, remote
 * charts from the on-demand download cache.
 */

export interface ChartValuesContext {
    readonly chart: string;
    readonly version: string;
    /** Parsed chart values.yaml, or null when the chart source is not available locally. */
    readonly tree: YTree | null;
}

const cache = new Map<string, ChartValuesContext | null>();

/** Resolve the chart (and its values.yaml tree) a values file belongs to. */
export function chartValuesContextFor(uri: vscode.Uri, environment: string): ChartValuesContext | null {
    const key = `${uri.toString()}|${environment}|${contentStamp()}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const result = computeContext(uri, environment);
    cache.set(key, result);
    return result;
}

function computeContext(uri: vscode.Uri, environment: string): ChartValuesContext | null {
    if (uri.scheme !== 'file') return null;
    const state = stateFor(uri);
    if (!state || state.uri.toString() === uri.toString()) return null;
    const target = path.resolve(uri.fsPath);
    for (const doc of state.tree.docs) {
        if (!doc.root) continue;
        // Every `values:` file list whose parent mapping declares a chart
        // (releases and templates both qualify).
        const owners: YMapping[] = [];
        walkAll(doc.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            if (pair.key !== 'values' || !pair.value || pair.value.kind !== 'sequence') return;
            const sequence = pair.value as YSequence;
            for (const item of sequence.items) {
                if (!item || item.kind !== 'scalar') continue;
                const raw = scalarPathText(item as YScalar);
                if (!raw || raw.includes('{{')) continue;
                const hit = resolveValueFiles(state, raw, environment).some(resolved => path.resolve(resolved.fsPath) === target);
                if (!hit) continue;
                const mapping = pair.parent;
                if (mapping && mapping.kind === 'mapping' && !owners.includes(mapping)) owners.push(mapping);
            }
        });
        for (const mapping of owners) {
            const chart = chartOf(state, mapping, environment, new Set());
            if (!chart || chart.includes('{{')) continue;
            const context = contextForRelease(state, chart, mapping, environment);
            if (context) return context;
        }
    }
    return null;
}

/** Resolve the chart values.yaml context of an explicit release mapping (for `set:` completion). */
export function chartValuesContextForRelease(source: SourceFile, chart: string, mapping: YMapping, environment: string): ChartValuesContext | null {
    return contextForRelease(source, chart, mapping, environment);
}

function contextForRelease(state: SourceFile, chart: string, mapping: YMapping, environment: string): ChartValuesContext | null {
    const versionPair = mappingGet(mapping, 'version');
    let version = versionPair && versionPair.value ? (scalarPathText(versionPair.value) ?? '') : '';
    if (version.includes('{{')) version = '';

    const stateDir = path.dirname(state.uri.fsPath);
    const local = chart.startsWith('.') || chart.startsWith('/') || (fs.existsSync(path.join(stateDir, chart)) && !chart.includes('://') && !repositoryQuery(state.uri, chart, environment));
    if (local) {
        const valuesPath = path.join(chart.startsWith('/') ? chart : path.join(stateDir, chart), 'values.yaml');
        return { chart, version, tree: readValuesYaml(valuesPath) };
    }
    const request = repositoryQuery(state.uri, chart, environment);
    const valuesPath = chartValuesFile({ chart, version, repository: request ? { url: request.access.url } : null });
    return { chart, version, tree: valuesPath ? readValuesYaml(valuesPath) : null };
}

function readValuesYaml(valuesPath: string): YTree | null {
    try {
        return parseTree(fs.readFileSync(valuesPath, 'utf8'));
    } catch {
        return null;
    }
}

function rootMapping(tree: YTree): YMapping | null {
    for (const doc of tree.docs) {
        if (doc.root && doc.root.kind === 'mapping') return doc.root;
    }
    return null;
}

export interface ChartValueKey {
    readonly key: string;
    readonly preview: string;
}

function previewOf(value: { kind: string } | null | undefined): string {
    if (!value) return '';
    if (value.kind === 'scalar') return '';
    return value.kind === 'sequence' ? 'list' : 'mapping';
}

/** Child keys (with default-value previews) of a chart values.yaml subtree. */
export function chartValueKeys(context: ChartValuesContext, segments: readonly string[]): readonly ChartValueKey[] {
    if (!context.tree) return [];
    let current: YMapping | null = rootMapping(context.tree);
    for (const segment of segments) {
        if (!current) return [];
        const pair = mappingGet(current, segment);
        if (!pair || !pair.value || pair.value.kind !== 'mapping') return [];
        current = pair.value;
    }
    if (!current) return [];
    const keys: ChartValueKey[] = [];
    for (const pair of current.pairs) {
        const preview = pair.value && pair.value.kind === 'scalar' ? (scalarPathText(pair.value) ?? '') : previewOf(pair.value);
        keys.push({ key: pair.key, preview });
    }
    return keys;
}

/** Flat dotted key paths for `set:` entry completion (maps expand, depth ≤ 3). */
export function chartValuePaths(context: ChartValuesContext, maxDepth = 3): readonly ChartValueKey[] {
    const root = context.tree ? rootMapping(context.tree) : null;
    if (!root) return [];
    const result: ChartValueKey[] = [];
    const visit = (mapping: YMapping, prefix: string, depth: number): void => {
        for (const pair of mapping.pairs) {
            if (!pair.value) continue;
            const name = prefix ? `${prefix}.${pair.key}` : pair.key;
            const preview = pair.value.kind === 'scalar' ? (scalarPathText(pair.value) ?? '') : previewOf(pair.value);
            result.push({ key: name, preview });
            if (pair.value.kind === 'mapping' && depth < maxDepth) visit(pair.value, name, depth + 1);
        }
    };
    visit(root, '', 1);
    return result;
}
