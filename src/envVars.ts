import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Variable names offered inside `{{ env "…" }}` / `{{ requiredEnv "…" }}`:
 * keys parsed from `.env` files at the workspace roots plus the extension
 * host process environment. Project-local `.env` entries sort first.
 */

interface EnvFileEntry {
    readonly uri: vscode.Uri;
    readonly mtimeMs: number;
    readonly vars: ReadonlyMap<string, string>;
}

const cache = new Map<string, EnvFileEntry>();

function readEnvFile(uri: vscode.Uri): EnvFileEntry | null {
    try {
        const stat = fs.statSync(uri.fsPath);
        const cached = cache.get(uri.fsPath);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
        const text = fs.readFileSync(uri.fsPath, 'utf8');
        const vars = new Map<string, string>();
        for (const line of text.split(/\r?\n/)) {
            const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
            if (!match) continue;
            let value = match[2].trim();
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
                value = value.slice(1, -1);
            }
            vars.set(match[1], value);
        }
        const entry: EnvFileEntry = { uri, mtimeMs: stat.mtimeMs, vars };
        cache.set(uri.fsPath, entry);
        return entry;
    } catch {
        return null;
    }
}

export interface EnvVarSuggestion {
    readonly name: string;
    readonly value: string;
    readonly source: 'env file' | 'environment';
}

/** Suggestions for `{{ env "…" }}` completion. `.env` keys shadow process env. */
export function envVarSuggestions(): readonly EnvVarSuggestion[] {
    const merged = new Map<string, EnvVarSuggestion>();
    for (const [name, value] of Object.entries(process.env)) {
        if (!name || value === undefined) continue;
        merged.set(name, { name, value, source: 'environment' });
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        for (const name of ['.env', '.env.local']) {
            const entry = readEnvFile(vscode.Uri.joinPath(folder.uri, name));
            if (!entry) continue;
            for (const [key, value] of entry.vars) {
                merged.set(key, { name: key, value, source: 'env file' });
            }
        }
    }
    return [...merged.values()].sort((a, b) => {
        if (a.source !== b.source) return a.source === 'env file' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

/** Path utilities shared with tests. */
export const envVarsForTest = { readEnvFile, envPath: (dir: string): string => path.join(dir, '.env') };
