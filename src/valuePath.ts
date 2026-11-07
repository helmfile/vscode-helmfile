/**
 * `.Values` / `.StateValues` / `.Environment.Values` path token scanning,
 * shared by the hover engine and the references providers. Editor-neutral:
 * plain text offsets, no `vscode` imports.
 */
import { TemplateScanner } from './templateScanner';
import { matchAll } from './language';

/** Unit separator for values key paths (mirrors values.ts SEPARATOR). */
const SEPARATOR = '\u001f';

function valuesKeyPath(segments: string[]): string {
    return segments.join(SEPARATOR);
}

/** `$.Values.a.b` / `.StateValues.a` / `.Environment.Values.a` inside an action. */
const ROOT_PATH = /(\$?\.(?:Values|StateValues|Environment\.Values)\.[A-Za-z0-9_.]*)/g;
/** `index .Values "key.with.dots"` quoted keys. */
const INDEX_CALL = /\bindex\s+(\$?\.(?:Values|StateValues|Environment\.Values)(?:\.[A-Za-z0-9_]+)*)((?:\s+"(?:[^"\\]|\\.)*")+)/g;
/** `get .Values "key.with.dots" [default]` call form. */
const GET_CALL = /\bget\s+(\$?\.(?:Values|StateValues|Environment\.Values)(?:\.[A-Za-z0-9_]+)*)\s+"((?:[^"\\]|\\.)*)"(?:\s+(?:"(?:[^"\\]|\\.)*"|true|false|nil|\d+(?:\.\d+)?))?/g;
/** `.Values | get "key.with.dots" [default]` pipeline form. */
const GET_PIPE = /(\$?\.(?:Values|StateValues|Environment\.Values)(?:\.[A-Za-z0-9_]+)*)\s*\|\s*get\s+"((?:[^"\\]|\\.)*)"(?:\s+(?:"(?:[^"\\]|\\.)*"|true|false|nil|\d+(?:\.\d+)?))?/g;

/** A values path token under the cursor, with its raw span in `text`. */
export interface ValuePathToken {
    /** Definition key path joined with the unit separator. */
    readonly key: string;
    readonly start: number;
    readonly end: number;
}

/** `.Values` / `.StateValues` / `.Environment.Values` roots carry no own definition key. */
function stripValueRoot(segments: string[]): string[] {
    const rest = [...segments];
    if (rest[0] === 'Environment' && rest[1] === 'Values') rest.splice(0, 2);
    else if (rest[0] === 'Values' || rest[0] === 'StateValues') rest.splice(0, 1);
    return rest;
}

function splitQuoted(quoted: string): string[] {
    const segments: string[] = [];
    for (const match of matchAll(/"((?:[^"\\]|\\.)*)"/g, quoted)) segments.push(match[1].replace(/\\(.)/g, '$1'));
    return segments;
}

/**
 * Find the values path token containing `offset` inside a Go template action,
 * including `index .Values "quoted"` keys.
 */
export function valuePathAt(text: string, offset: number): ValuePathToken | null {
    const action = TemplateScanner.at(text, offset);
    if (!action) return null;
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const bodyOffset = offset - action.bodyStart;

    for (const match of matchAll(INDEX_CALL, body)) {
        if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
        const base = match[1];
        const segments = [...stripValueRoot(base.replace(/^\$?/, '').split('.').filter(segment => segment.length > 0)), ...splitQuoted(match[2])];
        return { key: valuesKeyPath(segments), start: action.bodyStart + (match.index ?? 0), end: action.bodyStart + (match.index ?? 0) + match[0].length };
    }

    for (const pattern of [GET_PIPE, GET_CALL]) {
        for (const match of matchAll(pattern, body)) {
            if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
            const segments = [...stripValueRoot(match[1].replace(/^\$?/, '').split('.').filter(segment => segment.length > 0)), ...match[2].split('.')];
            return { key: valuesKeyPath(segments), start: action.bodyStart + (match.index ?? 0), end: action.bodyStart + (match.index ?? 0) + match[0].length };
        }
    }

    for (const match of matchAll(ROOT_PATH, body)) {
        if (bodyOffset < (match.index ?? 0) || bodyOffset > (match.index ?? 0) + match[0].length) continue;
        const segments = stripValueRoot(
            match[0]
                .replace(/^\$?/, '')
                .split('.')
                .filter(segment => segment.length > 0),
        );
        return { key: valuesKeyPath(segments), start: action.bodyStart + (match.index ?? 0), end: action.bodyStart + (match.index ?? 0) + match[0].length };
    }
    return null;
}
