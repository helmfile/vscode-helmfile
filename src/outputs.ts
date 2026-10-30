/**
 * Parsers and viewers for helmfile template/diff output.
 * Faithful ports of HelmfileTemplateOutput.java, HelmfileDiffOutput.java,
 * and HelmfileDiffViewer.java (no YAML evaluation of secret content,
 * generic diagnostics on parse errors).
 */

import * as vscode from 'vscode';
import { Scalar, YAMLMap, YAMLSeq, parseDocument } from 'yaml';

/* ---------------- template output ---------------- */

export interface TemplateResource {
    /** Path like `default/Deployment/nginx (2).yaml`. */
    readonly path: string;
    /** Raw YAML document text including `# Source:` comments. */
    readonly text: string;
}

export interface TemplateParseResult {
    readonly all: string;
    readonly resources: readonly TemplateResource[];
    /** True when a document could not be identified (generic diagnostics only). */
    readonly unrecognized: boolean;
}

const TEMPLATE_SEPARATOR = /^---[ \t]*(?:#.*)?(?:\r?\n|$)/gm;

/** Port of HelmfileTemplateOutput.parse(). */
export function parseTemplateOutput(text: string): TemplateParseResult {
    const resources: TemplateResource[] = [];
    const occurrences = new Map<string, number>();
    let unrecognized = false;
    for (const document of text.split(TEMPLATE_SEPARATOR)) {
        const parsed = parseDocument(document, { logLevel: 'silent' });
        if (parsed.errors.length > 0) {
            unrecognized = true;
            continue;
        }
        const contents = parsed.contents;
        if (!contents || contents instanceof Scalar) {
            if (contents instanceof Scalar) unrecognized = true;
            continue;
        }
        const kind = scalarOf(fieldOf(contents, 'kind'));
        if (!kind || !scalarOf(fieldOf(contents, 'apiVersion'))) {
            unrecognized = true;
            continue;
        }
        const metadata = fieldOf(contents, 'metadata');
        const namespace = scalarOf(fieldOf(metadata, 'namespace'));
        let name = scalarOf(fieldOf(metadata, 'name'));
        if (!name) name = scalarOf(fieldOf(metadata, 'generateName'));
        if (!name) name = `document-${resources.length + 1}`;
        const base = `${component(namespace || '_no-namespace')}/${component(kind)}/${component(name)}`;
        const occurrence = (occurrences.get(base) ?? 0) + 1;
        occurrences.set(base, occurrence);
        resources.push({ path: `${base}${occurrence > 1 ? ` (${occurrence})` : ''}.yaml`, text: document });
    }
    return { all: text, resources, unrecognized };
}

function fieldOf(node: unknown, key: string): unknown {
    if (node instanceof YAMLMap) {
        for (const pair of node.items) {
            if (pair.key instanceof Scalar && String(pair.key.value ?? '') === key) return pair.value;
        }
    } else if (node instanceof YAMLSeq) {
        return node.items.find(item => item instanceof YAMLMap && fieldOf(item, key) != null) ?? null;
    }
    return null;
}

function scalarOf(node: unknown): string {
    return node instanceof Scalar ? String(node.value ?? '') : '';
}

/** HelmfileTemplateOutput.component(): sanitize path segments. */
function component(text: string): string {
    const value = text.replace(/[^A-Za-z0-9._-]/g, '_');
    return value === '.' || value === '..' ? '_' : value;
}

/* ---------------- diff output ---------------- */

export type DiffResourceStatus = 'added' | 'modified' | 'deleted' | 'ownership' | 'suppressed';

export interface DiffResource {
    readonly release: string;
    readonly namespace: string;
    readonly name: string;
    readonly kind: string;
    readonly api: string;
    readonly status: DiffResourceStatus;
    readonly before: string;
    readonly after: string;
    /** True when output was truncated (`...`) or no content was captured. */
    readonly partial: boolean;
}

export interface DiffParseResult {
    readonly resources: readonly DiffResource[];
    /** Lines outside any resource block (helmfile progress, plugin notices). */
    readonly unparsed: readonly string[];
}

const MAX_RESOURCES = 5_000;
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
const COMPARISON = /^Comparing release=([^,]+), chart=.+$/;
const HEADER = /^([^,]*), ([^,]+), (\S+) \(([^)]+)\) (has been added:|has been removed:|has changed:|changed ownership:|has changed, but diff is empty after suppression\.)$/;

