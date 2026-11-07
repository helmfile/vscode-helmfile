/**
 * Diagnostics provider: debounce/tracking wiring plus conversion of the
 * neutral engine diagnostics (inspectionEngine.ts) into vscode.Diagnostic
 * objects, routing quick-fix payloads into the side tables codeActions.ts
 * consumes. All check logic lives in the engine.
 */
import * as vscode from 'vscode';
import { contentStamp, isHelmfileName, type SourceFile } from './values';
import { offsetRange } from './position';
import { alias, chart as chartOf, query as repositoryQuery, repositoryModel, value } from './repositories';
import { repositoryService } from './repositoryService';
import { EnvironmentService, repositoryDownloadsEnabled } from './settings';
import { chartFileOf, chartTemplateContextFor, chartTemplateDetected, type ChartTemplateContext } from './chartContext';
import {
    computeChartManifestDiagnostics,
    computeChartTemplateDiagnostics,
    computeStateDiagnostics,
    isChartManifestName,
    templateBlocks as engineTemplateBlocks,
    unclosedActions as engineUnclosedActions,
    chartYamlDependencyDiagnostics as engineChartYamlDependencyDiagnostics,
    repositoryDiagnostics as engineRepositoryDiagnostics,
    unknownFieldDiagnostics as engineUnknownFieldDiagnostics,
    missingFileDiagnostics as engineMissingFileDiagnostics,
    unusedDefineDiagnostics as engineUnusedDefineDiagnostics,
    type EngineDiagnostic,
    type InspectionDeps,
} from './inspectionEngine';

export { isChartManifestName } from './inspectionEngine';

export const HELMFILE_DIAGNOSTIC_SOURCE = 'helmfile';

/** Side table for the update-version quick fix: diagnostic → latest version. */
export const outdatedVersions = new WeakMap<vscode.Diagnostic, string>();

/** Side table for the remove-field quick fix: diagnostic → pair span. */
export const unknownFields = new WeakMap<vscode.Diagnostic, { start: number; end: number }>();

/** Side table for the create-file quick fix: diagnostic → absolute path. */
export const missingFiles = new WeakMap<vscode.Diagnostic, string>();

/** Quick-fix payload for missing-define diagnostics: define name + helpers file. */
export const missingChartDefines = new WeakMap<vscode.Diagnostic, { name: string; helpers: string }>();

/** Quick-fix payload for schema-unknown-key diagnostics: dotted path + schema file + JSON type to declare. */
export const schemaUnknownKeys = new WeakMap<vscode.Diagnostic, { segments: string[]; schemaFile: string; valuesFile: string; type: string }>();

/** Quick-fix payload for unused defines: the whole define block to remove. */
export const unusedChartDefines = new WeakMap<vscode.Diagnostic, { readonly name: string; readonly start: number; readonly end: number }>();

const SEVERITY: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

/** Engine diagnostic → vscode diagnostic, filling the quick-fix side tables. */
function toVscodeDiagnostic(text: string, engine: EngineDiagnostic): vscode.Diagnostic {
    const diagnostic = new vscode.Diagnostic(offsetRange(text, engine.start, engine.end), engine.message, SEVERITY[engine.severity]);
    diagnostic.source = HELMFILE_DIAGNOSTIC_SOURCE;
    if (engine.code) diagnostic.code = engine.code;
    const payload = engine.payload;
    if (payload) {
        if (payload.kind === 'outdatedVersion') outdatedVersions.set(diagnostic, payload.version);
        else if (payload.kind === 'unknownField') unknownFields.set(diagnostic, { start: payload.start, end: payload.end });
        else if (payload.kind === 'missingFile') missingFiles.set(diagnostic, payload.file);
        else if (payload.kind === 'missingDefine') missingChartDefines.set(diagnostic, { name: payload.name, helpers: payload.helpers });
        else if (payload.kind === 'schemaKey') schemaUnknownKeys.set(diagnostic, { segments: [...payload.segments], schemaFile: payload.schemaFile, valuesFile: payload.valuesFile, type: payload.type });
        else if (payload.kind === 'unusedDefine') unusedChartDefines.set(diagnostic, { name: payload.name, start: payload.start, end: payload.end });
    }
    return diagnostic;
}

