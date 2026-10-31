/**
 * Extension entry point: wires every Helmfile feature into VSCode.
 */
import * as vscode from 'vscode';
import { EnvironmentService } from './settings';
import { bumpContentVersion, closeOpenDocument, isHelmfileName, readSource, setOpenDocument, stateFor } from './values';
import { HelmfileCompletionProvider } from './completion';
import { HelmfileDefinitionProvider, HelmfileReferencesProvider } from './references';
import { HelmfileHoverProvider } from './hover';
import { HelmfileDiagnostics } from './inspection';
import { HelmfileCodeLensProvider, HELMFILE_SELECT_ENVIRONMENT, HELMFILE_GOTO_TEMPLATE_PARENT, HELMFILE_FIND_TEMPLATE_USAGES } from './codeLens';
import { HelmfileSemanticTokensProvider, SEMANTIC_TOKEN_TYPES } from './semanticTokens';
import { HelmfileDocumentSymbolProvider } from './documentSymbol';
import { HelmfileFoldingRangeProvider } from './folding';
import { HelmfileSelectionRangeProvider } from './selectionRanges';
import { HelmfileCodeActionProvider } from './codeActions';
import { HelmfileStatusBar } from './statusBar';
import { ChartSourceService } from './chartNavigation';
import { repositoryService, type RepositoryQuery } from './repositoryService';
import { repositoryModel, downloadable, query as repositoryQuery } from './repositories';
import { disposeOperations, runReleaseOperation, selectEnvironment } from './operations';
import { detectProject, projectFor } from './project';
import { channel } from './execution';
import { scalarPathText, walkAll, type YPair } from './yamlTree';
import { offsetPosition } from './position';

const HELMFILE_SELECTOR = { language: 'helmfile' };

function isHelmfileDocument(document: vscode.TextDocument): boolean {
    return document.languageId === 'helmfile' || isHelmfileName(document.uri.path.split('/').pop() ?? '');
}

