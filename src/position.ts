/**
 * Offset↔Position helpers shared by providers. Documents use UTF-16 code
 * units, matching TextDocument.positionAt semantics; the manual conversion
 * avoids repeated allocations when scanning.
 */
import * as vscode from 'vscode';

export function offsetPosition(text: string, offset: number): vscode.Position {
    let line = 0;
    let lastNewline = -1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') {
            line++;
            lastNewline = i;
        }
    }
    return new vscode.Position(line, offset - lastNewline - 1);
}

export function offsetRange(text: string, start: number, end: number): vscode.Range {
    return new vscode.Range(offsetPosition(text, start), offsetPosition(text, end));
}
