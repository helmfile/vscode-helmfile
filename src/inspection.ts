/**
 * Diagnostics: port of HelmfileRepositoryInspection (repository health,
 * undeclared aliases, missing charts/versions) plus the HelmfileAnnotator's
 * unclosed Go template action warning.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateScanner, fillMaskedTemplateKeys, type TemplateAction } from './templateScanner';
import { mappingGet, parseTree, scalarPathText, walkAll, type YPair, type YScalar } from './yamlTree';
import { isHelmfileName, type SourceFile } from './values';
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
        if (document.languageId !== 'helmfile' && !isHelmfileName(document.uri.path.split('/').pop() ?? '')) return;
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
        const source: SourceFile = { uri: document.uri, text, tree: parseTree(text) };
        yamlSyntaxErrors(document, diagnostics);
        unclosedActions(text, diagnostics);
        templateBlocks(text, diagnostics);
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
    let covered = 0;
    for (let i = 0; i + 1 < text.length; i++) {
        if (text[i] !== '}' || text[i + 1] !== '}') continue;
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
    const masked = fillMaskedTemplateKeys(TemplateScanner.mask(document.getText()));
    for (const error of parseTree(masked).errors) {
        const start = Math.min(Math.max(0, error.offset), masked.length);
        const end = Math.min(Math.max(start + 1, error.end), masked.length);
        diagnostics.push(
            new vscode.Diagnostic(new vscode.Range(document.positionAt(start), document.positionAt(end)), error.message, vscode.DiagnosticSeverity.Error),
        );
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