export function activate(context: vscode.ExtensionContext): void {
    const env = new EnvironmentService(context);
    const completion = new HelmfileCompletionProvider(() => env.get());
    const definition = new HelmfileDefinitionProvider(env);
    const references = new HelmfileReferencesProvider(env);
    const hover = new HelmfileHoverProvider(env);
    const diagnostics = new HelmfileDiagnostics(env);
    const lenses = new HelmfileCodeLensProvider(env);
    const charts = new ChartSourceService();
    charts.restore();

    // Project recognition: surface helmfile's own entry conflicts (yaml+
    // gotmpl both present, or default file next to helmfile.d/) once per root.
    const warned = new Set<string>();
    const warnConflict = (uri?: vscode.Uri): void => {
        const project = uri ? projectFor(uri.fsPath) : null;
        if (!project?.conflict || warned.has(project.root)) return;
        warned.add(project.root);
        void vscode.window.showWarningMessage(`Helmfile: ${project.conflict}`);
    };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const project = detectProject(folder.uri.fsPath);
        if (project?.conflict) {
            warned.add(project.root);
            void vscode.window.showWarningMessage(`Helmfile: ${project.conflict}`);
        }
    }

    context.subscriptions.push(env, charts, { dispose: disposeOperations });

    // Language providers.
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(HELMFILE_SELECTOR, completion, '.', '/', ' '),
        vscode.languages.registerDefinitionProvider(HELMFILE_SELECTOR, definition),
        vscode.languages.registerReferenceProvider(HELMFILE_SELECTOR, references),
        vscode.languages.registerHoverProvider(HELMFILE_SELECTOR, hover),
        vscode.languages.registerCodeLensProvider(HELMFILE_SELECTOR, lenses),
        vscode.languages.registerDocumentSemanticTokensProvider(HELMFILE_SELECTOR, new HelmfileSemanticTokensProvider(), new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES)),
        vscode.languages.registerDocumentSymbolProvider(HELMFILE_SELECTOR, new HelmfileDocumentSymbolProvider()),
        vscode.languages.registerFoldingRangeProvider(HELMFILE_SELECTOR, new HelmfileFoldingRangeProvider()),
        vscode.languages.registerSelectionRangeProvider(HELMFILE_SELECTOR, new HelmfileSelectionRangeProvider()),
        vscode.languages.registerCodeActionsProvider(HELMFILE_SELECTOR, new HelmfileCodeActionProvider()),
        diagnostics,
        vscode.window.registerTreeDataProvider('helmfile.charts', charts),
        new HelmfileStatusBar(env),
    );

    // Document lifecycle: track open helmfile documents for values resolution + diagnostics.
    const track = (document: vscode.TextDocument): void => {
        if (!isHelmfileDocument(document)) return;
        setOpenDocument(document.uri, document.version, document.getText(), document.version > 1);
        diagnostics.track(document);
    };
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(track),
        vscode.workspace.onDidOpenTextDocument(document => warnConflict(document.uri)),
        vscode.workspace.onDidChangeTextDocument(event => track(event.document)),
        vscode.workspace.onDidCloseTextDocument(document => {
            closeOpenDocument(document.uri);
            diagnostics.forget(document.uri);
        }),
    );
    vscode.workspace.textDocuments.forEach(track);

    // Edits to files on disk (values files, environment configs, included
    // bases edited externally or in another window) invalidate the static
    // model caches — open-document events alone never see them.
    let diskInvalidateTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidateDiskFiles = (): void => {
        if (diskInvalidateTimer) clearTimeout(diskInvalidateTimer);
        diskInvalidateTimer = setTimeout(() => {
            diskInvalidateTimer = undefined;
            bumpContentVersion();
            lenses.fire();
            diagnostics.refreshAll();
        }, 150);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml,gotmpl,tpl,json}');
    context.subscriptions.push(
        watcher,
        watcher.onDidChange(invalidateDiskFiles),
        watcher.onDidCreate(invalidateDiskFiles),
        watcher.onDidDelete(invalidateDiskFiles),
    );

    // Repository metadata changes refresh diagnostics.
    context.subscriptions.push(repositoryService().onChanged(() => diagnostics.refreshAll()));

    // Settings changes re-run diagnostics and refresh lenses (mutating-operation visibility depends on settings).
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('helmfile')) {
                diagnostics.refreshAll();
                lenses.fire();
            }
        }),
    );

    // Environment switching refreshes lenses + diagnostics.
    context.subscriptions.push(env.onDidChange(() => {
        lenses.fire();
        diagnostics.refreshAll();
    }));

    // Commands.
    const register = (command: string, handler: (...args: never[]) => unknown): void => {
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    };

    register(HELMFILE_SELECT_ENVIRONMENT, (uri?: vscode.Uri) => selectEnvironment(env, uri));
    register('helmfile.selectEnvironmentQuick', () => selectEnvironment(env, vscode.window.activeTextEditor?.document.uri));
    register('helmfile.refreshRepositories', async () => {
        const target = vscode.window.activeTextEditor?.document.uri ?? activeStateUri();
        const state = target ? stateFor(target) : null;
        if (!state) {
            void vscode.window.showWarningMessage('Helmfile: open a helmfile state file first.');
            return;
        }
        await repositoryService().refresh(collectQueries(state.uri, env.get()), true, 'Helmfile: Refresh Chart Repositories');
    });
    register('helmfile.templateRelease', (uri?: vscode.Uri, offset?: number) => runReleaseOperation(env, 'template', false, uri, offset));
    register('helmfile.diffRelease', (uri?: vscode.Uri, offset?: number) => runReleaseOperation(env, 'diff', false, uri, offset));
    register('helmfile.applyRelease', (uri?: vscode.Uri, offset?: number) => runReleaseOperation(env, 'apply', false, uri, offset));
    register('helmfile.destroyRelease', (uri?: vscode.Uri, offset?: number) => runReleaseOperation(env, 'destroy', false, uri, offset));
    register('helmfile.diffAllReleases', (uri?: vscode.Uri) => runReleaseOperation(env, 'diff', true, uri, undefined));
    register('helmfile.openChartSource', async (uri?: vscode.Uri, offset?: number) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        const at = offset ?? (vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.offsetAt(vscode.window.activeTextEditor.selection.active) : undefined);
        if (!target || at === undefined) return;
        const source = readSource(target);
        if (!source) return;
        await charts.open(source, at, env);
    });
    register(HELMFILE_GOTO_TEMPLATE_PARENT, async (uri?: vscode.Uri, offsets?: number[] | number) => {
        if (!uri) return;
        const starts = Array.isArray(offsets) ? offsets : offsets !== undefined ? [offsets] : [];
        const seen = new Map<string, vscode.Location>();
        for (const offset of starts) {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, positionOf(uri, offset));
            for (const location of locations ?? []) seen.set(`${location.uri.toString()}#${location.range.start.line}:${location.range.start.character}`, location);
        }
        const targets = [...seen.values()];
        if (targets.length === 1) {
            await vscode.window.showTextDocument(targets[0].uri, { selection: targets[0].range });
            return;
        }
        if (targets.length === 0) return;
        const picked = await vscode.window.showQuickPick(
            targets.map(location => ({ label: vscode.workspace.asRelativePath(location.uri), description: `line ${location.range.start.line + 1}`, location })),
            { placeHolder: 'Parent templates' },
        );
        if (picked) await vscode.window.showTextDocument(picked.location.uri, { selection: picked.location.range });
    });
    register(HELMFILE_FIND_TEMPLATE_USAGES, async (uri?: vscode.Uri, offset?: number) => {
        if (!uri || offset === undefined) return;
        const locations = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, positionOf(uri, offset));
        if (!locations?.length) return;
        if (locations.length === 1) {
            await vscode.window.showTextDocument(locations[0].uri, { selection: locations[0].range });
            return;
        }
        const picked = await vscode.window.showQuickPick(
            locations.map(location => ({ label: vscode.workspace.asRelativePath(location.uri), description: `line ${location.range.start.line + 1}`, location })),
            { placeHolder: 'Template usages' },
        );
        if (picked) await vscode.window.showTextDocument(picked.location.uri, { selection: picked.location.range });
    });

    channel().appendLine('Helmfile support activated.');
}

