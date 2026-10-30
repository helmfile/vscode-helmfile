/**
 * Diagnostics: port of HelmfileRepositoryInspection (repository health,
 * undeclared aliases, missing charts/versions) plus the HelmfileAnnotator's
 * unclosed Go template action warning.
 */
import * as vscode from 'vscode';
import { TemplateScanner } from './templateScanner';
import { mappingGet, parseTree, scalarPathText, walkAll, type YPair } from './yamlTree';
import { isHelmfileName, type SourceFile } from './values';
import { repositoryModel, query as repositoryQuery, isChartField } from './repositories';
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

function repositoryDiagnostics(source: SourceFile, environment: string, diagnostics: vscode.Diagnostic[]): void {
    const model = repositoryModel(source.uri, environment);
    const byName = new Map<string, { url: string; oci: boolean }>();
    for (const entry of model.entries) byName.set(entry.name, { url: entry.access.url, oci: entry.access.oci });

    // Declaration-level problems.
    const seen = new Set<string>();
    for (const entry of model.entries) {
        if (!entry.access.url) {
            diagnostics.push(diagnosticAt(source, entry.targetStart, entry.targetEnd, `Repository '${entry.name}' has no url`, vscode.DiagnosticSeverity.Warning));
        } else if (entry.access.url.includes('{{')) {
            // templated URLs cannot be validated
        } else if (!/^oci:\/\//.test(entry.access.url) && !/^https?:\/\/[^/]+/.test(entry.access.url)) {
            diagnostics.push(diagnosticAt(source, entry.targetStart, entry.targetEnd, `Repository '${entry.name}' URL has no host`, vscode.DiagnosticSeverity.Warning));
        }
        if (entry.name.includes('/')) {
            diagnostics.push(diagnosticAt(source, entry.targetStart, entry.targetEnd, `Repository name '${entry.name}' must not contain '/'`, vscode.DiagnosticSeverity.Warning));
        } else if (seen.has(entry.name)) {
            diagnostics.push(diagnosticAt(source, entry.targetStart, entry.targetEnd, `Duplicate repository '${entry.name}'`, vscode.DiagnosticSeverity.Warning));
        }
        seen.add(entry.name);
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
                checkChart(source, pair, byName, environment, diagnostics);
            } else {
                checkVersion(source, pair, environment, diagnostics);
            }
        });
    }
}

function checkChart(
    source: SourceFile,
    pair: YPair,
    byName: Map<string, { url: string; oci: boolean }>,
    environment: string,
    diagnostics: vscode.Diagnostic[],
): void {
    const chart = scalarPathText(pair.value);
    if (!chart || chart.includes('{{') || chart.includes('://') || chart.startsWith('.') || chart.startsWith('/')) return;
    const slash = chart.indexOf('/');
    if (slash <= 0) return; // local chart by name
    const aliasName = chart.slice(0, slash);
    if (!byName.has(aliasName)) {
        diagnostics.push(diagnosticAt(source, valueStart(source, pair), valueStart(source, pair) + aliasName.length, `Repository '${aliasName}' is not declared`, vscode.DiagnosticSeverity.Warning));
    }
    const request = repositoryQuery(source.uri, chart, environment);
    if (!request) return;
    const snapshot = repositoryService().snapshot(request, repositoryDownloadsEnabled());
    if (!snapshot.index) return;
    const name = request.chart;
    if (name && !snapshot.index.charts.has(name) && !request.access.oci) {
        diagnostics.push(diagnosticAt(source, valueStart(source, pair) + slash + 1, valueStart(source, pair) + chart.length, `Chart '${name}' is not available in repository '${aliasName}'`, vscode.DiagnosticSeverity.Warning));
    }
}

function checkVersion(source: SourceFile, pair: YPair, environment: string, diagnostics: vscode.Diagnostic[]): void {
    const version = scalarPathText(pair.value);
    if (!version || version.includes('{{') || !EXACT_VERSION.test(version)) return;
    // Find the enclosing item mapping and its chart field.
    const mapping = pair.parent;
    if (!mapping || mapping.kind !== 'mapping') return;
    const chartPair = mappingGet(mapping, 'chart');
    const chart = chartPair ? scalarPathText(chartPair.value) : '';
    if (!chart || chart.includes('{{') || !chart.includes('/')) return;
    const request = repositoryQuery(source.uri, chart, environment);
    if (!request || !request.chart) return;
    const snapshot = repositoryService().snapshot(request, repositoryDownloadsEnabled());
    if (!snapshot.index) return;
    if (!snapshot.index.containsVersion(request.chart, version)) {
        diagnostics.push(diagnosticAt(source, valueStart(source, pair), valueStart(source, pair) + version.length, `Version '${version}' of chart '${request.chart}' is not available`, vscode.DiagnosticSeverity.Warning));
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
