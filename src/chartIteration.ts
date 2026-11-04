/**
 * Resolves the innermost `{{ range ... }}` / `{{ with ... }}` block that
 * surrounds a position, and the dotted path it iterates over, so completion
 * can offer the keys of the iterated element at `.` / `$.` positions.
 */
import { TemplateScanner, type TemplateAction } from './templateScanner';

export interface IterationVariable {
    readonly name: string;
    /** `range $i, $v`: $i is the index, $v the element. `with $x`: the value. */
    readonly role: 'index' | 'element' | 'value';
}

export interface IterationContext {
    /** `range` or `with`. */
    readonly keyword: string;
    /** The collection/value expression, e.g. `.Values.apps` or `$.Subcharts.web.Values.ingress.hosts`. */
    readonly path: string;
    /** Variables the header declares, in declaration order. */
    readonly vars: readonly IterationVariable[];
}

interface BlockSpan extends IterationContext {
    readonly start: number;
    /** The opening action's `}}` — variables only become usable after it. */
    readonly bindingStart: number;
    readonly end: number;
}

/** A `$var` binding visible at a position. */
export interface VariableBinding extends IterationVariable {
    readonly keyword: string;
    readonly path: string;
    readonly start: number;
    readonly end: number;
}

/**
 * Innermost `range`/`with` block containing `offset`. `if` narrows scope but
 * never changes what `.` refers to, so `if` blocks are tracked on the stack
 * only to pair their `end`s correctly.
 */
export function enclosingIteration(text: string, offset: number): IterationContext | null {
    let best: BlockSpan | null = null;
    for (const span of blockSpans(text)) {
        if (offset >= span.start && offset <= span.end && (!best || span.start > best.start)) best = span;
    }
    return best;
}

/**
 * `$var` bindings visible at `offset`, outermost block first. For a name
 * bound more than once the LAST entry (innermost block) wins, as in Go
 * template lexical scoping.
 */
export function variableBindings(text: string, offset: number): VariableBinding[] {
    const spans = blockSpans(text).filter(span => offset >= span.bindingStart && offset <= span.end)
        .sort((a, b) => a.start - b.start);
    const bindings: VariableBinding[] = [];
    for (const span of spans) {
        for (const variable of span.vars) {
            bindings.push({ ...variable, keyword: span.keyword, path: span.path, start: span.start, end: span.end });
        }
    }
    return bindings;
}

/** All `range`/`with` blocks of the document with their source spans. */
function blockSpans(text: string): BlockSpan[] {
    const spans: BlockSpan[] = [];
    const stack: TemplateAction[] = [];
    for (const action of TemplateScanner.scan(text)) {
        const word = headWord(action, text);
        if (word === 'if' || word === 'range' || word === 'with') stack.push(action);
        else if (word === 'end' && stack.length > 0) {
            const open = stack.pop() as TemplateAction;
            pushSpan(spans, open, action.end, text);
        }
    }
    // Unclosed blocks at EOF still scope everything after them.
    for (const open of stack) pushSpan(spans, open, text.length, text);
    return spans;
}

function pushSpan(spans: BlockSpan[], open: TemplateAction, end: number, text: string): void {
    const word = headWord(open, text);
    if (word !== 'range' && word !== 'with') return;
    const header = headerOf(open, text, word);
    if (header) spans.push({ keyword: word, path: header.path, vars: header.vars, start: open.start, bindingStart: open.end, end });
}

/** First word of the action body, e.g. `range` in `{{- range .Values.x }}`. */
function headWord(action: TemplateAction, text: string): string | null {
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const match = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
    return match ? match[1] : null;
}

/**
 * Header of a `range`/`with` block: the expression `.` refers to (for
 * `range`, after any `$i, $v :=` destructuring) plus the variables the
 * header declares. Only plain dotted value paths are resolvable against
 * the model.
 */
function headerOf(action: TemplateAction, text: string, word: string): { path: string; vars: readonly IterationVariable[] } | null {
    const body = text.slice(action.bodyStart, action.bodyEnd).trim();
    const withoutKeyword = body.slice(word.length).trim();
    const destructureMatch = /^\$([A-Za-z0-9_]+)(?:\s*,\s*\$([A-Za-z0-9_]+))?\s*:=\s*(.+)$/.exec(withoutKeyword);
    const vars: IterationVariable[] = [];
    if (destructureMatch) {
        if (word === 'with') vars.push({ name: '$' + destructureMatch[1], role: 'value' });
        else if (destructureMatch[2]) {
            vars.push({ name: '$' + destructureMatch[1], role: 'index' }, { name: '$' + destructureMatch[2], role: 'element' });
        } else vars.push({ name: '$' + destructureMatch[1], role: 'element' });
    }
    const expression = (destructureMatch ? destructureMatch[3] : withoutKeyword).trim();
    if (!/^\$?\.[A-Za-z0-9_.]*$/.test(expression)) return null;
    return { path: expression, vars };
}
