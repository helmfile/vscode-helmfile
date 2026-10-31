/**
 * Completion for Helmfile state files, ported from
 * HelmfileCompletionContributor (function + values paths),
 * HelmfileSchema (mapping keys), HelmfileBlockCompletion (block snippets)
 * and HelmfileRepositoryCompletion (repository/chart/version fields).
 */
import * as vscode from 'vscode';
import { TemplateScanner } from './templateScanner';
import { allFunctions, functionMarkdown } from './functionCatalog';
import { nodeAt, parseTree, rootMappings, type YPair, type YMapping } from './yamlTree';
import { completionPath, schemaContext, schemaFields, type Field } from './schema';
import { childKeys, SEPARATOR, valuesModel, type SourceFile, type ValuesDefinition } from './values';
import { repositoryDownloadsEnabled } from './settings';
import { chart, query, repositoryModel, type RepositoryQuery } from './repositories';
import { repositoryService } from './repositoryService';
import { contextualCompletions, localChartCompletions } from './contextualCompletion';

/** Completion for values paths inside Go template actions, e.g. `.Values.image.` */
const PATH_PREFIX = /(\$?\.(?:Values|StateValues|Environment\.Values)\.)([A-Za-z0-9_.]*)$/;

/** Context paths offered in addition to catalog functions inside actions. */
const CONTEXT_PATHS = [
    '.Values',
    '.StateValues',
    '.Environment.Name',
    '.Environment.Values',
    '.Environment.KubeContext',
    '.Release.Name',
    '.Release.Namespace',
    '.Release.Chart',
    '.Release.Labels',
    '$.Values',
    '$.Environment.Name',
];

