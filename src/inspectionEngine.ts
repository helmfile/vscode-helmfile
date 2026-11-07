/**
 * Editor-neutral diagnostics engine: every check from HelmfileDiagnostics
 * (repository health, unknown fields, missing files, YAML syntax, Go
 * template structure, chart-template rules, Chart.yaml dependency sanity).
 * Diagnostics carry offset spans and string severities; the provider in
 * inspection.ts converts them to vscode.Diagnostic and routes quick-fix
 * payloads into its side tables. Workspace/repository access is injected
 * so the engine never touches the vscode API.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateScanner, fillMaskedTemplateKeys, type TemplateAction } from './templateScanner';
import type { ChartTemplateContext } from './chartContext';
import { chartCallsFor, chartDefinesFor } from './chartDefines';
import { conditionalSpans, variableScopeIssues } from './chartIteration';
import { chartModelFor } from './chartModel';
import { mappingGet, parseTree, rootMappings, scalarPathText, walkAll, ancestors, type YMapping, type YPair, type YScalar, type YTree } from './yamlTree';
import { contentStamp } from './values';
import { positionAt } from './language';
import { downloadable, namedMap, isChartField, type RepositoryModel } from './repositories';
import type { Access } from './repositories';
import type { ChartIndex } from './chartIndex';
import { schemaContext, schemaFields } from './schema';

export type Severity = 'error' | 'warning' | 'information';

/** Quick-fix payload attached to a diagnostic (consumed by codeActions.ts). */
export type DiagnosticPayload =
    | { readonly kind: 'outdatedVersion'; readonly version: string }
    | { readonly kind: 'unknownField'; readonly start: number; readonly end: number }
    | { readonly kind: 'missingFile'; readonly file: string }
    | { readonly kind: 'missingDefine'; readonly name: string; readonly helpers: string }
    | { readonly kind: 'schemaKey'; readonly segments: readonly string[]; readonly schemaFile: string; readonly valuesFile: string; readonly type: string }
    | { readonly kind: 'unusedDefine'; readonly name: string; readonly start: number; readonly end: number };

export interface EngineDiagnostic {
    readonly message: string;
    readonly severity: Severity;
    readonly start: number;
    readonly end: number;
    /** Command invoked by the quick fix, when there is one. */
    readonly code?: string;
    readonly payload?: DiagnosticPayload;
}

/** Repository access the engine needs from the host. */
export interface InspectionDeps {
    model(file: string, environment: string): RepositoryModel;
    alias(file: string, chartText: string): string | null;
    query(file: string, chartText: string, environment: string): { readonly access: Access; readonly chart: string } | null;
    /** Resolve a release mapping's `chart:` value (inherit chains included). */
    chartValue(doc: StateDoc, mapping: YMapping | null, environment: string, visiting: Set<YMapping>): string;
    /** Resolve a templated mapping field such as `name:` on a repository item. */
    fieldValue(doc: StateDoc, mapping: YMapping | null, key: string): string;
    snapshot(request: { readonly access: Access; readonly chart: string }, downloadsEnabled: boolean): { readonly index: ChartIndex | null; readonly error: string | null; readonly loading: boolean };
    downloadsEnabled(): boolean;
}

/** State file being inspected: path + parsed content. */
export interface StateDoc {
    readonly file: string;
    readonly text: string;
    readonly tree: YTree;
}

/** Diagnostics for a helmfile state file (yaml + template + repository checks). */
export function computeStateDiagnostics(file: string, text: string, environment: string, deps: InspectionDeps): readonly EngineDiagnostic[] {
    const diagnostics: EngineDiagnostic[] = [];
    const doc: StateDoc = { file, text, tree: parseTree(text) };
    if (/\.ya?ml(\.gotmpl)?$/i.test(file)) yamlSyntaxErrors(doc, diagnostics);
    unclosedActions(text, diagnostics);
    templateBlocks(text, diagnostics);
    repositoryDiagnostics(doc, environment, deps, diagnostics);
    unknownFieldDiagnostics(doc, diagnostics);
    missingFileDiagnostics(doc, environment, diagnostics);
    return diagnostics;
}

/** Diagnostics for a chart template file (templates/*.yaml|tpl etc.). */
export function computeChartTemplateDiagnostics(file: string, text: string, context: ChartTemplateContext): readonly EngineDiagnostic[] {
    const diagnostics: EngineDiagnostic[] = [];
    if (/\.ya?ml(\.gotmpl)?$/i.test(file)) yamlSyntaxErrors({ file, text, tree: parseTree(text) }, diagnostics);
    unclosedActions(text, diagnostics);
    templateBlocks(text, diagnostics);
    missingDefineDiagnostics(file, text, context, diagnostics);
    schemaUnknownKeyDiagnostics(file, text, context, diagnostics);
    variableScopeDiagnostics(text, diagnostics);
    duplicateDefineDiagnostics(file, text, context, diagnostics);
    unusedDefineDiagnostics(file, text, context, diagnostics);
    return diagnostics;
}

