/**
 * Diagnostics: port of HelmfileRepositoryInspection (repository health,
 * undeclared aliases, missing charts/versions) plus the HelmfileAnnotator's
 * unclosed Go template action warning.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateScanner, fillMaskedTemplateKeys, type TemplateAction } from './templateScanner';
import { chartFileOf, chartTemplateContextFor, chartTemplateDetected, type ChartTemplateContext } from './chartContext';
import { chartCallsFor, chartDefinesFor } from './chartDefines';
import { conditionalSpans, variableScopeIssues } from './chartIteration';
import { chartModelFor } from './chartModel';
import { mappingGet, parseTree, rootMappings, scalarPathText, walkAll, type YPair, type YScalar, type YTree } from './yamlTree';
import { contentStamp, isHelmfileName, type SourceFile } from './values';
import { offsetRange } from './position';
import { alias, chart as chartOf, downloadable, namedMap, repositoryModel, value, query as repositoryQuery, isChartField } from './repositories';
import { repositoryService } from './repositoryService';
import { EnvironmentService, repositoryDownloadsEnabled } from './settings';
import { ancestors } from './yamlTree';
import { schemaContext, schemaFields } from './schema';

export const HELMFILE_DIAGNOSTIC_SOURCE = 'helmfile';

/** Exact semver references checked against repository indexes. */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class HelmfileDiagnostics implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection;
    private readonly documents = new Set<vscode.Uri>();
    private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
    /** Debounce for keystroke-driven re-analysis (ms). */
    static readonly DEBOUNCE_MS = 150;

    constructor(private readonly env: EnvironmentService) {
        this.collection = vscode.languages.createDiagnosticCollection('helmfile');
    }

    track(document: vscode.TextDocument): void {
        const name = document.uri.path.split('/').pop() ?? '';
        if (document.languageId !== 'helmfile' && !isHelmfileName(name) && !isChartManifestName(name)) return;
        this.documents.add(document.uri);
        // Typing bursts re-parse YAML + repositories; debounce to keep edits smooth.
        const key = document.uri.toString();
        const timer = this.pending.get(key);
        if (timer) clearTimeout(timer);
        this.pending.set(key, setTimeout(() => {
            this.pending.delete(key);
            this.analyze(document);
        }, HelmfileDiagnostics.DEBOUNCE_MS));
    }

    /** Re-analyze every tracked document immediately (repository snapshots changed). */
    refreshAll(): void {
        for (const uri of this.documents) {
            const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
            if (document) {
                const timer = this.pending.get(uri.toString());
                if (timer) {
                    clearTimeout(timer);
                    this.pending.delete(uri.toString());
                }
                this.analyze(document);
            }
        }
    }

    analyze(document: vscode.TextDocument): void {
        const text = document.getText();
        const diagnostics: vscode.Diagnostic[] = [];
        // Chart.yaml is a plain YAML manifest: syntax check plus dependency
        // sanity, never Helm template rules.
        if (isChartManifestName(path.basename(document.uri.fsPath))) {
            yamlSyntaxErrors(document, diagnostics);
            chartYamlDependencyDiagnostics(document, diagnostics);
            this.collection.set(document.uri, diagnostics);
            return;
        }
        // Only YAML-like files get the YAML syntax check. `.tpl`, NOTES.txt
        // and bare `.gotmpl` files are Go template fragments, never parsed
        // as YAML by Helm either.
        if (/\.ya?ml(\.gotmpl)?$/i.test(document.uri.fsPath)) yamlSyntaxErrors(document, diagnostics);
        unclosedActions(text, diagnostics);
        templateBlocks(text, diagnostics);
        // Chart template files are Helm templates, not Helmfile state:
        // only template/YAML checks apply.
        if (chartTemplateDetected(chartFileOf(document.uri), contentStamp())) {
            const chartContext = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
            if (chartContext) {
                missingDefineDiagnostics(document, chartContext, diagnostics);
                schemaUnknownKeyDiagnostics(document, chartContext, diagnostics);
                variableScopeDiagnostics(document, diagnostics);
                duplicateDefineDiagnostics(document, chartContext, diagnostics);
                unusedDefineDiagnostics(document, chartContext, diagnostics);
            }
            this.collection.set(document.uri, diagnostics);
            return;
        }
        const source: SourceFile = { uri: document.uri, text, tree: parseTree(text) };
        repositoryDiagnostics(source, this.env.get(), diagnostics);
        unknownFieldDiagnostics(source, diagnostics);
        missingFileDiagnostics(source, this.env.get(), diagnostics);
        this.collection.set(document.uri, diagnostics);
    }

    forget(uri: vscode.Uri): void {
        const timer = this.pending.get(uri.toString());
        if (timer) {
            clearTimeout(timer);
            this.pending.delete(uri.toString());
        }
        this.documents.delete(uri);
        this.collection.delete(uri);
    }

    dispose(): void {
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        this.collection.dispose();
    }
}

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

