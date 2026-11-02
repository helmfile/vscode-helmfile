/**
 * Completion for Helmfile state files, ported from
 * HelmfileCompletionContributor (function + values paths),
 * HelmfileSchema (mapping keys), HelmfileBlockCompletion (block snippets)
 * and HelmfileRepositoryCompletion (repository/chart/version fields).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { TemplateScanner } from './templateScanner';
import { allFunctions, functionMarkdown } from './functionCatalog';
import { envVarSuggestions } from './envVars';
import { chartValueKeys, chartValuesContextFor, type ChartValuesContext } from './chartValues';
import { nodeAt, parseTree, rootMappings, type YPair, type YMapping } from './yamlTree';
import { completionPath, schemaContext, schemaFields, type Field } from './schema';
import { chartTemplateContextFor, chartTemplateDetected, chartFileOf, CHART_BUILTIN_SUFFIX, CHART_BUILTINS, CHART_ROOT_PATHS, type ChartTemplateContext } from './chartContext';
import { chartModelFor, iterationBaseModel, subchartModel, type ChartKey } from './chartModel';
import { chartDefinesFor } from './chartDefines';
import { enclosingIteration } from './chartIteration';
import { snippetsFor } from './templateSnippets';
import { childKeys, contentStamp, SEPARATOR, valuesModel, type SourceFile, type ValuesDefinition } from './values';
import { repositoryDownloadsEnabled } from './settings';
import { chart, query, repositoryModel, type RepositoryQuery } from './repositories';
import type { ChartEntry, ChartIndex } from './chartIndex';
import { repositoryService } from './repositoryService';
import { contextualCompletions, localChartCompletions } from './contextualCompletion';
import { offsetRange } from './position';

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

/**
 * Versions of the completion target chart only. OCI queries carry the
 * chart name in `request.chart`; HTTP indexes are keyed by the chart
 * segment after the repository alias (mirrors HelmfileRepositoryCompletion).
 */
export function chartVersions(chartText: string, request: RepositoryQuery, index: ChartIndex): readonly ChartEntry[] {
    const name = request.access.oci ? request.chart : chartText.slice(chartText.indexOf('/') + 1);
    return index.charts.get(name) ?? [];
}

/** Detail line shared by chart values completions: the default when scalar, the owning chart otherwise. */
function chartKeyDetail(key: { readonly preview: string }, chart: string): string {
    return key.preview && key.preview !== 'mapping' && key.preview !== 'list'
        ? `chart default: ${key.preview.slice(0, 100)}`
        : `chart value (${chart})`;
}

/** Length of the segment being completed after the last `.` of a value path. */
function segmentLength(partial: string): number {
    const lastDot = partial.lastIndexOf('.');
    return lastDot >= 0 ? partial.length - lastDot - 1 : partial.length;
}

/** `image.rep` → parent `[image]`, partial `rep`; `image.` → parent `[image]`, partial ``. */
function splitPartial(pathText: string): { parent: string[]; partial: string } {
    if (pathText.endsWith('.')) return { parent: pathText.split('.').filter(segment => segment.length > 0), partial: '' };
    const segments = pathText.split('.');
    const partial = segments.pop() ?? '';
    return { parent: segments.filter(segment => segment.length > 0), partial };
}

