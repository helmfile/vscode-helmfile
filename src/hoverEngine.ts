/**
 * Hover computation, editor-neutral. `computeHover` receives the document as
 * plain `(file, text, offset)` plus the selected environment and returns a
 * `HoverDoc` (markdown + highlighted span); hover.ts converts to vscode types.
 * No `vscode` imports here — the unit suite asserts it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateScanner } from './templateScanner';
import { Markdown, matchAll, type HoverDoc } from './language';
import { chartBuiltinOf, chartFileOf, chartTemplateContextFor, chartTemplateDetected, CHART_BUILTIN_TOKEN, CHART_ROOT_PATHS, type ChartTemplateContext } from './chartContext';
import { chartModelFor, iterationBaseModel, subchartModel } from './chartModel';
import { chartDefinesFor, templateCallAt } from './chartDefines';
import { enclosingIteration, variableBindings } from './chartIteration';
import { findFunction, functionMarkdown } from './functionCatalog';
import { ancestors, pairKeyAt, parseTree } from './yamlTree';
import { schemaContext, schemaFields } from './schema';
import { contentStamp, type ValuesDefinition } from './values';
import type { EvaluatedExpression } from './environmentInference';
import { valuePathAt } from './valuePath';

/** Workspace services the engine needs but must not import. */
export interface HoverDeps {
    /** Values definitions of the current environment (values.ts). */
    readonly allDefinitions: (file: string, environment: string) => readonly ValuesDefinition[];
    /** Statically evaluated expression at an offset (environmentInference.ts). */
    readonly evaluate: (text: string, offset: number, environment: string) => EvaluatedExpression | null;
}

/** Identifiers inside actions that carry documentation. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** `.Files.Get "…"` / `.Files.Glob "…"` literals. */
const FILES_CALL = /\$?\.Files\.(?:Get|GetBytes|Glob|Lines)\s*"((?:[^"\\]|\\.)*)"/g;

