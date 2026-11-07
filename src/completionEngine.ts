/**
 * Completion inside Go template actions (`{{ … }}`), editor-neutral:
 * `computeActionCompletions` receives (file, text, offset, environment)
 * and returns neutral `Completion` items; completion.ts converts to
 * vscode.CompletionItem. YAML-side completions (schema fields, repositories,
 * chart values files) stay in the provider file. No `vscode` imports here —
 * the unit suite asserts it.
 */
import * as path from 'node:path';
import { allFunctions, functionMarkdown } from './functionCatalog';
import { chartTemplateContextFor, chartTemplateDetected, chartFileOf, CHART_BUILTIN_SUFFIX, CHART_BUILTINS, CHART_ROOT_PATHS, type ChartTemplateContext } from './chartContext';
import { chartModelFor, iterationBaseModel, subchartModel, type ChartKey } from './chartModel';
import { chartDefinesFor } from './chartDefines';
import { enclosingIteration, variableBindings } from './chartIteration';
import { snippetsFor } from './templateSnippets';
import { childKeys, contentStamp, type ValuesDefinition, type ValuesModel } from './values';
import { Completion, Markdown } from './language';
import type { EnvVarSuggestion } from './envVars';

/** Workspace services the engine needs but must not import. */
export interface ActionCompletionDeps {
    /** Environment variables visible in the editor (envVars.ts). */
    readonly envVars: () => readonly EnvVarSuggestion[];
    /** Values model of the current state file (values.ts). */
    readonly stateModel: (file: string, environment: string) => ValuesModel | null;
}

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

/** Unit separator for values key paths (mirrors values.ts SEPARATOR). */
const SEPARATOR = '\u001f';

