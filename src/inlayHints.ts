/**
 * Inlay hints provider: annotates `.Values.x` references in chart template
 * files with the effective value resolved from chart defaults and the
 * selected environment's release overlay.
 */
import * as vscode from 'vscode';
import { chartFileOf, chartTemplateContextFor } from './chartContext';
import { computeInlayHints } from './inlayEngine';
import { chartValueHintsEnabled } from './settings';
import type { EnvironmentService } from './settings';
import { contentStamp } from './values';

export class HelmfileInlayHintsProvider implements vscode.InlayHintsProvider {
    constructor(private readonly env: EnvironmentService) {}

    provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
        if (!chartValueHintsEnabled()) return [];
        try {
            const context = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
            if (!context) return [];
            const text = document.getText();
            return computeInlayHints(text, document.offsetAt(range.start), document.offsetAt(range.end), context, this.env.get()).map(hint => {
                const item = new vscode.InlayHint(document.positionAt(hint.offset), hint.label);
                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown('```yaml\n' + hint.preview + '\n```\n\n');
                tooltip.appendMarkdown(`From \`${hint.source}\``);
                item.tooltip = tooltip;
                return item;
            });
        } catch {
            return [];
        }
    }
}