/** Diagnostics for Chart.yaml: plain YAML syntax plus dependency sanity. */
export function computeChartManifestDiagnostics(file: string, text: string): readonly EngineDiagnostic[] {
    const diagnostics: EngineDiagnostic[] = [];
    yamlSyntaxErrors({ file, text, tree: parseTree(text) }, diagnostics);
    chartYamlDependencyDiagnostics(file, text, diagnostics);
    return diagnostics;
}

/* ---------------- Go template structure ---------------- */

/** Quoted scalar spans (single/double, YAML escapes, line-scoped). */
function quotedSpans(text: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    let quote: '\'' | '"' | null = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '\n') {
            // Unbalanced quote on a line must not leak into the next one.
            if (quote !== null) spans.push([start, i]);
            quote = null;
            continue;
        }
        if (quote === '\'') {
            if (char === '\'') {
                if (text[i + 1] === '\'') { i++; continue; } // '' escapes a quote
                spans.push([start, i + 1]);
                quote = null;
            }
        } else if (quote === '"') {
            if (char === '\\') { i++; continue; }
            if (char === '"') { spans.push([start, i + 1]); quote = null; }
        } else if (char === '\'' || char === '"') {
            // Quotes start scalars after delimiters; a mid-word apostrophe
            // (`it's`) must not open a span.
            const prev = i === 0 ? '\n' : text[i - 1];
            if (prev === ' ' || prev === '\t' || prev === ':' || prev === '-' || prev === '[' || prev === '{' || prev === ',' || prev === '(' || prev === '=') {
                quote = char;
                start = i;
            }
        }
    }
    if (quote !== null) spans.push([start, text.length]);
    return spans;
}

function diagnostic(text: string, start: number, end: number, message: string, severity: Severity, code?: string, payload?: DiagnosticPayload): EngineDiagnostic {
    const span = { start: Math.max(0, Math.min(start, text.length)), end: Math.max(start, Math.min(end, text.length)) };
    return code || payload ? { message, severity, start: span.start, end: span.end, ...(code ? { code } : {}), ...(payload ? { payload } : {}) } : { message, severity, start: span.start, end: span.end };
}

export function unclosedActions(text: string, diagnostics: EngineDiagnostic[]): void {
    const actions = TemplateScanner.scan(text);
    for (const action of actions) {
        if (!action.closed) {
            diagnostics.push(diagnostic(text, action.start, text.length, 'Unclosed Go template action: expected }}', 'warning'));
            continue;
        }
        // An auto-closed "{{}}" is a valid shape for the scanner but an empty
        // command for Go templates — helmfile fails to render it.
        const body = text.slice(action.bodyStart, action.bodyEnd).trim();
        if (body.length === 0) {
            diagnostics.push(diagnostic(text, action.start, action.end, 'Empty Go template action: nothing between {{ and }}', 'warning'));
        }
    }
    // Orphan closers: a "}}" outside any action span almost always means the
    // opening "{{" was deleted, so Go templates treat the leftover text as a
    // literal value (e.g. `routerInstances:  .Values | get "x" 2 }}`).
    // `}}` inside a quoted scalar is literal text (e.g. a dockerconfigjson
    // blob), never a template closer.
    const quotes = quotedSpans(text);
    const inQuotes = (offset: number) => quotes.some(([start, end]) => offset >= start && offset < end);
    let covered = 0;
    for (let i = 0; i + 1 < text.length; i++) {
        if (text[i] !== '}' || text[i + 1] !== '}') continue;
        if (inQuotes(i)) { i++; continue; }
        while (covered < actions.length && actions[covered].end <= i) covered++;
        if (covered < actions.length && i >= actions[covered].start) continue;
        diagnostics.push(diagnostic(text, i, i + 2, 'Unmatched Go template closing: no matching {{', 'warning'));
        i++;
    }
}

const BLOCK_KEYWORDS = new Set(['if', 'range', 'with', 'define', 'block']);

/**
 * Go template block matching, the diagnostics twin of the IntelliJ
 * annotator's unmatched-block highlighting: every {{ if / range / with /
 * define / block }} must be closed by {{ end }}, {{ else }} may only appear
 * inside if/range/with, and stray {{ end }} is flagged.
 */