/** Detail line shared by chart values completions: the default when scalar, the owning chart otherwise. */
export function chartKeyDetail(key: { readonly preview: string }, chart: string): string {
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

/** Documentation for an effective chart key: value preview plus schema description. */
function keyDocumentation(key: ChartKey): string | undefined {
    const documentation = new Markdown();
    if (key.preview) documentation.appendCodeblock(key.preview, 'yaml');
    if (key.description) documentation.appendMarkdown('\n\n' + key.description);
    const value = documentation.toString();
    return value.length > 0 ? value : undefined;
}

/** Completion items for effective chart keys, with source labels and previews. */
function keyItems(keys: readonly ChartKey[], offset: number, typedLength: number): Completion[] {
    return keys.map(key => ({
        label: key.key,
        kind: 'variable' as const,
        detail: key.source ?? 'chart value',
        documentation: keyDocumentation(key),
        replace: { start: offset - typedLength, end: offset },
    }));
}

/**
 * Completions inside a Go template action: env vars of `env`/`requiredEnv`,
 * values paths, Helm chart builtins, `.Files` paths, `include` names,
 * function names, context paths, `$var` bindings and skeleton snippets.
 */
export function computeActionCompletions(file: string, text: string, offset: number, environment: string, deps: ActionCompletionDeps): Completion[] {
    const chartFile = chartFileOf({ scheme: 'file', fsPath: file });
    const chartTemplate = chartTemplateContextFor(chartFile, contentStamp());
    // Chart file with `helmfile.chartSupport: false`: generic template
    // help only — no chart values, no Helmfile state paths.
    const chartDetected = chartTemplate !== null || chartTemplateDetected(chartFile, contentStamp());
    const head = text.slice(Math.max(0, offset - 500), offset);

    const envMatch = /\b(?:env|requiredEnv)\s*"([^"\r\n]*)$/.exec(head);
    if (envMatch) {
        let rank = 0;
        return deps.envVars().map(suggestion => ({
            label: suggestion.name,
            kind: 'variable' as const,
            detail: suggestion.value === '' ? '(empty)' : suggestion.value.slice(0, 80),
            documentation: `Environment variable from the ${suggestion.source}.`,
            insertText: suggestion.name,
            replace: { start: offset - envMatch[1].length, end: offset },
            sortText: String(rank++).padStart(4, '0') + suggestion.name,
        }));
    }

    const pathMatch = PATH_PREFIX.exec(head);
    if (pathMatch) {
        if (chartTemplate) return chartValueCompletions(text, offset, chartTemplate, pathMatch, environment);
        if (chartDetected) return [];
        const parent = pathMatch[1] + pathMatch[2];
        const model = deps.stateModel(file, environment);
        if (!model) return [];
        const existing = new Set<string>();
        return childKeys(model, parent).reduce<Completion[]>((items, definition) => {
            const key = lastSegment(definition.path);
            if (existing.has(key)) return items;
            existing.add(key);
            items.push({
                label: key,
                kind: 'variable',
                detail: definition.preview || key,
                documentation: sourceLabel(definition),
                replace: { start: offset - segmentLength(pathMatch[2]), end: offset },
            });
            return items;
        }, []);
    }

    // `.Chart.` / `.Release.` … built-in Helm template variables, plus the
    // `.Subcharts.<name>.Values.` drill-down.
    if (chartTemplate) {
        const builtinMatch = CHART_BUILTIN_SUFFIX.exec(head);
        if (builtinMatch) {
            if (builtinMatch[1] === 'Subcharts' && /^\.[A-Za-z0-9_]+\.Values\./.test(builtinMatch[2])) {
                return subchartValueCompletions(text, offset, chartTemplate, builtinMatch[2], environment);
            }
            return chartBuiltinCompletions(text, offset, chartTemplate, builtinMatch[1] + builtinMatch[2]);
        }
        const files = chartFileCompletions(text, offset, chartTemplate, environment);
        if (files) return files;
        const defines = defineNameCompletions(file, text, offset, chartTemplate);
        if (defines) return defines;
    }

    const items: Completion[] = [];
    // Replace the whole partial token: the leading `.`/`$` of `.Values`
    // etc. is not part of VSCode's default word definition, so without an
    // explicit range acceptance appends to the typed dot (`..Values`).
    const wordMatch = /[$.A-Za-z_][A-Za-z0-9_.$]*$/.exec(head);
    const replace = { start: offset - (wordMatch ? wordMatch[0].length : 0), end: offset };
    for (const func of allFunctions()) {
        items.push({
            label: func.name,
            kind: 'function',
            detail: func.signature,
            documentation: functionMarkdown(func),
            replace,
        });
    }
    if (chartTemplate) {
        const typed = wordMatch ? wordMatch[0] : '';
        const dollar = typed.startsWith('$');
        // `$var.` — keys of the element/value the innermost binding holds.
        const varMatch = /^(\$[A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_.]*)$/.exec(typed);
        if (varMatch) {
            variableCompletions(text, offset, chartTemplate, varMatch[1], varMatch[2], environment, items);
        } else {
            if (!/^\$[A-Za-z_]/.test(typed)) {
                const labelPrefix = dollar ? '$.' : '.';
                for (const root of CHART_ROOT_PATHS) {
                    items.push({
                        label: labelPrefix + root,
                        kind: 'variable',
                        detail: 'Helm template variable',
                        replace,
                    });
                }
            }
            // Declared `$var` names of enclosing range/with blocks.
            if (dollar) variableNameCompletions(text, offset, typed, replace, items);
            // Inside `range`/`with`, `.` refers to the iterated element: offer
            // its keys for relative paths (`.field`) that are not root names.
            if (!dollar && /^\.[A-Za-z0-9_.]*$/.test(typed)) {
                const { parent, partial } = splitPartial(typed.slice(1));
                iterationCompletions(text, offset, chartTemplate, parent, partial, environment, items);
            }
        }
    } else if (!chartDetected) {
        for (const path of CONTEXT_PATHS) {
            items.push({
                label: path,
                kind: 'variable',
                detail: 'Helmfile state value path',
                replace,
            });
        }
    }
    // Skeleton snippets (range/with/if/…) for both state and chart files.
    const wordPart = /[A-Za-z_][A-Za-z0-9_]*$/.exec(head);
    if (wordPart) {
        for (const snippet of snippetsFor(wordPart[0])) {
            items.push({
                label: snippet.trigger,
                kind: 'snippet',
                detail: snippet.detail,
                documentation: '```go-template\n' + snippet.body + '\n```',
                snippet: snippet.body,
                sortText: '0000' + snippet.trigger,
                replace: { start: offset - wordPart[0].length, end: offset },
            });
        }
    }
    return items;
}

