/**
 * Recognition of dynamically generated `environments:` entries.
 *
 * Helmfile states may produce environment names with Go templates, e.g.
 * the workaround for roboll/helmfile#1045:
 *
 *   environments:
 *   {{ $environments := (readFile "bases/environments.yaml" | fromYaml) }}
 *   {{ range $key, $env := (index $environments "environments") }}
 *     {{ $key }}:
 *       values:
 *         - "environments/{{ $key }}/*.yaml.gotmpl"
 *   {{- end }}
 *
 * Two static tiers resolve those names without executing anything, in the
 * spirit of the IntelliJ plugin's "static analysis only" philosophy:
 *
 *   1. Evaluate the pure read-only expression chain: `readFile` +
 *      `fromYaml` + `index` over template variables, then take the keys of
 *      the resulting mapping as environment names.
 *   2. Fall back to directory inference: value paths templated as
 *      `environments/{{ $key }}/…` imply one environment per child
 *      directory of the static prefix.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateScanner } from './templateScanner';
import { mappingGet, parseTree, type YMapping } from './yamlTree';
import type { SourceFile } from './values';

export interface InferredEnvironment {
    readonly name: string;
    /** Where the name came from, e.g. `bases/environments.yaml` or `environments/`. */
    readonly origin: string;
}

type Value = { kind: 'text'; text: string; origin: string } | { kind: 'mapping'; mapping: YMapping; origin: string } | null;

/** Environment names implied by templates in the `environments:` mapping. */
export function inferEnvironments(source: SourceFile): InferredEnvironment[] {
    const region = environmentsRegion(source);
    if (!region) return [];

    const actions = TemplateScanner.scan(source.text).filter(action => action.bodyStart >= region.start && action.bodyEnd <= region.end);
    const variables = new Map<string, Value>();
    const inferred: InferredEnvironment[] = [];
    for (const action of actions) {
        const body = source.text.slice(action.bodyStart, action.bodyEnd);

        const assign = /^\s*\$(\w+)\s*:=\s*([\s\S]+?)\s*$/.exec(body);
        if (assign) {
            variables.set(assign[1], evaluate(assign[2], variables, source));
            continue;
        }

        const range = /^\s*range\s+\$(\w+)\s*(?:,\s*\$\w+\s*)?:=\s*([\s\S]+?)\s*$/.exec(body);
        if (range) {
            const value = evaluate(range[2], variables, source);
            if (value?.kind === 'mapping') {
                for (const pair of value.mapping.pairs) {
                    if (pair.key && isEnvironmentName(pair.key) && !pair.key.includes('{{')) {
                        inferred.push({ name: pair.key, origin: value.origin });
                    }
                }
            }
        }
    }
    if (inferred.length) return dedupe(inferred);

    // Tier 2: `dir/{{ $key }}/…` value paths imply one env per child dir.
    const results: InferredEnvironment[] = [];
    const regionText = source.text.slice(region.start, region.end);
    const seen = new Set<string>();
    for (const match of regionText.matchAll(/["']([^"'\r\n{}]*)\{\{-?\s*\$key\s*-?\}\}([^"'\r\n{}]*)["']/g)) {
        const prefix = match[1];
        const dir = path.dirname(path.join(path.dirname(source.uri.fsPath), prefix));
        const base = prefix ? path.join(path.dirname(source.uri.fsPath), prefix) : path.dirname(source.uri.fsPath);
        if (dir !== base && !prefix.endsWith('/')) continue; // template replaces a path segment, not a file name
        let entries: string[];
        try {
            entries = fs.readdirSync(base);
        } catch {
            continue;
        }
        const origin = prefix || '.';
        for (const entry of entries) {
            if (!isEnvironmentName(entry)) continue;
            try {
                if (!fs.statSync(path.join(base, entry)).isDirectory()) continue;
            } catch {
                continue;
            }
            if (seen.has(entry)) continue;
            seen.add(entry);
            results.push({ name: entry, origin });
        }
    }
    return dedupe(results);
}

/** Static evaluation of a pure, read-only template expression. */
function evaluate(raw: string, variables: Map<string, Value>, source: SourceFile): Value {
    let expr = stripParens(raw.trim());
    if (!expr) return null;

    // `index $var "k"` / `index (expr) "k1" "k2"` — call form.
    if (expr.startsWith('index ')) {
        const call = /^index\s+("[^"]*"|\$\w+|\([^()]*\))((?:\s+"[^"]*")*)\s*$/.exec(expr);
        if (!call) return null;
        const head = evaluate(call[1], variables, source);
        const keys = [...call[2].matchAll(/"([^"]*)"/g)].map(m => m[1]);
        let value: Value = head;
        for (const key of keys) {
            if (value?.kind !== 'mapping') return null;
            const pair = mappingGet(value.mapping, key);
            value = pair?.value && pair.value.kind === 'mapping' ? { kind: 'mapping', mapping: pair.value, origin: value.origin } : null;
        }
        return value;
    }

    const segments = splitPipeline(expr);
    let value: Value = evaluateHead(segments[0], variables, source);
    if (!value || segments.length === 1) return value;
    for (const segment of segments.slice(1)) {
        const fn = segment.trim();
        if (fn === 'fromYaml' || fn === 'fromYamlArray') {
            if (!value || value.kind !== 'text') return null;
            const origin: string = value.origin;
            const tree = parseTree(value.text);
            const root = tree.docs.find(doc => doc.root?.kind === 'mapping')?.root;
            if (!root || root.kind !== 'mapping') return null;
            value = { kind: 'mapping', mapping: root, origin };
        } else if (fn === 'quote' || fn === 'squote' || /^default\b/.test(fn) || fn === 'toString') {
            // identity for our purposes
        } else if (fn.startsWith('index ') && value?.kind === 'mapping') {
            value = evaluate(fn, variables, source);
        } else {
            return null; // unknown pipeline stage: refuse to guess
        }
    }
    return value;
}