function toVscode(text: string, engine: readonly EngineDiagnostic[]): vscode.Diagnostic[] {
    return engine.map(item => toVscodeDiagnostic(text, item));
}

/** Repository access injected into the engine (vscode.Uri-flavored). */
const deps: InspectionDeps = {
    model: (file, environment) => repositoryModel(vscode.Uri.file(file), environment),
    alias: (file, chartText) => alias(vscode.Uri.file(file), chartText),
    query: (file, chartText, environment) => repositoryQuery(vscode.Uri.file(file), chartText, environment),
    chartValue: (doc, mapping, environment, visiting) => chartOf({ uri: vscode.Uri.file(doc.file), text: doc.text, tree: doc.tree }, mapping, environment, visiting),
    fieldValue: (doc, mapping, key) => value({ uri: vscode.Uri.file(doc.file), text: doc.text, tree: doc.tree }, mapping, key),
    snapshot: (request, downloadsEnabled) => repositoryService().snapshot(request, downloadsEnabled),
    downloadsEnabled: () => repositoryDownloadsEnabled(),
};

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
        const file = document.uri.fsPath;
        let engine: readonly EngineDiagnostic[];
        if (isChartManifestName(file.split('/').pop() ?? '')) {
            // Chart.yaml is a plain YAML manifest: syntax check plus dependency
            // sanity, never Helm template rules.
            engine = computeChartManifestDiagnostics(file, text);
        } else if (chartTemplateDetected(chartFileOf(document.uri), contentStamp())) {
            // Chart template files are Helm templates, not Helmfile state:
            // only template/YAML checks apply.
            const context = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
            engine = context
                ? computeChartTemplateDiagnostics(file, text, context)
                : [...(() => { const out: EngineDiagnostic[] = []; engineUnclosedActions(text, out); engineTemplateBlocks(text, out); return out; })()];
        } else {
            engine = computeStateDiagnostics(file, text, this.env.get(), deps);
        }
        this.collection.set(document.uri, toVscode(text, engine));
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

/* ---------------- vscode-shaped wrappers over engine checks ---------------- */

export function unclosedActions(text: string, diagnostics: vscode.Diagnostic[]): void {
    const engine: EngineDiagnostic[] = [];
    engineUnclosedActions(text, engine);
    diagnostics.push(...toVscode(text, engine));
}

export function templateBlocks(text: string, diagnostics: vscode.Diagnostic[]): void {
    const engine: EngineDiagnostic[] = [];
    engineTemplateBlocks(text, engine);
    diagnostics.push(...toVscode(text, engine));
}

export function repositoryDiagnostics(source: SourceFile, environment: string, diagnostics: vscode.Diagnostic[]): void {
    const engine: EngineDiagnostic[] = [];
    engineRepositoryDiagnostics({ file: source.uri.fsPath, text: source.text, tree: source.tree }, environment, deps, engine);
    diagnostics.push(...toVscode(source.text, engine));
}

export function unknownFieldDiagnostics(source: SourceFile, diagnostics: vscode.Diagnostic[]): void {
    const engine: EngineDiagnostic[] = [];
    engineUnknownFieldDiagnostics({ file: source.uri.fsPath, text: source.text, tree: source.tree }, engine);
    diagnostics.push(...toVscode(source.text, engine));
}

export function missingFileDiagnostics(source: SourceFile, environment: string, diagnostics: vscode.Diagnostic[]): void {
    const engine: EngineDiagnostic[] = [];
    engineMissingFileDiagnostics({ file: source.uri.fsPath, text: source.text, tree: source.tree }, environment, engine);
    diagnostics.push(...toVscode(source.text, engine));
}

export function chartYamlDependencyDiagnostics(document: { uri: vscode.Uri; getText(): string }, diagnostics: vscode.Diagnostic[]): void {
    const text = document.getText();
    const engine: EngineDiagnostic[] = [];
    engineChartYamlDependencyDiagnostics(document.uri.fsPath, text, engine);
    diagnostics.push(...toVscode(text, engine));
}

export function unusedDefineDiagnostics(document: vscode.TextDocument, context: ChartTemplateContext, diagnostics: vscode.Diagnostic[]): void {
    const text = document.getText();
    const engine: EngineDiagnostic[] = [];
    engineUnusedDefineDiagnostics(document.uri.fsPath, text, context, engine);
    diagnostics.push(...toVscode(text, engine));
}