export function unclosedActions(text: string, diagnostics: vscode.Diagnostic[]): void {
    const actions = TemplateScanner.scan(text);
    for (const action of actions) {
        if (!action.closed) {
            diagnostics.push(
                new vscode.Diagnostic(offsetRange(text, action.start, text.length), 'Unclosed Go template action: expected }}', vscode.DiagnosticSeverity.Warning),
            );
            continue;
        }
        // An auto-closed "{{}}" is a valid shape for the scanner but an empty
        // command for Go templates — helmfile fails to render it.
        const body = text.slice(action.bodyStart, action.bodyEnd).trim();
        if (body.length === 0) {
            diagnostics.push(
                new vscode.Diagnostic(offsetRange(text, action.start, action.end), 'Empty Go template action: nothing between {{ and }}', vscode.DiagnosticSeverity.Warning),
            );
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
        diagnostics.push(
            new vscode.Diagnostic(offsetRange(text, i, i + 2), 'Unmatched Go template closing: no matching {{', vscode.DiagnosticSeverity.Warning),
        );
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
export function templateBlocks(text: string, diagnostics: vscode.Diagnostic[]): void {
    const stack: { keyword: string; action: TemplateAction }[] = [];
    for (const action of TemplateScanner.scan(text)) {
        const body = text.slice(action.bodyStart, action.bodyEnd).trim();
        if (body.startsWith('/*')) continue; // comment action
        const head = body.split(/\s+/)[0] ?? '';
        if (BLOCK_KEYWORDS.has(head)) {
            stack.push({ keyword: head, action });
        } else if (head === 'end') {
            if (stack.length === 0) {
                diagnostics.push(
                    new vscode.Diagnostic(offsetRange(text, action.start, action.end), '{{ end }} without a matching {{ if }}, {{ range }}, {{ with }}, {{ define }} or {{ block }}', vscode.DiagnosticSeverity.Warning),
                );
            } else {
                stack.pop();
            }
        } else if (head === 'else') {
            const open = stack[stack.length - 1];
            if (!open || (open.keyword !== 'if' && open.keyword !== 'range' && open.keyword !== 'with')) {
                diagnostics.push(
                    new vscode.Diagnostic(offsetRange(text, action.start, action.end), '{{ else }} outside of an {{ if }}, {{ range }} or {{ with }} block', vscode.DiagnosticSeverity.Warning),
                );
            }
            // `else if ...` reuses the enclosing block's {{ end }} — depth stays.
        }
    }
    for (const open of stack) {
        // A block whose opening action itself never closed is already reported
        // by the unclosed-action warning; don't double-report it.
        if (!open.action.closed) continue;
        diagnostics.push(
            new vscode.Diagnostic(offsetRange(text, open.action.start, open.action.end), `Unclosed Go template block {{ ${open.keyword} }}: expected {{ end }}`, vscode.DiagnosticSeverity.Warning),
        );
    }
}


/**
 * Genuine YAML syntax errors, reported as red squiggles. The document is
 * parsed with Go template actions masked out (equal-length spaces), so
 * valid `{{ ... }}` blocks are not misread as YAML flow mappings; keys
 * produced by whole-template actions are filled to stay valid.
 */
function yamlSyntaxErrors(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): void {
    const text = document.getText();
    const masked = fillMaskedTemplateKeys(TemplateScanner.maskForYaml(text));
    const tree = parseTree(masked);
    duplicateKeyDiagnostics(document, text, tree, diagnostics);
    for (const error of tree.errors) {
        // Duplicate keys get a dedicated, named diagnostic below.
        if (error.message.includes('Map keys must be unique')) continue;
        const start = Math.min(Math.max(0, error.offset), masked.length);
        const end = Math.min(Math.max(start + 1, error.end), masked.length);
        diagnostics.push(
            new vscode.Diagnostic(new vscode.Range(document.positionAt(start), document.positionAt(end)), error.message, vscode.DiagnosticSeverity.Error),
        );
    }
}

/**
 * Named duplicate-key diagnostics: `repository:` twice in one mapping is a
 * real post-render defect (the first write is silently dropped), but the
 * parser's own "Map keys must be unique at line/column" message points at
 * the wrong place and never names the key. Keys produced by template
 * actions (`{{ $key }}:`) are skipped — their rendered value is unknowable.
 */
function duplicateKeyDiagnostics(document: vscode.TextDocument, text: string, tree: YTree, diagnostics: vscode.Diagnostic[]): void {
    const conditional = conditionalSpans(text);
    const insideConditional = (offset: number): boolean => conditional.some(span => offset >= span.start && offset <= span.end);
    for (const doc of tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
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
                    new vscode.Diagnostic(
                        new vscode.Range(document.positionAt(pair.keyStart), document.positionAt(pair.keyEnd)),
                        `Duplicate map key "${pair.key}" — already set at line ${document.positionAt(first.offset).line + 1}`,
                        vscode.DiagnosticSeverity.Error,
                    ),
                );
            }
        });
    }
}

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

