/**
 * Hover documentation, ported from HelmfileDocumentationProvider.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { TemplateScanner } from './templateScanner';
import * as path from 'node:path';
import { chartBuiltinOf, chartFileOf, chartTemplateContextFor, chartTemplateDetected, CHART_BUILTIN_TOKEN, CHART_ROOT_PATHS, type ChartTemplateContext } from './chartContext';
import { chartModelFor, iterationBaseModel, subchartModel } from './chartModel';
import { chartDefinesFor, templateCallAt } from './chartDefines';
import { enclosingIteration } from './chartIteration';
import { findFunction, functionMarkdown } from './functionCatalog';
import { ancestors, pairKeyAt, parseTree } from './yamlTree';
import { schemaContext, schemaFields } from './schema';
import { allDefinitions, contentStamp, type ValuesDefinition } from './values';
import { EnvironmentService } from './settings';
import { valuePathAt } from './references';
import { offsetRange } from './position';
import { evaluateExpressionAt, type EvaluatedExpression } from './environmentInference';

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

export class HelmfileHoverProvider implements vscode.HoverProvider {
    constructor(private readonly env: EnvironmentService) {}

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const uri = document.uri;

        // Chart template files: built-in Helm variables and the chart's own
        // values.yaml defaults — never Helmfile state values, even when a
        // state file sits above the chart. Function identifiers keep their
        // catalog documentation.
        const chartTemplate = chartTemplateContextFor(chartFileOf(uri), contentStamp());
        if (chartTemplate) {
            return this.chartTemplateHover(uri, text, offset, chartTemplate)
                ?? this.chartDefineHover(uri, text, offset, chartTemplate)
                ?? this.functionHover(text, offset);
        }
        // Chart file with `helmfile.chartSupport: false`: keep function
        // documentation, never Helmfile state values.
        if (chartTemplateDetected(chartFileOf(uri), contentStamp())) {
            return this.functionHover(text, offset);
        }

        // 1. Values path under the cursor: resolved value + source + environment.
        const valuePath = valuePathAt(text, offset);
        if (valuePath) {
            const definitions = allDefinitions(uri, this.env.get()).filter(definition => definition.path === valuePath.key);
            if (definitions.length) {
                return new vscode.Hover(definitions.map(definitionMarkdown), valuePath.range);
            }
        }

        // 2. Go/Sprig/Helmfile function identifier inside an action; any
        // other position in an action falls through to computed values.
        const functionDoc = this.functionHover(text, offset);
        if (functionDoc) return functionDoc;

        // 3. Statically computed value of the surrounding expression.
        const action = TemplateScanner.at(text, offset);
        if (action) {
            const evaluated = evaluateExpressionAt({ uri, text, tree: parseTree(text) }, offset, this.env.get());
            if (evaluated) {
                return new vscode.Hover(computedValueMarkdown(evaluated, this.env.get()), offsetRange(text, evaluated.start, evaluated.end));
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
                const range = offsetRange(text, pair.keyStart, pair.keyEnd);
                return new vscode.Hover(new vscode.MarkdownString(`**${field.name}** \`${field.type}\`\n\n${field.description}`), range);
            }
        }
        return null;
    }

    /** Go/Sprig/Helmfile function identifier inside an action. */
    private functionHover(text: string, offset: number): vscode.Hover | null {
        const action = TemplateScanner.at(text, offset);
        if (!action) return null;
        const body = text.slice(action.bodyStart, action.bodyEnd);
        const word = identifierAt(body, offset - action.bodyStart);
        if (!word) return null;
        const func = findFunction(word.text);
        if (!func) return null;
        const range = offsetRange(text, action.bodyStart + word.start, action.bodyStart + word.start + word.text.length);
        return new vscode.Hover(functionMarkdown(func), range);
    }

    /**
     * Built-in Helm template variables, the chart's effective values, the
     * current `range`/`with` element, and `.Subcharts.<name>.Values.` paths.
     */
    private chartTemplateHover(uri: vscode.Uri, text: string, offset: number, context: ChartTemplateContext): vscode.Hover | null {
        const builtin = builtinPathAt(text, offset);
        if (builtin) {
            const subchart = /^Subcharts\.([A-Za-z0-9_]+)\.Values\.(.+)$/.exec(builtin.text);
            if (subchart) {
                const model = subchartModel(context, subchart[1], contentStamp());
                const info = model?.valueAt(subchart[2].split('.'));
                if (info) {
                    const content = new vscode.MarkdownString();
                    content.appendMarkdown(`**Subcharts.${subchart[1]}.Values.${subchart[2]}** — ${info.kind === 'scalar' ? 'value' : info.kind}:`);
                    content.appendCodeblock(info.preview, 'yaml');
                    content.appendMarkdown(`\n\nFrom \`${info.source}\` (subchart \`${subchart[1]}\`'s values.yaml).`);
                    return new vscode.Hover(content, offsetRange(text, builtin.start, builtin.end));
                }
            }
            const entry = chartBuiltinOf(builtin.text);
            if (entry) {
                const range = offsetRange(text, builtin.start, builtin.end);
                return new vscode.Hover(new vscode.MarkdownString(`**.${entry.path}** \`${entry.detail}\`\n\n${entry.documentation}`), range);
            }
            // `.Values.x` tokens reach here: fall through to value resolution.
        }
        const filesHover = chartFilesHover(text, offset, context);
        if (filesHover) return filesHover;
        const valuePath = valuePathAt(text, offset);
        if (valuePath) {
            const model = chartModelFor(context, contentStamp(), this.env.get());
            const segments = valuePath.key.split('\u001f');
            const info = model.valueAt(segments);
            const display = valuePath.key.split('\u001f').join('.');
            if (!info) {
                return new vscode.Hover(new vscode.MarkdownString(`**${display}** — no value in \`${context.name}\`'s effective values.`), valuePath.range);
            }
            const content = new vscode.MarkdownString();
            content.appendMarkdown(`**${display}** — ${info.kind === 'scalar' ? 'value' : info.kind}:`);
            content.appendCodeblock(info.preview, 'yaml');
            const description = model.schemaDescriptionAt(segments);
            if (description) content.appendMarkdown(`\n\n${description}`);
            content.appendMarkdown(`\n\nFrom \`${info.source}\``);
            return new vscode.Hover(content, valuePath.range);
        }
        // Relative `.field` path inside a `range`/`with` block: show what the
        // element field resolves to.
        const relative = relativePathAt(text, offset);
        if (relative) {
            const iteration = enclosingIteration(text, offset);
            const base = iteration ? iterationBaseModel(iteration.path, context, contentStamp(), this.env.get()) : null;
            if (base) {
                const segments = relative.path.slice(1).split('.');
                const info = base.model.valueAt([...base.segments, ...segments]);
                if (info) {
                    const content = new vscode.MarkdownString();
                    content.appendMarkdown(`**${relative.path}** — ${info.kind === 'scalar' ? 'value' : info.kind} of the \`${iteration!.keyword}\` element:`);
                    content.appendCodeblock(info.preview, 'yaml');
                    content.appendMarkdown(`\n\nVia \`${iteration!.keyword} ${iteration!.path}\` · from \`${info.source}\``);
                    return new vscode.Hover(content, offsetRange(text, relative.start, relative.end));
                }
                // `range` over a list: elements are maps, so a relative path
                // refers to an element field — show the available keys.
                const baseInfo = base.model.valueAt(base.segments);
                if (baseInfo && baseInfo.kind === 'list' && segments.length === 1) {
                    const elementKeys = base.model.elementKeys(base.segments).map(key => key.key);
                    if (elementKeys.includes(segments[0])) {
                        const content = new vscode.MarkdownString();
                        content.appendMarkdown(`**${relative.path}** — field of the \`${iteration!.keyword}\` element.`);
                        content.appendMarkdown(`\n\nElement keys: ${elementKeys.map(key => '\`' + key + '\`').join(', ')}`);
                        content.appendMarkdown(`\n\nVia \`${iteration!.keyword} ${iteration!.path}\``);
                        return new vscode.Hover(content, offsetRange(text, relative.start, relative.end));
                    }
                }
            }
        }
        return null;
    }

    /** Template-name literal of an `include`/`template` call. */
    private chartDefineHover(uri: vscode.Uri, text: string, offset: number, context: ChartTemplateContext): vscode.Hover | null {
        const call = templateCallAt(text, offset);
        if (!call) return null;
        const define = chartDefinesFor(context, contentStamp(), { file: uri.fsPath, text }).find(candidate => candidate.name === call.name);
        if (!define) return null;
        const content = new vscode.MarkdownString();
        content.appendMarkdown(`**${define.name}** — named template\n\nDeclared in \`${path.basename(define.file)}\`.`);
        content.appendCodeblock(define.body || '(empty)', 'go-template');
        return new vscode.Hover(content, offsetRange(text, call.start, call.end));
    }
}

