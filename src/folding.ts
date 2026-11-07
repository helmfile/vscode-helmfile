/**
 * Folding provider: converts neutral folding spans into line-based ranges.
 */
import * as vscode from 'vscode';
import { foldingSpans } from './foldingEngine';

export class HelmfileFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        for (const span of foldingSpans(document.getText())) {
            const startLine = document.positionAt(span.start).line;
            const endLine = document.positionAt(span.end).line;
            // Pair folds need at least two lines; document regions a bit more.
            if (endLine > startLine + (span.document ? 1 : 0)) {
                ranges.push(new vscode.FoldingRange(startLine, endLine));
            }
        }
        return ranges;
    }
}