export function repositoryDiagnostics(source: SourceFile, environment: string, diagnostics: vscode.Diagnostic[]): void {
    const model = repositoryModel(source.uri, environment);
    const named = new Map(namedMap(model.entries).map(repository => [repository.name, repository]));

    // Declaration-level problems for repositories declared in this file.
    for (const doc of source.tree.docs) {
        const sequence = mappingGet(doc.root ?? null, 'repositories')?.value;
        if (!sequence || sequence.kind !== 'sequence') continue;
        for (const item of sequence.items) {
            if (!item || item.kind !== 'mapping') continue;
            const name = value(source, item, 'name');
            const url = value(source, item, 'url');
            const namePair = item.pairs.find(pair => pair.key === 'name') ?? null;
            const urlPair = item.pairs.find(pair => pair.key === 'url') ?? null;
            if (!name) {
                diagnostics.push(diagnosticAt(source, item.start, item.end, 'Helm repository requires a name', vscode.DiagnosticSeverity.Warning));
            } else if (!name.includes('{{') && name.includes('/')) {
                diagnostics.push(diagnosticAt(source, namePair?.keyStart ?? item.start, namePair?.keyEnd ?? item.end, "Repository name must not contain '/'", vscode.DiagnosticSeverity.Warning));
            }
            if (!url) {
                diagnostics.push(diagnosticAt(source, urlPair?.keyStart ?? item.start, urlPair?.keyEnd ?? item.end, 'Helm repository requires a URL', vscode.DiagnosticSeverity.Warning));
            }
            if (!name || name.includes('{{')) continue;
            if (model.entries.filter(entry => entry.name === name).length > 1) {
                const start = namePair?.value ? namePair.value.start : namePair?.keyStart ?? item.start;
                const end = namePair?.value ? namePair.value.end : namePair?.keyEnd ?? item.end;
                diagnostics.push(diagnosticAt(source, start, end, `Duplicate Helm repository name '${name}'`, vscode.DiagnosticSeverity.Warning));
            }
            if (url && !url.includes('{{') && urlPair && invalidRepositoryUrl(url)) {
                diagnostics.push(diagnosticAt(source, urlPair.keyStart, urlPair.keyEnd, 'Invalid Helm repository URL', vscode.DiagnosticSeverity.Warning));
            }
            const repository = named.get(name);
            if (repository && downloadable(repository.access) && urlPair) {
                const snapshot = repositoryService().snapshot({ access: repository.access, chart: '' }, false);
                if (snapshot.error) {
                    const diagnostic = diagnosticAt(source, urlPair.keyStart, urlPair.keyEnd, snapshot.error, vscode.DiagnosticSeverity.Information);
                    diagnostic.code = 'helmfile.refreshRepositories';
                    diagnostics.push(diagnostic);
                }
            }
        }
    }

    if (model.incomplete) return;

    // chart / version problems against loaded indexes.
    for (const doc of source.tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            if (!isChartField(pair, 'chart') && !isChartField(pair, 'version')) return;
            if (pair.value && pair.value.kind !== 'scalar') return;
            if (isChartField(pair, 'chart')) {
                checkChart(source, pair, named, environment, diagnostics);
            } else {
                checkVersion(source, pair, environment, diagnostics);
            }
        });
    }
}

