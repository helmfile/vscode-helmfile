/**
 * Editor-neutral navigation engine: definition/references/rename results as
 * file+offset spans and text edits. The references.ts provider converts them
 * into vscode Location/Range/WorkspaceEdit objects.
 */
import { TemplateScanner } from './templateScanner';
import { chartCallsFor, chartDefinesFor, templateCallAt } from './chartDefines';
import { chartModelFor } from './chartModel';
import type { ChartTemplateContext } from './chartContext';
import { matchAll } from './language';
import { valuePathAt } from './valuePath';
import { contentStamp } from './values';
import { nodeAt, pairKeyAt, parseTree, scalarPathText, walkAll, type YPair, type YTree } from './yamlTree';
import { isChartField, isDeclaration as isRepositoryDeclaration } from './repositories';
import { isDeclaration as isTemplateDeclaration, isInheritance, inheritanceScalars } from './templates';

/** A span in some file on disk (or an open buffer of it). */
export interface EngineLocation {
    readonly file: string;
    readonly start: number;
    readonly end: number;
}

/** A single text replacement in a file. */
export interface EngineTextEdit {
    readonly file: string;
    readonly start: number;
    readonly end: number;
    readonly newText: string;
}

/** Values definition with the vscode.Uri flattened to a path. */
export interface EngineDefinition {
    readonly path: string;
    readonly originFile: string;
    readonly keyStart: number;
    readonly keyEnd: number;
}

/** Template declaration with its owning file flattened to a path. */
export interface EngineDeclaration {
    readonly file: string;
    readonly text: string;
    readonly keyStart: number;
    readonly keyEnd: number;
}

export interface RepositoryEntryLike {
    readonly name: string;
    readonly declarationFile: string;
    readonly targetStart: number;
    readonly targetEnd: number;
}

/** File-system and state access the engine needs from the host. */
export interface ReferenceDeps {
    /** Current text of a file (open buffers preferred), or undefined. */
    read(file: string): string | undefined;
    /** Helmfile state files in the workspace (plus the active document). */
    stateFiles(): Promise<string[]>;
    allDefinitions(file: string, environment: string): readonly EngineDefinition[];
    /** Resolve a values/base/readFile literal against a state file. */
    resolveValueFiles(file: string, text: string, literal: string, environment: string): string[];
    templateDeclarations(file: string, environment: string): Map<string, EngineDeclaration>;
    parents(file: string, text: string, pair: YPair, environment: string): readonly EngineDeclaration[];
    repositoryEntries(file: string, environment: string): readonly RepositoryEntryLike[];
    alias(file: string, chartText: string): string | null;
}

/** String literal argument of readFile/isFile/isDir inside actions. */
const FILE_FUNCTION = /\b(?:readFile|isFile|isDir)\s*\(\s*(?:"([^"\\]|\\.)*"|'([^'\\]|\\.)*')/g;

/* ------------------------------ definitions ------------------------------ */

/**
 * Go-to-definition inside a chart template file: `include "name"` → its
 * `define`, `.Values.x` → the origin the effective value came from.
 */
export function chartTemplateDefinitionAt(file: string, text: string, offset: number, context: ChartTemplateContext, environment: string): EngineLocation | null {
    const call = templateCallAt(text, offset);
    if (call) {
        const define = chartDefinesFor(context, contentStamp(), { file, text })
            .find(candidate => candidate.name === call.name);
        return define ? { file: define.file, start: define.start, end: define.start } : null;
    }
    const valuePath = valuePathAt(text, offset);
    if (valuePath) {
        const segments = valuePath.key.split('\u001f').filter(segment => segment.length > 0);
        const origin = chartModelFor(context, contentStamp(), environment).originAt(segments);
        if (origin) return { file: origin.file, start: origin.offset, end: origin.offset };
    }
    return null;
}

/**
 * Go-to-definition in a Helmfile state file: values paths, values-file
 * literals, repository alias prefixes and template inheritance.
 */