export function templateBlocks(text: string, diagnostics: EngineDiagnostic[]): void {
    const stack: { keyword: string; action: TemplateAction }[] = [];
    for (const action of TemplateScanner.scan(text)) {
        const body = text.slice(action.bodyStart, action.bodyEnd).trim();
        if (body.startsWith('/*')) continue; // comment action
        const head = body.split(/\s+/)[0] ?? '';
        if (BLOCK_KEYWORDS.has(head)) {
            stack.push({ keyword: head, action });
        } else if (head === 'end') {
            if (stack.length === 0) {
                diagnostics.push(diagnostic(text, action.start, action.end, '{{ end }} without a matching {{ if }}, {{ range }}, {{ with }}, {{ define }} or {{ block }}', 'warning'));
            } else {
                stack.pop();
            }
        } else if (head === 'else') {
            const open = stack[stack.length - 1];
            if (!open || (open.keyword !== 'if' && open.keyword !== 'range' && open.keyword !== 'with')) {
                diagnostics.push(diagnostic(text, action.start, action.end, '{{ else }} outside of an {{ if }}, {{ range }} or {{ with }} block', 'warning'));
            }
            // `else if ...` reuses the enclosing block's {{ end }} — depth stays.
        }
    }
    for (const open of stack) {
        // A block whose opening action itself never closed is already reported
        // by the unclosed-action warning; don't double-report it.
        if (!open.action.closed) continue;
        diagnostics.push(diagnostic(text, open.action.start, open.action.end, `Unclosed Go template block {{ ${open.keyword} }}: expected {{ end }}`, 'warning'));
    }
}

/* ---------------- YAML syntax ---------------- */

/**
 * Genuine YAML syntax errors, reported as red squiggles. The document is
 * parsed with Go template actions masked out (equal-length spaces), so
 * valid `{{ ... }}` blocks are not misread as YAML flow mappings; keys
 * produced by whole-template actions are filled to stay valid.
 */
function yamlSyntaxErrors(doc: StateDoc, diagnostics: EngineDiagnostic[]): void {
    const { text } = doc;
    const masked = fillMaskedTemplateKeys(TemplateScanner.maskForYaml(text));
    const tree = parseTree(masked);
    duplicateKeyDiagnostics(doc, tree, diagnostics);
    for (const error of tree.errors) {
        // Duplicate keys get a dedicated, named diagnostic below.
        if (error.message.includes('Map keys must be unique')) continue;
        const start = Math.min(Math.max(0, error.offset), masked.length);
        const end = Math.min(Math.max(start + 1, error.end), masked.length);
        diagnostics.push(diagnostic(text, start, end, error.message, 'error'));
    }
}

/**
 * Named duplicate-key diagnostics: `repository:` twice in one mapping is a
 * real post-render defect (the first write is silently dropped), but the
 * parser's own "Map keys must be unique at line/column" message points at
 * the wrong place and never names the key. Keys produced by template
 * actions (`{{ $key }}:`) are skipped — their rendered value is unknowable.
 */
function duplicateKeyDiagnostics(doc: StateDoc, tree: YTree, diagnostics: EngineDiagnostic[]): void {
    const { text } = doc;
    const conditional = conditionalSpans(text);
    const insideConditional = (offset: number): boolean => conditional.some(span => offset >= span.start && offset <= span.end);
    for (const document of tree.docs) {
        if (!document.root) continue;
        walkAll(document.root, node => {
            if (node.kind !== 'mapping') return;
            const seen = new Map<string, { offset: number; conditional: boolean }>();
            for (const pair of node.pairs) {
                if (!pair.key) continue;
                const first = seen.get(pair.key);
                if (first === undefined) {
                    seen.set(pair.key, { offset: pair.keyStart, conditional: insideConditional(pair.keyStart) });
                    continue;
                }
                if (!text.slice(pair.keyStart, pair.keyEnd).trim()) continue; // templated key
                // Two occurrences in different conditional branches never
                // coexist at render time — only unconditional duplicates are
                // real defects.
                if (first.conditional || insideConditional(pair.keyStart)) continue;
                diagnostics.push(
                    diagnostic(text, pair.keyStart, pair.keyEnd, `Duplicate map key "${pair.key}" — already set at line ${positionAt(text, first.offset).line + 1}`, 'error'),
                );
            }
        });
    }
}

/* ---------------- helmfile state: repositories ---------------- */

