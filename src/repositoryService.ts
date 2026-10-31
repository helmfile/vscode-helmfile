/**
 * In-memory per-window repository metadata cache. Port of
 * HelmfileRepositoryService from the IntelliJ plugin: successful downloads
 * refresh after five minutes, failures retry after one minute, and previously
 * downloaded suggestions stay available.
 */

import * as vscode from 'vscode';
import { ChartIndex } from './chartIndex';
import { loadRepository } from './repositoryDownload';
import { Access, downloadable } from './repositories';
import { clean, preview, reason } from './downloadDiagnostics';
import { repositoryDownloadsEnabled } from './settings';
import { channel } from './execution';

export interface RepositoryQuery {
    readonly access: Access;
    readonly chart: string;
}

export interface RepositorySnapshot {
    readonly index: ChartIndex | null;
    readonly error: string | null;
    readonly loading: boolean;
    readonly checked: number;
}

interface CacheEntry {
    index: ChartIndex | null;
    error: string | null;
    checked: number;
}

let shared: RepositoryService | null = null;

/** Shared service instance for the extension host. */
export function repositoryService(): RepositoryService {
    return (shared ??= new RepositoryService());
}

export class RepositoryService implements vscode.Disposable {
    private readonly cache = new Map<string, CacheEntry>();
    private readonly pending = new Set<string>();
    private readonly queued = new Map<string, RepositoryQuery>();
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private changedTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly onChangedEmitter = new vscode.EventEmitter<void>();
    /** Fires when snapshots change so diagnostics and completions refresh. */
    readonly onChanged = this.onChangedEmitter.event;

    constructor() {}

    snapshot(query: RepositoryQuery, request: boolean): RepositorySnapshot {
        const key = queryKey(query);
        const current = this.cache.get(key);
        const loading = this.pending.has(key) || this.queued.has(key);
        if (
            request &&
            repositoryDownloadsEnabled() &&
            (current === undefined || Date.now() - current.checked > (current.error == null ? 300_000 : 60_000))
        ) {
            this.queue(query);
        }
        return {
            index: current?.index ?? null,
            error: current?.error ?? null,
            loading,
            checked: current?.checked ?? 0,
        };
    }

    /** Test hook and successful-download cache priming. */
    remember(query: RepositoryQuery, index: ChartIndex): void {
        this.cache.set(queryKey(query), { index, error: null, checked: Date.now() });
        this.notifyChanged();
    }

    async refresh(queries: readonly RepositoryQuery[], notify: boolean, title = 'Load Helm chart repositories'): Promise<void> {
        const work = queries.filter(query => {
            const url = query.access.url;
            return (
                !url.includes('{{') &&
                !query.access.username.includes('{{') &&
                !query.access.password.includes('{{') &&
                (downloadable(query.access) || (query.access.oci && query.chart !== ''))
            );
        });
        const added: string[] = [];
        for (const query of work) {
            this.queued.delete(queryKey(query));
            const key = queryKey(query);
            if (this.pending.has(key)) continue;
            this.pending.add(key);
            added.push(key);
        }
        if (work.length === 0) return;
        this.notifyChanged();
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title, cancellable: true },
                async (progress, token) => {
                    for (let i = 0; i < work.length; i++) {
                        if (token.isCancellationRequested) return;
                        const query = work[i];
                        progress.report({ message: `Loading ${query.access.name}`, increment: (100 * (i + 1)) / work.length });
                        await this.load(query);
                    }
                },
            );
        } finally {
            // Only release the marks this run acquired: a key that was already
            // pending belongs to an in-flight background load and must survive.
            for (const key of added) this.pending.delete(key);
            this.notifyChanged();
        }
        if (!notify) return;
        const ready = work.filter(query => {
            const entry = this.cache.get(queryKey(query));
            return entry && entry.index != null && entry.error == null;
        }).length;
        const summary = `Loaded ${ready} of ${work.length} repository indexes or chart tag lists.`;
        if (ready === work.length) {
            void vscode.window.showInformationMessage('Helm chart repositories', summary);
        } else {
            const failures = work
                .map(query => this.cache.get(queryKey(query))?.error)
                .filter((error): error is string => error != null)
                .slice(0, 3)
                .map(error => preview(error));
            void this.warn('Helm chart repositories', summary + (failures.length ? '\n' + failures.join('\n') : ''), failures.join('\n\n'));
        }
    }

    private async load(query: RepositoryQuery): Promise<void> {
        const key = queryKey(query);
        try {
            const index = await loadRepository(query.access, query.chart);
            this.cache.set(key, { index, error: null, checked: Date.now() });
        } catch (error) {
            const previous = this.cache.get(key);
            const source = query.access.name + (query.chart === '' ? '' : '/' + query.chart);
            let endpoint = query.access.url;
            if (query.access.oci && !endpoint.includes('://')) endpoint = 'oci://' + endpoint;
            const message =
                `Repository '${source}' unavailable: ${reason(error, query.access)}\n` +
                `Repository URL: ${endpoint}\n` +
                (previous?.index != null ? 'Using the last downloaded index.' : 'Repository-name completion remains available.');
            this.cache.set(key, { index: previous?.index ?? null, error: clean(message, query.access), checked: Date.now() });
        }
    }

    warn(title: string, summary: string, details: string): void {
        void vscode.window
            .showWarningMessage(title, { modal: false, detail: summary }, 'Show Details')
            .then(choice => {
                if (choice === 'Show Details') {
                    channel().appendLine(details);
                    channel().show();
                }
            });
    }

    private queue(query: RepositoryQuery): void {
        this.queued.set(queryKey(query), query);
        if (this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            clearTimeout(this.refreshTimer as unknown as ReturnType<typeof setTimeout>);
            this.refreshTimer = null;
            const work = [...this.queued.values()];
            this.queued.clear();
            void this.refresh(work, false);
        }, 200);
    }

    private notifyChanged(): void {
        if (this.changedTimer) return;
        this.changedTimer = setTimeout(() => {
            clearTimeout(this.changedTimer as unknown as ReturnType<typeof setTimeout>);
            this.changedTimer = null;
            this.onChangedEmitter.fire();
        }, 200);
    }

    dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.changedTimer) clearTimeout(this.changedTimer);
        this.onChangedEmitter.dispose();
    }
}

/**
 * Cache identity. The password is intentionally omitted: it never changes the
 * fetched bytes (index/tags are identical for the same credentials realm) and
 * keeping it out of the key avoids leaking it into error/cache diagnostics.
 */
function queryKey(query: RepositoryQuery): string {
    return JSON.stringify([query.access.name, query.access.url, query.access.oci, query.access.username, query.chart]);
}