/** Hover for `.Files.Get "path"` / `.Files.Glob "pattern"` literals: a
 * head preview of the file (or the matched files) under the chart root. */
function chartFilesHover(text: string, offset: number, context: ChartTemplateContext): vscode.Hover | null {
    for (const match of matchAll(FILES_CALL, text)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (offset < start || offset > end) continue;
        const literal = match[1];
        const range = offsetRange(text, start, end);
        const content = new vscode.MarkdownString();
        if (/\.Files\.Glob\s*$/.test(match[0].slice(0, match[0].length - literal.length - 2))) {
            const pattern = globToRegExp(literal);
            const matches = chartModelFor(context, contentStamp(), 'default').files.filter(file => pattern.test(file)).slice(0, 20);
            content.appendMarkdown(`**${literal}** — ${matches.length} file(s) under \`${path.basename(context.root)}\``);
            if (matches.length) content.appendCodeblock(matches.join('\n'), 'text');
            return new vscode.Hover(content, range);
        }
        const absolute = path.join(context.root, literal);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
            content.appendMarkdown(`**${literal}** — not found under the chart root.`);
            return new vscode.Hover(content, range);
        }
        const body = fs.readFileSync(absolute, 'utf8');
        const head = body.length > 500 ? `${body.slice(0, 500)}\n…` : body;
        content.appendMarkdown(`**${literal}** — file under \`${path.basename(context.root)}\``);
        content.appendCodeblock(head, path.extname(literal) === '.json' ? 'json' : 'yaml');
        return new vscode.Hover(content, range);
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

function computedValueMarkdown(evaluated: EvaluatedExpression, environment: string): vscode.MarkdownString {
    const content = new vscode.MarkdownString();
    content.appendCodeblock(previewOf(evaluated.value), 'yaml');
    const mentionsValues = /(?:\$?\.(?:Values|StateValues)|\.Environment\.Values)/.test(evaluated.expression);
    const origin = evaluated.value.origin === 'default' ? 'default literal' : evaluated.value.origin;
    const suffix = mentionsValues && environment ? ` · environment ${environment}` : '';
    content.appendMarkdown(`\n\nComputed statically from \`${origin}${suffix}\``);
    return content;
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

function definitionMarkdown(definition: ValuesDefinition): vscode.MarkdownString {
    const label = definition.environment ? `${definition.origin} · ${definition.environment}` : definition.origin;
    const content = new vscode.MarkdownString();
    content.appendCodeblock(definition.path.split('\u001f').join('.'), 'yaml');
    if (definition.valueKind === 'scalar') content.appendCodeblock(definition.preview, 'yaml');
    else content.appendMarkdown(`_${definition.valueKind}_`);
    content.appendMarkdown(`\n\nFrom \`${label}\``);
    return content;
}

/** Identifier containing `offset` within the action body, if any. */
function identifierAt(body: string, offset: number): { text: string; start: number } | null {
    for (const match of matchAll(IDENTIFIER, body)) {
        const start = match.index ?? 0;
        if (offset >= start && offset <= start + match[0].length) return { text: match[0], start };
    }
    return null;
}

function matchAll(pattern: RegExp, text: string): RegExpMatchArray[] {
    const result: RegExpMatchArray[] = [];
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
        result.push(match);
        match = pattern.exec(text);
    }
    return result;
}


