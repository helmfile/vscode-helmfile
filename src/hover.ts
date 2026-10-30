/**
 * Hover documentation, ported from HelmfileDocumentationProvider.
 */
import * as vscode from 'vscode';
import { TemplateScanner } from './templateScanner';
import { findFunction, functionMarkdown } from './functionCatalog';
import { ancestors, pairKeyAt, parseTree } from './yamlTree';
import { schemaContext, schemaFields } from './schema';
import { allDefinitions, type ValuesDefinition } from './values';
import { EnvironmentService } from './settings';
import { valuePathAt } from './references';
import { offsetRange } from './position';

/** Identifiers inside actions that carry documentation. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

export class HelmfileHoverProvider implements vscode.HoverProvider {
    constructor(private readonly env: EnvironmentService) {}

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const uri = document.uri;

        // 1. Values path under the cursor: resolved value + source + environment.
        const valuePath = valuePathAt(text, offset);
        if (valuePath) {
            const definitions = allDefinitions(uri, this.env.get()).filter(definition => definition.path === valuePath.key);
            if (definitions.length) {
                return new vscode.Hover(definitions.map(definitionMarkdown), valuePath.range);
            }
        }

        // 2. Go/Sprig/Helmfile function identifier inside an action.
        const action = TemplateScanner.at(text, offset);
        if (action) {
            const body = text.slice(action.bodyStart, action.bodyEnd);
            const bodyOffset = offset - action.bodyStart;
            for (const match of matchAll(IDENTIFIER, body)) {
                if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
                const func = findFunction(match[0]);
                if (func) {
                    const range = offsetRange(text, action.bodyStart + (match.index ?? 0), action.bodyStart + (match.index ?? 0) + match[0].length);
                    return new vscode.Hover(functionMarkdown(func), range);
                }
                return null;
            }
        }

        // 3. Mapping key: Helmfile schema field description.
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


