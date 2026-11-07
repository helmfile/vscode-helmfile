/**
 * Smart selection (expand selection) provider: the VSCode counterpart of
 * the IntelliJ structural Ctrl+W, over the neutral selection chain.
 */
import * as vscode from 'vscode';
import { selectionChain } from './selectionEngine';

export class HelmfileSelectionRangeProvider implements vscode.SelectionRangeProvider {
    provideSelectionRanges(document: vscode.TextDocument, positions: readonly vscode.Position[]): vscode.SelectionRange[] {
        const text = document.getText();
        return positions.map(position => {
            const chain = selectionChain(text, document.offsetAt(position));
            // Innermost first, each wrapping the previous.
            let selection: vscode.SelectionRange | undefined;
            for (let i = chain.length - 1; i >= 0; i--) {
                const [start, end] = chain[i];
                selection = new vscode.SelectionRange(
                    new vscode.Range(document.positionAt(start), document.positionAt(end)),
                    selection,
                );
            }
            return selection!;
        });
    }
}
