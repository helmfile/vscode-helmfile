/**
 * Hover provider adapter: converts vscode document/position into the
 * editor-neutral (file, text, offset) triple, delegates to hoverEngine and
 * converts the result back. All hover logic lives in hoverEngine.ts.
 */
import * as vscode from 'vscode';
import { parseTree } from './yamlTree';
import { allDefinitions } from './values';
import { EnvironmentService } from './settings';
import { offsetRange } from './position';
import { evaluateExpressionAt } from './environmentInference';
import { computeHover } from './hoverEngine';

export class HelmfileHoverProvider implements vscode.HoverProvider {
    constructor(private readonly env: EnvironmentService) {}

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const uri = document.uri;
        const doc = computeHover(uri.fsPath, text, offset, this.env.get(), {
            allDefinitions: (_file, environment) => allDefinitions(uri, environment),
            evaluate: (docText, docOffset, environment) =>
                evaluateExpressionAt({ uri, text: docText, tree: parseTree(docText) }, docOffset, environment),
        });
        if (!doc) return null;
        return new vscode.Hover(new vscode.MarkdownString(doc.markdown, true), offsetRange(text, doc.span.start, doc.span.end));
    }
}
