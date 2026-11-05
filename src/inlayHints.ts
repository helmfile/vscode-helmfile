/**
 * Inline value hints for chart template files: `.Values.x` references show
 * their effective value (chart defaults + helmfile release overlay) right
 * next to the code. Opt-out via `helmfile.chartValueHints: false`.
 */
import * as vscode from 'vscode';
import { chartFileOf, chartTemplateContextFor, type ChartTemplateContext } from './chartContext';
import { iterationBaseModel } from './chartModel';
import { contentStamp } from './values';
import { chartValueHintsEnabled, EnvironmentService } from './settings';
import { TemplateScanner } from './templateScanner';

/** `.Values.x.y` and `.Subcharts.<name>.Values.x` references inside actions. */
const VALUE_PATH = /\$?\.(?:Subcharts\.[A-Za-z0-9_]+\.)?Values((?:\.[A-Za-z0-9_]+)+)/g;

export class HelmfileInlayHintsProvider implements vscode.InlayHintsProvider {
    constructor(private readonly env: EnvironmentService) {}

    provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
        if (!chartValueHintsEnabled()) return [];
        const context = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
        if (!context) return [];
        const text = document.getText();
        const hints: vscode.InlayHint[] = [];
        const start = document.offsetAt(range.start);
        const end = document.offsetAt(range.end);
        for (const action of TemplateScanner.scan(text)) {
            if (action.end < start || action.start > end) continue;
            VALUE_PATH.lastIndex = 0;
            const body = text.slice(action.bodyStart, action.bodyEnd);
            for (const match of body.matchAll(VALUE_PATH)) {
                const pathEnd = action.bodyStart + (match.index ?? 0) + match[0].length;
                if (pathEnd < start || pathEnd > end) continue;
                const hint = this.hintFor(text, pathEnd, match[0], context);
                if (hint) hints.push(hint);
            }
        }
        return hints;
    }

    private hintFor(text: string, pathEnd: number, path: string, context: ChartTemplateContext): vscode.InlayHint | null {
        const base = iterationBaseModel(path, context, contentStamp(), this.env.get());
        if (!base) return null;
        // For `.Values…` references the base model already resolves the full
        // path (iteration bases only matter for relative `.field` references).
        const info = base.model.valueAt(base.segments);
        if (!info) return null;
        // kindOf already renders an accurate preview for every kind
        // (`""`/`(empty)` scalars, `[]`/`[a, b]` lists, `{}`/`{a, b}` maps).
        const preview = info.preview.length > 40 ? `${info.preview.slice(0, 40)}…` : info.preview;
        const label = `= ${preview.length > 40 ? `${preview.slice(0, 40)}…` : preview}`;
        const hint = new vscode.InlayHint(positionAt(text, pathEnd), label);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendCodeblock(info.preview, 'yaml');
        tooltip.appendMarkdown(`\n\nFrom \`${info.source}\``);
        hint.tooltip = tooltip;
        return hint;
    }
}

function positionAt(text: string, offset: number): vscode.Position {
    const before = text.slice(0, offset);
    const line = (before.match(/\n/g) ?? []).length;
    return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1));
}