function checkChart(
    source: SourceFile,
    pair: YPair,
    named: Map<string, unknown>,
    environment: string,
    diagnostics: vscode.Diagnostic[],
): void {
    const chart = scalarPathText(pair.value);
    if (!chart || chart.endsWith('/') || chart.includes('{{')) return;
    const model = repositoryModel(source.uri, environment);
    const chartAlias = alias(source.uri, chart);
    if (chartAlias && !named.has(chartAlias) && !model.incomplete) {
        diagnostics.push(
            diagnosticAt(
                source,
                valueStart(source, pair),
                valueStart(source, pair) + chart.length,
                `Repository '${chartAlias}' is not declared in this Helmfile or its bases`,
                vscode.DiagnosticSeverity.Warning,
            ),
        );
        return;
    }
    const request = repositoryQuery(source.uri, chart, environment);
    if (!request) return;
    const snapshot = repositoryService().snapshot(request, repositoryDownloadsEnabled());
    if (!snapshot.index) return;
    const name = request.access.oci ? request.chart : chart.slice(chart.indexOf('/') + 1);
    if (name && !snapshot.index.charts.has(name)) {
        const diagnostic = diagnosticAt(
            source,
            valueStart(source, pair),
            valueStart(source, pair) + chart.length,
            `Chart '${name}' was not found in repository '${request.access.name}'`,
            vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.code = 'helmfile.refreshRepositories';
        diagnostics.push(diagnostic);
    }
}

function checkVersion(source: SourceFile, pair: YPair, environment: string, diagnostics: vscode.Diagnostic[]): void {
    const version = scalarPathText(pair.value);
    // A Helm constraint such as ~1, ^2.0, 1.x, or >=1.0.0 is not an exact pin.
    if (!version || !EXACT_VERSION.test(version)) return;
    // Find the enclosing item mapping and resolve its chart (inherit included).
    const mapping = pair.parent;
    if (!mapping || mapping.kind !== 'mapping') return;
    const chart = chartOf(source, mapping, environment, new Set());
    if (!chart || chart.includes('{{') || !chart.includes('/')) return;
    const request = repositoryQuery(source.uri, chart, environment);
    if (!request) return;
    const snapshot = repositoryService().snapshot(request, repositoryDownloadsEnabled());
    if (!snapshot.index) return;
    const name = request.access.oci ? request.chart : chart.slice(chart.indexOf('/') + 1);
    if (snapshot.index.charts.has(name) && !snapshot.index.containsVersion(name, version)) {
        const diagnostic = diagnosticAt(
            source,
            valueStart(source, pair),
            valueStart(source, pair) + version.length,
            `Version '${version}' was not found for chart '${chart}'`,
            vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.code = 'helmfile.refreshRepositories';
        diagnostics.push(diagnostic);
        return;
    }
    const entries = snapshot.index.charts.get(name);
    if (!entries || entries.length === 0) return;
    const candidate = entries.find(entry => !entry.deprecated) ?? entries[0];
    if (!candidate || candidate.version === version) return;
    const diagnostic = diagnosticAt(
        source,
        valueStart(source, pair),
        valueStart(source, pair) + version.length,
        `Version '${version}' is outdated: ${chart} ${candidate.version} is available`,
        vscode.DiagnosticSeverity.Information,
    );
    diagnostic.code = 'helmfile.updateVersion';
    outdatedVersions.set(diagnostic, candidate.version);
    diagnostics.push(diagnostic);
}

/** Side table for the update-version quick fix: diagnostic → latest version. */
export const outdatedVersions = new WeakMap<vscode.Diagnostic, string>();

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

/** Side table for the remove-field quick fix: diagnostic → pair span. */
export const unknownFields = new WeakMap<vscode.Diagnostic, { start: number; end: number }>();

/**
 * Unknown-field warnings for contexts the Helmfile schema fully describes
 * (helmfile strict-decodes release/repository entries, so a typo like
 * `insatlled:` fails at run time). Root-level keys stay unchecked: the
 * state format allows more top-level keys than the completion schema lists.
 */
export function unknownFieldDiagnostics(source: SourceFile, diagnostics: vscode.Diagnostic[]): void {
    for (const doc of source.tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            const key = pair.key;
            if (!key || key.includes('{{')) return;
            const path = ancestors(pair);
            const context = schemaContext(path);
            if (!STRICT_CONTEXTS.has(context)) return;
            if (knownFields(context).has(key)) return;
            const diagnostic = diagnosticAt(source, pair.keyStart, pair.keyEnd, `Unknown field '${key}' in ${context}`, vscode.DiagnosticSeverity.Warning);
            unknownFields.set(diagnostic, { start: pair.start, end: pair.end });
            diagnostics.push(diagnostic);
        });
    }
}

