/**
 * Repository declarations and immutable download settings, resolved without
 * executing templates. Port of HelmfileRepositories from the IntelliJ plugin.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInheritance, templateDeclarations } from './templates';
import { schemaContext } from './schema';
import { SourceFile, contentStamp, readSource, resolveValueFiles, stateFor, valuesModel } from './values';
import { YMapping, YPair, YScalar, ancestors, mappingGet, rootMappings, scalarPathText } from './yamlTree';

export interface Access {
    readonly name: string;
    readonly url: string;
    readonly oci: boolean;
    readonly username: string;
    readonly password: string;
    readonly caFile: string;
    readonly certFile: string;
    readonly keyFile: string;
    readonly skipTLSVerify: boolean;
    readonly passCredentials: boolean;
    readonly plainHttp: boolean;
}

export function downloadable(access: Access): boolean {
    return (
        !access.oci &&
        (access.url.startsWith('https://') || access.url.startsWith('http://')) &&
        !access.url.includes('{{') &&
        !access.username.includes('{{') &&
        !access.password.includes('{{')
    );
}

export interface Repository {
    readonly name: string;
    readonly declaration: YPair;
    readonly declarationUri: vscode.Uri;
    /** Declaration value node when present, otherwise the key. */
    readonly targetStart: number;
    readonly targetEnd: number;
    readonly source: string;
    readonly access: Access;
}

export interface RepositoryModel {
    readonly entries: readonly Repository[];
    readonly incomplete: boolean;
}

export interface RepositoryQuery {
    readonly access: Access;
    readonly chart: string;
}

const VALUE = /\{\{-?\s*(\$?\.(?:Values|StateValues|Environment\.Values)\.[A-Za-z0-9_.]+|\.Environment\.Name)\s*-?}}/g;

const modelCache = new Map<string, RepositoryModel>();

export function repositoryModel(uri: vscode.Uri, environment: string): RepositoryModel {
    const source = readSource(uri);
    const cacheKey = `${source?.uri.toString() ?? uri.toString()}|${environment}|${contentStamp()}`;
    const cached = modelCache.get(cacheKey);
    if (cached) return cached;
    const builder = new Builder(environment);
    builder.collect(stateFor(uri), new Set(), 0);
    const model: RepositoryModel = { entries: [...builder.entries], incomplete: builder.incomplete };
    modelCache.set(cacheKey, model);
    return model;
}

export function isChartField(pair: YPair | null, field: string): boolean {
    if (!pair || pair.key !== field) return false;
    const context = schemaContext(ancestors(pair));
    return context === 'releases' || context === 'dependencies';
}

export function isDeclaration(pair: YPair | null): boolean {
    return (
        !!pair &&
        pair.key === 'name' &&
        ancestors(pair).length === 1 &&
        ancestors(pair)[0] === 'repositories' &&
        pair.value != null &&
        pair.value.kind === 'scalar' &&
        scalarPathText(pair.value).trim() !== ''
    );
}

/** Field value: scalar text, or the inline template fragment after the key. */
export function value(source: SourceFile, mapping: YMapping | null, key: string): string {
    if (!mapping) return '';
    const entry = mappingGet(mapping, key);
    if (!entry) return '';
    if (entry.value && entry.value.kind === 'scalar') return scalarPathText(entry.value);
    // An unquoted Go-only value may not parse as a YAML scalar; recover the
    // rest of the declaration line and accept it when it holds a template.
    const text = source.text;
    const lineEnd = text.indexOf('\n', entry.keyEnd);
    const tail = text.substring(entry.keyEnd, lineEnd < 0 ? text.length : lineEnd).trim();
    return tail.includes('{{') ? tail : '';
}

/** Substitute static state values and the environment name inside `input`. */
export function resolved(uri: vscode.Uri, environment: string, input: string): string {
    return input.replace(VALUE, match => {
        const inner = match.replace(/^\{\{-?\s*/, '').replace(/\s*-?}}$/, '');
        if (inner === '.Environment.Name') return environment;
        const root = inner.startsWith('$.') ? '$.' : '.';
        const rest = inner.substring(root.length);
        const model = valuesModel(uri, environment);
        const definition = model ? model.definitions.get(rest.split('.').join('\u001f')) : null;
        if (definition && definition.valueKind === 'scalar' && !definition.preview.includes('{{')) return definition.preview;
        return match;
    });
}

/** Resolve `chart:` through `inherit[].template` chains without running templates. */
export function chart(source: SourceFile | null, mapping: YMapping | null, environment: string, visiting: Set<YMapping>): string {
    // Compact YAML sequence entries and incomplete editor trees may have no mapping.
    if (!source || !mapping || visiting.has(mapping) || visiting.size > 40) return '';
    visiting.add(mapping);
    try {
        const chartValue = value(source, mapping, 'chart');
        if (chartValue) return resolved(source.uri, environment, chartValue);
        const inherit = mappingGet(mapping, 'inherit');
        if (!inherit?.value || inherit.value.kind !== 'sequence') return '';
        const declarations = templateDeclarations(source.uri, environment);
        for (const scalar of inheritScalars(inherit.value.items)) {
            if (!isInheritance(scalar)) continue;
            const parent = declarations.get(scalarPathText(scalar));
            if (parent && parent.pair.value && parent.pair.value.kind === 'mapping') {
                const parentChart = chart(parent.source, parent.pair.value, environment, visiting);
                if (parentChart) return parentChart;
            }
        }
        return '';
    } finally {
        visiting.delete(mapping);
    }
}

