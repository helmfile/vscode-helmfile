/**
 * Editor-neutral language types and geometry.
 *
 * Engine modules (hoverEngine, completionEngine, valuePath, chart*, yamlTree,
 * templateScanner, …) compute everything against these plain shapes and raw
 * string offsets; provider modules (hover.ts, completion.ts, …) are thin
 * adapters that convert to `vscode.*` types. Nothing under this module may
 * import `vscode` — the unit suite asserts that (see test/run.ts, "engine
 * purity" checks).
 */

/** Zero-based line/character position. */
export interface Position {
    readonly line: number;
    readonly character: number;
}

/** Zero-based half-open span in text offsets. */
export interface OffsetSpan {
    readonly start: number;
    readonly end: number;
}

/** Pure offset → Position conversion, matching TextDocument.positionAt. */
export function positionAt(text: string, offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    let lastNewline = -1;
    for (let index = 0; index < clamped; index++) {
        if (text.charCodeAt(index) === 10) {
            line++;
            lastNewline = index;
        }
    }
    return { line, character: clamped - lastNewline - 1 };
}

/** Markdown document content, assembled exactly like vscode.MarkdownString. */
export class Markdown {
    private value = '';

    appendMarkdown(markdown: string): this {
        this.value += markdown;
        return this;
    }

    appendCodeblock(code: string, language = ''): this {
        this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
        return this;
    }

    toString(): string {
        return this.value;
    }
}

/** Hover result: markdown plus the highlighted source span. */
export interface HoverDoc {
    readonly markdown: string;
    readonly span: OffsetSpan;
}

/** Neutral completion kinds; providers map them to their own enums. */
export type CompletionKind =
    | 'function'
    | 'variable'
    | 'module'
    | 'field'
    | 'property'
    | 'file'
    | 'snippet'
    | 'reference'
    | 'constant'
    | 'text';

/** Neutral completion item; `replace` is the text span to overwrite. */
export interface Completion {
    readonly label: string;
    readonly kind: CompletionKind;
    readonly detail?: string;
    /** Markdown documentation. */
    readonly documentation?: string;
    /** Plain insert text; defaults to `label` when absent. */
    readonly insertText?: string;
    /** Snippet-syntax insert text (wins over `insertText`). */
    readonly snippet?: string;
    readonly sortText?: string;
    readonly deprecated?: boolean;
    /** Re-open the completion list after accepting this item. */
    readonly triggerSuggest?: boolean;
    readonly replace?: OffsetSpan;
}

/** All matches of a global regex; `lastIndex` is reset before and after. */
export function matchAll(pattern: RegExp, text: string): RegExpMatchArray[] {
    const result: RegExpMatchArray[] = [];
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
        result.push(match);
        match = pattern.exec(text);
    }
    return result;
}

/** Structural stand-in for editor URIs: vscode.Uri satisfies it, and a
 * plain object covers engine-internal file references. */
export type UriLike = { readonly fsPath: string; toString(): string };

/** Neutral Uri factory for engine-side file references (cache key + fsPath). */
export function fileUri(fsPath: string): UriLike {
    return { fsPath, toString: () => `file://${fsPath}` };
}