/** Side table for the create-file quick fix: diagnostic → absolute path. */
export const missingFiles = new WeakMap<vscode.Diagnostic, string>();

const ENV_NAME = /\{\{-?\s*\.Environment\.Name\s*-?\}\}/;


/**
 * Warn when a values/secrets/bases/helmfiles entry points at a file that
 * does not exist on disk. Templated paths and globs are skipped: they only
 * resolve at render time.
 */
export function missingFileDiagnostics(source: SourceFile, environment: string, diagnostics: vscode.Diagnostic[]): void {
    for (const doc of source.tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind === 'scalar') {
                checkFileScalar(source, environment, node as YScalar, diagnostics);
            } else if (node.kind === 'pair') {
                checkFilePair(source, environment, node as YPair, diagnostics);
            }
        });
    }
}

function checkFileScalar(source: SourceFile, environment: string, scalar: YScalar, diagnostics: vscode.Diagnostic[]): void {
    const sequence = scalar.parent;
    const owner = sequence && sequence.kind === 'sequence' ? sequence.parent : null;
    if (!owner || owner.kind !== 'pair') return;
    const pair = owner as YPair;
    const a = ancestors(pair);
    const ownerOk =
        (pair.key === 'values' || pair.key === 'secrets' || pair.key === 'bases' || pair.key === 'helmfiles') &&
        (a.length === 0 || (a.length === 2 && (a[0] === 'releases' || a[0] === 'templates' || a[0] === 'environments')));
    if (!ownerOk) return;
    pushIfMissing(source, environment, scalar, pair.key === 'helmfiles' ? 'Helmfile state' : 'Values', diagnostics);
}

function checkFilePair(source: SourceFile, environment: string, pair: YPair, diagnostics: vscode.Diagnostic[]): void {
    // `helmfiles:` entries of mapping form carry the path in a `path:` pair.
    if (pair.key !== 'path' || !pair.value || pair.value.kind !== 'scalar') return;
    if (ancestors(pair).join('\u001f') !== 'helmfiles') return;
    pushIfMissing(source, environment, pair.value as YScalar, 'Helmfile state', diagnostics);
}

function pushIfMissing(source: SourceFile, environment: string, scalar: YScalar, label: string, diagnostics: vscode.Diagnostic[]): void {
    let raw = scalarPathText(scalar);
    if (!raw || raw.includes('{{') || raw.includes('://') || raw.includes('*') || raw.includes('?') || raw.includes('[')) return;
    raw = raw.replace(ENV_NAME, environment);
    if (raw.includes('{{')) return;
    const base = raw.startsWith('/') ? raw : path.join(path.dirname(source.uri.fsPath), raw);
    if (fs.existsSync(base)) return;
    const diagnostic = diagnosticAt(source, scalar.start, scalar.end, `${label} file does not exist: ${raw}`, vscode.DiagnosticSeverity.Warning);
    missingFiles.set(diagnostic, base);
    diagnostics.push(diagnostic);
}