function inheritScalars(items: readonly unknown[]): YScalar[] {
    const result: YScalar[] = [];
    for (const item of items) {
        if (item && typeof item === 'object' && 'kind' in item) {
            const node = item as YMapping | YScalar;
            if (node.kind === 'mapping') {
                for (const pair of node.pairs) {
                    if (pair.value && pair.value.kind === 'scalar') result.push(pair.value);
                }
            } else if (node.kind === 'scalar') {
                result.push(node);
            }
        }
    }
    return result;
}

/** Repository alias prefix of a chart reference, or null when not a repository reference. */
export function alias(uri: vscode.Uri, chartText: string): string | null {
    if (
        !chartText.trim() ||
        chartText.includes('{{') ||
        chartText.includes('://') ||
        chartText.includes('::') ||
        chartText.startsWith('.') ||
        chartText.startsWith('/') ||
        chartText.startsWith('~') ||
        chartText.includes('\\') ||
        /^[A-Za-z]:/.test(chartText)
    ) {
        return null;
    }
    try {
        if (fs.existsSync(path.join(path.dirname(uri.fsPath), chartText))) return null;
    } catch {
        /* unreadable directory: keep treating it as a repository reference */
    }
    const slash = chartText.indexOf('/');
    return slash > 0 ? chartText.substring(0, slash) : null;
}

export function query(uri: vscode.Uri, chartText: string, environment: string): RepositoryQuery | null {
    if (!chartText.trim() || chartText.includes('{{')) return null;
    const repositories = namedMap(repositoryModel(uri, environment).entries);
    if (chartText.startsWith('oci://')) {
        const slash = chartText.lastIndexOf('/');
        if (slash <= 'oci://'.length || slash === chartText.length - 1) return null;
        const base = chartText.substring(6, slash);
        const name = chartText.substring(slash + 1);
        if (name.includes('@') || name.includes(':')) return null;
        const access: Access =
            repositories
                .map(entry => entry.access)
                .find(candidate => candidate.oci && base === candidate.url.replace(/^(?:oci|https?):\/\//, '').replace(/\/+$/, '')) ??
            { name: base, url: base, oci: true, username: '', password: '', caFile: '', certFile: '', keyFile: '', skipTLSVerify: false, passCredentials: false, plainHttp: false };
        return { access, chart: name };
    }
    const aliasName = alias(uri, chartText);
    const repository = aliasName == null ? null : repositories.find(entry => entry.name === aliasName);
    return repository
        ? { access: repository.access, chart: repository.access.oci ? chartText.substring(aliasName!.length + 1) : '' }
        : null;
}

export function namedMap(entries: readonly Repository[]): Repository[] {
    const result: Repository[] = [];
    for (const entry of entries) if (!result.some(existing => existing.name === entry.name)) result.push(entry);
    return result;
}

class Builder {
    readonly entries: Repository[] = [];
    incomplete = false;

    constructor(private readonly environment: string) {}

    collect(source: SourceFile | null, visiting: Set<string>, depth: number): void {
        if (!source || depth > 40) {
            this.incomplete = true;
            return;
        }
        const id = source.uri.toString();
        if (visiting.has(id)) {
            this.incomplete = true;
            return;
        }
        visiting.add(id);
        try {
            for (const root of rootMappings(source.tree)) {
                const bases = mappingGet(root, 'bases');
                if (bases?.value && bases.value.kind === 'sequence') {
                    for (const item of bases.value.items) {
                        if (item.kind !== 'scalar') continue;
                        const files = resolveValueFiles(source, scalarPathText(item), this.environment);
                        if (files.length === 0) this.incomplete = true;
                        for (const base of files) this.collect(readSource(base), visiting, depth + 1);
                    }
                }
                const repositories = mappingGet(root, 'repositories');
                if (!repositories) continue;
                if (!repositories.value || repositories.value.kind !== 'sequence') {
                    this.incomplete = true;
                    continue;
                }
                for (const item of repositories.value.items) {
                    if (item.kind !== 'mapping') continue;
                    const declaration = mappingGet(item, 'name');
                    const name = resolved(source.uri, this.environment, value(source, item, 'name'));
                    if (!declaration || !name || name.includes('{{')) {
                        this.incomplete = true;
                        continue;
                    }
                    const prefix = name.toUpperCase().replace(/-/g, '_');
                    let username = resolved(source.uri, this.environment, value(source, item, 'username'));
                    let password = resolved(source.uri, this.environment, value(source, item, 'password'));
                    if (!username) username = process.env[prefix + '_USERNAME'] ?? '';
                    if (!password) password = process.env[prefix + '_PASSWORD'] ?? '';
                    this.entries.push({
                        name,
                        declaration,
                        declarationUri: source.uri,
                        targetStart: declaration.value ? declaration.value.start : declaration.keyStart,
                        targetEnd: declaration.value ? declaration.value.end : declaration.keyEnd,
                        source: path.basename(source.uri.fsPath),
                        access: {
                            name,
                            url: resolved(source.uri, this.environment, value(source, item, 'url')),
                            oci: value(source, item, 'oci') === 'true',
                            username,
                            password,
                            caFile: this.path(source, item, 'caFile'),
                            certFile: this.path(source, item, 'certFile'),
                            keyFile: this.path(source, item, 'keyFile'),
                            skipTLSVerify: value(source, item, 'skipTLSVerify') === 'true',
                            passCredentials: value(source, item, 'passCredentials') === 'true',
                            plainHttp: value(source, item, 'plainHttp') === 'true',
                        },
                    });
                }
            }
        } finally {
            visiting.delete(id);
        }
    }

    private path(source: SourceFile, mapping: YMapping, key: string): string {
        const resolvedValue = resolved(source.uri, this.environment, value(source, mapping, key));
        if (!resolvedValue || resolvedValue.startsWith('/') || resolvedValue.includes('://')) return resolvedValue;
        return path.dirname(source.uri.fsPath) + '/' + resolvedValue;
    }
}