/** `.Values.` keys of the chart's effective values: chart defaults overlaid by helmfile releases. */
function chartValueCompletions(text: string, offset: number, context: ChartTemplateContext, pathMatch: RegExpMatchArray, environment: string): Completion[] {
    const valuesPrefix = pathMatch[1] === '.Values.' || pathMatch[1] === '$.Values.'; // `$` is Helm's root context
    if (!valuesPrefix) return [];
    // `.Subcharts.<name>.Values.` resolves against the dependency's own
    // values.yaml, not this chart's merged values.
    const head = text.slice(Math.max(0, offset - 500), offset);
    const subchart = /(?:^|[^.A-Za-z0-9_])\$?\.Subcharts\.([A-Za-z0-9_]+)\.Values\.$/.exec(head);
    if (subchart) {
        const model = subchartModel(context, subchart[1], contentStamp(), environment);
        if (model) return keyItems(model.keysUnder([]), offset, segmentLength(pathMatch[2]));
    }
    const { parent, partial } = splitPartial(pathMatch[2]);
    const model = chartModelFor(context, contentStamp(), environment);
    return keyItems(model.keysUnder(parent).filter(key => key.key.startsWith(partial)), offset, segmentLength(pathMatch[2]));
}

/** `.Subcharts.<name>.Values.` keys: the dependency's effective values
 * (its own defaults overlaid with the parent's `<name>` subtree). */
function subchartValueCompletions(text: string, offset: number, context: ChartTemplateContext, typedSuffix: string, environment: string): Completion[] {
    const segments = typedSuffix.split('.').filter(segment => segment.length > 0); // [name, 'Values', ...rest]
    const model = subchartModel(context, segments[0], contentStamp(), environment);
    if (!model) return [];
    const { parent, partial } = splitPartial(segments.slice(2).join('.'));
    return keyItems(model.keysUnder(parent).filter(key => key.key.startsWith(partial)), offset, segmentLength(typedSuffix));
}

/** Quoted path literals of `.Files.Get "…"` / `.Files.Glob "…"`. */
function chartFileCompletions(text: string, offset: number, context: ChartTemplateContext, environment: string): Completion[] | null {
    const head = text.slice(Math.max(0, offset - 500), offset);
    const match = /(?:\$)?\.Files\.(?:Get|GetBytes|Glob|Lines)\s*"([^"\r\n]*)$/.exec(head);
    if (!match) return null;
    const model = chartModelFor(context, contentStamp(), environment);
    return model.files
        .filter(file => file.startsWith(match[1]))
        .map(file => ({
            label: file,
            kind: 'file' as const,
            detail: 'chart file',
            replace: { start: offset - match[1].length, end: offset },
        }));
}

/** Quoted template names of `include "…"` / `template "…"`. */
function defineNameCompletions(file: string, text: string, offset: number, context: ChartTemplateContext): Completion[] | null {
    const head = text.slice(Math.max(0, offset - 500), offset);
    const match = /\b(?:include|template)\s*"([^"\r\n]*)$/.exec(head);
    if (!match) return null;
    const defines = chartDefinesFor(context, contentStamp(), { file, text });
    const seen = new Set<string>();
    const items: Completion[] = [];
    for (const define of defines) {
        if (!define.name.startsWith(match[1]) || seen.has(define.name)) continue;
        seen.add(define.name);
        items.push({
            label: define.name,
            kind: 'reference',
            detail: `define · ${path.basename(define.file)}`,
            documentation: '```go-template\n' + (define.body || '(empty)') + '\n```',
            replace: { start: offset - match[1].length, end: offset },
        });
    }
    return items;
}

/**
 * `$var.` — keys of the value the innermost binding of `$var` refers to:
 * the element of its `range`, or the narrowed value of its `with`.
 */