/** Completion items for effective chart keys, with source labels and previews. */
function keyItems(keys: readonly ChartKey[], text: string, offset: number, typedLength: number): vscode.CompletionList {
    const replace = offsetRange(text, offset - typedLength, offset);
    const items: vscode.CompletionItem[] = [];
    for (const key of keys) {
        const item = new vscode.CompletionItem(key.key, vscode.CompletionItemKind.Variable);
        item.detail = key.source ?? 'chart value';
        const documentation = new vscode.MarkdownString();
        if (key.preview) documentation.appendCodeblock(key.preview, 'yaml');
        if (key.description) documentation.appendMarkdown('\n\n' + key.description);
        if (documentation.value.length > 0) item.documentation = documentation;
        item.insertText = key.key;
        item.range = replace;
        items.push(item);
    }
    return new vscode.CompletionList(items, false);
}

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

        // Chart template files (under <chart>/templates/) are Helm
        // templates, not Helmfile state: no state field/repository
        // completion. Actions above still get template completions.
        if (chartTemplateDetected(chartFileOf(uri), contentStamp())) {
            return new vscode.CompletionList([], false);
        }

        const tree = parseTree(text);
        const source: SourceFile = { uri, text, tree };

        // Values files (*.yaml.gotmpl under a release's `values:` list) get
        // chart-aware key completion instead of state-field completion.
        const chartValues = chartValuesContextFor(uri, this.env());
        if (chartValues) return this.chartValuesCompletions(source, offset, chartValues);

        const repository = this.repositoryCompletions(source, offset, prefix);
        if (repository) return repository;

        const contextual = contextualCompletions(source, offset, this.env());
        if (contextual) return contextual;

        return this.fieldCompletions(source, offset);
    }

    private actionCompletions(uri: vscode.Uri, text: string, offset: number): vscode.CompletionList {
        const chartTemplate = chartTemplateContextFor(chartFileOf(uri), contentStamp());
        // Chart file with `helmfile.chartSupport: false`: generic template
        // help only — no chart values, no Helmfile state paths.
        const chartDetected = chartTemplate !== null || chartTemplateDetected(chartFileOf(uri), contentStamp());
        const head = text.slice(Math.max(0, offset - 500), offset);
        const envMatch = /\b(?:env|requiredEnv)\s*"([^"\r\n]*)$/.exec(head);
        if (envMatch) {
            const items: vscode.CompletionItem[] = [];
            let rank = 0;
            for (const suggestion of envVarSuggestions()) {
                const item = new vscode.CompletionItem(suggestion.name, vscode.CompletionItemKind.Variable);
                item.detail = suggestion.value === '' ? '(empty)' : suggestion.value.slice(0, 80);
                item.documentation = new vscode.MarkdownString(`Environment variable from the ${suggestion.source}.`);
                item.insertText = suggestion.name;
                item.range = offsetRange(text, offset - envMatch[1].length, offset);
                item.sortText = String(rank++).padStart(4, '0') + suggestion.name;
                items.push(item);
            }
            return new vscode.CompletionList(items, false);
        }
        const pathMatch = PATH_PREFIX.exec(head);
        if (pathMatch) {
            if (chartTemplate) return this.chartValueCompletions(text, offset, chartTemplate, pathMatch);
            if (chartDetected) return new vscode.CompletionList([], false);
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
                item.range = offsetRange(text, offset - segmentLength(pathMatch[2]), offset);
                items.push(item);
            }
            return new vscode.CompletionList(items, false);
        }
        // `.Chart.` / `.Release.` … built-in Helm template variables, plus the
        // `.Subcharts.<name>.Values.` drill-down.
        if (chartTemplate) {
            const builtinMatch = CHART_BUILTIN_SUFFIX.exec(head);
            if (builtinMatch) {
                if (builtinMatch[1] === 'Subcharts' && /^\.[A-Za-z0-9_]+\.Values\./.test(builtinMatch[2])) {
                    return this.subchartValueCompletions(text, offset, chartTemplate, builtinMatch[2]);
                }
                return this.chartBuiltinCompletions(text, offset, chartTemplate, builtinMatch[1] + builtinMatch[2]);
            }
            const files = this.chartFileCompletions(text, offset, chartTemplate);
            if (files) return files;
            const defines = this.defineNameCompletions(uri, text, offset, chartTemplate);
            if (defines) return defines;
        }

        const items: vscode.CompletionItem[] = [];
        // Replace the whole partial token: the leading `.`/`$` of `.Values`
        // etc. is not part of VSCode's default word definition, so without an
        // explicit range acceptance appends to the typed dot (`..Values`).
        const wordMatch = /[$.A-Za-z_][A-Za-z0-9_.$]*$/.exec(head);
        const replace = offsetRange(text, offset - (wordMatch ? wordMatch[0].length : 0), offset);
        for (const func of allFunctions()) {
            const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
            item.detail = func.signature;
            item.documentation = functionMarkdown(func);
            item.insertText = func.name;
            item.range = replace;
            items.push(item);
        }
        if (chartTemplate) {
            const typed = wordMatch ? wordMatch[0] : '';
            const dollar = typed.startsWith('$');
            const labelPrefix = dollar ? '$.' : '.';
            for (const root of CHART_ROOT_PATHS) {
                const label = labelPrefix + root;
                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Variable);
                item.detail = 'Helm template variable';
                item.insertText = label;
                item.range = replace;
                items.push(item);
            }
            // Inside `range`/`with`, `.` refers to the iterated element: offer
            // its keys for relative paths (`.field`) that are not root names.
            if (!dollar && /^\.[A-Za-z0-9_.]*$/.test(typed)) {
                const { parent, partial } = splitPartial(typed.slice(1));
                this.iterationCompletions(text, offset, chartTemplate, parent, partial, items);
            }
        } else if (!chartDetected) {
            for (const path of CONTEXT_PATHS) {
                const item = new vscode.CompletionItem(path, vscode.CompletionItemKind.Variable);
                item.detail = 'Helmfile state value path';
                item.insertText = path;
                item.range = replace;
                items.push(item);
            }
        }
        // Skeleton snippets (range/with/if/…) for both state and chart files.
        const wordPart = /[A-Za-z_][A-Za-z0-9_]*$/.exec(head);
        if (wordPart) {
            for (const snippet of snippetsFor(wordPart[0])) {
                const item = new vscode.CompletionItem(snippet.trigger, vscode.CompletionItemKind.Snippet);
                item.detail = snippet.detail;
                item.documentation = new vscode.MarkdownString('```go-template\n' + snippet.body + '\n```');
                item.insertText = new vscode.SnippetString(snippet.body);
                item.sortText = '0000' + snippet.trigger;
                item.range = offsetRange(text, offset - wordPart[0].length, offset);
                items.push(item);
            }
        }
        return new vscode.CompletionList(items, false);
    }

    /** `.Values.` keys of the chart's effective values: chart defaults overlaid by helmfile releases. */
    private chartValueCompletions(text: string, offset: number, context: ChartTemplateContext, pathMatch: RegExpMatchArray): vscode.CompletionList {
        const valuesPrefix = pathMatch[1] === '.Values.' || pathMatch[1] === '$.Values.'; // `$` is Helm's root context
        if (!valuesPrefix) return new vscode.CompletionList([], false);
        // `.Subcharts.<name>.Values.` resolves against the dependency's own
        // values.yaml, not this chart's merged values.
        const head = text.slice(Math.max(0, offset - 500), offset);
        const subchart = /(?:^|[^.A-Za-z0-9_])\$?\.Subcharts\.([A-Za-z0-9_]+)\.Values\.$/.exec(head);
        if (subchart) {
            const model = subchartModel(context, subchart[1], contentStamp());
            if (model) return keyItems(model.keysUnder([]), text, offset, segmentLength(pathMatch[2]));
        }
        const { parent, partial } = splitPartial(pathMatch[2]);
        const model = chartModelFor(context, contentStamp(), this.env());
        return keyItems(model.keysUnder(parent).filter(key => key.key.startsWith(partial)), text, offset, segmentLength(pathMatch[2]));
    }

    /** `.Subcharts.<name>.Values.` keys, resolved against the dependency's own values.yaml. */
    private subchartValueCompletions(text: string, offset: number, context: ChartTemplateContext, typedSuffix: string): vscode.CompletionList {
        const segments = typedSuffix.split('.').filter(segment => segment.length > 0); // [name, 'Values', ...rest]
        const model = subchartModel(context, segments[0], contentStamp());
        if (!model) return new vscode.CompletionList([], false);
        const { parent, partial } = splitPartial(segments.slice(2).join('.'));
        return keyItems(model.keysUnder(parent).filter(key => key.key.startsWith(partial)), text, offset, segmentLength(typedSuffix));
    }

    /** Quoted path literals of `.Files.Get "…"` / `.Files.Glob "…"`. */
    private chartFileCompletions(text: string, offset: number, context: ChartTemplateContext): vscode.CompletionList | null {
        const head = text.slice(Math.max(0, offset - 500), offset);
        const match = /(?:\$)?\.Files\.(?:Get|GetBytes|Glob|Lines)\s*"([^"\r\n]*)$/.exec(head);
        if (!match) return null;
        const model = chartModelFor(context, contentStamp(), this.env());
        const items: vscode.CompletionItem[] = [];
        for (const file of model.files) {
            if (!file.startsWith(match[1])) continue;
            const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
            item.detail = 'chart file';
            item.insertText = file;
            item.range = offsetRange(text, offset - match[1].length, offset);
            items.push(item);
        }
        return new vscode.CompletionList(items, false);
    }

    /** Quoted template names of `include "…"` / `template "…"`. */
    private defineNameCompletions(uri: vscode.Uri, text: string, offset: number, context: ChartTemplateContext): vscode.CompletionList | null {
        const head = text.slice(Math.max(0, offset - 500), offset);
        const match = /\b(?:include|template)\s*"([^"\r\n]*)$/.exec(head);
        if (!match) return null;
        const defines = chartDefinesFor(context, contentStamp(), { file: uri.fsPath, text });
        const items: vscode.CompletionItem[] = [];
        const seen = new Set<string>();
        for (const define of defines) {
            if (!define.name.startsWith(match[1]) || seen.has(define.name)) continue;
            seen.add(define.name);
            const item = new vscode.CompletionItem(define.name, vscode.CompletionItemKind.Reference);
            item.detail = `define · ${path.basename(define.file)}`;
            item.documentation = new vscode.MarkdownString('```go-template\n' + (define.body || '(empty)') + '\n```');
            item.insertText = define.name;
            item.range = offsetRange(text, offset - match[1].length, offset);
            items.push(item);
        }
        return new vscode.CompletionList(items, false);
    }

    /**
     * Keys of the element `.` refers to inside the innermost `range`/`with`.
     * `parent` are the typed path segments before the partial word.
     */
    private iterationCompletions(text: string, offset: number, context: ChartTemplateContext, parent: readonly string[], partial: string, items: vscode.CompletionItem[]): void {
        const iteration = enclosingIteration(text, offset);
        if (!iteration) return;
        const base = iterationBaseModel(iteration.path, context, contentStamp(), this.env());
        if (!base) return;
        const info = base.model.valueAt(base.segments);
        if (!info) return;
        // `range` over a list iterates elements; `with` narrows to the value itself.
        const keys = parent.length === 0 && (iteration.keyword === 'range' && info.kind === 'list')
            ? base.model.elementKeys(base.segments)
            : base.model.keysUnder([...base.segments, ...parent]);
        const replace = offsetRange(text, offset - partial.length, offset);
        for (const key of keys) {
            if (!key.key.startsWith(partial)) continue;
            const item = new vscode.CompletionItem(key.key, vscode.CompletionItemKind.Variable);
            item.detail = key.source ?? 'list element';
            if (key.description) item.documentation = new vscode.MarkdownString(key.description);
            item.insertText = key.key;
            item.range = replace;
            items.push(item);
        }
    }

    /**
     * Sub-paths of the built-in Helm template variables: completes the next
     * path segment after the typed anchor (`.Capabilities.` → `KubeVersion`),
     * deduplicated across the catalog's deeper entries.
     */
    private chartBuiltinCompletions(text: string, offset: number, context: ChartTemplateContext, typed: string): vscode.CompletionList {
        const partial = typed.slice(typed.lastIndexOf('.') + 1);
        const anchor = typed.slice(0, typed.length - partial.length); // dotted prefix ending in '.', or ''
        const replace = offsetRange(text, offset - partial.length, offset);
        const items: vscode.CompletionItem[] = [];
        if (anchor === 'Subcharts.') {
            for (const name of context.subcharts) {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
                item.detail = 'Subchart';
                item.insertText = name;
                item.range = replace;
                items.push(item);
            }
            return new vscode.CompletionList(items, false);
        }
        const seen = new Set<string>();
        for (const builtin of CHART_BUILTINS) {
            if (!builtin.path.startsWith(anchor)) continue;
            const rest = builtin.path.slice(anchor.length);
            const dot = rest.indexOf('.');
            const label = dot === -1 ? rest : rest.slice(0, dot);
            if (!label.startsWith(partial) || label === partial || seen.has(label)) continue;
            seen.add(label);
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Variable);
            if (dot === -1) {
                item.detail = builtin.detail;
                item.documentation = new vscode.MarkdownString(builtin.documentation);
            } else {
                item.detail = 'Helm template variable';
                item.documentation = new vscode.MarkdownString(`Prefix of the built-in \`${anchor}${label}\` variable — keep typing for its fields.`);
            }
            item.insertText = label;
            item.range = replace;
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
        // Chart names/versions contain `-` and `/`, which the default word
        // definition treats as separators — replace the whole typed value.
        const replace = offsetRange(source.text, offset - value.length, offset);

        if (field === 'chart') {
            if (value.startsWith('.')) {
                const list = localChartCompletions(source, value);
                for (const item of list.items) item.range = replace;
                return list;
            }
            return this.chartCompletions(source.uri, env, value, replace);
        }

        const pair = keyPairAt(source.tree, offset);
        const mapping = pair && pair.value && pair.value.kind === 'mapping' ? pair.value : enclosingMapping(nodeAt(source.tree, offset));
        if (!mapping) return new vscode.CompletionList([], false);
        return this.versionCompletions(source, mapping, env, replace);
    }

    private chartCompletions(uri: vscode.Uri, env: string, value: string, replace: vscode.Range): vscode.CompletionList {
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
                item.range = replace;
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
                    item.detail = latest ? latest.version : 'chart';
                    item.documentation = new vscode.MarkdownString(latest?.description || name);
                    item.insertText = aliasPart + '/' + name;
                    if (versions.every(version => version.deprecated)) {
                        item.tags = [vscode.CompletionItemTag.Deprecated];
                    }
                    item.range = replace;
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

    private versionCompletions(source: SourceFile, mapping: YMapping, env: string, replace: vscode.Range): vscode.CompletionList {
        const chartText = chart(source, mapping, env, new Set());
        const request = query(source.uri, chartText, env);
        const items: vscode.CompletionItem[] = [];
        if (!request) return new vscode.CompletionList(items, false);
        const snapshot = repositoryService().snapshot(request, repositoryDownloadsEnabled());
        if (snapshot.index) {
            let order = 0;
            for (const entry of chartVersions(chartText, request, snapshot.index)) {
                const item = new vscode.CompletionItem(entry.version, vscode.CompletionItemKind.Constant);
                item.sortText = String(order++).padStart(6, '0');
                item.insertText = entry.version;
                item.range = replace;
                if (entry.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
                items.push(item);
            }
        } else {
            items.push(...advertise(snapshot));
        }
        return new vscode.CompletionList(items, false);
    }

    private chartValuesCompletions(source: SourceFile, offset: number, context: ChartValuesContext): vscode.CompletionList {
        if (!context.tree) return new vscode.CompletionList([], false);
        const path = completionPath(source.text, offset);
        if (!path) return new vscode.CompletionList([], false);
        const mapping = enclosingMapping(nodeAt(source.tree, offset)) ?? rootMappings(source.tree)[0];
        const existing = new Set<string>(mapping ? mapping.pairs.map((pair: YPair) => pair.key) : []);
        const replace = offsetRange(source.text, offset - typedWord(source.text, offset).length, offset);
        const items: vscode.CompletionItem[] = [];
        for (const key of chartValueKeys(context, path)) {
            if (existing.has(key.key)) continue;
            const item = new vscode.CompletionItem(key.key, vscode.CompletionItemKind.Property);
            item.detail = chartKeyDetail(key, context.chart);
            item.documentation = new vscode.MarkdownString(`Key defined by \`${context.chart}\`'s values.yaml.`);
            item.insertText = new vscode.SnippetString(key.key + ': ');
            item.range = replace;
            items.push(item);
        }
        return new vscode.CompletionList(items, false);
    }

    private fieldCompletions(source: SourceFile, offset: number): vscode.CompletionList {
        const path = completionPath(source.text, offset);
        if (!path) return new vscode.CompletionList([], false);
        const context = schemaContext(path);
        const items: vscode.CompletionItem[] = [];

        // Two IntelliJ block forms: the section key typed at the root
        // (`releases:` + first item) and the alias typed as a list item
        // (`- release` expands into name/chart/version). The replace range
        // must cover the typed word — appending would double it.
        const typed = typedWord(source.text, offset);
        const sectionAtRoot = context === ''
            ? (['releases', 'repositories'].find(name => name.startsWith(typed) && typed.length > 0) ?? null)
            : null;
        const listItem = context === 'releases' || context === 'dependencies' || context === 'repositories'
            ? (context === 'releases' ? 'release' : context === 'dependencies' ? 'dependency' : 'repository')
            : null;
        const trigger = sectionAtRoot ?? (listItem && listItem.startsWith(typed) ? listItem : null);
        if (trigger) {
            const item = new vscode.CompletionItem(trigger + ' (block)', vscode.CompletionItemKind.Snippet);
            item.detail = 'Helmfile block';
            item.documentation = new vscode.MarkdownString('Insert the required fields; Tab moves between values.');
            item.insertText = blockSnippet(trigger, sectionAtRoot != null, source.text, offset);
            item.sortText = '00000';
            item.range = offsetRange(source.text, offset - typed.length, offset);
            items.push(item);
        }

        // Keys already present in the enclosing mapping are noise: hide them.
        const mapping = enclosingMapping(nodeAt(source.tree, offset)) ?? rootMappings(source.tree)[0];
        const existing = new Set<string>(mapping ? mapping.pairs.map((pair: YPair) => pair.key) : []);
        const order = FIELD_ORDER[context] ?? [];
        const replace = offsetRange(source.text, offset - typedWord(source.text, offset).length, offset);
        for (const field of schemaFields(context)) {
            if (existing.has(field.name)) continue;
            const item = fieldItem(field, sortKey(order.indexOf(field.name), field.name));
            item.range = replace;
            items.push(item);
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

/** Partial mapping key typed on the current line (letters, like parseCompletionPath's prefix charset). */
function typedWord(text: string, offset: number): string {
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const match = /[A-Za-z_]+$/.exec(text.slice(lineStart, offset));
    return match ? match[0] : '';
}

/**
 * IntelliJ's block templates: at the root the section key plus its first
 * list item; inside the list the alias word expands into the item's fields.
 */
function blockSnippet(trigger: string, section: boolean, text: string, offset: number): vscode.SnippetString {
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const line = text.slice(lineStart, offset);
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    const P = (n: number, v: string): string => '$' + `{${n}:${v}}`;
    const fields = trigger === 'repositories'
        ? `name: ${P(1, 'name')}\n${lead}  url: ${P(2, 'https://')}`
        : trigger === 'dependencies' || trigger === 'dependency'
            ? `chart: ${P(1, 'chart')}\n${lead}  version: ${P(2, 'version')}`
            : `name: ${P(1, 'name')}\n${lead}  chart: ${P(2, 'chart')}\n${lead}  version: ${P(3, 'version')}`;
    if (section) {
        const name = trigger === 'repositories' ? 'repositories' : 'releases';
        return new vscode.SnippetString(`${name}:\n${lead}  - ${fields}`);
    }
    return new vscode.SnippetString(fields);
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
