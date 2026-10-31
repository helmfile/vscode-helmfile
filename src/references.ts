/**
 * Navigation: Go-to-definition and find-references, ported from
 * HelmfileReferences, HelmfileGotoDeclarationHandler and HelmfileUsageSearch.
 */
import * as vscode from 'vscode';
import { TemplateScanner } from './templateScanner';
import { offsetRange } from './position';
import { nodeAt, pairKeyAt, parseTree, scalarPathText, walkAll, type YPair } from './yamlTree';
import { allDefinitions, isHelmfileName, readSource, resolveValueFiles, valuesKeyPath, type SourceFile, type ValuesDefinition } from './values';
import { EnvironmentService } from './settings';
import { alias, isChartField, isDeclaration as isRepositoryDeclaration, repositoryModel } from './repositories';
import { isDeclaration as isTemplateDeclaration, isInheritance, parents, templateDeclarations, inheritanceScalars } from './templates';

export interface ValuePathReference {
    /** Definition key path joined with the unit separator. */
    readonly key: string;
    readonly range: vscode.Range;
}

export interface PathFileReference {
    readonly files: readonly vscode.Uri[];
    readonly range: vscode.Range;
}

export interface RepositoryAliasReference {
    /** Repository declaration pair range in its own document. */
    readonly target: vscode.Location;
    readonly alias: string;
    readonly range: vscode.Range;
}

export interface ChartFieldReference {
    readonly chart: string;
    readonly aliasLength: number;
    readonly range: vscode.Range;
}

export interface InheritanceReference {
    readonly targets: readonly vscode.Location[];
    readonly range: vscode.Range;
}

/** `$.Values.a.b` / `.StateValues.a` / `.Environment.Values.a` inside an action. */
const ROOT_PATH = /(\$?\.(?:Values|StateValues|Environment\.Values)\.[A-Za-z0-9_.]*)/g;
/** `index .Values "key.with.dots"` quoted keys. */
const INDEX_CALL = /\bindex\s+(\$?\.(?:Values|StateValues|Environment\.Values)(?:\.[A-Za-z0-9_]+)*)((?:\s+"(?:[^"\\]|\\.)*")+)/g;
/** `get .Values "key.with.dots" [default]` call form. */
const GET_CALL = /\bget\s+(\$?\.(?:Values|StateValues|Environment\.Values)(?:\.[A-Za-z0-9_]+)*)\s+"((?:[^"\\]|\\.)*)"(?:\s+(?:"(?:[^"\\]|\\.)*"|true|false|nil|\d+(?:\.\d+)?))?/g;
/** `.Values | get "key.with.dots" [default]` pipeline form. */
const GET_PIPE = /(\$?\.(?:Values|StateValues|Environment\.Values)(?:\.[A-Za-z0-9_]+)*)\s*\|\s*get\s+"((?:[^"\\]|\\.)*)"(?:\s+(?:"(?:[^"\\]|\\.)*"|true|false|nil|\d+(?:\.\d+)?))?/g;
/** String literal argument of readFile/isFile/isDir inside actions. */
const FILE_FUNCTION = /\b(?:readFile|isFile|isDir)\s*\(\s*(?:"([^"\\]|\\.)*"|'([^'\\]|\\.)*')/g;

export class HelmfileDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly env: EnvironmentService) {}

    provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const uri = document.uri;

        // 1. Values paths inside Go template actions.
        const valuePath = valuePathAt(text, offset);
        if (valuePath) {
            return allDefinitions(uri, this.env.get())
                .filter(definition => definition.path === valuePath.key)
                .map(definition => definitionLocation(definition));
        }

        // 2. Values-file / base / readFile path references.
        const pathRef = pathFileReferenceAt(uri, text, offset, this.env.get());
        if (pathRef && pathRef.files.length > 0) {
            return pathRef.files.map(file => new vscode.Location(file, new vscode.Position(0, 0)));
        }

        // 3. Repository alias prefix of `chart: alias/name`.
        const source: SourceFile = { uri, text, tree: parseTree(text) };
        const chartRef = chartFieldReferenceAt(source, offset);
        if (chartRef && chartRef.aliasLength > 0) {
            const model = repositoryModel(uri, this.env.get());
            const repository = model.entries.find(entry => entry.name === chartRef.chart.slice(0, chartRef.aliasLength));
            if (repository) return repositoryTarget(repository);
        }

        // 4. Template inheritance declarations.
        const inheritance = inheritanceReferenceAt(source, offset, this.env.get());
        if (inheritance) return [...inheritance.targets];

        // 5. Environment key → reselect (handled by CodeLens in the port).
        return [];
    }
}