function variableCompletions(text: string, offset: number, context: ChartTemplateContext, name: string, rest: string, environment: string, items: Completion[]): void {
    const binding = [...variableBindings(text, offset)].reverse().find(candidate => candidate.name === name);
    if (!binding || binding.role === 'index') return; // the index/key is a scalar
    const base = iterationBaseModel(binding.path, context, contentStamp(), environment);
    if (!base) return;
    const info = base.model.valueAt(base.segments);
    if (!info) return;
    const { parent, partial } = splitPartial(rest);
    // `range` over a list iterates elements; a `with` variable narrows to
    // the value itself.
    const keys = parent.length === 0 && binding.role === 'element' && info.kind === 'list'
        ? base.model.elementKeys(base.segments)
        : base.model.keysUnder([...base.segments, ...parent]);
    for (const key of keys) {
        if (!key.key.startsWith(partial)) continue;
        items.push({
            label: key.key,
            kind: 'variable',
            detail: key.source ?? 'list element',
            documentation: key.description ?? undefined,
            replace: { start: offset - partial.length, end: offset },
        });
    }
}

/** Names of `$var`s declared by enclosing `range`/`with` headers. */
function variableNameCompletions(text: string, offset: number, typed: string, replace: Completion['replace'], items: Completion[]): void {
    const seen = new Set<string>();
    for (const binding of [...variableBindings(text, offset)].reverse()) {
        if (seen.has(binding.name) || !binding.name.startsWith(typed)) continue;
        seen.add(binding.name);
        const roleText = binding.role === 'index' ? 'index' : binding.role === 'element' ? 'element' : 'value';
        items.push({
            label: binding.name,
            kind: 'variable',
            detail: `${binding.keyword} ${roleText} · ${binding.path}`,
            replace,
        });
    }
}

/**
 * Keys of the element `.` refers to inside the innermost `range`/`with`.
 * `parent` are the typed path segments before the partial word.
 */
function iterationCompletions(text: string, offset: number, context: ChartTemplateContext, parent: readonly string[], partial: string, environment: string, items: Completion[]): void {
    const iteration = enclosingIteration(text, offset);
    if (!iteration) return;
    const base = iterationBaseModel(iteration.path, context, contentStamp(), environment);
    if (!base) return;
    const info = base.model.valueAt(base.segments);
    if (!info) return;
    // `range` over a list iterates elements; `with` narrows to the value itself.
    const keys = parent.length === 0 && (iteration.keyword === 'range' && info.kind === 'list')
        ? base.model.elementKeys(base.segments)
        : base.model.keysUnder([...base.segments, ...parent]);
    const replace = { start: offset - partial.length, end: offset };
    for (const key of keys) {
        if (!key.key.startsWith(partial)) continue;
        items.push({
            label: key.key,
            kind: 'variable',
            detail: key.source ?? 'list element',
            documentation: key.description ?? undefined,
            replace,
        });
    }
}

/**
 * Sub-paths of the built-in Helm template variables: completes the next
 * path segment after the typed anchor (`.Capabilities.` → `KubeVersion`),
 * deduplicated across the catalog's deeper entries.
 */
function chartBuiltinCompletions(text: string, offset: number, context: ChartTemplateContext, typed: string): Completion[] {
    const partial = typed.slice(typed.lastIndexOf('.') + 1);
    const anchor = typed.slice(0, typed.length - partial.length); // dotted prefix ending in '.', or ''
    const replace = { start: offset - partial.length, end: offset };
    if (anchor === 'Subcharts.') {
        return context.subcharts.map(name => ({
            label: name,
            kind: 'module' as const,
            detail: 'Subchart',
            replace,
        }));
    }
    const items: Completion[] = [];
    const seen = new Set<string>();
    for (const builtin of CHART_BUILTINS) {
        if (!builtin.path.startsWith(anchor)) continue;
        const rest = builtin.path.slice(anchor.length);
        const dot = rest.indexOf('.');
        const label = dot === -1 ? rest : rest.slice(0, dot);
        if (!label.startsWith(partial) || label === partial || seen.has(label)) continue;
        seen.add(label);
        items.push({
            label,
            kind: 'variable',
            detail: dot === -1 ? builtin.detail : 'Helm template variable',
            documentation: dot === -1
                ? builtin.documentation
                : `Prefix of the built-in \`${anchor}${label}\` variable — keep typing for its fields.`,
            replace,
        });
    }
    return items;
}

function sourceLabel(definition: ValuesDefinition): string {
    return definition.environment ? `${definition.origin} · ${definition.environment}` : definition.origin;
}

function lastSegment(path: string): string {
    const index = path.lastIndexOf(SEPARATOR);
    return index >= 0 ? path.slice(index + 1) : path;
}
