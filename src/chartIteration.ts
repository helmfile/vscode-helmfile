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

/** A scope problem found by {@link variableScopeIssues}. */
export interface VariableScopeIssue {
    readonly start: number;
    readonly end: number;
    readonly message: string;
}

interface ScopeFrame {
    /** `if` frames only pair their `end`; they never scope variables. */
    readonly real: boolean;
    /** `define`/`block` bodies start fresh: outer bindings are invisible. */
    readonly cuts: boolean;
    readonly bindings: Map<string, number>;
}

const DECLARED = /\$([A-Za-z_][A-Za-z0-9_]*)\s*:=/;

/**
 * Validates `$variable` usage across the whole document following Go
 * template lexical scoping: `range`/`with`/`define`/`block` open scopes
 * (`if` does not), `define`/`block` start fresh, and `{{ $x = v }}`
 * requires an earlier declaration. `{{ else if }}` chains neither open
 * nor close — the single `{{ end }}` pairs the outer block.
 */
export function variableScopeIssues(text: string): readonly VariableScopeIssue[] {
    const issues: VariableScopeIssue[] = [];
    const stack: ScopeFrame[] = [{ real: true, cuts: false, bindings: new Map() }];
    const nearestReal = () => {
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].real) return stack[i];
        return stack[0];
    };
    const visibleFrom = (name: string, offset: number): number | null => {
        for (let i = stack.length - 1; i >= 0; i--) {
            const from = stack[i].bindings.get(name);
            if (from !== undefined && from <= offset) return from;
            if (stack[i].cuts) return null;
        }
        return null;
    };
    for (const action of TemplateScanner.scan(text)) {
        const body = text.slice(action.bodyStart, action.bodyEnd);
        if (body.trim().startsWith('/*')) continue;
        const head = headWord(action, text);
        if (head === 'end') {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const opens = head === 'if' || head === 'range' || head === 'with' || head === 'define' || head === 'block';
        // References first: header/declaration names on the left of `:=`
        // are declarations, not uses, and RHS uses resolve against outer
        // bindings only. `afterKeyword` starts after any stripped keyword,
        // so its indices are rebased with `keywordOffset`.
        const stripMatch = /^\s*-?\s*(?:if|range|with|define|block)\b\s*/.exec(body);
        const keywordOffset = stripMatch ? stripMatch[0].length : 0;
        const afterKeyword = body.slice(keywordOffset);
        const declaredInAction: string[] = [];
        let declarationEnd = 0;
        const destructure = /^\s*\$([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*\$([A-Za-z_][A-Za-z0-9_]*))?\s*:=/.exec(afterKeyword);
        if (head === 'range' && destructure) {
            declaredInAction.push(destructure[1], ...(destructure[2] ? [destructure[2]] : []));
            declarationEnd = afterKeyword.indexOf(':=');
        } else if (head === 'with' && destructure) {
            declaredInAction.push(destructure[1]);
            declarationEnd = afterKeyword.indexOf(':=');
        } else if (!opens) {
            const plain = DECLARED.exec(afterKeyword);
            if (plain) {
                declaredInAction.push(plain[1]);
                declarationEnd = afterKeyword.indexOf(':=');
            }
        }
        const assignment = !declaredInAction.length ? /^\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(afterKeyword) : null;
        let useStart = 0;
        if (assignment) {
            useStart = (assignment.index ?? 0) + assignment[0].length;
            if (visibleFrom(assignment[1], action.start) === null) {
                const nameStart = keywordOffset + (assignment.index ?? 0) + assignment[0].indexOf('$' + assignment[1]);
                const start = action.bodyStart + nameStart;
                issues.push({
                    start,
                    end: start + assignment[1].length + 1,
                    message: `Assignment to undeclared variable $${assignment[1]}: declare it with $${assignment[1]} := first`,
                });
            }
        }
        // Every `$name` outside the declaration/assignment LHS is a use;
        // the `$` root (`$.Values.x`) never matches because a name must
        // follow the dollar.
        for (const match of afterKeyword.slice(useStart).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
            if (useStart + match.index! < declarationEnd) continue;
            const name = match[1];
            if (visibleFrom(name, action.start) === null) {
                const start = action.bodyStart + keywordOffset + useStart + match.index!;
                issues.push({
                    start,
                    end: start + name.length + 1,
                    message: `Undefined variable $${name}`,
                });
            }
        }
        // Push the frame first so `range`/`with` header variables are
        // declared into their own scope and die at the matching `end`.
        if (opens) stack.push({ real: head !== 'if', cuts: head === 'define' || head === 'block', bindings: new Map() });
        for (const name of declaredInAction) nearestReal().bindings.set(name, action.end);
    }
    return issues;
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

/**
 * Spans of every conditional block (`if`/`range`/`with`/`define`/`block`).
 * Content inside one of these may or may not render, so two occurrences
 * that live in different branches do not necessarily coexist — static
 * checks must not treat them as duplicates.
 */
export function conditionalSpans(text: string): readonly { readonly start: number; readonly end: number }[] {
    const spans: { start: number; end: number }[] = [];
    const stack: TemplateAction[] = [];
    for (const action of TemplateScanner.scan(text)) {
        const word = headWord(action, text);
        if (word === 'if' || word === 'range' || word === 'with' || word === 'define' || word === 'block') stack.push(action);
        else if (word === 'end' && stack.length > 0) {
            const open = stack.pop() as TemplateAction;
            spans.push({ start: open.start, end: action.end });
        }
    }
    // Unclosed blocks at EOF still gate everything after them.
    for (const open of stack) spans.push({ start: open.start, end: text.length });
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
