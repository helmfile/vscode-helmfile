/**
 * Signature help for catalog functions. Go template calls are space
 * separated (`{{ printf "%s" "a" }}`), so the cursor's argument position is
 * derived from the last catalog function before the cursor and the complete
 * top-level arguments typed after it.
 */
import * as vscode from 'vscode';
import { findFunction, functionMarkdown } from './functionCatalog';
import { TemplateScanner } from './templateScanner';

const IDENTIFIER = /([A-Za-z_][A-Za-z0-9_]*)/g;

export class HelmfileSignatureHelpProvider implements vscode.SignatureHelpProvider {
    provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | null {
        try {
            const text = document.getText();
            const offset = document.offsetAt(position);
            const action = TemplateScanner.at(text, offset);
            if (!action) return null;
            const call = callAt(text.slice(action.bodyStart, action.bodyEnd), offset - action.bodyStart);
            if (!call) return null;
            const func = findFunction(call.name);
            if (!func) return null;
            const parameters = parameterList(func.signature);
            const help = new vscode.SignatureHelp();
            const signature = new vscode.SignatureInformation(`${func.name}(${parameters.join(', ')})`);
            signature.documentation = functionMarkdown(func);
            for (const parameter of parameters) signature.parameters.push(new vscode.ParameterInformation(parameter));
            help.signatures.push(signature);
            help.activeSignature = 0;
            help.activeParameter = Math.min(call.args, Math.max(parameters.length - 1, 0));
            return help;
        } catch {
            return null;
        }
    }
}

interface CallSite {
    readonly name: string;
    /** Number of complete top-level arguments typed after the function name. */
    readonly args: number;
}

/** Find the last catalog function before the cursor that owns the argument
 * region containing the cursor. */
function callAt(body: string, offset: number): CallSite | null {
    const masked = maskQuoted(body, ' ');
    let best: CallSite | null = null;
    IDENTIFIER.lastIndex = 0;
    for (const match of masked.matchAll(IDENTIFIER)) {
        const end = (match.index ?? 0) + match[0].length;
        if (end >= offset) break;
        if (!findFunction(match[1])) continue;
        // Quoted arguments are single tokens: mask them with a word char so
        // each string literal counts as one argument.
        const args = topLevelArgs(maskQuoted(body.slice(end, offset), 'x'));
        if (args === null) continue; // cursor inside a grouped sub-expression
        best = { name: match[1], args };
    }
    return best;
}

/** Replace quoted spans (including an unterminated one) with `replacement`
 * characters so scanners never match string contents. */
function maskQuoted(text: string, replacement: string): string {
    let out = '';
    let index = 0;
    while (index < text.length) {
        const ch = text[index];
        if (ch === '"') {
            let end = index + 1;
            while (end < text.length && text[end] !== '"') {
                if (text[end] === '\\') end++; // skip escaped char
                end++;
            }
            const stop = Math.min(end + 1, text.length); // include closing quote
            out += replacement.repeat(stop - index);
            index = stop;
            continue;
        }
        out += ch;
        index++;
    }
    return out;
}

/** Count complete top-level arguments in the region between a function name
 * and the cursor; null when the region ends inside a parenthesized group. */
function topLevelArgs(segment: string): number | null {
    let count = 0;
    let depth = 0;
    let inToken = false;
    for (const ch of segment) {
        if (ch === '(') {
            depth++;
            continue;
        }
        if (ch === ')') {
            depth--;
            continue;
        }
        if (depth > 0) continue;
        if (ch === '|') break; // pipeline continuation belongs to the next function
        if (/\s/.test(ch)) {
            inToken = false;
            continue;
        }
        if (!inToken) {
            count++;
            inToken = true;
        }
    }
    return depth > 0 ? null : count;
}

/** Parameter names from a catalog signature like `include name context → string`. */
function parameterList(signature: string): string[] {
    return signature.split('→')[0].trim().split(/\s+/).filter(part => part.length > 0);
}