/** Port of HelmfileDiffOutput.parse(): standard helm-diff renderer with full context. */
export function parseDiffOutput(text: string): DiffParseResult {
    const resources: DiffResource[] = [];
    const unparsed: string[] = [];
    let current: DiffBuilder | null = null;
    let release = '';
    for (const line of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(ANSI, '').split('\n')) {
        const comparison = COMPARISON.exec(line);
        if (comparison) {
            if (current) {
                resources.push(current.build());
                current = null;
            }
            release = comparison[1];
            continue;
        }
        const header = HEADER.exec(line);
        if (header) {
            if (current) resources.push(current.build());
            if (resources.length >= MAX_RESOURCES) {
                unparsed.push('More than 5,000 resources; narrow the diff to individual releases.');
                current = null;
                break;
            }
            const phrase = header[5];
            const status: DiffResourceStatus =
                phrase === 'has been added:'
                    ? 'added'
                    : phrase === 'has been removed:'
                      ? 'deleted'
                      : phrase === 'changed ownership:'
                        ? 'ownership'
                        : phrase === 'has changed, but diff is empty after suppression.'
                          ? 'suppressed'
                          : 'modified';
            current = new DiffBuilder(release, header[1], header[2], header[3], header[4], status);
            continue;
        }
        if (current && line === '...') {
            current.partial = true;
            current.before.append('# ... context omitted by helm-diff ...\n');
            current.after.append('# ... context omitted by helm-diff ...\n');
        } else if (current && line.startsWith('+ Changes suppressed on sensitive content of type ')) {
            current.status = 'suppressed';
        } else if (current && (line.startsWith('+ ') || line.startsWith('- ') || line.startsWith('  ') || line === '')) {
            const content = line === '' ? '' : line.substring(2);
            if (!line.startsWith('+ ')) current.before.append(content + '\n');
            if (!line.startsWith('- ')) current.after.append(content + '\n');
        } else if (line.trim() !== '') {
            if (current) {
                resources.push(current.build());
                current = null;
            }
            unparsed.push(line);
        }
    }
    if (current) resources.push(current.build());
    return { resources, unparsed };
}

class StringBuilder {
    private parts: string[] = [];
    append(text: string): void { this.parts.push(text); }
    toString(): string { return this.parts.join(''); }
    isEmpty(): boolean { return this.parts.length === 0; }
}

class DiffBuilder {
    readonly before = new StringBuilder();
    readonly after = new StringBuilder();
    partial = false;

    constructor(
        private readonly release: string,
        private readonly namespace: string,
        private readonly name: string,
        private readonly kind: string,
        private readonly api: string,
        status: DiffResourceStatus,
    ) {
        this.status = status;
    }

    status: DiffResourceStatus;

    private suppressed(): boolean { return this.status === 'suppressed'; }

    build(): DiffResource {
        const beforeText = this.before.toString();
        const afterText = this.after.toString();
        const invalid = !this.suppressed() && beforeText === '' && afterText === '';
        return {
            release: this.release,
            namespace: this.namespace,
            name: this.name,
            kind: this.kind,
            api: this.api,
            status: this.status,
            before: this.status === 'added' && beforeText.trim() === '' ? '' : beforeText,
            after: this.status === 'deleted' && afterText.trim() === '' ? '' : afterText,
            partial: this.partial || invalid,
        };
    }
}

/** DiffResource.path(): release/namespace/Kind/name.yaml. */
export function diffResourcePath(resource: DiffResource): string {
    return `${resource.release ? resource.release + '/' : ''}${resource.namespace || '_cluster'}/${resource.kind}/${resource.name}.yaml`;
}

/** Result.partial(): any resource partial or unparsed lines present. */
export function diffPartial(result: DiffParseResult): boolean {
    return result.unparsed.length > 0 || result.resources.some(resource => resource.partial);
}

/* ---------------- viewer ---------------- */

const SCHEME = 'helmfile-output';

/**
 * Virtual document store: keeps rendered texts addressable by URI so quick
 * picks and diff views can reopen them. Mirrors the IntelliJ read-only viewers.
 */
export class OutputViewer implements vscode.Disposable {
    private readonly documents = new Map<string, string>();
    private readonly provider: vscode.Disposable;
    private readonly baseName: string;