/** Exact semver references checked against repository indexes. */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Characters that make java.net.URI#create throw. */
const URI_ILLEGAL = /[\s"<>\\^`{}|]/;

/**
 * Mirrors HelmfileRepositoryInspection: only http(s) URLs require a host.
 * Scheme-less URLs (e.g. bare OCI registry hosts like quay.io/okdp/charts)
 * are valid and never flagged.
 */
function invalidRepositoryUrl(url: string): boolean {
    if (URI_ILLEGAL.test(url)) return true;
    if (!url.startsWith('http:') && !url.startsWith('https:')) return false;
    try {
        return new URL(url).hostname === '';
    } catch {
        return true;
    }
}

export function repositoryDiagnostics(doc: StateDoc, environment: string, deps: InspectionDeps, diagnostics: EngineDiagnostic[]): void {
    const model = deps.model(doc.file, environment);
    const named = new Map(namedMap(model.entries).map(repository => [repository.name, repository]));

    // Declaration-level problems for repositories declared in this file.
    for (const document of doc.tree.docs) {
        const sequence = mappingGet(document.root ?? null, 'repositories')?.value;
        if (!sequence || sequence.kind !== 'sequence') continue;
        for (const item of sequence.items) {
            if (!item || item.kind !== 'mapping') continue;
            const name = deps.fieldValue(doc, item, 'name');
            const url = deps.fieldValue(doc, item, 'url');
            const namePair = item.pairs.find(pair => pair.key === 'name') ?? null;
            const urlPair = item.pairs.find(pair => pair.key === 'url') ?? null;
            if (!name) {
                diagnostics.push(diagnosticAt(doc, item.start, item.end, 'Helm repository requires a name', 'warning'));
            } else if (!name.includes('{{') && name.includes('/')) {
                diagnostics.push(diagnosticAt(doc, namePair?.keyStart ?? item.start, namePair?.keyEnd ?? item.end, "Repository name must not contain '/'", 'warning'));
            }
            if (!url) {
                diagnostics.push(diagnosticAt(doc, urlPair?.keyStart ?? item.start, urlPair?.keyEnd ?? item.end, 'Helm repository requires a URL', 'warning'));
            }
            if (!name || name.includes('{{')) continue;
            if (model.entries.filter(entry => entry.name === name).length > 1) {
                const start = namePair?.value ? namePair.value.start : namePair?.keyStart ?? item.start;
                const end = namePair?.value ? namePair.value.end : namePair?.keyEnd ?? item.end;
                diagnostics.push(diagnosticAt(doc, start, end, `Duplicate Helm repository name '${name}'`, 'warning'));
            }
            if (url && !url.includes('{{') && urlPair && invalidRepositoryUrl(url)) {
                diagnostics.push(diagnosticAt(doc, urlPair.keyStart, urlPair.keyEnd, 'Invalid Helm repository URL', 'warning'));
            }
            const repository = named.get(name);
            if (repository && downloadable(repository.access) && urlPair) {
                const snapshot = deps.snapshot({ access: repository.access, chart: '' }, false);
                if (snapshot.error) {
                    diagnostics.push(diagnosticAt(doc, urlPair.keyStart, urlPair.keyEnd, snapshot.error, 'information', 'helmfile.refreshRepositories'));
                }
            }
        }
    }

    if (model.incomplete) return;

    // chart / version problems against loaded indexes.
    for (const document of doc.tree.docs) {
        if (!document.root) continue;
        walkAll(document.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            if (!isChartField(pair, 'chart') && !isChartField(pair, 'version')) return;
            if (pair.value && pair.value.kind !== 'scalar') return;
            if (isChartField(pair, 'chart')) {
                checkChart(doc, pair, named, environment, deps, diagnostics);
            } else {
                checkVersion(doc, pair, environment, deps, diagnostics);
            }
        });
    }
}

function checkChart(
    doc: StateDoc,
    pair: YPair,
    named: Map<string, unknown>,
    environment: string,
    deps: InspectionDeps,
    diagnostics: EngineDiagnostic[],
): void {
    const chart = scalarPathText(pair.value);
    if (!chart || chart.endsWith('/') || chart.includes('{{')) return;
    const model = deps.model(doc.file, environment);
    const chartAlias = deps.alias(doc.file, chart);
    if (chartAlias && !named.has(chartAlias) && !model.incomplete) {
        diagnostics.push(
            diagnosticAt(
                doc,
                valueStart(doc, pair),
                valueStart(doc, pair) + chart.length,
                `Repository '${chartAlias}' is not declared in this Helmfile or its bases`,
                'warning',
            ),
        );
        return;
    }
    const request = deps.query(doc.file, chart, environment);
    if (!request) return;
    const snapshot = deps.snapshot(request, deps.downloadsEnabled());
    if (!snapshot.index) return;
    const name = request.access.oci ? request.chart : chart.slice(chart.indexOf('/') + 1);
    if (name && !snapshot.index.charts.has(name)) {
        diagnostics.push(
            diagnosticAt(
                doc,
                valueStart(doc, pair),
                valueStart(doc, pair) + chart.length,
                `Chart '${name}' was not found in repository '${request.access.name}'`,
                'warning',
                'helmfile.refreshRepositories',
            ),
        );
    }
}