export function stateDefinitionAt(file: string, text: string, offset: number, environment: string, deps: ReferenceDeps): EngineLocation[] | null {
    // 1. Values paths inside Go template actions.
    const valuePath = valuePathAt(text, offset);
    if (valuePath) {
        return deps.allDefinitions(file, environment)
            .filter(definition => definition.path === valuePath.key)
            .map(definition => ({ file: definition.originFile, start: definition.keyStart, end: definition.keyEnd }));
    }

    // 2. Values-file / base / readFile path references.
    const pathRef = pathFileReferenceSpan(text, offset);
    if (pathRef) {
        const files = deps.resolveValueFiles(file, text, pathRef.literal, environment);
        if (files.length > 0) return files.map(target => ({ file: target, start: 0, end: 0 }));
    }

    const tree = parseTree(text);

    // 3. Repository alias prefix of `chart: alias/name`.
    const chartRef = chartFieldReferenceAt(file, text, tree, offset, deps);
    if (chartRef && chartRef.aliasLength > 0) {
        const repository = deps.repositoryEntries(file, environment)
            .find(entry => entry.name === chartRef.chart.slice(0, chartRef.aliasLength));
        if (repository) return [{ file: repository.declarationFile, start: repository.targetStart, end: repository.targetEnd }];
    }

    // 4. Template inheritance declarations.
    const inheritance = inheritanceReferenceAt(file, text, tree, offset, environment, deps);
    if (inheritance) return [...inheritance.targets];

    return null;
}

/** String literal argument of readFile/isFile/isDir containing `offset`. */
export function pathFileReferenceSpan(text: string, offset: number): { literal: string; start: number; end: number } | null {
    const action = TemplateScanner.at(text, offset);
    if (!action) return null;
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const bodyOffset = offset - action.bodyStart;
    for (const match of matchAll(FILE_FUNCTION, body)) {
        if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
        const raw = match[1] ?? match[2] ?? '';
        return {
            literal: unquote(raw),
            start: action.bodyStart + (match.index ?? 0),
            end: action.bodyStart + (match.index ?? 0) + match[0].length,
        };
    }
    return null;
}

/** The `chart: alias/name` scalar span and the alias prefix length. */
export function chartFieldReferenceAt(file: string, text: string, tree: YTree, offset: number, deps: ReferenceDeps): { chart: string; aliasLength: number; start: number; end: number } | null {
    let current: ReturnType<typeof nodeAt> = nodeAt(tree, offset);
    while (current) {
        if (current.kind === 'pair') {
            const pair = current as YPair;
            const inValue = pair.value && offset >= pair.keyEnd && offset <= pair.value.end;
            if (inValue && isChartField(pair, 'chart') && pair.value && pair.value.kind === 'scalar') {
                const chartText = scalarPathText(pair.value);
                if (chartText && !chartText.includes('{{')) {
                    const aliasLength = deps.alias(file, chartText)?.length ?? -1;
                    const quote = quoted(text, pair.value.start);
                    const start = pair.value.start + (quote ? 1 : 0);
                    return { chart: chartText, aliasLength, start, end: start + chartText.length };
                }
            }
            break;
        }
        current = current.parent as typeof current;
    }
    return null;
}

/** `inherit: [{template: parent}]` reference at offset. */
export function inheritanceReferenceAt(file: string, text: string, tree: YTree, offset: number, environment: string, deps: ReferenceDeps): { targets: readonly EngineLocation[]; start: number; end: number } | null {
    let current: ReturnType<typeof nodeAt> = nodeAt(tree, offset);
    while (current) {
        if (current.kind === 'scalar') {
            const scalar = current;
            if (isInheritance(scalar) && scalar.value.length > 0 && offset >= scalar.start && offset <= scalar.end) {
                const declaration = deps.templateDeclarations(file, environment).get(scalar.value);
                if (declaration) {
                    return {
                        targets: [{ file: declaration.file, start: declaration.keyStart, end: declaration.keyEnd }],
                        start: scalar.start,
                        end: scalar.end,
                    };
                }
            }
            break;
        }
        current = current.parent as typeof current;
    }
    // Declaration → parent template mapping (navigate to parent's body owner).
    const pair = pairKeyAt(tree, offset);
    if (pair && isTemplateDeclaration(pair)) {
        const targets = deps.parents(file, text, pair, environment)
            .map(parent => ({ file: parent.file, start: parent.keyStart, end: parent.keyEnd }));
        if (targets.length) return { targets, start: pair.keyStart, end: pair.keyEnd };
    }
    return null;
}