export class HelmfileReferencesProvider implements vscode.ReferenceProvider {
    constructor(private readonly env: EnvironmentService) {}

    async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[]> {
        const uri = document.uri;
        const offset = document.offsetAt(position);
        const text = document.getText();
        const source: SourceFile = { uri, text, tree: parseTree(text) };

        // Repository name declaration → chart usages.
        const key = pairKeyAt(source.tree, offset);
        if (key && isRepositoryDeclaration(key)) {
            const name = scalarPathText(key.value ?? null);
            if (name) return repositoryUsages(name);
        }

        // Template declaration → inherit references.
        if (key && isTemplateDeclaration(key)) {
            const name = key.key;
            return templateUsages(uri, name, this.env.get());
        }

        // Values definition key → path usages across state files.
        const definition = definitionAt(uri, offset, this.env.get());
        if (definition) {
            const suffix = definition.path.split('\u001f').join('.');
            return valueUsages(definition, suffix, context.includeDeclaration);
        }

        return [];
    }
}

/** `.Values` / `.StateValues` / `.Environment.Values` roots carry no own definition key. */
function stripValueRoot(segments: string[]): string[] {
    const rest = [...segments];
    if (rest[0] === 'Environment' && rest[1] === 'Values') rest.splice(0, 2);
    else if (rest[0] === 'Values' || rest[0] === 'StateValues') rest.splice(0, 1);
    return rest;
}

/**
 * Find the values path token containing `offset` inside a Go template action,
 * including `index .Values "quoted"` keys.
 */
export function valuePathAt(text: string, offset: number): ValuePathReference | null {
    const action = TemplateScanner.at(text, offset);
    if (!action) return null;
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const bodyOffset = offset - action.bodyStart;

    for (const match of matchAll(INDEX_CALL, body)) {
        const base = match[1];
        const quoted = match[2];
        if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
        const segments = [...stripValueRoot(base.replace(/^\$?/, '').split('.').filter(segment => segment.length > 0)), ...splitQuoted(quoted)];
        const key = valuesKeyPath(segments);
        return { key, range: offsetRange(text, action.bodyStart + (match.index ?? 0), action.bodyStart + (match.index ?? 0) + match[0].length) };
    }

    for (const pattern of [GET_PIPE, GET_CALL]) {
        for (const match of matchAll(pattern, body)) {
            if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
            const base = match[1];
            const quotedKey = match[2];
            const segments = [...stripValueRoot(base.replace(/^\$?/, '').split('.').filter(segment => segment.length > 0)), ...quotedKey.split('.')];
            const key = valuesKeyPath(segments);
            return { key, range: offsetRange(text, action.bodyStart + (match.index ?? 0), action.bodyStart + (match.index ?? 0) + match[0].length) };
        }
    }

    for (const match of matchAll(ROOT_PATH, body)) {
        if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
        const token = match[0];
        const segments = stripValueRoot(
            token
                .replace(/^\$?/, '')
                .split('.')
                .filter(segment => segment.length > 0),
        );
        return { key: valuesKeyPath(segments), range: offsetRange(text, action.bodyStart + (match.index ?? 0), action.bodyStart + (match.index ?? 0) + token.length) };
    }
    return null;
}

