/**
 * Folding for helmfile YAML: every pair with a block value folds from its
 * key line; `---` documents fold as regions in multi-document files.
 */
import * as vscode from 'vscode';
import { parseTree, walkAll, type YPair } from './yamlTree';

export class HelmfileFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        const tree = parseTree(document.getText());
        for (const doc of tree.docs) {
            if (doc.root) {
                walkAll(doc.root, node => {
                    if (node.kind !== 'pair') return;
                    const pair = node as YPair;
                    if (!pair.value) return;
                    const startLine = document.positionAt(pair.keyStart).line;
                    const endLine = document.positionAt(pair.valueEnd).line;
                    if (endLine > startLine) ranges.push(new vscode.FoldingRange(startLine, endLine));
                });
            }
            const startLine = document.positionAt(doc.start).line;
            const endLine = document.positionAt(doc.end).line;
            if (tree.docs.length > 1 && endLine > startLine + 1) {
                ranges.push(new vscode.FoldingRange(startLine, endLine));
            }
        }
        return ranges;
    }
}