function activeStateUri(): vscode.Uri | undefined {
    return vscode.workspace.textDocuments.find(isHelmfileDocument)?.uri;
}

/** Repository queries for the refresh action: HTTP index downloads + OCI tag listings in use. */
function collectQueries(uri: vscode.Uri, environment: string): RepositoryQuery[] {
    const source = readSource(uri);
    if (!source) return [];
    const model = repositoryModel(uri, environment);
    const queries: RepositoryQuery[] = [];
    const seen = new Set<string>();
    for (const entry of model.entries) {
        if (entry.access.oci || !downloadable(entry.access)) continue;
        const key = entry.access.url;
        if (key && !seen.has(key)) {
            seen.add(key);
            queries.push({ access: entry.access, chart: '' });
        }
    }
    // OCI repositories: collect charts referencing them for tag listings.
    for (const doc of source.tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind !== 'pair') return;
            const pair = node as YPair;
            if (pair.key !== 'chart' || !pair.value || pair.value.kind !== 'scalar') return;
            const chartText = scalarPathText(pair.value);
            if (!chartText || chartText.includes('{{')) return;
            const query = repositoryQuery(uri, chartText, environment);
            if (!query || !query.access.oci || !query.chart) return;
            const key = `${query.access.url} ${query.chart}`;
            if (seen.has(key)) return;
            seen.add(key);
            queries.push(query);
        });
    }
    return queries;
}

function positionOf(uri: vscode.Uri, offset: number): vscode.Position {
    return offsetPosition(readSource(uri)?.text ?? '', offset);
}
