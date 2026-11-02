/**
 * Named-template index: scans Go template actions for `{{ define "name" }}`
 * … `{{ end }}` (and `block`) so `include`/`template` calls get completion,
 * hover, navigation and outline symbols — both in Helm charts (every file
 * under `<chart>/templates/`) and in Helmfile state documents that declare
 * helpers inline.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateScanner } from './templateScanner';
import type { ChartTemplateContext } from './chartContext';

export interface ChartDefine {
    /** Template name as written in the declaration, e.g. `mychart.name`. */
    readonly name: string;
    /** Absolute path of the declaring file. */
    readonly file: string;
    /** Offset of the `{{ define` action. */
    readonly start: number;
    /** Offset just past the matching `{{ end }}` (or end of text when unclosed). */
    readonly end: number;
    /** Template body between `}}` and `{{ end }}`, for hover previews (capped). */
    readonly body: string;
}

export interface TemplateCall {
    readonly name: string;
    /** Range of the quoted name literal (without quotes). */
    readonly start: number;
    readonly end: number;
}

/** An `include`/`template` call site, attributed to its file. */
export interface ChartCall extends TemplateCall {
    readonly file: string;
}

/** Upper bounds keeping the index cheap on pathological charts. */
const MAX_FILES = 200;
const MAX_DEFINES = 500;
const MAX_FILE_BYTES = 512 * 1024;

const OPENERS = new Set(['if', 'range', 'with', 'define', 'block']);

/** First word of an action body: `define`, `else`, `end`, a function name… */
function headWord(body: string): string {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
    return match ? match[1] : '';
}

/** First quoted string literal of an action body with its absolute range, if any. */
function quotedArg(action: { readonly bodyStart: number; readonly bodyEnd: number }, text: string): { value: string; start: number; end: number } | null {
    const body = text.slice(action.bodyStart, action.bodyEnd);
    const match = /"((?:[^"\\]|\\.)*)"/.exec(body);
    if (!match || match.index === undefined) return null;
    return {
        value: match[1],
        start: action.bodyStart + match.index + 1,
        end: action.bodyStart + match.index + 1 + match[1].length,
    };
}

/**
 * All `define`/`block` declarations of a document, nesting-aware: `end`
 * closes the innermost opener, so defines inside `if`/`range`/`with` blocks
 * are attributed to the right span. Unclosed defines run to the end of text
 * (the file is being edited).
 */
export function scanDefines(text: string, file: string): readonly ChartDefine[] {
    const defines: ChartDefine[] = [];
    const stack: { word: string; name: string | null; actionStart: number; actionEnd: number }[] = [];
    for (const action of TemplateScanner.scan(text)) {
        const body = text.slice(action.bodyStart, action.bodyEnd);
        const word = headWord(body);
        if (word === 'else') continue; // `else` / `else if …` never changes depth
        if (OPENERS.has(word)) {
            const name = word === 'define' || word === 'block' ? quotedArg(action, text)?.value ?? null : null;
            stack.push({ word, name, actionStart: action.start, actionEnd: action.end });
        } else if (word === 'end') {
            const open = stack.pop();
            if (open && open.name !== null) {
                defines.push({ name: open.name, file, start: open.actionStart, end: action.end, body: boundedBody(text.slice(open.actionEnd, action.start)) });
            }
        }
    }
    // Unclosed declarations (still typing): attribute them with the rest of
    // the file so navigation keeps working on partial documents.
    for (const open of stack) {
        if (open.name !== null) defines.push({ name: open.name, file, start: open.actionStart, end: text.length, body: boundedBody(text.slice(open.actionEnd, text.length)) });
    }
    return defines;
}

/** Keep hover previews small even for large helper templates. */
function boundedBody(body: string): string {
    const trimmed = body.trim();
    return trimmed.length > 400 ? trimmed.slice(0, 400) + '…' : trimmed;
}