export class HelmfileCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly env: () => string) {}

    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const uri = document.uri;
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
        const prefix = text.slice(lineStart, offset);

        if (TemplateScanner.at(text, offset)) {
            return this.actionCompletions(uri, text, offset);
        }

        const tree = parseTree(text);
        const source: SourceFile = { uri, text, tree };
        const repository = this.repositoryCompletions(source, offset, prefix);
        if (repository) return repository;

        const contextual = contextualCompletions(source, offset, this.env());
        if (contextual) return contextual;

        return this.fieldCompletions(source, offset);
    }

    private actionCompletions(uri: vscode.Uri, text: string, offset: number): vscode.CompletionList {
        const head = text.slice(Math.max(0, offset - 500), offset);
        const pathMatch = PATH_PREFIX.exec(head);
        if (pathMatch) {
            const parent = pathMatch[1] + pathMatch[2];
            const model = valuesModel(uri, this.env());
            if (!model) return new vscode.CompletionList([], false);
            const definitions = childKeys(model, parent);
            const items: vscode.CompletionItem[] = [];
            const existing = new Set<string>();
            for (const definition of definitions) {
                const key = lastSegment(definition.path);
                if (existing.has(key)) continue;
                existing.add(key);
                const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Variable);
                item.detail = definition.preview || key;
                item.documentation = new vscode.MarkdownString(sourceLabel(definition));
                item.insertText = key;
                items.push(item);
            }
            return new vscode.CompletionList(items, false);
        }

        const items: vscode.CompletionItem[] = [];
        for (const func of allFunctions()) {
            const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
            item.detail = func.signature;
            item.documentation = functionMarkdown(func);
            item.insertText = func.name;
            items.push(item);
        }
        for (const path of CONTEXT_PATHS) {
            const item = new vscode.CompletionItem(path, vscode.CompletionItemKind.Variable);
            item.detail = 'Helmfile state value path';
            item.insertText = path;
            items.push(item);
        }
        return new vscode.CompletionList(items, false);
    }

    private repositoryCompletions(source: SourceFile, offset: number, prefix: string): vscode.CompletionList | null {
        const match = /^([ \t]*(?:-\s*)?)(chart|version):[ \t]*(['"]?)([^'"\r\n]*)$/.exec(prefix);
        if (!match) return null;
        const field = match[2];
        const value = match[4];
        if (value.includes('{{') || value.includes(' #')) return null;

        const path = completionPath(source.text, offset);
        const context = path ? schemaContext(path) : null;
        if (context !== 'releases' && context !== 'dependencies') return null;

        const env = this.env();

        if (field === 'chart') {
            if (value.startsWith('.')) return localChartCompletions(source, value);
            return this.chartCompletions(source.uri, env, value);
        }

        const pair = keyPairAt(source.tree, offset);
        const mapping = pair && pair.value && pair.value.kind === 'mapping' ? pair.value : enclosingMapping(nodeAt(source.tree, offset));
        if (!mapping) return new vscode.CompletionList([], false);
        return this.versionCompletions(source, mapping, env);
    }

    private chartCompletions(uri: vscode.Uri, env: string, value: string): vscode.CompletionList {
        const model = repositoryModel(uri, env);
        const slash = value.indexOf('/');
        const aliasPart = slash >= 0 ? value.slice(0, slash) : value;
        const chartPart = slash >= 0 ? value.slice(slash + 1) : null;

        if (chartPart === null) {
            const items: vscode.CompletionItem[] = [];
            for (const entry of model.entries) {
                const item = new vscode.CompletionItem(entry.name + '/', vscode.CompletionItemKind.Module);
                item.detail = entry.access.oci ? 'OCI repository' : 'Helm repository';
                item.documentation = new vscode.MarkdownString(entry.access.url || entry.name);
                item.insertText = entry.name + '/';
                item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
                items.push(item);
            }
            return new vscode.CompletionList(items, false);
        }

        const entry = model.entries.find(candidate => candidate.name === aliasPart);
        if (!entry) return new vscode.CompletionList([], false);
        if (!entry.access.oci) {
            const query: RepositoryQuery = { access: entry.access, chart: '' };
            const snapshot = repositoryService().snapshot(query, repositoryDownloadsEnabled());
            const items: vscode.CompletionItem[] = [];
            if (snapshot.index) {
                for (const [name, versions] of snapshot.index.charts) {
                    const latest = versions[0];
                    const item = new vscode.CompletionItem(aliasPart + '/' + name, vscode.CompletionItemKind.Module);
                    item.detail = 'version';
                    item.documentation = new vscode.MarkdownString(latest?.description || name);
                    item.insertText = aliasPart + '/' + name;
                    if (versions.every(version => version.deprecated)) {
                        item.tags = [vscode.CompletionItemTag.Deprecated];
                    }
                    items.push(item);
                }
            } else {
                items.push(...advertise(snapshot));
            }
            return new vscode.CompletionList(items, false);
        }

        // OCI registries do not provide a Helm chart index.
        const item = new vscode.CompletionItem('OCI registries do not provide a Helm chart index…', vscode.CompletionItemKind.Text);
        return new vscode.CompletionList([item], false);
    }

    private versionCompletions(source: SourceFile, mapping: YMapping, env: string): vscode.CompletionList {
        const chartText = chart(source, mapping, env, new Set());
        const request = query(source.uri, chartText, env);
        const items: vscode.CompletionItem[] = [];
        if (!request) return new vscode.CompletionList(items, false);
        const snapshot = repositoryService().snapshot(request, repositoryDownloadsEnabled());
        if (snapshot.index) {
            let order = 0;
            for (const versions of snapshot.index.charts.values()) {
                for (const entry of versions) {
                    const item = new vscode.CompletionItem(entry.version, vscode.CompletionItemKind.Constant);
                    item.sortText = String(order++).padStart(6, '0');
                    item.insertText = entry.version;
                    items.push(item);
                }
            }
        } else {
            items.push(...advertise(snapshot));
        }
        return new vscode.CompletionList(items, false);
    }

    private fieldCompletions(source: SourceFile, offset: number): vscode.CompletionList {
        const path = completionPath(source.text, offset);
        if (!path) return new vscode.CompletionList([], false);
        const context = schemaContext(path);
        const items: vscode.CompletionItem[] = [];

        if (context === 'releases' || context === 'dependencies' || context === 'repositories') {
            const word = path.length ? path[path.length - 1] : '';
            const trigger = context === 'releases' ? 'release' : context === 'dependencies' ? 'dependency' : 'repository';
            if (word === trigger || trigger.startsWith(word)) {
                const item = new vscode.CompletionItem(trigger + ' (block)', vscode.CompletionItemKind.Snippet);
                item.detail = 'Helmfile block';
                item.documentation = new vscode.MarkdownString('Insert the required fields; Tab moves between values.');
                item.insertText = blockSnippet(context);
                item.sortText = '00000';
                items.push(item);
            }
        }

        // Keys already present in the enclosing mapping are noise: hide them.
        const mapping = enclosingMapping(nodeAt(source.tree, offset)) ?? rootMappings(source.tree)[0];
        const existing = new Set<string>(mapping ? mapping.pairs.map((pair: YPair) => pair.key) : []);
        const order = FIELD_ORDER[context] ?? [];
        for (const field of schemaFields(context)) {
            if (existing.has(field.name)) continue;
            items.push(fieldItem(field, sortKey(order.indexOf(field.name), field.name)));
        }
        return new vscode.CompletionList(items, false);
    }
}

function fieldItem(field: Field, sortText?: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
    item.detail = field.type;
    item.documentation = new vscode.MarkdownString(field.description);
    item.insertText = new vscode.SnippetString(field.name + ': ');
    if (sortText) item.sortText = sortText;
    return item;
}

/** Typical field order per context: most-used keys surface first. */
const FIELD_ORDER: Record<string, readonly string[]> = {
    releases: ['name', 'chart', 'version', 'namespace', 'values', 'set', 'setString', 'needs', 'condition', 'installed', 'createNamespace', 'wait', 'waitForJobs', 'timeout', 'kubeContext', 'labels', 'inherit', 'dependencies', 'hooks', 'secrets', 'setFile'],
    dependencies: ['chart', 'version', 'alias'],
    repositories: ['name', 'url', 'oci', 'username', 'password', 'caFile', 'certFile', 'keyFile', 'skipTLSVerify', 'passCredentials'],
    environment: ['values', 'secrets', 'kubeContext', 'missingFileHandler'],
    hooks: ['events', 'command', 'args', 'showlogs'],
    set: ['name', 'value', 'file', 'values'],
};

function sortKey(index: number, name: string): string {
    return String(index >= 0 ? index : 500).padStart(3, '0') + name;
}

function advertise(snapshot: { error: string | null; loading: boolean }): vscode.CompletionItem[] {
    if (snapshot.loading) {
        return [new vscode.CompletionItem('Loading repository metadata in the background…', vscode.CompletionItemKind.Text)];
    }
    if (snapshot.error) {
        return [new vscode.CompletionItem('Repository metadata unavailable: ' + snapshot.error, vscode.CompletionItemKind.Text)];
    }
    return [];
}

function sourceLabel(definition: ValuesDefinition): string {
    return definition.environment ? `${definition.origin} · ${definition.environment}` : definition.origin;
}

function lastSegment(path: string): string {
    const index = path.lastIndexOf(SEPARATOR);
    return index >= 0 ? path.slice(index + 1) : path;
}

/**
 * IntelliJ's block templates expand into a full list item. The VSCode port
 * offers a snippet that appends the item under the typed key.
 */
function blockSnippet(context: string): vscode.SnippetString {
    switch (context) {
        case 'repositories':
            return new vscode.SnippetString('repository\n- name: ${1:name}\n  url: ${2:https://}');
        case 'dependencies':
            return new vscode.SnippetString('dependency\n- chart: ${1:chart}\n  version: ${2:version}');
        default:
            return new vscode.SnippetString('release\n- name: ${1:name}\n  chart: ${2:chart}\n  version: ${3:version}');
    }
}

/** Nearest mapping that contains `node`. */
function enclosingMapping(node: import('./yamlTree').TreeNode | null): YMapping | null {
    let current = node;
    while (current) {
        if (current.kind === 'mapping') return current;
        current = current.parent as import('./yamlTree').TreeNode | null;
    }
    return null;
}

/**
 * The mapping that owns the key at `offset`: the release/dependency item
 * mapping whose `chart` and `version` fields are being completed.
 */
function keyPairAt(tree: import('./yamlTree').YTree, offset: number): YPair | null {
    const node = nodeAt(tree, offset);
    let current: import('./yamlTree').TreeNode | null = node;
    while (current) {
        if (current.kind === 'pair') return current;
        current = current.parent as import('./yamlTree').TreeNode | null;
    }
    return null;
}