/** String argument of readFile/isFile/isDir containing `offset`. */
export function pathFileReferenceAt(uri: vscode.Uri, text: string, offset: number, environment: string): PathFileReference | null {
    const action = TemplateScanner.at(text, offset);
    if (!action) return null;
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const bodyOffset = offset - action.bodyStart;
    for (const match of matchAll(FILE_FUNCTION, body)) {
        if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
        const raw = match[1] ?? match[2] ?? '';
        const literal = unquote(raw);
        const files = resolveValueFiles({ uri, text, tree: parseTree(text) }, literal, environment);
        return { files, range: offsetRange(text, action.bodyStart + (match.index ?? 0), action.bodyStart + (match.index ?? 0) + match[0].length) };
    }
    return null;
}

/** The `chart: alias/name` scalar range and the alias prefix length. */
export function chartFieldReferenceAt(source: SourceFile, offset: number): ChartFieldReference | null {
    let current: ReturnType<typeof nodeAt> = nodeAt(source.tree, offset);
    while (current) {
        if (current.kind === 'pair') {
            const pair = current as YPair;
            const inValue = pair.value && offset >= pair.keyEnd && offset <= pair.value.end;
            if (inValue && isChartField(pair, 'chart') && pair.value && pair.value.kind === 'scalar') {
                const chartText = scalarPathText(pair.value);
                if (chartText && !chartText.includes('{{')) {
                    const aliasLength = alias(source.uri, chartText)?.length ?? -1;
                    const quote = quoted(source.text, pair.value.start);
                    const start = pair.value.start + (quote ? 1 : 0);
                    return { chart: chartText, aliasLength, range: offsetRange(source.text, start, start + chartText.length) };
                }
            }
            break;
        }
        current = current.parent as typeof current;
    }
    return null;
}

/** `inherit: [{template: parent}]` reference at offset. */
export function inheritanceReferenceAt(source: SourceFile, offset: number, environment: string): InheritanceReference | null {
    const node = nodeAt(source.tree, offset);
    let current = node;
    while (current) {
        if (current.kind === 'scalar') {
            const scalar = current;
            if (isInheritance(scalar) && scalar.value.length > 0 && offset >= scalar.start && offset <= scalar.end) {
                const declarations = templateDeclarations(source.uri, environment);
                const declaration = declarations.get(scalar.value);
                if (declaration) {
                    return {
                        targets: [new vscode.Location(declaration.source.uri, offsetRange(declaration.source.text, declaration.pair.keyStart, declaration.pair.keyEnd))],
                        range: offsetRange(source.text, scalar.start, scalar.end),
                    };
                }
            }
            break;
        }
        current = current.parent as typeof current;
    }
    // Declaration → parent template mapping (navigate to parent's body owner).
    const pair = pairKeyAt(source.tree, offset);
    if (pair && isTemplateDeclaration(pair)) {
        const targets = parents(pair, source, environment).map(parent =>
            new vscode.Location(parent.source.uri, offsetRange(parent.source.text, parent.pair.keyStart, parent.pair.keyEnd)),
        );
        if (targets.length) return { targets, range: offsetRange(source.text, pair.keyStart, pair.keyEnd) };
    }
    return null;
}

/** Definition whose key range contains offset (for find-usages of values keys). */
export function definitionAt(uri: vscode.Uri, offset: number, environment: string): ValuesDefinition | null {
    return (
        allDefinitions(uri, environment).find(
            definition => definition.originUri.toString() === uri.toString() && offset >= definition.keyStart && offset <= definition.keyEnd,
        ) ?? null
    );
}

/** Location of a repository declaration's name (or value) range. */
function repositoryTarget(repository: { declarationUri: vscode.Uri; targetStart: number; targetEnd: number }): vscode.Location {
    const source = readSource(repository.declarationUri);
    return new vscode.Location(repository.declarationUri, offsetRange(source?.text ?? '', repository.targetStart, repository.targetEnd));
}

function definitionLocation(definition: ValuesDefinition): vscode.Location {
    const source = readSource(definition.originUri);
    const text = source?.text ?? '';
    return new vscode.Location(definition.originUri, offsetRange(text, definition.keyStart, definition.keyEnd));
}