/** `include "name"` / `template "name"` call sites of a document. */
export function templateCalls(text: string): readonly TemplateCall[] {
    const calls: TemplateCall[] = [];
    for (const action of TemplateScanner.scan(text)) {
        const body = text.slice(action.bodyStart, action.bodyEnd);
        if (!/^\s*(?:include|template)\s/.test(body)) continue;
        const arg = quotedArg(action, text);
        if (arg) calls.push({ name: arg.value, start: arg.start, end: arg.end });
    }
    return calls;
}

/** The template-name literal of an include/template call containing `offset`, if any. */
export function templateCallAt(text: string, offset: number): TemplateCall | null {
    for (const call of templateCalls(text)) {
        if (offset >= call.start - 1 && offset <= call.end + 1) return call; // include the quotes
    }
    return null;
}

let memo: { stamp: number; root: string; current: string; value: readonly ChartDefine[] } = { stamp: -1, root: '', current: '', value: [] };

/**
 * Named templates of a whole chart: every file under `<root>/templates/`.
 * `current` replaces the on-disk content of its file, so unsaved buffers
 * participate.
 */
export function chartDefinesFor(
    context: ChartTemplateContext,
    stamp: number,
    current?: { readonly file: string; readonly text: string } | null,
): readonly ChartDefine[] {
    const cur = current ?? null;
    if (memo.stamp !== stamp || memo.root !== context.root || memo.current !== cur?.file) {
        memo = { stamp, root: context.root, current: cur?.file ?? '', value: collectDefines(context.root, cur) };
    }
    return memo.value;
}

let callMemo: { stamp: number; root: string; current: string; value: readonly ChartCall[] } = { stamp: -1, root: '', current: '', value: [] };

/** `include`/`template` call sites across every template file of the chart. */
export function chartCallsFor(
    context: ChartTemplateContext,
    stamp: number,
    current?: { readonly file: string; readonly text: string } | null,
): readonly ChartCall[] {
    const cur = current ?? null;
    if (callMemo.stamp !== stamp || callMemo.root !== context.root || callMemo.current !== cur?.file) {
        callMemo = { stamp, root: context.root, current: cur?.file ?? '', value: collectCalls(context.root, cur) };
    }
    return callMemo.value;
}

function collectDefines(root: string, current: { readonly file: string; readonly text: string } | null): readonly ChartDefine[] {
    const defines: ChartDefine[] = [];
    for (const entry of templateFileTexts(root, current)) {
        defines.push(...scanDefines(entry.text, entry.file));
        if (defines.length >= MAX_DEFINES) break;
    }
    return defines;
}

function collectCalls(root: string, current: { readonly file: string; readonly text: string } | null): readonly ChartCall[] {
    const calls: ChartCall[] = [];
    for (const entry of templateFileTexts(root, current)) {
        for (const call of templateCalls(entry.text)) calls.push({ ...call, file: entry.file });
        if (calls.length >= MAX_DEFINES) break;
    }
    return calls;
}

/** Every readable file under `<root>/templates/` with its text; `current` overrides its own file. */
function* templateFileTexts(root: string, current: { readonly file: string; readonly text: string } | null): Generator<{ file: string; text: string }> {
    const templatesDir = path.join(root, 'templates');
    let files: string[];
    try {
        files = listFiles(templatesDir, '', 0, { count: 0 });
    } catch {
        return;
    }
    for (const file of files) {
        const absolute = path.join(templatesDir, file);
        const text = current && absolute === current.file ? current.text : readBounded(absolute);
        if (text !== null) yield { file: absolute, text };
    }
}

/** Recursive file list under `dir` (relative, `/`-joined) within the bounds. */
function listFiles(dir: string, prefix: string, depth: number, budget: { count: number }): string[] {
    if (depth > 8 || budget.count > MAX_FILES) return [];
    const result: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return result;
    }
    for (const entry of entries) {
        if (++budget.count > MAX_FILES) return result;
        if (entry.isDirectory()) {
            result.push(...listFiles(path.join(dir, entry.name), prefix + entry.name + '/', depth + 1, budget));
        } else if (entry.isFile()) {
            result.push(prefix + entry.name);
        }
    }
    return result;
}

function readBounded(file: string): string | null {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}