function checkVersion(doc: StateDoc, pair: YPair, environment: string, deps: InspectionDeps, diagnostics: EngineDiagnostic[]): void {
    const version = scalarPathText(pair.value);
    // A Helm constraint such as ~1, ^2.0, 1.x, or >=1.0.0 is not an exact pin.
    if (!version || !EXACT_VERSION.test(version)) return;
    // Find the enclosing item mapping and resolve its chart (inherit included).
    const mapping = pair.parent;
    if (!mapping || mapping.kind !== 'mapping') return;
    const chart = deps.chartValue(doc, mapping, environment, new Set());
    if (!chart || chart.includes('{{') || !chart.includes('/')) return;
    const request = deps.query(doc.file, chart, environment);
    if (!request) return;
    const snapshot = deps.snapshot(request, deps.downloadsEnabled());
    if (!snapshot.index) return;
    const name = request.access.oci ? request.chart : chart.slice(chart.indexOf('/') + 1);
    if (snapshot.index.charts.has(name) && !snapshot.index.containsVersion(name, version)) {
        diagnostics.push(
            diagnosticAt(
                doc,
                valueStart(doc, pair),
                valueStart(doc, pair) + version.length,
                `Version '${version}' was not found for chart '${chart}'`,
                'warning',
                'helmfile.refreshRepositories',
            ),
        );
        return;
    }
    const entries = snapshot.index.charts.get(name);
    if (!entries || entries.length === 0) return;
    const candidate = entries.find(entry => !entry.deprecated) ?? entries[0];
    if (!candidate || candidate.version === version) return;
    diagnostics.push(
        diagnosticAt(
            doc,
            valueStart(doc, pair),
            valueStart(doc, pair) + version.length,
            `Version '${version}' is outdated: ${chart} ${candidate.version} is available`,
            'information',
            'helmfile.updateVersion',
            { kind: 'outdatedVersion', version: candidate.version },
        ),
    );
}

/* ---------------- helmfile state: fields and files ---------------- */

const STRICT_CONTEXTS = new Set(['releases', 'repositories', 'dependencies', 'environment', 'helmDefaults', 'set', 'hooks', 'inherit', 'helmfiles']);
const knownFieldsCache = new Map<string, Set<string>>();

function knownFields(context: string): Set<string> {
    let names = knownFieldsCache.get(context);
    if (!names) {
        names = new Set(schemaFields(context).map(field => field.name));
        knownFieldsCache.set(context, names);
    }
    return names;
}

/**
 * Unknown-field warnings for contexts the Helmfile schema fully describes
 * (helmfile strict-decodes release/repository entries, so a typo like
 * `insatlled:` fails at run time). Root-level keys stay unchecked: the
 * state format allows more top-level keys than the completion schema lists.
 */
export function unknownFieldDiagnostics(doc: StateDoc, diagnostics: EngineDiagnostic[]): void {
    for (const document of doc.tree.docs) {
        if (!document.root) continue;
        walkAll(document.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            const key = pair.key;
            if (!key || key.includes('{{')) return;
            const path = ancestors(pair);
            const context = schemaContext(path);
            if (!STRICT_CONTEXTS.has(context)) return;
            if (knownFields(context).has(key)) return;
            diagnostics.push(diagnosticAt(doc, pair.keyStart, pair.keyEnd, `Unknown field '${key}' in ${context}`, 'warning', undefined, { kind: 'unknownField', start: pair.start, end: pair.end }));
        });
    }
}

const ENV_NAME = /\{\{-?\s*\.Environment\.Name\s*-?\}\}/;

/**
 * Warn when a values/secrets/bases/helmfiles entry points at a file that
 * does not exist on disk. Templated paths and globs are skipped: they only
 * resolve at render time.
 */
export function missingFileDiagnostics(doc: StateDoc, environment: string, diagnostics: EngineDiagnostic[]): void {
    for (const document of doc.tree.docs) {
        if (!document.root) continue;
        walkAll(document.root, node => {
            if (node.kind === 'scalar') {
                checkFileScalar(doc, environment, node as YScalar, diagnostics);
            } else if (node.kind === 'pair') {
                checkFilePair(doc, environment, node as YPair, diagnostics);
            }
        });
    }
}