/** Definition whose key range contains offset (for find-usages of values keys). */
export function definitionAt(file: string, offset: number, environment: string, deps: ReferenceDeps): EngineDefinition | null {
    return (
        deps.allDefinitions(file, environment).find(
            definition => definition.originFile === file && offset >= definition.keyStart && offset <= definition.keyEnd,
        ) ?? null
    );
}

/* ------------------------------- references ------------------------------ */

/**
 * Named-template references inside a chart: on an `include`/`template`
 * name or on the `define` declaration itself, every declaration and call
 * site of that template across the chart's template files.
 */
export function chartTemplateReferenceSpans(currentFile: string, text: string, offset: number, context: ChartTemplateContext, deps: Pick<ReferenceDeps, 'read'>): EngineLocation[] {
    const stamp = contentStamp();
    const current = { file: currentFile, text };
    const target = templateCallAt(text, offset)?.name
        ?? declarationNameAt(chartDefinesFor(context, stamp, current), currentFile, text, offset)?.name;
    if (!target) return [];
    const locations: EngineLocation[] = [];
    for (const define of chartDefinesFor(context, stamp, current)) {
        if (define.name === target && deps.read(define.file) !== undefined) {
            locations.push({ file: define.file, start: define.start, end: define.start });
        }
    }
    for (const call of chartCallsFor(context, stamp, current)) {
        if (call.name === target && deps.read(call.file) !== undefined) {
            locations.push({ file: call.file, start: call.start, end: call.start });
        }
    }
    return locations.filter((location, index) =>
        locations.findIndex(other => other.file === location.file && other.start === location.start && other.end === location.end) === index);
}

/** Find-references in a Helmfile state file. */
export async function stateReferenceSpans(file: string, text: string, offset: number, environment: string, includeDeclaration: boolean, deps: ReferenceDeps): Promise<EngineLocation[]> {
    const tree = parseTree(text);

    // Repository name declaration → chart usages.
    const key = pairKeyAt(tree, offset);
    if (key && isRepositoryDeclaration(key)) {
        const name = scalarPathText(key.value ?? null);
        if (name) return repositoryUsages(name, deps);
    }

    // Template declaration → inherit references.
    if (key && isTemplateDeclaration(key)) {
        return templateUsages(key.key, deps);
    }

    // Values definition key → path usages across state files.
    const definition = definitionAt(file, offset, environment, deps);
    if (definition) {
        const suffix = definition.path.split('\u001f').join('.');
        return valueUsages(definition, suffix, includeDeclaration, deps);
    }

    return [];
}

async function repositoryUsages(name: string, deps: ReferenceDeps): Promise<EngineLocation[]> {
    const locations: EngineLocation[] = [];
    for (const file of await deps.stateFiles()) {
        const text = deps.read(file);
        if (text === undefined) continue;
        for (const entry of chartPairs(text)) {
            if (!entry.value) continue;
            const chartText = entry.chart;
            if (!chartText.includes('/')) continue;
            const prefix = chartText.slice(0, chartText.indexOf('/'));
            if (prefix !== name) continue;
            const valueStart = entry.value.start + (quoted(text, entry.value.start) ? 1 : 0);
            locations.push({ file, start: valueStart, end: valueStart + prefix.length });
        }
    }
    return locations;
}

async function templateUsages(name: string, deps: ReferenceDeps): Promise<EngineLocation[]> {
    const locations: EngineLocation[] = [];
    for (const candidate of await deps.stateFiles()) {
        const text = deps.read(candidate);
        if (text === undefined) continue;
        for (const item of inheritanceScalars({ text, tree: parseTree(text) } as never)) {
            if (item.name !== name) continue;
            locations.push({ file: candidate, start: item.scalar.start, end: item.scalar.end });
        }
    }
    return locations;
}

async function valueUsages(definition: EngineDefinition, dottedSuffix: string, includeDeclaration: boolean, deps: ReferenceDeps): Promise<EngineLocation[]> {
    const locations: EngineLocation[] = [];
    const needles = unique([
        '.Values.' + dottedSuffix,
        '.StateValues.' + dottedSuffix,
        '.Environment.Values.' + dottedSuffix,
        '$.Values.' + dottedSuffix,
    ]);
    for (const file of await deps.stateFiles()) {
        const text = deps.read(file);
        if (text === undefined) continue;
        for (const needle of needles) {
            let index = text.indexOf(needle);
            while (index >= 0) {
                const after = index + needle.length;
                // Boundary on both ends: `my.Values.x` is not a reference to
                // `.Values.x`, and `$.Values.x` must not match twice (the
                // leading `$` fails the before-boundary for the bare needle).
                const boundary =
                    (after >= text.length ? true : !/[A-Za-z0-9_.]/.test(text[after])) &&
                    (index === 0 ? true : !/[A-Za-z0-9_$]/.test(text[index - 1]));
                if (boundary) locations.push({ file, start: index, end: after });
                index = text.indexOf(needle, index + 1);
            }
        }
    }
    if (includeDeclaration) {
        locations.unshift({ file: definition.originFile, start: definition.keyStart, end: definition.keyEnd });
    }
    return locations;
}

