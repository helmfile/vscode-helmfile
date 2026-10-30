/**
 * Diagnostics: port of HelmfileRepositoryInspection (repository health,
 * undeclared aliases, missing charts/versions) plus the HelmfileAnnotator's
 * unclosed Go template action warning.
 */
import * as vscode from 'vscode';
import { TemplateScanner } from './templateScanner';
import { mappingGet, parseTree, scalarPathText, walkAll, type YPair } from './yamlTree';
import { isHelmfileName, type SourceFile } from './values';
import { alias, chart as chartOf, downloadable, namedMap, repositoryModel, value, query as repositoryQuery, isChartField } from './repositories';
import { repositoryService } from './repositoryService';
import { EnvironmentService, repositoryDownloadsEnabled } from './settings';

export const HELMFILE_DIAGNOSTIC_SOURCE = 'helmfile';

/** Exact semver references checked against repository indexes. */
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export class HelmfileDiagnostics implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection;
    private readonly documents = new Set<vscode.Uri>();

    constructor(private readonly env: EnvironmentService) {
        this.collection = vscode.languages.createDiagnosticCollection('helmfile');
    }

    track(document: vscode.TextDocument): void {
        if (document.languageId !== 'helmfile' && !isHelmfileName(document.uri.path.split('/').pop() ?? '')) return;
        this.documents.add(document.uri);
        this.analyze(document);
    }

    /** Re-analyze every tracked document (repository snapshots changed). */
    refreshAll(): void {
        for (const uri of this.documents) {
            const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
            if (document) this.analyze(document);
        }
    }

    analyze(document: vscode.TextDocument): void {
        const text = document.getText();
        const diagnostics: vscode.Diagnostic[] = [];
        unclosedActions(text, diagnostics);
        repositoryDiagnostics({ uri: document.uri, text, tree: parseTree(text) }, this.env.get(), diagnostics);
        this.collection.set(document.uri, diagnostics);
    }

    forget(uri: vscode.Uri): void {
        this.documents.delete(uri);
        this.collection.delete(uri);
    }

    dispose(): void {
        this.collection.dispose();
    }
}

function unclosedActions(text: string, diagnostics: vscode.Diagnostic[]): void {
    for (const action of TemplateScanner.scan(text)) {
        if (action.closed) continue;
        diagnostics.push(
            new vscode.Diagnostic(range(text, action.start, text.length), 'Unclosed Go template action: expected }}', vscode.DiagnosticSeverity.Warning),
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

function repositoryDiagnostics(source: SourceFile, environment: string, diagnostics: vscode.Diagnostic[]): void {
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
    }
}

function valueStart(source: SourceFile, pair: YPair): number {
    if (!pair.value) return pair.keyEnd;
    const quote = pair.value.start > 0 && (source.text[pair.value.start - 1] === '"' || source.text[pair.value.start - 1] === "'");
    return pair.value.start + (quote ? 1 : 0);
}

function diagnosticAt(source: SourceFile, start: number, end: number, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(range(source.text, start, end), message, severity);
    diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
    return diagnostic;
}

function range(text: string, start: number, end: number): vscode.Range {
    return new vscode.Range(position(text, start), position(text, end));
}

function position(text: string, offset: number): vscode.Position {
    let line = 0;
    let lastNewline = -1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') {
            line++;
            lastNewline = i;
        }
    }
    return new vscode.Position(line, offset - lastNewline - 1);
}