    constructor(private readonly kind: 'template' | 'diff') {
        this.provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: uri => this.documents.get(decodeURIComponent(uri.path.slice(1))) ?? '' });
        this.baseName = kind === 'template' ? 'All manifests.yaml' : 'All changes.yaml';
    }

    private uriOf(label: string): vscode.Uri {
        return vscode.Uri.parse(`${SCHEME}://render/${encodeURIComponent(label)}`);
    }

    private remember(label: string, content: string): vscode.Uri {
        this.documents.set(label, content);
        return this.uriOf(label);
    }

    /** Show the template output: pick "All manifests" or an individual resource. */
    async showTemplate(result: TemplateParseResult, environment: string): Promise<void> {
        if (result.unrecognized) {
            void vscode.window.showWarningMessage('Helmfile: helmfile template completed, but the output could not be parsed into resources; showing the raw output.');
        }
        const all = this.remember(`${this.kind}:${this.baseName}`, result.all);
        const picks: vscode.QuickPickItem[] = [
            { label: this.baseName, description: 'complete output' },
            ...result.resources.map(resource => ({ label: resource.path, description: 'resource' })),
        ];
        const picked = await vscode.window.showQuickPick(picks, { placeHolder: `Template output — ${environment}` });
        if (!picked) return;
        const target = picked.label === this.baseName ? all : this.remember(`${this.kind}:${picked.label}`, result.resources.find(resource => resource.path === picked.label)?.text ?? '');
        await vscode.window.showTextDocument(target, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }

    /** Show the diff output: "All changes" plus one virtual diff per resource (HelmfileDiffViewer). */
    async showDiff(result: DiffParseResult, scope: string, environment: string, review?: { command: string; run: () => Promise<void> }): Promise<void> {
        const title = `Helmfile diff: ${scope} [${environment}]`;
        const before = new StringBuilder();
        const after = new StringBuilder();
        for (const resource of result.resources) {
            appendComposite(before, diffResourcePath(resource), resource.before, resource.status === 'suppressed');
            appendComposite(after, diffResourcePath(resource), resource.after, resource.status === 'suppressed');
        }
        const occurrences = new Map<string, number>();
        const picks: (vscode.QuickPickItem & { before?: vscode.Uri; after?: vscode.Uri; suppressed?: boolean; labelPath?: string })[] = [
            {
                label: this.baseName,
                description: 'complete comparison' + (diffPartial(result) ? ' (partial output)' : ''),
                before: this.remember(`${this.kind}:all-before`, before.toString()),
                after: this.remember(`${this.kind}:all-after`, after.toString()),
            },
        ];
        for (const resource of result.resources) {
            const base = diffResourcePath(resource);
            const occurrence = (occurrences.get(base) ?? 0) + 1;
            occurrences.set(base, occurrence);
            const path = occurrence > 1 ? base.slice(0, -5) + ` (${occurrence}).yaml` : base;
            picks.push({
                label: path,
                description:
                    resource.status === 'suppressed'
                        ? 'suppressed'
                        : resource.status + (resource.partial ? ', partial output' : ''),
                before: this.remember(`${this.kind}:${path}|before`, resource.before),
                after: this.remember(`${this.kind}:${path}|after`, resource.after),
                suppressed: resource.status === 'suppressed',
                labelPath: path,
            });
        }
        const picked = await vscode.window.showQuickPick(picks, { placeHolder: title });
        if (!picked) return;
        if (picked.suppressed) {
            void vscode.window.showInformationMessage(`${title} — ${picked.label}: changes to this resource are suppressed by the Helmfile configuration.`);
        } else if (picked.before && picked.after) {
            const suffix = picked.description?.includes('partial output') ? ' (partial output)' : '';
            await vscode.commands.executeCommand('vscode.diff', picked.before, picked.after, `${title} — ${picked.label}`, {
                preview: true,
                viewColumn: vscode.ViewColumn.Beside,
            });
            void vscode.window.showInformationMessage(`Deployed${suffix} ↔ Desired${suffix}`);
        }
        if (review) {
            void vscode.window
                .showInformationMessage(`Helmfile: reviewed the diff for ${scope} (${environment})?`, review.command)
                .then(choice => {
                    if (choice === review.command) void review.run();
                });
        }
    }

    dispose(): void {
        this.provider.dispose();
    }
}

/** HelmfileDiffViewer.append(): composite document with `# path` separators. */
function appendComposite(target: StringBuilder, path: string, text: string, suppressed: boolean): void {
    if (text === '' && !suppressed) return;
    if (!target.isEmpty()) target.append('---\n');
    target.append(`# ${path}\n`);
    target.append(suppressed ? '# Changes suppressed by Helmfile configuration.\n' : text);
}
