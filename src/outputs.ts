/**
 * Rendering helmfile template/diff output into browsable virtual documents:
 * port of HelmfileTemplateOutput, HelmfileDiffOutput, HelmfileTemplateViewer
 * and HelmfileDiffViewer. "All manifests.yaml" carries the complete output;
 * individual resources appear as `<namespace>/Kind/name.yaml` entries.
 */
import * as vscode from 'vscode';
import YAML from 'yaml';

export interface TemplateResource {
    /** Display label, e.g. `default/Deployment/nginx`. */
    readonly label: string;
    /** Full YAML document text including the leading `# Source:` comment. */
    readonly content: string;
}

export interface TemplateParseResult {
    readonly all: string;
    readonly resources: readonly TemplateResource[];
    /** True when no resource could be identified (malformed output). */
    readonly unreadable: boolean;
}

/** Port of HelmfileTemplateOutput.parse(). */
export function parseTemplateOutput(text: string): TemplateParseResult {
    const docs = text.split(/^---\s*$/m);
    const resources: TemplateResource[] = [];
    const counters = new Map<string, number>();
    for (const doc of docs) {
        const trimmed = doc.replace(/^\s*\n/, '').replace(/\s+$/, '');
        if (!trimmed) continue;
        const identity = resourceIdentity(doc);
        if (!identity) continue;
        const base = identity.namespace ? `${identity.namespace}/${identity.kind}/${identity.name}` : `_no-namespace/${identity.kind}/${identity.name}`;
        const count = (counters.get(base) ?? 0) + 1;
        counters.set(base, count);
        resources.push({ label: count > 1 ? `${base} #${count}` : base, content: trimmed + '\n' });
    }
    return { all: text, resources, unreadable: text.trim().length > 0 && resources.length === 0 };
}

interface ResourceIdentity {
    readonly kind: string;
    readonly name: string;
    readonly namespace: string;
}

function resourceIdentity(doc: string): ResourceIdentity | null {
    try {
        const parsed = YAML.parse(doc) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') return null;
        const kind = typeof parsed['kind'] === 'string' ? parsed['kind'] : '';
        const metadata = parsed['metadata'] as Record<string, unknown> | undefined;
        const name = metadata && typeof metadata['name'] === 'string' ? metadata['name'] : '';
        const namespace = metadata && typeof metadata['namespace'] === 'string' ? metadata['namespace'] : '';
        if (!kind || !name) return null;
        return { kind, name, namespace };
    } catch {
        return null;
    }
}

export type ResourceChangeStatus = 'added' | 'modified' | 'deleted';

export interface DiffResource {
    /** Display label, e.g. `default/Deployment/nginx`. */
    readonly label: string;
    readonly status: ResourceChangeStatus;
    readonly before: string;
    readonly after: string;
}

export interface DiffParseResult {
    readonly resources: readonly DiffResource[];
    /** Concatenated before/after composites with `# label` separators. */
    readonly allBefore: string;
    readonly allAfter: string;
    /** Release/chart header lines found in the output. */
    readonly releases: readonly string[];
    readonly empty: boolean;
}

/**
 * Port of HelmfileDiffOutput.parse(): helm-diff text grouped per resource,
 * unified-diff lines split into before (context + `-`) and after
 * (context + `+`) sides.
 */
export function parseDiffOutput(text: string): DiffParseResult {
    const lines = text.split('\n');
    const resources: DiffResource[] = [];
    const releases: string[] = [];
    const counters = new Map<string, number>();
    let current: { header: string[]; before: string[]; after: string[] } | null = null;

    const flush = (): void => {
        if (!current) return;
        const header = current.header.join('\n');
        const before = header + (header && current.before.length ? '\n' : '') + current.before.join('\n') + '\n';
        const after = header + (header && current.after.length ? '\n' : '') + current.after.join('\n') + '\n';
        const identity = lastIdentity(current.after.join('\n'));
        if (identity) {
            const base = identity.namespace ? `${identity.namespace}/${identity.kind}/${identity.name}` : `_no-namespace/${identity.kind}/${identity.name}`;
            const count = (counters.get(base) ?? 0) + 1;
            counters.set(base, count);
            const hasBefore = current.before.length > 0;
            const hasAfter = current.after.length > 0;
            const status: ResourceChangeStatus = !hasBefore ? 'added' : !hasAfter ? 'deleted' : 'modified';
            resources.push({ label: count > 1 ? `${base} #${count}` : base, status, before, after });
        }
        current = null;
    };

    for (const line of lines) {
        if (/^helmfile-|Legacy mapping of release/.test(line)) {
            if (!releases.includes(line)) releases.push(line);
            continue;
        }
        if (/^# Source: /.test(line)) {
            // Chart source header: start a new resource block.
            flush();
            current = { header: [line], before: [], after: [] };
            continue;
        }
        if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
        if (line.startsWith('@@')) {
            if (!current) current = { header: [], before: [], after: [] };
            continue;
        }
        if (line.startsWith('+')) {
            if (!current) current = { header: [], before: [], after: [] };
            current.after.push(line.slice(1));
            continue;
        }
        if (line.startsWith('-') && !/^--- /.test(line)) {
            if (!current) current = { header: [], before: [], after: [] };
            current.before.push(line.slice(1));
            continue;
        }
        if (line.startsWith(' ')) {
            if (!current) current = { header: [], before: [], after: [] };
            current.before.push(line.slice(1));
            current.after.push(line.slice(1));
        }
    }
    flush();

    const allBefore = resources.map(resource => `# ${resource.label}\n${resource.before}`).join('\n');
    const allAfter = resources.map(resource => `# ${resource.label}\n${resource.after}`).join('\n');
    return { resources, allBefore, allAfter, releases, empty: text.trim().length === 0 };
}

