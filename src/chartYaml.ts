/**
 * Completion for Chart.yaml `dependencies:` entries: dependency names and
 * versions from the charts/ directory next to the Chart.yaml, `repository:`
 * URLs from the helmfile state's `repositories:` declarations above the
 * chart, and `condition:` keys from the chart's values.yaml. Chart.yaml
 * keeps its YAML language; this provider matches by file pattern only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mappingGet, parseTree, rootMappings, scalarPathText, type YMapping } from './yamlTree';
import { stateFor } from './values';

/** Document selector that claims Chart.yaml/Chart.yml by pattern, not language. */
export const CHART_YAML_SELECTOR: vscode.DocumentSelector = [{ pattern: '**/Chart.yaml' }, { pattern: '**/Chart.yml' }];

const DEPENDENCY_FIELD = /^\s*(?:-\s+)?(name|version|repository|condition|tags|alias):\s*("?)([A-Za-z0-9._/\-]*)$/;
const DEPENDENCIES_KEY = /^(\s*)dependencies:\s*(?:#.*)?$/;

export class ChartYamlCompletionProvider implements vscode.CompletionItemProvider {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList {
        const file = document.uri.fsPath;
        if (path.basename(file) !== 'Chart.yaml' && path.basename(file) !== 'Chart.yml') return new vscode.CompletionList([], false);
        const line = document.lineAt(position.line).text.slice(0, position.character);
        const field = DEPENDENCY_FIELD.exec(line);
        if (!field) return new vscode.CompletionList([], false);
        const chartRoot = path.dirname(file);
        if (!inDependenciesBlock(document, position.line)) return new vscode.CompletionList([], false);

        const replaceStart = line.length - field[3].length;
        const replace = new vscode.Range(position.line, replaceStart, position.line, position.character);
        const items: vscode.CompletionItem[] = [];
        const dependencyName = dependencyNameAbove(document, position.line);
        switch (field[1]) {
            case 'name':
                for (const name of chartDirectoryNames(chartRoot)) {
                    items.push(item(name, `${path.join('charts', name)} dependency`, replace));
                }
                break;
            case 'version':
                if (dependencyName) {
                    const version = dependencyVersion(chartRoot, dependencyName);
                    if (version) items.push(item(version, `version of charts/${dependencyName}`, replace));
                }
                break;
            case 'repository':
                for (const url of repositoryUrls(chartRoot)) {
                    items.push(item(url, 'helmfile repositories declaration', replace));
                }
                break;
            case 'condition':
                for (const condition of conditionKeys(chartRoot, dependencyName)) {
                    items.push(item(condition, 'condition key in values.yaml', replace));
                }
                break;
        }
        return new vscode.CompletionList(items, false);
    }
}

function item(label: string, detail: string, replace: vscode.Range): vscode.CompletionItem {
    const completion = new vscode.CompletionItem(label, vscode.CompletionItemKind.Value);
    completion.detail = detail;
    completion.insertText = label;
    completion.range = replace;
    return completion;
}

/**
 * Whether the line sits inside the `dependencies:` block: the nearest
 * `dependencies:` key above whose indent is smaller than every
 * non-blank/non-comment line between it and the cursor line.
 */
function inDependenciesBlock(document: vscode.TextDocument, line: number): boolean {
    const lineIndent = indentOf(document.lineAt(line).text);
    for (let i = line - 1; i >= 0; i--) {
        const text = document.lineAt(i).text;
        if (text.trim() === '' || text.trim().startsWith('#')) continue;
        const indent = indentOf(text);
        if (indent >= lineIndent) continue; // same item or nested below it
        if (/^\s*-\s/.test(text)) continue; // an earlier item of the same sequence
        const key = DEPENDENCIES_KEY.exec(text);
        if (key) return true;
        return false; // a shallower key that is not `dependencies:`
    }
    return false;
}

function indentOf(text: string): number {
    const match = /^[ \t]*/.exec(text);
    return match ? match[0].replace(/\t/g, '    ').length : 0;
}

/** The `name:` of the dependency item the line belongs to (nearest `name:` above at item-key indent). */
function dependencyNameAbove(document: vscode.TextDocument, line: number): string | null {
    const lineIndent = indentOf(document.lineAt(line).text);
    for (let i = line - 1; i >= 0; i--) {
        const text = document.lineAt(i).text;
        if (text.trim() === '' || text.trim().startsWith('#')) continue;
        if (indentOf(text) > lineIndent) continue;
        const name = /^\s*(?:-\s*)?name:\s*"?([A-Za-z0-9._\-]+)"?/.exec(text);
        if (name) return name[1];
        if (/(^|\s)-\s+\S/.test(text)) return null; // started a new item without a name
    }
    return null;
}

/** Subdirectories of charts/ that are themselves charts. */
function chartDirectoryNames(chartRoot: string): string[] {
    const dir = path.join(chartRoot, 'charts');
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const names: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(dir, entry.name, 'Chart.yaml')) || fs.existsSync(path.join(dir, entry.name, 'Chart.yml'))) names.push(entry.name);
    }
    return names;
}

/** `version:` of charts/<name>/Chart.yaml, when the dependency is unpacked. */
function dependencyVersion(chartRoot: string, name: string): string | null {
    for (const marker of ['Chart.yaml', 'Chart.yml']) {
        const chart = readRootMapping(path.join(chartRoot, 'charts', name, marker));
        const version = chart && mappingGet(chart, 'version');
        if (version?.value && version.value.kind === 'scalar') {
            const text = scalarPathText(version.value);
            if (text) return text;
        }
    }
    return null;
}

/** `url:`s of the `repositories:` declarations in the nearest helmfile state above the chart. */
function repositoryUrls(chartRoot: string): string[] {
    const state = stateFor(vscode.Uri.file(path.join(chartRoot, 'Chart.yaml')));
    if (!state) return [];
    const urls: string[] = [];
    for (const root of rootMappings(state.tree)) {
        const repositories = mappingGet(root, 'repositories');
        if (!repositories?.value || repositories.value.kind !== 'sequence') continue;
        for (const entry of repositories.value.items) {
            if (entry.kind !== 'mapping') continue;
            const url = mappingGet(entry as YMapping, 'url');
            const text = url?.value && url.value.kind === 'scalar' ? scalarPathText(url.value) : null;
            if (text && !urls.includes(text)) urls.push(text);
        }
    }
    return urls;
}

/** `<dependency>.enabled` plus any `*.enabled` keys present in the chart's values.yaml. */
function conditionKeys(chartRoot: string, dependencyName: string | null): string[] {
    const conditions: string[] = [];
    if (dependencyName) conditions.push(`${dependencyName}.enabled`);
    const values = readRootMapping(path.join(chartRoot, 'values.yaml'));
    for (const pair of values?.pairs ?? []) {
        if (pair.key && pair.key.endsWith('.enabled') && !conditions.includes(pair.key)) conditions.push(pair.key);
    }
    return conditions;
}

function readRootMapping(file: string): YMapping | null {
    try {
        return rootMappings(parseTree(fs.readFileSync(file, 'utf8')))[0] ?? null;
    } catch {
        return null;
    }
}
