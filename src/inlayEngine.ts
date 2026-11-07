/**
 * Editor-neutral inlay value hints for chart template files: `.Values.x`
 * references resolved to their effective value (chart defaults + helmfile
 * release overlay).
 */
import { chartTemplateContextFor, type ChartTemplateContext } from './chartContext';
import { iterationBaseModel } from './chartModel';
import { TemplateScanner } from './templateScanner';
import { contentStamp } from './values';

/** `.Values.x.y` and `.Subcharts.<name>.Values.x` references inside actions. */
const VALUE_PATH = /\$?\.(?:Subcharts\.[A-Za-z0-9_]+\.)?Values((?:\.[A-Za-z0-9_]+)+)/g;

export interface InlayValueHint {
    /** Offset the hint attaches to (end of the value path). */
    readonly offset: number;
    /** Short label shown inline, e.g. `= nginx`. */
    readonly label: string;
    /** Full preview for the tooltip (untruncated). */
    readonly preview: string;
    /** Where the value comes from, e.g. `mychart values.yaml`. */
    readonly source: string;
}

/**
 * Hints for the value paths inside `[start, end]`.
 */
export function computeInlayHints(text: string, start: number, end: number, context: ChartTemplateContext, environment: string): InlayValueHint[] {
    const stamp = contentStamp();
    const hints: InlayValueHint[] = [];
    for (const action of TemplateScanner.scan(text)) {
        if (action.end < start || action.start > end) continue;
        VALUE_PATH.lastIndex = 0;
        const body = text.slice(action.bodyStart, action.bodyEnd);
        for (const match of body.matchAll(VALUE_PATH)) {
            const pathEnd = action.bodyStart + (match.index ?? 0) + match[0].length;
            if (pathEnd < start || pathEnd > end) continue;
            const base = iterationBaseModel(match[0], context, stamp, environment);
            if (!base) continue;
            // For `.Values…` references the base model already resolves the
            // full path (iteration bases only matter for relative references).
            const info = base.model.valueAt(base.segments);
            if (!info) continue;
            const preview = info.preview.length > 40 ? `${info.preview.slice(0, 40)}…` : info.preview;
            hints.push({ offset: pathEnd, label: `= ${preview}`, preview: info.preview, source: info.source });
        }
    }
    return hints;
}

export { chartTemplateContextFor };
