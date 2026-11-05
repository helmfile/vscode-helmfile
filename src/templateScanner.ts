/**
 * Recognizes Go template actions (`{{ ... }}`) without mistaking delimiters
 * inside Go strings or comments for endings.
 * Port of TemplateScanner from the IntelliJ plugin.
 */

export interface TemplateAction {
    /** Offset of the opening `{{`. */
    readonly start: number;
    /** Offset of the first character after `{{` / `{{-`. */
    readonly bodyStart: number;
    /** Offset just past the last body character (before trim marker / `}}`). */
    readonly bodyEnd: number;
    /** Offset just past `}}`, or text length for unclosed actions. */
    readonly end: number;
    readonly closed: boolean;
}

export class TemplateScanner {
    private constructor() {}

    static scan(text: string): TemplateAction[] {
        const actions: TemplateAction[] = [];
        const length = text.length;
        for (let i = 0; i + 1 < length; i++) {
            if (text[i] !== '{' || text[i + 1] !== '{') continue;
            const start = i;
            let body = i + 2;
            if (body + 1 < length && text[body] === '-' && isWhitespace(text.charCodeAt(body + 1))) body++;
            let j = body;
            let quote = '';
            let comment = false;
            for (; j < length; j++) {
                const c = text[j];
                if (comment) {
                    if (c === '*' && j + 1 < length && text[j + 1] === '/') {
                        comment = false;
                        j++;
                    }
                } else if (quote) {
                    if (c === '\\' && quote !== '`') j++;
                    else if (c === quote) quote = '';
                } else if (c === '"' || c === "'" || c === '`') quote = c;
                else if (c === '/' && j + 1 < length && text[j + 1] === '*') {
                    comment = true;
                    j++;
                } else if (c === '}' && j + 1 < length && text[j + 1] === '}') break;
            }
            const closed = j + 1 < length;
            const end = closed ? j + 2 : length;
            let bodyEnd = closed ? j : length;
            if (closed && bodyEnd > body && text[bodyEnd - 1] === '-' && isWhitespace(text.charCodeAt(bodyEnd - 2))) bodyEnd--;
            actions.push({ start, bodyStart: body, bodyEnd, end, closed });
            i = end - 1;
        }
        return actions;
    }

    /** The action whose body contains the offset (inclusive), or null. */
    static at(text: string, offset: number): TemplateAction | null {
        for (const action of TemplateScanner.scan(text)) {
            if (offset >= action.bodyStart && offset <= action.bodyEnd) return action;
        }
        return null;
    }

    /** Equal-length YAML projection used only for incomplete-key completion. */
    static mask(text: string): string {
        const result = text.split('');
        for (const action of TemplateScanner.scan(text)) {
            for (let i = action.start; i < action.end; i++) {
                if (result[i] !== '\n' && result[i] !== '\r') result[i] = ' ';
            }
        }
        return result.join('');
    }

    /**
     * YAML projection for syntax checking. Actions inside a flow
     * collection (`args: [{{ a }},{{ b }}]`) fill with `x` instead of
     * blanks — masking them to spaces would leave empty flow entries
     * (`[ , ]`) that surface as parser errors. Block-level actions stay
     * blank so `{{- if }}`/`{{- end }}` lines remain empty lines.
     */
    static maskForYaml(text: string): string {
        const actions = TemplateScanner.scan(text);
        const result = text.split('');
        let depth = 0;
        let quote = '';
        let comment = false;
        let i = 0;
        for (const action of actions) {
            for (; i < action.start; i++) {
                const c = text[i];
                // Brackets inside quoted scalars and comments do not open
                // flow collections; stray quotes reset at end of line.
                if (comment) {
                    if (c === '\n') comment = false;
                } else if (quote) {
                    if (quote === '"' && c === '\\') i++;
                    else if (c === quote || c === '\n') quote = '';
                } else if (c === '"' || c === "'") quote = c;
                else if (c === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) comment = true;
                else if (c === '[' || c === '{') depth++;
                else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
            }
            const fill = depth > 0 ? 'x' : ' ';
            for (let j = action.start; j < action.end; j++) {
                if (result[j] !== '\n' && result[j] !== '\r') result[j] = fill;
            }
            i = Math.max(i, action.end - 1);
        }
        return result.join('');
    }
}

function isWhitespace(c: number): boolean {
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x1c && c <= 0x20);
}

/**
 * Equal-length filler for template-derived mapping keys: `  {{ $key }}:`
 * masks to `        :` (a null key misaligned with its siblings); replacing
 * the blank key with `x` characters keeps the parse valid and offsets
 * unchanged. Only whitespace-only keys are touched.
 */
export function fillMaskedTemplateKeys(masked: string): string {
    return masked.replace(/^[ \t]+:(?=\s|$)/gm, line => 'x'.repeat(line.length - 1) + ':');
}