/** `readFile "path"` and `$var` heads of an expression. */
function evaluateHead(segment: string, variables: Map<string, Value>, source: SourceFile): Value {
    const text = segment.trim();
    const readFile = /^readFile\s+"([^"]+)"$/.exec(text);
    if (readFile) {
        const file = path.isAbsolute(readFile[1]) ? readFile[1] : path.join(path.dirname(source.uri.fsPath), readFile[1]);
        const origin = path.relative(path.dirname(source.uri.fsPath), file) || path.basename(file);
        try {
            return { kind: 'text', text: fs.readFileSync(file, 'utf8'), origin };
        } catch {
            return null;
        }
    }
    const variable = /^\$(\w+)$/.exec(text);
    if (variable) return variables.get(variable[1]) ?? null;
    const nested = stripParens(text);
    return nested !== text ? evaluate(nested, variables, source) : null;
}

function splitPipeline(expr: string): string[] {
    const segments: string[] = [];
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let start = 0;
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === '(' || c === '{') depth++;
        else if (c === ')' || c === '}') depth--;
        else if (c === '|' && depth === 0) {
            segments.push(expr.slice(start, i));
            start = i + 1;
        }
    }
    segments.push(expr.slice(start));
    return segments;
}

function stripParens(expr: string): string {
    let text = expr.trim();
    while (text.startsWith('(') && text.endsWith(')')) {
        let depth = 0;
        let balanced = true;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') {
                depth--;
                if (depth === 0 && i !== text.length - 1) balanced = false;
            }
        }
        if (!balanced) break;
        text = text.slice(1, -1).trim();
    }
    return text;
}

/**
 * The `environments:` mapping region, located by line scanning: from the
 * line after a top-level `environments:` key to the next top-level key or
 * document separator. (The masked-document parse cannot be used here:
 * templated keys fill whole lines, which breaks the mapping structure.)
 */
function environmentsRegion(source: SourceFile): { start: number; end: number } | null {
    const text = source.text;
    const lines = text.split('\n');
    let offset = 0;
    let start = -1;
    for (const line of lines) {
        const at = offset;
        offset += line.length + 1;
        if (start < 0) {
            if (/^environments:\s*(#.*)?$/.test(line)) start = Math.min(at + line.length + 1, text.length);
            continue;
        }
        // A top-level key, list item, or document separator ends the region;
        // col-0 template actions ({{ ... }}, {{- end }}) do not.
        if (line.length > 0 && !/^\s/.test(line) && !/^\{|^#/.test(line)) {
            return { start, end: at };
        }
    }
    return start >= 0 && start < text.length ? { start, end: text.length } : null;
}

function isEnvironmentName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('.');
}

function dedupe(list: InferredEnvironment[]): InferredEnvironment[] {
    const seen = new Set<string>();
    const unique: InferredEnvironment[] = [];
    for (const item of list) {
        if (seen.has(item.name)) continue;
        seen.add(item.name);
        unique.push(item);
    }
    return unique;
}
