/**
 * Resolves the innermost `{{ range ... }}` / `{{ with ... }}` block that
 * surrounds a position, and the dotted path it iterates over, so completion
 * can offer the keys of the iterated element at `.` / `$.` positions.
 */
import { TemplateScanner, type TemplateAction } from './templateScanner';

export interface IterationContext {
    /** `range` or `with`. */
    readonly keyword: string;
    /** The collection/value expression, e.g. `.Values.apps` or `$.Subcharts.web.Values.ingress.hosts`. */
    readonly path: string;
}

interface BlockSpan extends IterationContext {
    readonly start: number;
    readonly end: number;
}

/**
 * Innermost `range`/`with` block containing `offset`. `if` narrows scope but
 * never changes what `.` refers to, so `if` blocks are tracked on the stack
 * only to pair their `end`s correctly.
 */
export function enclosingIteration(text: string, offset: number): IterationContext | null {
    const spans: BlockSpan[] = [];
    const stack: TemplateAction[] = [];
    for (const action of TemplateScanner.scan(text)) {
        const word = headWord(action, text);
        if (word === 'if' || word === 'range' || word === 'with') stack.push(action);
        else if (word === 'end' && stack.length > 0) {
            const open = stack.pop() as TemplateAction;
            const openWord = headWord(open, text);
            const path = (openWord === 'range' || openWord === 'with') ? iteratedPath(open, text, openWord) : null;
            if (path) spans.push({ keyword: openWord as string, path, start: open.start, end: action.end });
        }
    }
    // Unclosed blocks at EOF still scope everything after them.
    for (const open of stack) {
        const openWord = headWord(open, text);
        const path = (openWord === 'range' || openWord === 'with') ? iteratedPath(open, text, openWord) : null;
        if (path) spans.push({ keyword: openWord as string, path, start: open.start, end: text.length });
    }
    let best: BlockSpan | null = null;
    for (const span of spans) {
        if (offset >= span.start && offset <= span.end && (!best || span.start > best.start)) best = span;
    }
    return best;
}

/** First word of the action body, e.g. `range` in `{{- range .Values.x }}`. */
function headWord(action: TemplateAction, text: string): string | null {
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const match = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
    return match ? match[1] : null;
}

/**
 * The expression `.` refers to inside the block: for `range` the collection
 * (after any `$i, $v :=` destructuring), for `with` the argument. Only plain
 * dotted value paths are resolvable against the model.
 */
function iteratedPath(action: TemplateAction, text: string, word: string): string | null {
    const body = text.slice(action.bodyStart, action.bodyEnd).trim();
    const withoutKeyword = body.slice(word.length).trim();
    const destructureMatch = /^\$[A-Za-z0-9_]*(?:\s*,\s*\$[A-Za-z0-9_]*)?\s*:=\s*(.+)$/.exec(withoutKeyword);
    const expression = (destructureMatch ? destructureMatch[1] : withoutKeyword).trim();
    if (/^\$?\.[A-Za-z0-9_.]*$/.test(expression)) return expression;
    return null;
}