/** Best-effort kind/name/namespace from a unified-diff "after" side. */
function lastIdentity(afterText: string): ResourceIdentity | null {
    const parsed = safeParse(afterText);
    if (parsed) return identityOf(parsed);
    // Fall back to scanning desired-side lines.
    let kind = '';
    let name = '';
    let namespace = '';
    for (const line of afterText.split('\n')) {
        const kindMatch = /^kind:\s*(\S+)/.exec(line);
        if (kindMatch) kind = kindMatch[1];
        const nameMatch = /^(\s+)name:\s*(\S+)/.exec(line);
        if (nameMatch && nameMatch[1].length <= 2) name = nameMatch[2];
        const nsMatch = /^(\s+)namespace:\s*(\S+)/.exec(line);
        if (nsMatch && nsMatch[1].length <= 2) namespace = nsMatch[2];
    }
    return kind && name ? { kind, name, namespace } : null;
}

function safeParse(text: string): Record<string, unknown> | null {
    try {
        const parsed = YAML.parse(text);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function identityOf(parsed: Record<string, unknown>): ResourceIdentity | null {
    const kind = typeof parsed['kind'] === 'string' ? parsed['kind'] : '';
    const metadata = parsed['metadata'] as Record<string, unknown> | undefined;
    const name = metadata && typeof metadata['name'] === 'string' ? metadata['name'] : '';
    const namespace = metadata && typeof metadata['namespace'] === 'string' ? metadata['namespace'] : '';
    return kind && name ? { kind, name, namespace } : null;
}

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
        this.provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, { provideTextDocumentContent: uri => this.documents.get(uri.path.slice(1)) ?? '' });
        this.baseName = kind === 'template' ? 'All manifests.yaml' : 'All changes.yaml';
    }

    private key(label: string): string {
        return `${this.kind}:${label}`;
    }

    private uriOf(label: string): vscode.Uri {
        return vscode.Uri.parse(`${SCHEME}://render/${encodeURIComponent(this.key(label))}`);
    }

    private remember(label: string, content: string): vscode.Uri {
        const key = this.key(label);
        this.documents.set(key, content);
        return this.uriOf(label);
    }

    /** Show the template output: pick "All manifests" or an individual resource. */
    async showTemplate(result: TemplateParseResult, environment: string): Promise<void> {
        if (result.unreadable) {
            void vscode.window.showWarningMessage('Helmfile: helmfile template completed, but the output could not be parsed into resources; showing the raw output.');
        }
        const all = this.remember(this.baseName, result.all);
        const picks: vscode.QuickPickItem[] = [
            { label: this.baseName, description: 'complete output' },
            ...result.resources.map(resource => ({ label: resource.label, description: 'resource' })),
        ];
        const picked = await vscode.window.showQuickPick(picks, { placeHolder: `Template output — ${environment}` });
        if (!picked) return;
        const target = picked.label === this.baseName ? all : this.remember(picked.label, result.resources.find(resource => resource.label === picked.label)?.content ?? '');
        await vscode.window.showTextDocument(target, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }

    /** Show the diff output: pick "All changes" or an individual resource. */
    async showDiff(result: DiffParseResult, environment: string, review?: { command: string; run: () => Promise<void> }): Promise<void> {
        const all = this.remember(`${this.baseName}|before`, result.allBefore);
        const allAfter = this.remember(`${this.baseName}|after`, result.allAfter);
        const picks: (vscode.QuickPickItem & { before?: vscode.Uri; after?: vscode.Uri })[] = [
            { label: this.baseName, description: 'complete comparison', before: all, after: allAfter },
            ...result.resources.map(resource => ({
                label: resource.label,
                description: resource.status,
                before: this.remember(`${resource.label}|before`, resource.before),
                after: this.remember(`${resource.label}|after`, resource.after),
            })),
        ];
        const picked = await vscode.window.showQuickPick(picks, { placeHolder: `Diff — ${environment}` });
        if (!picked || !picked.before || !picked.after) return;
        await vscode.commands.executeCommand('vscode.diff', picked.before, picked.after, `${picked.label} (${environment})`, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        if (review && picked.label === this.baseName) {
            void vscode.window
                .showInformationMessage(`Helmfile: reviewed the diff for ${environment}?`, review.command)
                .then(choice => {
                    if (choice === review.command) void review.run();
                });
        }
    }

    dispose(): void {
        this.provider.dispose();
    }
}