function checkFileScalar(doc: StateDoc, environment: string, scalar: YScalar, diagnostics: EngineDiagnostic[]): void {
    const sequence = scalar.parent;
    const owner = sequence && sequence.kind === 'sequence' ? sequence.parent : null;
    if (!owner || owner.kind !== 'pair') return;
    const pair = owner as YPair;
    const a = ancestors(pair);
    const ownerOk =
        (pair.key === 'values' || pair.key === 'secrets' || pair.key === 'bases' || pair.key === 'helmfiles') &&
        (a.length === 0 || (a.length === 2 && (a[0] === 'releases' || a[0] === 'templates' || a[0] === 'environments')));
    if (!ownerOk) return;
    pushIfMissing(doc, environment, scalar, pair.key === 'helmfiles' ? 'Helmfile state' : 'Values', diagnostics);
}

function checkFilePair(doc: StateDoc, environment: string, pair: YPair, diagnostics: EngineDiagnostic[]): void {
    // `helmfiles:` entries of mapping form carry the path in a `path:` pair.
    if (pair.key !== 'path' || !pair.value || pair.value.kind !== 'scalar') return;
    if (ancestors(pair).join('\u001f') !== 'helmfiles') return;
    pushIfMissing(doc, environment, pair.value as YScalar, 'Helmfile state', diagnostics);
}

function pushIfMissing(doc: StateDoc, environment: string, scalar: YScalar, label: string, diagnostics: EngineDiagnostic[]): void {
    let raw = scalarPathText(scalar);
    if (!raw || raw.includes('{{') || raw.includes('://') || raw.includes('*') || raw.includes('?') || raw.includes('[')) return;
    raw = raw.replace(ENV_NAME, environment);
    if (raw.includes('{{')) return;
    const base = raw.startsWith('/') ? raw : path.join(path.dirname(doc.file), raw);
    if (fs.existsSync(base)) return;
    diagnostics.push(diagnosticAt(doc, scalar.start, scalar.end, `${label} file does not exist: ${raw}`, 'warning', undefined, { kind: 'missingFile', file: base }));
}

/* ---------------- chart template checks ---------------- */

const INCLUDE_NAME = /\b(?:include|template)\s+"((?:[^"\\]|\\.)*)"/g;

/** Warn about `include "x"` / `template "x"` calls with no matching `define`. */
function missingDefineDiagnostics(file: string, text: string, context: ChartTemplateContext, diagnostics: EngineDiagnostic[]): void {
    const defines = new Set(chartDefinesFor(context, contentStamp(), { file, text }).map(define => define.name));
    const warned = new Set<string>();
    for (const action of TemplateScanner.scan(text)) {
        if (!action.closed) continue; // still being typed
        const body = text.slice(action.bodyStart, action.bodyEnd);
        INCLUDE_NAME.lastIndex = 0;
        for (const match of body.matchAll(INCLUDE_NAME)) {
            const name = match[1];
            if (name.length === 0 || defines.has(name) || warned.has(name)) continue;
            warned.add(name);
            const literalStart = action.bodyStart + (match.index ?? 0) + match[0].indexOf('"');
            diagnostics.push(
                diagnostic(text, literalStart, literalStart + name.length + 2, `Named template "${name}" is not defined in this chart`, 'warning', undefined,
                    { kind: 'missingDefine', name, helpers: path.join(context.root, 'templates', '_helpers.tpl') }),
            );
        }
    }
}

const SCHEMA_VALUE_PATH = /\$?\.Values((?:\.[A-Za-z0-9_]+)+)/g;

/**
 * Warn about `.Values.x.y` references that a strict values.schema.json
 * (`additionalProperties: false` at the parent) does not declare — helm
 * rejects those at install time. Explicit `.Values` paths only; relative
 * paths inside `range`/`with` are not schema-checked.
 */
function schemaUnknownKeyDiagnostics(file: string, text: string, context: ChartTemplateContext, diagnostics: EngineDiagnostic[]): void {
    const schemaFile = path.join(context.root, 'values.schema.json');
    if (!fs.existsSync(schemaFile)) return;
    const model = chartModelFor(context, contentStamp(), 'default');
    const warned = new Set<string>();
    for (const action of TemplateScanner.scan(text)) {
        if (!action.closed) continue; // still being typed
        const body = text.slice(action.bodyStart, action.bodyEnd);
        for (const match of body.matchAll(SCHEMA_VALUE_PATH)) {
            const segments = match[1].slice(1).split('.');
            const dotted = segments.join('.');
            if (warned.has(dotted)) continue;
            const reason = model.schemaRejects(segments);
            if (!reason) continue;
            warned.add(dotted);
            const start = action.bodyStart + (match.index ?? 0);
            const kind = model.valueAt(segments)?.kind;
            diagnostics.push(
                diagnostic(text, start, start + match[0].length, reason, 'warning', undefined,
                    { kind: 'schemaKey', segments, schemaFile, valuesFile: path.join(context.root, 'values.yaml'), type: kind === 'map' ? 'object' : kind === 'list' ? 'array' : 'string' }),
            );
        }
    }
}