/** All `chart:` scalar pairs in a state file (releases, dependencies, templates). */
function chartPairs(text: string): { chart: string; value: { start: number; end: number } | null }[] {
    const tree = parseTree(text);
    const result: { chart: string; value: { start: number; end: number } | null }[] = [];
    for (const doc of tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            if (pair.value && pair.value.kind === 'scalar' && isChartField(pair, 'chart')) {
                result.push({ chart: scalarPathText(pair.value), value: { start: pair.value.start, end: pair.value.end } });
            }
        });
    }
    return result;
}

/* --------------------------------- rename -------------------------------- */

/** Span to highlight for F2 in the current buffer, or null. */
export function chartTemplateRenameSpan(currentFile: string, text: string, offset: number, context: ChartTemplateContext): { start: number; end: number } | null {
    const call = templateCallAt(text, offset);
    if (call) return { start: call.start, end: call.end };
    const declaration = declarationNameAt(chartDefinesFor(context, contentStamp(), { file: currentFile, text }), currentFile, text, offset);
    return declaration ? { start: declaration.start, end: declaration.end } : null;
}

/**
 * Rename a named template: the `{{ define }}` declaration literal plus
 * every include/template call, as neutral text edits.
 */
export function chartTemplateRenameEdits(currentFile: string, text: string, offset: number, newName: string, context: ChartTemplateContext, deps: Pick<ReferenceDeps, 'read'>): EngineTextEdit[] | null {
    const name = newName.trim();
    if (name.length === 0 || name.length > 200 || /["'\\\r\n]/.test(name)) return null;
    const stamp = contentStamp();
    const current = { file: currentFile, text };
    const target = templateCallAt(text, offset)?.name
        ?? declarationNameAt(chartDefinesFor(context, stamp, current), currentFile, text, offset)?.name;
    if (!target) return null;
    const edits: EngineTextEdit[] = [];
    for (const define of chartDefinesFor(context, stamp, current)) {
        if (define.name !== target) continue;
        const body = deps.read(define.file);
        if (body === undefined) continue;
        const span = defineLiteralSpan(define, body);
        if (span) edits.push({ file: define.file, start: span.start, end: span.end, newText: name });
    }
    for (const call of chartCallsFor(context, stamp, current)) {
        if (call.name !== target) continue;
        if (deps.read(call.file) === undefined) continue;
        edits.push({ file: call.file, start: call.start, end: call.end, newText: name });
    }
    return edits.length > 0 ? edits : null;
}

/** Name and literal span of the `define` whose quoted name contains `offset`, if any. */
function declarationNameAt(defines: readonly { name: string; file: string; start: number }[], currentFile: string, text: string, offset: number): { name: string; start: number; end: number } | null {
    for (const define of defines) {
        if (define.file !== currentFile) continue;
        if (offset < define.start || offset > define.start + 200) continue;
        const match = /"((?:[^"\\]|\\.)*)"/.exec(text.slice(define.start, define.start + 200));
        if (!match) continue;
        const start = define.start + (match.index ?? 0) + 1;
        const end = start + match[1].length;
        if (offset >= start - 1 && offset <= end + 1) return { name: define.name, start, end };
    }
    return null;
}

/** Literal span of `name` inside a `{{ define "name" }}` header, without the quotes. */
function defineLiteralSpan(define: { name: string; file: string; start: number }, text: string): { start: number; end: number } | null {
    const header = text.slice(define.start, define.start + 200);
    const match = /"((?:[^"\\]|\\.)*)"/.exec(header);
    if (!match || match[1] !== define.name) return null;
    const start = define.start + (match.index ?? 0) + 1;
    return { start, end: start + define.name.length };
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
