/**
 * Hover documentation, ported from HelmfileDocumentationProvider.
 */
import * as vscode from 'vscode';
import { TemplateScanner } from './templateScanner';
import { chartBuiltinOf, chartFileOf, chartTemplateContextFor, chartValuePreview, CHART_BUILTIN_TOKEN, type ChartTemplateContext } from './chartContext';
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

function builtinPathAt(text: string, offset: number): { text: string; start: number; end: number } | null {
    for (const match of matchAll(CHART_BUILTIN_TOKEN, text)) {
        if (offset < (match.index ?? 0) || offset > (match.index ?? 0) + match[0].length) continue;
        return { text: match[0].slice(1), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length };
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
            return this.chartTemplateHover(text, offset, chartTemplate) ?? this.functionHover(text, offset);
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

    /** Built-in Helm template variables + chart values.yaml defaults. */
    private chartTemplateHover(text: string, offset: number, context: ChartTemplateContext): vscode.Hover | null {
        const valuePath = valuePathAt(text, offset);
        if (valuePath) {
            const preview = chartValuePreview(context, valuePath.key);
            const display = valuePath.key.split('\u001f').join('.');
            const body = preview === null
                ? `**${display}** — no default in \`${context.name}\`'s values.yaml.`
                : `**${display}** — chart default\n\n\`\`\`yaml\n${preview}\n\`\`\`\nFrom \`${context.name}\`'s values.yaml.`;
            return new vscode.Hover(new vscode.MarkdownString(body), valuePath.range);
        }
        const builtin = builtinPathAt(text, offset);
        if (builtin) {
            const entry = chartBuiltinOf(builtin.text);
            if (entry) {
                const range = offsetRange(text, builtin.start, builtin.end);
                return new vscode.Hover(new vscode.MarkdownString(`**.${entry.path}** \`${entry.detail}\`\n\n${entry.documentation}`), range);
            }
        }
        return null;
    }
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