/**
 * `$variable` scoping across the document: uses of never-declared names and
 * assignments to undeclared names. Go template scoping — `range`/`with`/
 * `define`/`block` open scopes, `if` does not, `define`/`block` bodies start
 * fresh — so `{{ range $i, $v := . }}{{ $v }}{{ end }}` is clean while
 * `{{ $missing }}` flags.
 */
function variableScopeDiagnostics(text: string, diagnostics: EngineDiagnostic[]): void {
    for (const issue of variableScopeIssues(text)) {
        diagnostics.push(diagnostic(text, issue.start, issue.end, issue.message, 'warning'));
    }
}

/**
 * `{{ define "name" }}` declared more than once in the same chart. Helm
 * silently uses the last one — almost always a copy-paste accident worth
 * a warning.
 */
function duplicateDefineDiagnostics(file: string, text: string, context: ChartTemplateContext, diagnostics: EngineDiagnostic[]): void {
    const defines = [...chartDefinesFor(context, contentStamp(), { file, text })]
        .sort((a, b) => (a.file === b.file ? a.start - b.start : a.file.localeCompare(b.file)));
    const seen = new Map<string, { file: string; start: number }>();
    for (const define of defines) {
        const first = seen.get(define.name);
        if (!first) {
            seen.set(define.name, define);
            continue;
        }
        if (define.file !== file) continue; // reported in its own buffer
        const where = first.file === file
            ? 'earlier in this file'
            : `templates/${path.relative(path.join(context.root, 'templates'), first.file)}`;
        const header = text.slice(define.start);
        const literal = header.indexOf(`"${define.name}"`);
        const start = literal > 0 ? define.start + literal + 1 : define.start;
        diagnostics.push(diagnostic(text, start, start + define.name.length, `Duplicate define "${define.name}": also defined ${where}`, 'warning'));
    }
}

/* ---------------- Chart.yaml dependency diagnostics ---------------- */

const CHART_MANIFEST_NAME = /^Chart\.ya?ml$/i;

export function isChartManifestName(name: string): boolean {
    return CHART_MANIFEST_NAME.test(name);
}

interface VendoredDependency {
    /** Version found in the vendored copy, when known. */
    readonly version: string | null;
}

/** Version-looking archive suffix: `1.0.0`, `2.31.0-debian-12-r6`, `0.1.0-bb.0` — not `pushgateway-1.0.0`. */
const ARCHIVE_VERSION = /^v?\d+(?:[.\-+][\w.-]+)*$/;

/** charts/<name>/ directory (with its own Chart.yaml) or a charts/<name>-<version>.tgz archive. */
function vendoredDependency(chartsDir: string, name: string, version: string, archives: () => string[]): VendoredDependency | null {
    // Chart names never hold path separators or `.`/`..` — refuse them so the
    // charts/<name> join cannot resolve outside the chart.
    if (name === '.' || name === '..' || /[/\\]/.test(name)) return null;
    const dir = path.join(chartsDir, name);
    if (fs.existsSync(path.join(dir, 'Chart.yaml')) || fs.existsSync(path.join(dir, 'Chart.yml'))) {
        try {
            const manifest = parseTree(fs.readFileSync(fs.existsSync(path.join(dir, 'Chart.yaml')) ? path.join(dir, 'Chart.yaml') : path.join(dir, 'Chart.yml'), 'utf8'));
            const versionPair = rootMappings(manifest).map(root => mappingGet(root, 'version'))[0];
            const vendoredVersion = versionPair?.value?.kind === 'scalar' ? scalarPathText(versionPair.value).trim() : '';
            return { version: vendoredVersion || null };
        } catch {
            return { version: null };
        }
    }
    if (version) {
        const exact = `${name}-${version}.tgz`;
        if (archives().includes(exact)) return { version };
    }
    const prefix = `${name}-`;
    // Archive names are `<chart>-<version>.tgz` and chart names may contain
    // dashes themselves, so only accept a version-looking suffix — `foo-`
    // must not match `foo-bar-1.0.0.tgz` (a different chart's archive).
    const loose = archives().find(archive => {
        if (!archive.startsWith(prefix)) return false;
        return ARCHIVE_VERSION.test(archive.slice(prefix.length).replace(/\.tgz$/, ''));
    });
    if (loose) {
        const looseVersion = loose.slice(prefix.length).replace(/\.tgz$/, '');
        return { version: looseVersion || null };
    }
    return null;
}

/**
 * `dependencies:` sanity for Chart.yaml: every entry either declares a
 * repository (fetchable) or is vendored under charts/, and a pinned version
 * matches the vendored copy.
 */
