/**
 * Semantic highlighting for Go template actions, port of the IntelliJ
 * plugin's HelmfileLexer color classes onto VSCode semantic tokens:
 * keywords, Go/Sprig/Helmfile functions, value paths, variables,
 * constants, strings, comments and numbers inside `{{ ... }}`.
 */
import * as vscode from 'vscode';
import { TemplateScanner, type TemplateAction } from './templateScanner';
import { findFunction } from './functionCatalog';

export type ActionTokenType =
    | 'keyword'
    | 'function'
    | 'variable'
    | 'constant'
    | 'property'
    | 'string'
    | 'comment'
    | 'number'
    | 'operator';

export interface ActionToken {
    readonly start: number;
    readonly end: number;
    readonly type: ActionTokenType;
}

const KEYWORDS = new Set(['if', 'else', 'end', 'range', 'with', 'define', 'block', 'template', 'break', 'continue']);
const CONSTANTS = new Set(['true', 'false', 'nil']);

function isIdent(c: string): boolean {
    return /[A-Za-z0-9_]/.test(c);
}

/**
 * Tokenize one template action body. Mirrors HelmfileLexer.lexBody:
 * quote/comment aware, paths as `.`/`$.` dotted chains, `$var` variables,
 * keywords, catalog functions, numbers, `|` operators.
 */
export function tokenizeAction(text: string, action: TemplateAction): ActionToken[] {
    const tokens: ActionToken[] = [];
    for (let i = action.bodyStart; i < action.bodyEnd; i++) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            let j = i + 1;
            while (j < action.bodyEnd) {
                const q = text[j];
                if (q === '\\' && quote !== '`' && j + 1 < action.bodyEnd) j += 2;
                else if (q === quote) break;
                else j++;
            }
            tokens.push({ start: i, end: Math.min(j + 1, action.bodyEnd), type: 'string' });
            i = j;
            continue;
        }
        if (c === '/' && text[i + 1] === '*' && i + 1 < action.bodyEnd) {
            let j = i + 2;
            while (j + 1 < action.bodyEnd && !(text[j] === '*' && text[j + 1] === '/')) j++;
            tokens.push({ start: i, end: Math.min(j + 2, action.bodyEnd), type: 'comment' });
            i = j + 1;
            continue;
        }
        if (c === '|' && (text[i + 1] === ' ' || text[i + 1] === '\t' || i + 1 === action.bodyEnd)) {
            tokens.push({ start: i, end: i + 1, type: 'operator' });
            continue;
        }
        if (c === '$' && text[i + 1] !== '.' && isIdent(text[i + 1] ?? '')) {
            let j = i + 1;
            while (j < action.bodyEnd && isIdent(text[j])) j++;
            tokens.push({ start: i, end: j, type: 'variable' });
            i = j - 1;
            continue;
        }
        if (c === '.' || (c === '$' && text[i + 1] === '.')) {
            let j = i + 1;
            while (j < action.bodyEnd && (isIdent(text[j]) || text[j] === '.')) j++;
            // `.` alone (the dot) is not a path.
            if (j > i + 1) {
                tokens.push({ start: i, end: j, type: 'property' });
                i = j - 1;
                continue;
            }
        }
        if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
            let j = i + 1;
            while (j < action.bodyEnd && /[0-9._]/.test(text[j])) j++;
            tokens.push({ start: i, end: j, type: 'number' });
            i = j - 1;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < action.bodyEnd && isIdent(text[j])) j++;
            const word = text.slice(i, j);
            const type: ActionTokenType | null = KEYWORDS.has(word)
                ? 'keyword'
                : CONSTANTS.has(word)
                    ? 'constant'
                    : findFunction(word)
                        ? 'function'
                        : null;
            if (type) tokens.push({ start: i, end: j, type });
            i = j - 1;
            continue;
        }
    }
    return tokens;
}

export const SEMANTIC_TOKEN_TYPES: ActionTokenType[] = [
    'keyword', 'function', 'variable', 'constant', 'property', 'string', 'comment', 'number', 'operator',
];

export class HelmfileSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    readonly onDidChangeSemanticTokens = undefined;

    provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
        const legend = new vscode.SemanticTokensLegend(SEMANTIC_TOKEN_TYPES);
        const builder = new vscode.SemanticTokensBuilder(legend);
        const text = document.getText();
        const lineStarts = computeLineStarts(text);
        for (const action of TemplateScanner.scan(text)) {
            for (const token of tokenizeAction(text, action)) {
                // Semantic tokens may not span lines: split per line.
                let offset = token.start;
                while (offset < token.end) {
                    const line = lineIndex(lineStarts, offset);
                    const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
                    const end = Math.min(token.end, lineEnd);
                    if (end > offset) {
                        builder.push(line, offset - lineStarts[line], end - offset, SEMANTIC_TOKEN_TYPES.indexOf(token.type));
                    }
                    offset = end;
                }
            }
        }
        return builder.build();
    }
}

export function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

export function lineIndex(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= offset) low = mid;
        else high = mid - 1;
    }
    return low;
}
