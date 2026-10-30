/**
 * Chart source browsing: port of HelmfileChartNavigation (Ctrl+Click on a
 * chart name) and HelmfileChartSourceService (helm pull into a persistent
 * cache plus the "Chart Sources" tree view that mirrors External Libraries).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { mappingGet, pairKeyAt, scalarPathText } from './yamlTree';
import { readSource, stateFor, type SourceFile } from './values';
import { allDefinitions } from './values';
import { EnvironmentService, settings } from './settings';
import { query as repositoryQuery } from './repositories';
import { clean, reason } from './downloadDiagnostics';
import type { Access } from './repositories';

const NO_ACCESS: Access = {
    name: '',
    url: '',
    oci: false,
    username: '',
    password: '',
    caFile: '',
    certFile: '',
    keyFile: '',
    skipTLSVerify: false,
    passCredentials: false,
    plainHttp: false,
};

/** Simple state-value references inside version/chart strings: `{{ .Values.x }}` plus default/quote pipelines. */
const STATE_VALUE = /\{\{-?\s*(\$?\.(?:Values|StateValues|Environment\.Values)\.[A-Za-z0-9_.]+|\.Environment\.Name)((?:\s*\|\s*(?:default|quote)\s+(?:"[^"]*"|'[^']*'))*)\s*-?\}\}/;

interface ChartRequest {
    /** Resolved chart reference, e.g. `ingress-nginx/ingress-nginx` or a local path. */
    readonly chart: string;
    /** Resolved version constraint or empty. */
    readonly version: string;
    readonly repository: { url: string; oci: boolean } | null;
    readonly problem: string | null;
    /** True when a template value could not be resolved statically. */
    readonly unresolvedEnvironment: boolean;
}

export class ChartSourceService implements vscode.Disposable {
    private readonly output = vscode.window.createOutputChannel('Helmfile Chart Sources', { log: true });
    private readonly downloaded = new Map<string, vscode.Uri>();
    private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | vscode.TreeItem[] | null | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    /** Open a chart's source: local directory or downloaded remote chart. */
    async open(source: SourceFile, offset: number, env: EnvironmentService): Promise<void> {
        const request = requestAt(source, offset, env.get());
        if (request.problem) {
            void vscode.window.showWarningMessage('Helmfile', request.problem);
            return;
        }
        if (request.unresolvedEnvironment) {
            const picked = await pickEnvironment(env, source.uri);
            if (picked === undefined) return;
            return this.open(source, offset, env);
        }
        const chart = request.chart;
        if (chart.includes('://')) {
            void vscode.window.showWarningMessage('Helmfile', 'Chart URLs are not browsable; use a repository alias or a local path.');
            return;
        }
        if (isLocalDirectory(source, chart)) {
            await openLocal(source, chart);
            return;
        }
        await this.download(request, env);
    }

    private async download(request: ChartRequest, env: EnvironmentService): Promise<void> {
        if (settings().disableDownloads) {
            void vscode.window.showWarningMessage('Helmfile', 'Chart downloads are disabled (helmfile.disableAutomaticDownloads).');
            return;
        }
        const helm = settings().helmExecutable;
        const cacheRoot = chartCacheRoot();
        const display = request.chart + (request.version ? '@' + request.version : '');
        const directory = path.join(cacheRoot, hash(`${request.chart}@${request.version}@${request.repository?.url ?? ''}`), chartName(request.chart));
        const marker = path.join(directory, '.helmfile-vscode-chart');

        if (fs.existsSync(marker)) {
            this.remember(directory, display);
            return;
        }
        fs.mkdirSync(path.dirname(directory), { recursive: true });

        const args = ['pull', '--untar', '--destination', path.dirname(directory), '--untardir', chartName(request.chart)];
        if (request.version) args.push('--version', request.version);
        if (request.repository?.url) {
            if (request.repository.oci) args.push('oci://' + request.repository.url.replace(/^oci:\/\//, '') + '/' + chartName(request.chart));
            else args.push('--repo', request.repository.url, chartName(request.chart));
        } else {
            args.push(request.chart);
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Downloading ${display}`, cancellable: true },
            (progress, token) =>
                new Promise<void>(resolve => {
                    const child = spawn(helm, args, { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
                    token.onCancellationRequested(() => child.kill());
                    let stdout = '';
                    let stderr = '';
                    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
                    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
                    child.on('error', error => {
                        this.reportFailure(display, env.get(), `Failed to start helm: ${reason(error, NO_ACCESS)}`, stdout, stderr);
                        resolve();
                    });
                    child.on('close', code => {
                        if (code === 0 && fs.existsSync(directory)) {
                            fs.writeFileSync(marker, display);
                            this.remember(directory, display);
                        } else {
                            const failure = clean(stderr || stdout, NO_ACCESS);
                            this.reportFailure(display, env.get(), `helm pull failed${code != null ? ` (exit ${code})` : ''}`, stdout, stderr + (failure ? '\n' + failure : ''));
                        }
                        resolve();
                    });
                }),
        );
    }

    private reportFailure(display: string, environment: string, message: string, stdout: string, stderr: string): void {
        this.output.appendLine(`helm pull failed: ${display} (environment ${environment})`);
        if (stdout) this.output.appendLine(stdout);
        if (stderr) this.output.appendLine(stderr);
        void vscode.window
            .showWarningMessage(`Helmfile: Failed to download ${display} (${environment})`, { detail: message, modal: false }, 'Show Details')
            .then(choice => {
                if (choice === 'Show Details') this.output.show();
            });
    }

    private remember(directory: string, display: string): void {
        this.downloaded.set(display, vscode.Uri.file(directory));
        this.emitter.fire(undefined);
        void vscode.commands.executeCommand('setContext', 'helmfile.hasCharts', true);
        void vscode.window.showTextDocument(vscode.Uri.file(path.join(directory, 'Chart.yaml')));
    }

    /** Restore previously downloaded charts from the cache directory. */
    restore(): void {
        const root = chartCacheRoot();
        if (!fs.existsSync(root)) return;
        for (const hashDir of fs.readdirSync(root)) {
            const chartRoot = path.join(root, hashDir);
            for (const chartDir of fs.readdirSync(chartRoot)) {
                const marker = path.join(chartRoot, chartDir, '.helmfile-vscode-chart');
                if (fs.existsSync(marker)) {
                    let display = fs.readFileSync(marker, 'utf8').trim();
                    if (!display) display = chartDir;
                    this.downloaded.set(display, vscode.Uri.file(path.join(chartRoot, chartDir)));
                }
            }
        }
        if (this.downloaded.size > 0) void vscode.commands.executeCommand('setContext', 'helmfile.hasCharts', true);
        this.emitter.fire(undefined);
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element) return [];
        return [...this.downloaded.entries()]
            .sort((left, right) => left[0].localeCompare(right[0]))
            .map(([label, uri]) => {
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                item.resourceUri = uri;
                item.contextValue = 'chartSource';
                item.iconPath = new vscode.ThemeIcon('library');
                return item;
            });
    }

    dispose(): void {
        this.output.dispose();
        this.emitter.dispose();
    }
}

/** Resolve the chart reference at `offset` (chart field of a release/dependency). */
export function requestAt(source: SourceFile, offset: number, environment: string): ChartRequest {
    const pair = pairKeyAt(source.tree, offset);
    if (!pair || pair.key !== 'chart') return empty('Not a chart field');
    const raw = scalarPathText(pair.value);
    if (!raw) return empty('Not a chart field');
    const mapping = pair.parent;
    const chartResolved = resolveTemplate(raw, source, environment, 'chart');
    const versionPair = mappingGet(mapping, 'version');
    const versionRaw = versionPair ? scalarPathText(versionPair.value) : '';
    const versionResolved = versionRaw ? resolveTemplate(versionRaw, source, environment, 'version') : { text: '', problem: null as string | null, unresolved: false };

    const problems = [chartResolved.problem, versionResolved.problem].filter(Boolean).join('\n');
    if (problems) return { chart: chartResolved.text, version: versionResolved.text, repository: null, problem: problems, unresolvedEnvironment: false };
    if (chartResolved.unresolved || versionResolved.unresolved) {
        return { chart: chartResolved.text, version: versionResolved.text, repository: null, problem: null, unresolvedEnvironment: true };
    }
    return {
        chart: chartResolved.text,
        version: versionResolved.text,
        repository: repositoryOf(source, chartResolved.text, environment),
        problem: null,
        unresolvedEnvironment: false,
    };
}

function empty(problem: string): ChartRequest {
    return { chart: '', version: '', repository: null, problem, unresolvedEnvironment: false };
}

function resolveTemplate(raw: string, source: SourceFile, environment: string, label: string): { text: string; problem: string | null; unresolved: boolean } {
    if (!raw.includes('{{')) return { text: raw, problem: null, unresolved: false };
    const match = STATE_VALUE.exec(raw);
    if (!match) return { text: raw, problem: `The ${label} expression could not be resolved statically`, unresolved: false };
    const path = match[1].replace(/^\$?\./, '');
    const segments = path.split('.');
    if (segments[0] === 'Environment' && segments[1] === 'Name') return { text: environment, problem: null, unresolved: false };
    const fallback = defaultValue(match[2]);
    const definitions = allDefinitions(source.uri, environment).filter(definition => definition.path === segments.join('\u001f'));
    const definition = definitions[definitions.length - 1] ?? null;
    if (!definition) {
        if (fallback !== null) return { text: fallback, problem: null, unresolved: false };
        return { text: raw, problem: null, unresolved: true };
    }
    if (definition.valueKind !== 'scalar' || definition.preview.includes('{{')) {
        if (fallback !== null) return { text: fallback, problem: null, unresolved: false };
        return { text: raw, problem: null, unresolved: true };
    }
    return { text: definition.preview, problem: null, unresolved: false };
}

function defaultValue(pipeline: string | undefined): string | null {
    if (!pipeline) return null;
    const match = /default\s+(?:"([^"]*)"|'([^']*)')/.exec(pipeline);
    if (!match) return null;
    return match[1] ?? match[2] ?? '';
}

function repositoryOf(source: SourceFile, chart: string, environment: string): { url: string; oci: boolean } | null {
    const query = repositoryQuery(source.uri, chart, environment);
    return query ? { url: query.access.url, oci: query.access.oci } : null;
}

function isLocalDirectory(source: SourceFile, chart: string): boolean {
    if (chart.includes('://')) return false;
    if (chart.startsWith('.') || chart.startsWith('/')) return true;
    const candidate = path.join(path.dirname(source.uri.fsPath), chart);
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
}

async function openLocal(source: SourceFile, chart: string): Promise<void> {
    const candidate = path.join(path.dirname(source.uri.fsPath), chart);
    const chartYaml = path.join(candidate, 'Chart.yaml');
    if (fs.existsSync(chartYaml)) {
        await vscode.window.showTextDocument(vscode.Uri.file(chartYaml));
        return;
    }
    void vscode.window.showWarningMessage('Helmfile', `The chart at ${chart} has no Chart.yaml.`);
}

async function pickEnvironment(env: EnvironmentService, uri: vscode.Uri): Promise<string | undefined> {
    const state = stateFor(uri);
    const model = state ? environmentList(state.uri) : [];
    const picked = await vscode.window.showQuickPick(model.length ? model : ['default'], { placeHolder: 'Select the Helmfile environment used to resolve template values' });
    if (picked === undefined) return undefined;
    env.set(picked);
    return picked;
}

function environmentList(uri: vscode.Uri): string[] {
    const source = readSource(uri);
    if (!source) return ['default'];
    const names = new Set<string>(['default']);
    for (const doc of source.tree.docs) {
        const root = doc.root;
        if (!root) continue;
        const environments = mappingGet(root, 'environments');
        const envMapping = environments?.value;
        if (envMapping && envMapping.kind === 'mapping') {
            for (const pair of envMapping.pairs) if (pair.key) names.add(pair.key);
        }
    }
    return [...names];
}

function chartName(chart: string): string {
    const slash = chart.lastIndexOf('/');
    return slash >= 0 ? chart.slice(slash + 1) : chart;
}

function hash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 24);
}

function chartCacheRoot(): string {
    const home = process.env['HELMFILE_CHART_CACHE'] ?? path.join(process.env['HOME'] ?? process.cwd(), '.cache', 'vscode-helmfile', 'chart-sources');
    return home;
}