export function chartYamlDependencyDiagnostics(file: string, text: string, diagnostics: EngineDiagnostic[]): void {
    const tree = parseTree(text);
    const depsPair = rootMappings(tree).map(root => mappingGet(root, 'dependencies')).find(pair => pair?.value?.kind === 'sequence');
    if (!depsPair || depsPair.value?.kind !== 'sequence') return;
    const chartsDir = path.join(path.dirname(file), 'charts');
    let cachedArchives: string[] | null = null;
    const archives = (): string[] => {
        if (cachedArchives === null) {
            try {
                cachedArchives = fs.readdirSync(chartsDir).filter(archive => archive.endsWith('.tgz'));
            } catch {
                cachedArchives = [];
            }
        }
        return cachedArchives;
    };
    for (const item of depsPair.value.items) {
        if (item.kind !== 'mapping') continue;
        const namePair = mappingGet(item, 'name');
        const name = namePair?.value?.kind === 'scalar' ? scalarPathText(namePair.value).trim() : '';
        if (!name) continue;
        if (name.includes('{{')) continue; // templated name — cannot resolve the vendored copy
        const scalarOf = (key: string): string => {
            const pair = mappingGet(item, key);
            return pair?.value?.kind === 'scalar' ? scalarPathText(pair.value).trim() : '';
        };
        const version = scalarOf('version');
        const repository = scalarOf('repository');
        const start = namePair?.value?.start ?? item.start;
        const end = namePair?.value?.end ?? item.end;
        const vendored = vendoredDependency(chartsDir, name, version, archives);
        if (!vendored && !repository) {
            diagnostics.push(diagnostic(text, start, end, `Dependency "${name}" declares no repository and is not vendored under charts/ — run helm dependency update`, 'error'));
            continue;
        }
        if (!vendored) {
            diagnostics.push(diagnostic(text, start, end, `Dependency "${name}" is not vendored under charts/ yet — run helm dependency build`, 'information'));
            continue;
        }
        if (version && !version.includes('{{') && vendored.version && vendored.version !== version) {
            diagnostics.push(diagnostic(text, start, end, `Dependency "${name}" pins ${version} but the vendored copy has ${vendored.version} — run helm dependency update`, 'warning'));
        }
    }
}

/* ---------------- unused define diagnostics ---------------- */

function isLibraryChart(root: string): boolean {
    for (const name of ['Chart.yaml', 'Chart.yml']) {
        const file = path.join(root, name);
        if (!fs.existsSync(file)) continue;
        try {
            const manifest = parseTree(fs.readFileSync(file, 'utf8'));
            const typePair = rootMappings(manifest).map(mapping => mappingGet(mapping, 'type'))[0];
            return typePair?.value?.kind === 'scalar' && scalarPathText(typePair.value).trim() === 'library';
        } catch {
            return false; // unreadable manifest — treat as an application chart
        }
    }
    return false;
}

/**
 * `{{ define }}` blocks no include/template call in the chart references.
 * Library charts publish their defines for other charts, so they are exempt.
 */
export function unusedDefineDiagnostics(file: string, text: string, context: ChartTemplateContext, diagnostics: EngineDiagnostic[]): void {
    if (isLibraryChart(context.root)) return;
    const current = { file, text };
    const stamp = contentStamp();
    const used = new Set(chartCallsFor(context, stamp, current).map(call => call.name));
    const warned = new Set<string>();
    for (const define of chartDefinesFor(context, stamp, current)) {
        if (define.file !== file || used.has(define.name) || warned.has(define.name)) continue;
        warned.add(define.name);
        const header = text.slice(define.start);
        const literal = header.indexOf(`"${define.name}"`);
        if (literal < 0) continue;
        const start = define.start + literal + 1;
        diagnostics.push(
            diagnostic(text, start, start + define.name.length, `Define "${define.name}" is never used in this chart`, 'information', undefined,
                { kind: 'unusedDefine', name: define.name, start: define.start, end: define.end }),
        );
    }
}

/* ---------------- local helpers ---------------- */

function diagnosticAt(doc: StateDoc, start: number, end: number, message: string, severity: Severity, code?: string, payload?: DiagnosticPayload): EngineDiagnostic {
    return diagnostic(doc.text, start, end, message, severity, code, payload);
}

function valueStart(doc: StateDoc, pair: YPair): number {
    if (!pair.value) return pair.keyEnd;
    const quote = pair.value.start > 0 && (doc.text[pair.value.start - 1] === '"' || doc.text[pair.value.start - 1] === "'");
    return pair.value.start + (quote ? 1 : 0);
}