function valueStart(source: SourceFile, pair: YPair): number {
    if (!pair.value) return pair.keyEnd;
    const quote = pair.value.start > 0 && (source.text[pair.value.start - 1] === '"' || source.text[pair.value.start - 1] === "'");
    return pair.value.start + (quote ? 1 : 0);
}

function diagnosticAt(source: SourceFile, start: number, end: number, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(offsetRange(source.text, start, end), message, severity);
    diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
    return diagnostic;
}

/** Quick-fix payload for missing-define diagnostics: define name + helpers file. */
export const missingChartDefines = new WeakMap<vscode.Diagnostic, { name: string; helpers: string }>();

/** Quick-fix payload for schema-unknown-key diagnostics: dotted path + schema file + JSON type to declare. */
export const schemaUnknownKeys = new WeakMap<vscode.Diagnostic, { segments: string[]; schemaFile: string; valuesFile: string; type: string }>();

const INCLUDE_NAME = /\b(?:include|template)\s+"((?:[^"\\]|\\.)*)"/g;

/** Warn about `include "x"` / `template "x"` calls with no matching `define`. */
function missingDefineDiagnostics(document: vscode.TextDocument, context: ChartTemplateContext, diagnostics: vscode.Diagnostic[]): void {
    const text = document.getText();
    const defines = new Set(chartDefinesFor(context, contentStamp(), { file: document.uri.fsPath, text }).map(define => define.name));
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
            const diagnostic = new vscode.Diagnostic(
                offsetRange(text, literalStart, literalStart + name.length + 2),
                `Named template "${name}" is not defined in this chart`,
                vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
            missingChartDefines.set(diagnostic, { name, helpers: path.join(context.root, 'templates', '_helpers.tpl') });
            diagnostics.push(diagnostic);
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
function schemaUnknownKeyDiagnostics(document: vscode.TextDocument, context: ChartTemplateContext, diagnostics: vscode.Diagnostic[]): void {
    const schemaFile = path.join(context.root, 'values.schema.json');
    if (!fs.existsSync(schemaFile)) return;
    const text = document.getText();
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
            const diagnostic = new vscode.Diagnostic(offsetRange(text, start, start + match[0].length), reason, vscode.DiagnosticSeverity.Warning);
            diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
            const kind = model.valueAt(segments)?.kind;
            schemaUnknownKeys.set(diagnostic, { segments, schemaFile, valuesFile: path.join(context.root, 'values.yaml'), type: kind === 'map' ? 'object' : kind === 'list' ? 'array' : 'string' });
            diagnostics.push(diagnostic);
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
function variableScopeDiagnostics(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): void {
    const text = document.getText();
    for (const issue of variableScopeIssues(text)) {
        const diagnostic = new vscode.Diagnostic(offsetRange(text, issue.start, issue.end), issue.message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
        diagnostics.push(diagnostic);
    }
}

/**
 * `{{ define "name" }}` declared more than once in the same chart. Helm
 * silently uses the last one — almost always a copy-paste accident worth
 * a warning.
 */
function duplicateDefineDiagnostics(document: vscode.TextDocument, context: ChartTemplateContext, diagnostics: vscode.Diagnostic[]): void {
    const text = document.getText();
    const defines = [...chartDefinesFor(context, contentStamp(), { file: document.uri.fsPath, text })]
        .sort((a, b) => (a.file === b.file ? a.start - b.start : a.file.localeCompare(b.file)));
    const seen = new Map<string, { file: string; start: number }>();
    for (const define of defines) {
        const first = seen.get(define.name);
        if (!first) {
            seen.set(define.name, define);
            continue;
        }
        if (define.file !== document.uri.fsPath) continue; // reported in its own buffer
        const where = first.file === document.uri.fsPath
            ? 'earlier in this file'
            : `templates/${path.relative(path.join(context.root, 'templates'), first.file)}`;
        const header = text.slice(define.start);
        const literal = header.indexOf(`"${define.name}"`);
        const start = literal > 0 ? define.start + literal + 1 : define.start;
        const diagnostic = new vscode.Diagnostic(offsetRange(text, start, start + define.name.length), `Duplicate define "${define.name}": also defined ${where}`, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
        diagnostics.push(diagnostic);
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

/** charts/<name>/ directory (with its own Chart.yaml) or a charts/<name>-<version>.tgz archive. */
function vendoredDependency(chartsDir: string, name: string, version: string, archives: () => string[]): VendoredDependency | null {
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
    const loose = archives().find(archive => archive.startsWith(prefix));
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
export function chartYamlDependencyDiagnostics(document: vscode.TextDocument, diagnostics: vscode.Diagnostic[]): void {
    const text = document.getText();
    const tree = parseTree(text);
    const depsPair = rootMappings(tree).map(root => mappingGet(root, 'dependencies')).find(pair => pair?.value?.kind === 'sequence');
    if (!depsPair || depsPair.value?.kind !== 'sequence') return;
    const chartsDir = path.join(path.dirname(document.uri.fsPath), 'charts');
    let cachedArchives: string[] | null = null;
    const archives = (): string[] => {
        if (cachedArchives === null) {
            try {
                cachedArchives = fs.readdirSync(chartsDir).filter(file => file.endsWith('.tgz'));
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
        const scalarOf = (key: string): string => {
            const pair = mappingGet(item, key);
            return pair?.value?.kind === 'scalar' ? scalarPathText(pair.value).trim() : '';
        };
        const version = scalarOf('version');
        const repository = scalarOf('repository');
        const start = namePair?.value?.start ?? item.start;
        const end = namePair?.value?.end ?? item.end;
        const range = offsetRange(text, start, end);
        const vendored = vendoredDependency(chartsDir, name, version, archives);
        if (!vendored && !repository) {
            const diagnostic = new vscode.Diagnostic(range, `Dependency "${name}" declares no repository and is not vendored under charts/ — run helm dependency update`, vscode.DiagnosticSeverity.Error);
            diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
            diagnostics.push(diagnostic);
            continue;
        }
        if (!vendored) {
            const diagnostic = new vscode.Diagnostic(range, `Dependency "${name}" is not vendored under charts/ yet — run helm dependency build`, vscode.DiagnosticSeverity.Information);
            diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
            diagnostics.push(diagnostic);
            continue;
        }
        if (version && vendored.version && vendored.version !== version) {
            const diagnostic = new vscode.Diagnostic(range, `Dependency "${name}" pins ${version} but the vendored copy has ${vendored.version} — run helm dependency update`, vscode.DiagnosticSeverity.Warning);
            diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
            diagnostics.push(diagnostic);
        }
    }
}

/* ---------------- unused define diagnostics ---------------- */

/** Quick-fix payload for unused defines: the whole define block to remove. */
export const unusedChartDefines = new WeakMap<vscode.Diagnostic, { readonly name: string; readonly start: number; readonly end: number }>();

function isLibraryChart(root: string): boolean {
    for (const name of ['Chart.yaml', 'Chart.yml']) {
        const file = path.join(root, name);
        if (!fs.existsSync(file)) continue;
        try {
            const manifest = parseTree(fs.readFileSync(file, 'utf8'));
            const typePair = rootMappings(manifest).map(root => mappingGet(root, 'type'))[0];
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
export function unusedDefineDiagnostics(document: vscode.TextDocument, context: ChartTemplateContext, diagnostics: vscode.Diagnostic[]): void {
    if (isLibraryChart(context.root)) return;
    const text = document.getText();
    const current = { file: document.uri.fsPath, text };
    const stamp = contentStamp();
    const used = new Set(chartCallsFor(context, stamp, current).map(call => call.name));
    const warned = new Set<string>();
    for (const define of chartDefinesFor(context, stamp, current)) {
        if (define.file !== document.uri.fsPath || used.has(define.name) || warned.has(define.name)) continue;
        warned.add(define.name);
        const header = text.slice(define.start);
        const literal = header.indexOf(`"${define.name}"`);
        if (literal < 0) continue;
        const start = define.start + literal + 1;
        const diagnostic = new vscode.Diagnostic(offsetRange(text, start, start + define.name.length), `Define "${define.name}" is never used in this chart`, vscode.DiagnosticSeverity.Information);
        diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
        unusedChartDefines.set(diagnostic, { name: define.name, start: define.start, end: define.end });
        diagnostics.push(diagnostic);
    }
}