async function repositoryUsages(name: string): Promise<vscode.Location[]> {
    const locations: vscode.Location[] = [];
    for (const file of await stateFiles()) {
        const source = openOrRead(file);
        if (!source) continue;
        for (const entry of chartPairs(source)) {
            const chartText = scalarPathText(entry.pair.value);
            if (!chartText.includes('/')) continue;
            const prefix = chartText.slice(0, chartText.indexOf('/'));
            if (prefix !== name) continue;
            const valueStart = entry.pair.value ? entry.pair.value.start + (quoted(source.text, entry.pair.value.start) ? 1 : 0) : entry.pair.keyEnd;
            locations.push(new vscode.Location(file, offsetRange(source.text, valueStart, valueStart + prefix.length)));
        }
    }
    return locations;
}

async function templateUsages(uri: vscode.Uri, name: string, environment: string): Promise<vscode.Location[]> {
    const locations: vscode.Location[] = [];
    for (const file of await stateFiles()) {
        const source = openOrRead(file);
        if (!source) continue;
        for (const item of inheritanceScalars(source)) {
            if (item.name !== name) continue;
            locations.push(new vscode.Location(file, offsetRange(source.text, item.scalar.start, item.scalar.end)));
        }
    }
    return locations;
}

async function valueUsages(definition: ValuesDefinition, dottedSuffix: string, includeDeclaration: boolean): Promise<vscode.Location[]> {
    const locations: vscode.Location[] = [];
    const needles = unique([
        '.Values.' + dottedSuffix,
        '.StateValues.' + dottedSuffix,
        '.Environment.Values.' + dottedSuffix,
        '$.Values.' + dottedSuffix,
    ]);
    for (const file of await stateFiles()) {
        const source = openOrRead(file);
        if (!source) continue;
        const text = source.text;
        for (const needle of needles) {
            let index = text.indexOf(needle);
            while (index >= 0) {
                const after = index + needle.length;
                const boundary = after >= text.length ? true : !/[A-Za-z0-9_.]/.test(text[after]);
                if (boundary) locations.push(new vscode.Location(file, offsetRange(text, index, after)));
                index = text.indexOf(needle, index + 1);
            }
        }
    }
    if (includeDeclaration) {
        const origin = readSource(definition.originUri);
        locations.unshift(new vscode.Location(definition.originUri, offsetRange(origin?.text ?? '', definition.keyStart, definition.keyEnd)));
    }
    return locations;
}

/** Helmfile state files in the workspace plus the active document. */
async function stateFiles(): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles('**/*.{yaml,yml,gotmpl,tpl}', '**/node_modules/**');
    const result = files.filter(file => isHelmfileName(file.path.split('/').pop() ?? ''));
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && isHelmfileName(active.path.split('/').pop() ?? '') && !result.some(file => file.toString() === active.toString())) {
        result.push(active);
    }
    return result;
}

function openOrRead(uri: vscode.Uri): SourceFile | null {
    return readSource(uri);
}

/** All `chart:` scalar pairs in the state file (releases, dependencies, templates). */
function chartPairs(source: SourceFile): { pair: YPair; value: { start: number; end: number } | null }[] {
    const result: { pair: YPair; value: { start: number; end: number } | null }[] = [];
    for (const doc of source.tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            if (pair.value && pair.value.kind === 'scalar' && isChartField(pair, 'chart')) {
                result.push({ pair, value: { start: pair.value.start, end: pair.value.end } });
            }
        });
    }
    return result;
}

function matchAll(pattern: RegExp, text: string): RegExpMatchArray[] {
    const result: RegExpMatchArray[] = [];
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
        result.push(match);
        match = pattern.exec(text);
    }
    return result;
}

function splitQuoted(quoted: string): string[] {
    const segments: string[] = [];
    for (const match of matchAll(/"((?:[^"\\]|\\.)*)"/g, quoted)) segments.push(match[1].replace(/\\(.)/g, '$1'));
    return segments;
}

function unquote(raw: string): string {
    return raw.slice(1, -1).replace(/\\(.)/g, '$1');
}

function quoted(text: string, start: number): boolean {
    return start > 0 && (text[start - 1] === '"' || text[start - 1] === "'");
}



function unique(values: string[]): string[] {
    return [...new Set(values)];
}