function builtinPathAt(text: string, offset: number): { text: string; start: number; end: number } | null {
    for (const match of matchAll(CHART_BUILTIN_TOKEN, text)) {
        if (offset < (match.index ?? 0) || offset > (match.index ?? 0) + match[0].length) continue;
        return { text: match[0].slice(1), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
    }
    return null;
}

const RELATIVE_PATH = /(?<![.A-Za-z0-9_$])(\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g;
const VARIABLE_PATH = /\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/g;

/** A relative `.field.path` under the cursor that is not a built-in root. */
function relativePathAt(text: string, offset: number): { path: string; start: number; end: number } | null {
    for (const match of matchAll(RELATIVE_PATH, text)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (offset < start || offset > end) continue;
        const first = match[0].slice(1).split('.')[0];
        if ((CHART_ROOT_PATHS as readonly string[]).includes(first)) continue;
        return { path: match[0], start, end };
    }
    return null;
}

/** A `$var[.field.path]` token under the cursor. */
function variablePathAt(text: string, offset: number): { name: string; fields: string; start: number; end: number } | null {
    for (const match of matchAll(VARIABLE_PATH, text)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (offset < start || offset > end) continue;
        const token = match[0];
        const dot = token.indexOf('.');
        return dot === -1
            ? { name: token, fields: '', start, end }
            : { name: token.slice(0, dot), fields: token.slice(dot), start, end };
    }
    return null;
}

export function computeHover(file: string, text: string, offset: number, environment: string, deps: HoverDeps): HoverDoc | null {
    const chartFile = chartFileOf({ scheme: 'file', fsPath: file });

    // Chart template files: built-in Helm variables and the chart's own
    // values.yaml defaults — never Helmfile state values, even when a
    // state file sits above the chart. Function identifiers keep their
    // catalog documentation.
    const chartTemplate = chartTemplateContextFor(chartFile, contentStamp());
    if (chartTemplate) {
        return chartTemplateHover(text, offset, chartTemplate, environment)
            ?? chartDefineHover(file, text, offset, chartTemplate)
            ?? functionHover(text, offset);
    }
    // Chart file with `helmfile.chartSupport: false`: keep function
    // documentation, never Helmfile state values.
    if (chartTemplateDetected(chartFile, contentStamp())) {
        return functionHover(text, offset);
    }

    // 1. Values path under the cursor: resolved value + source + environment.
    const valuePath = valuePathAt(text, offset);
    if (valuePath) {
        const definitions = deps.allDefinitions(file, environment).filter(definition => definition.path === valuePath.key);
        if (definitions.length) {
            return { markdown: definitions.map(definitionMarkdown).join('\n\n---\n\n'), span: { start: valuePath.start, end: valuePath.end } };
        }
    }

    // 2. Go/Sprig/Helmfile function identifier inside an action; any
    // other position in an action falls through to computed values.
    const functionDoc = functionHover(text, offset);
    if (functionDoc) return functionDoc;

    // 3. Statically computed value of the surrounding expression.
    const action = TemplateScanner.at(text, offset);
    if (action) {
        const evaluated = deps.evaluate(text, offset, environment);
        if (evaluated) {
            return { markdown: computedValueMarkdown(evaluated, environment), span: { start: evaluated.start, end: evaluated.end } };
        }
        return null;
    }

    // 4. Mapping key: Helmfile schema field description.
    const tree = parseTree(text);
    const pair = pairKeyAt(tree, offset);
    if (pair && offset >= pair.keyStart && offset <= pair.keyEnd) {
        const context = schemaContext(ancestors(pair));
        const field = schemaFields(context).find(candidate => candidate.name === pair.key);
        if (field) {
            return { markdown: `**${field.name}** \`${field.type}\`\n\n${field.description}`, span: { start: pair.keyStart, end: pair.keyEnd } };
        }
    }
    return null;
}

/** Go/Sprig/Helmfile function identifier inside an action. */
function functionHover(text: string, offset: number): HoverDoc | null {
    const action = TemplateScanner.at(text, offset);
    if (!action) return null;
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const word = identifierAt(body, offset - action.bodyStart);
    if (!word) return null;
    const func = findFunction(word.text);
    if (!func) return null;
    return { markdown: functionMarkdown(func), span: { start: action.bodyStart + word.start, end: action.bodyStart + word.start + word.text.length } };
}

/**
 * Built-in Helm template variables, the chart's effective values, the
 * current `range`/`with` element, and `.Subcharts.<name>.Values.` paths.
 */
function chartTemplateHover(text: string, offset: number, context: ChartTemplateContext, environment: string): HoverDoc | null {
    const builtin = builtinPathAt(text, offset);
    if (builtin) {
        const subchart = /^Subcharts\.([A-Za-z0-9_]+)\.Values\.(.+)$/.exec(builtin.text);
        if (subchart) {
            const model = subchartModel(context, subchart[1], contentStamp(), environment);
            const info = model?.valueAt(subchart[2].split('.'));
            if (info) {
                const content = new Markdown();
                content.appendMarkdown(`**Subcharts.${subchart[1]}.Values.${subchart[2]}** — ${info.kind === 'scalar' ? 'value' : info.kind}:`);
                content.appendCodeblock(info.preview, 'yaml');
                content.appendMarkdown(`\n\nFrom \`${info.source}\` (subchart \`${subchart[1]}\`'s effective values).`);
                return { markdown: content.toString(), span: { start: builtin.start, end: builtin.end } };
            }
        }
        const entry = chartBuiltinOf(builtin.text);
        if (entry) {
            return { markdown: `**.${entry.path}** \`${entry.detail}\`\n\n${entry.documentation}`, span: { start: builtin.start, end: builtin.end } };
        }
        // `.Values.x` tokens reach here: fall through to value resolution.
    }
    const filesHover = chartFilesHover(text, offset, context);
    if (filesHover) return filesHover;
    const valuePath = valuePathAt(text, offset);
    if (valuePath) {
        const model = chartModelFor(context, contentStamp(), environment);
        const segments = valuePath.key.split('\u001f');
        const info = model.valueAt(segments);
        const display = valuePath.key.split('\u001f').join('.');
        if (!info) {
            return { markdown: `**${display}** — no value in \`${context.name}\`'s effective values.`, span: { start: valuePath.start, end: valuePath.end } };
        }
        const content = new Markdown();
        content.appendMarkdown(`**${display}** — ${info.kind === 'scalar' ? 'value' : info.kind}:`);
        content.appendCodeblock(info.preview, 'yaml');
        const description = model.schemaDescriptionAt(segments);
        if (description) content.appendMarkdown(`\n\n${description}`);
        content.appendMarkdown(`\n\nFrom \`${info.source}\``);
        return { markdown: content.toString(), span: { start: valuePath.start, end: valuePath.end } };
    }
    // `$var` / `$var.field`: what the innermost binding refers to.
    const variable = variablePathAt(text, offset);
    if (variable) {
        const binding = [...variableBindings(text, offset)].reverse().find(candidate => candidate.name === variable.name);
        const base = binding ? iterationBaseModel(binding.path, context, contentStamp(), environment) : null;
        if (binding && base) {
            const roleText = binding.role === 'index' ? 'index of' : binding.role === 'element' ? 'element of' : 'value of';
            const header = `**${binding.name}** — ${roleText} \`${binding.keyword} ${binding.path}\``;
            const baseInfo = base.model.valueAt(base.segments);
            const segments = variable.fields.slice(1).split('.').filter(segment => segment.length > 0);
            const span = { start: variable.start, end: variable.end };
            if (segments.length === 0) {
                const content = new Markdown();
                content.appendMarkdown(header);
                if (baseInfo) {
                    content.appendMarkdown(`\n\nCollection (${baseInfo.kind}):`);
                    content.appendCodeblock(baseInfo.preview, 'yaml');
                    content.appendMarkdown(`\n\nFrom \`${baseInfo.source}\``);
                }
                return { markdown: content.toString(), span };
            }
            const info = base.model.valueAt([...base.segments, ...segments]);
            if (info) {
                const content = new Markdown();
                content.appendMarkdown(header);
                content.appendMarkdown(`\n\n**${binding.name}${variable.fields}** — ${info.kind === 'scalar' ? 'value' : info.kind}:`);
                content.appendCodeblock(info.preview, 'yaml');
                content.appendMarkdown(`\n\nFrom \`${info.source}\``);
                return { markdown: content.toString(), span };
            }
            // `range` over a list: element fields vary per item — list the union.
            if (binding.role === 'element' && baseInfo?.kind === 'list' && segments.length === 1) {
                const elementKeys = base.model.elementKeys(base.segments).map(key => key.key);
                if (elementKeys.includes(segments[0])) {
                    const content = new Markdown();
                    content.appendMarkdown(header);
                    content.appendMarkdown(`\n\n**${binding.name}.${segments[0]}** — field of the range element.`);
                    content.appendMarkdown(`\n\nElement keys: ${elementKeys.map(key => '`' + key + '`').join(', ')}`);
                    return { markdown: content.toString(), span };
                }
            }
        }
    }
    // Relative `.field` path inside a `range`/`with` block: show what the
    // element field resolves to.
    const relative = relativePathAt(text, offset);
    if (relative) {
        const iteration = enclosingIteration(text, offset);
        const base = iteration ? iterationBaseModel(iteration.path, context, contentStamp(), environment) : null;
        if (base) {
            const segments = relative.path.slice(1).split('.');
            const info = base.model.valueAt([...base.segments, ...segments]);
            if (info) {
                const content = new Markdown();
                content.appendMarkdown(`**${relative.path}** — ${info.kind === 'scalar' ? 'value' : info.kind} of the \`${iteration!.keyword}\` element:`);
                content.appendCodeblock(info.preview, 'yaml');
                content.appendMarkdown(`\n\nVia \`${iteration!.keyword} ${iteration!.path}\` · from \`${info.source}\``);
                return { markdown: content.toString(), span: { start: relative.start, end: relative.end } };
            }
            // `range` over a list: elements are maps, so a relative path
            // refers to an element field — show the available keys.
            const baseInfo = base.model.valueAt(base.segments);
            if (baseInfo && baseInfo.kind === 'list' && segments.length === 1) {
                const elementKeys = base.model.elementKeys(base.segments).map(key => key.key);
                if (elementKeys.includes(segments[0])) {
                    const content = new Markdown();
                    content.appendMarkdown(`**${relative.path}** — field of the \`${iteration!.keyword}\` element.`);
                    content.appendMarkdown(`\n\nElement keys: ${elementKeys.map(key => '`' + key + '`').join(', ')}`);
                    content.appendMarkdown(`\n\nVia \`${iteration!.keyword} ${iteration!.path}\``);
                    return { markdown: content.toString(), span: { start: relative.start, end: relative.end } };
                }
            }
        }
    }
    return null;
}

/** Template-name literal of an `include`/`template` call. */
function chartDefineHover(file: string, text: string, offset: number, context: ChartTemplateContext): HoverDoc | null {
    const call = templateCallAt(text, offset);
    if (!call) return null;
    const define = chartDefinesFor(context, contentStamp(), { file, text }).find(candidate => candidate.name === call.name);
    if (!define) return null;
    const content = new Markdown();
    content.appendMarkdown(`**${define.name}** — named template\n\nDeclared in \`${path.basename(define.file)}\`.`);
    content.appendCodeblock(define.body || '(empty)', 'go-template');
    return { markdown: content.toString(), span: { start: call.start, end: call.end } };
}

/** Hover for `.Files.Get "path"` / `.Files.Glob "pattern"` literals: a
 * head preview of the file (or the matched files) under the chart root. */
function chartFilesHover(text: string, offset: number, context: ChartTemplateContext): HoverDoc | null {
    for (const match of matchAll(FILES_CALL, text)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (offset < start || offset > end) continue;
        const literal = match[1];
        const span = { start, end };
        const content = new Markdown();
        if (/\.Files\.Glob\s*$/.test(match[0].slice(0, match[0].length - literal.length - 2))) {
            const pattern = globToRegExp(literal);
            const matches = chartModelFor(context, contentStamp(), 'default').files.filter(file => pattern.test(file)).slice(0, 20);
            content.appendMarkdown(`**${literal}** — ${matches.length} file(s) under \`${path.basename(context.root)}\``);
            if (matches.length) content.appendCodeblock(matches.join('\n'), 'text');
            return { markdown: content.toString(), span };
        }
        const absolute = path.join(context.root, literal);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
            content.appendMarkdown(`**${literal}** — not found under the chart root.`);
            return { markdown: content.toString(), span };
        }
        const body = fs.readFileSync(absolute, 'utf8');
        const head = body.length > 500 ? `${body.slice(0, 500)}\n…` : body;
        content.appendMarkdown(`**${literal}** — file under \`${path.basename(context.root)}\``);
        content.appendCodeblock(head, path.extname(literal) === '.json' ? 'json' : 'yaml');
        return { markdown: content.toString(), span };
    }
    return null;
}

/** Chart-file glob patterns use `*` / `**` / `?`. */
function globToRegExp(glob: string): RegExp {
    let source = '';
    for (let index = 0; index < glob.length; index++) {
        const ch = glob[index];
        if (ch === '*') {
            if (glob[index + 1] === '*') { source += '.*'; index++; }
            else source += '[^/]*';
        } else if (ch === '?') source += '[^/]';
        else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${source}$`);
}

function computedValueMarkdown(evaluated: EvaluatedExpression, environment: string): string {
    const content = new Markdown();
    content.appendCodeblock(previewOf(evaluated.value), 'yaml');
    const mentionsValues = /(?:\$?\.(?:Values|StateValues)|\.Environment\.Values)/.test(evaluated.expression);
    const origin = evaluated.value.origin === 'default' ? 'default literal' : evaluated.value.origin;
    const suffix = mentionsValues && environment ? ` · environment ${environment}` : '';
    content.appendMarkdown(`\n\nComputed statically from \`${origin}${suffix}\``);
    return content.toString();
}

function previewOf(value: NonNullable<EvaluatedExpression['value']>): string {
    if (value.kind === 'text') return value.text.length > 600 ? value.text.slice(0, 600) + '\u2026' : value.text;
    if (value.kind === 'mapping') {
        const keys = value.mapping.pairs.filter(pair => pair.key).map(pair => pair.key!);
        return `mapping (${keys.length} keys): ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', \u2026' : ''}`;
    }
    const prefix = value.prefix ? value.prefix + '\u001f' : '';
    const names: string[] = [];
    for (const definition of value.definitions) {
        if (!definition.path.startsWith(prefix)) continue;
        const rest = definition.path.slice(prefix.length);
        if (!rest) continue;
        const child = rest.split('\u001f')[0];
        if (!names.includes(child)) names.push(child);
    }
    return `mapping (${names.length} keys): ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', \u2026' : ''}`;
}

function definitionMarkdown(definition: ValuesDefinition): string {
    const label = definition.environment ? `${definition.origin} · ${definition.environment}` : definition.origin;
    const content = new Markdown();
    content.appendCodeblock(definition.path.split('\u001f').join('.'), 'yaml');
    if (definition.valueKind === 'scalar') content.appendCodeblock(definition.preview, 'yaml');
    else content.appendMarkdown(`_${definition.valueKind}_`);
    content.appendMarkdown(`\n\nFrom \`${label}\``);
    return content.toString();
}

/** Identifier containing `offset` within the action body, if any. */
function identifierAt(body: string, offset: number): { text: string; start: number } | null {
    for (const match of matchAll(IDENTIFIER, body)) {
        const start = match.index ?? 0;
        if (offset >= start && offset <= start + match[0].length) return { text: match[0], start };
    }
    return null;
}
