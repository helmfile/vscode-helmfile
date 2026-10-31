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
 * …or gate literal entries behind value conditions:
 *
 *   environments:
 *     default:
 *       values: […]
 *   {{- if .Values | get "install.mysql_innodbcluster_d7y" false }}
 *     mysql-innodbcluster:
 *       values: […]
 *   {{- end }}
 *
 * Everything is resolved statically, in the spirit of the IntelliJ plugin's
 * "no execution" philosophy — a small evaluator over a whitelist of pure,
 * read-only constructs; anything else refuses to guess and falls back to:
 *
 *   1. Evaluate `readFile`/`fromYaml`/`index`/`get`/`.Values` expressions
 *      over template variables and the current values model; keys of the
 *      resulting mappings and condition-guarded literal keys become names.
 *   2. Directory inference: value paths templated as `environments/{{ $key }}/…`
 *      imply one environment per child directory of the static prefix.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateScanner } from './templateScanner';
import { mappingGet, parseTree, scalarPathText, type YMapping } from './yamlTree';
import { SEPARATOR, stateFor, valuesModel, type SourceFile, type ValuesDefinition } from './values';

export interface InferredEnvironment {
    readonly name: string;
    /** Where the name came from, e.g. `bases/environments.yaml` or `environments/`. */
    readonly origin: string;
}

type Value =
    | { kind: 'text'; text: string; origin: string }
    | { kind: 'mapping'; mapping: YMapping; origin: string }
    | { kind: 'values'; definitions: ValuesDefinition[]; prefix: string; origin: string }
    | null;

interface Frame {
    kind: 'if' | 'range';
    /** Whether the current branch's content is collected. */
    active: boolean;
    /** Whether any branch of this `if` has been taken yet. */
    taken: boolean;
}

/** Environment names implied by templates in the `environments:` mapping. */
export function inferEnvironments(source: SourceFile, environment?: string): InferredEnvironment[] {
    const region = environmentsRegion(source);
    if (!region) return [];

    const actions = TemplateScanner.scan(source.text)
        .filter(action => action.bodyStart >= region.start && action.bodyEnd <= region.end)
        .map(action => ({ offset: action.bodyStart, body: source.text.slice(action.bodyStart, action.bodyEnd) }));

    // Literal mapping keys inside the region (the raw YAML parse may fail on
    // the surrounding templates, so they are collected textually here). Only
    // keys at the entries' own indentation level count — deeper lines are the
    // bodies of an environment entry (`values:`, `secrets:`, …).
    const literals: { offset: number; name: string }[] = [];
    const regionText = source.text.slice(region.start, region.end);
    let entryIndent = -1;
    for (const line of regionText.split('\n')) {
        const match = /^([ \t]*)(?:\{\{[^\n]*|[A-Za-z0-9][A-Za-z0-9_.-]*):/.exec(line);
        if (!match) continue;
        if (entryIndent < 0 || match[1].length < entryIndent) entryIndent = match[1].length;
    }
    if (entryIndent >= 0) {
        for (const match of regionText.matchAll(new RegExp('^[ \\t]{' + entryIndent + '}([A-Za-z0-9][A-Za-z0-9_.-]*):(?=[ \\t]|$)', 'gm'))) {
            const line = regionText.slice(0, match.index!).split('\n').pop() ?? '';
            if (line.includes('{{')) continue; // templated keys come from range resolution
            literals.push({ offset: region.start + match.index!, name: match[1] });
        }
    }

    const variables = new Map<string, Value>();
    const inferred: InferredEnvironment[] = [];
    const stack: Frame[] = [];
    const active = () => stack.every(frame => frame.active);

    const events: { offset: number; action?: { offset: number; body: string }; literal?: { offset: number; name: string } }[] = [
        ...actions.map(action => ({ offset: action.offset, action })),
        ...literals.map(literal => ({ offset: literal.offset, literal })),
    ].sort((a, b) => a.offset - b.offset);

    for (const event of events) {
        if (event.action) {
            const body = event.action.body;
            if (/^\s*end\b/.test(body)) {
                stack.pop();
                continue;
            }
            if (/^\s*else\s+if\b/.test(body)) {
                const top = stack[stack.length - 1];
                if (top?.kind === 'if') {
                    top.active = !top.taken && truthy(evaluate(body.replace(/^\s*else\s+if/, ''), variables, source, environment));
                    top.taken = top.taken || top.active;
                }
                continue;
            }
            if (/^\s*else\b/.test(body)) {
                const top = stack[stack.length - 1];
                if (top?.kind === 'if') {
                    top.active = !top.taken;
                    top.taken = true;
                }
                continue;
            }
            if (/^\s*if\b/.test(body)) {
                const condition = evaluate(body.replace(/^\s*if/, ''), variables, source, environment);
                // An unresolvable condition is treated as taken: better to
                // offer a name that may not exist than to hide one that does.
                stack.push({ kind: 'if', active: condition === null || truthy(condition), taken: condition === null || truthy(condition) });
                continue;
            }
            if (/^\s*(?:range|with|define|block)\b/.test(body)) {
                stack.push({ kind: 'range', active: true, taken: true });
            }
            if (!active()) continue;

            const assign = /^\s*\$(\w+)\s*:=\s*([\s\S]+?)\s*$/.exec(body);
            if (assign) {
                variables.set(assign[1], evaluate(assign[2], variables, source, environment));
                continue;
            }
            const range = /^\s*range\s+\$(\w+)\s*(?:,\s*\$\w+\s*)?:=\s*([\s\S]+?)\s*$/.exec(body);
            if (range) {
                const value = evaluate(range[2], variables, source, environment);
                const names =
                    value?.kind === 'mapping'
                        ? value.mapping.pairs.filter(pair => pair.key && isEnvironmentName(pair.key)).map(pair => pair.key!)
                        : value?.kind === 'values'
                          ? childKeysOf(value).filter(isEnvironmentName)
                          : [];
                for (const name of names) inferred.push({ name, origin: value!.origin });
            }
            continue;
        }
        if (event.literal && active() && isEnvironmentName(event.literal.name)) {
            inferred.push({ name: event.literal.name, origin: path.basename(source.uri.fsPath) });
        }
    }
    if (inferred.length) return dedupe(inferred);

    // Tier 2: `dir/{{ $key }}/…` value paths imply one env per child dir.
    const results: InferredEnvironment[] = [];
    const seen = new Set<string>();
    for (const match of regionText.matchAll(/["']([^"'\r\n{}]*)\{\{-?\s*\$key\s*-?\}\}([^"'\r\n{}]*)["']/g)) {
        const prefix = match[1];
        const base = prefix ? path.join(path.dirname(source.uri.fsPath), prefix) : path.dirname(source.uri.fsPath);
        if (!prefix.endsWith('/')) continue; // template replaces a file name, not a directory segment
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

/* ---------------- static expression evaluator ---------------- */

/** Static evaluation of a pure, read-only template expression. */
function evaluate(raw: string, variables: Map<string, Value>, source: SourceFile, environment?: string): Value {
    let expr = stripParens(raw.trim());
    if (!expr) return null;

    // Call forms: `index HEAD "k"…` and `get HEAD "k" [default]`.
    for (const name of ['index', 'get']) {
        if (!expr.startsWith(name + ' ')) continue;
        const call = new RegExp(
            '^' + name + '\\s+("(?:[^"\\\\]|\\\\.)*"|\\$\\w+|\\([^()]*\\)|\\$?\\.(?:Values|StateValues))((?:\\s+"(?:[^"\\\\]|\\\\.)*")*(?:\\s+(?:true|false|nil|\\d+(?:\\.\\d+)?))?)\\s*$',
        ).exec(expr);
        if (!call) return null;
        const value = evaluate(call[1], variables, source, environment);
        const args = [...call[2].matchAll(/"((?:[^"\\]|\\.)*)"|(true|false|nil|\d+(?:\.\d+)?)/g)].map(m => (m[1] !== undefined ? m[1] : m[2]));
        if (name === 'get') {
            const next = value && lookup(value, args[0]);
            if (next) return next;
            return args.length > 1 ? { kind: 'text', text: args[args.length - 1], origin: 'default' } : null;
        }
        let nested = value;
        for (const key of args) {
            const next = nested && lookup(nested, key);
            if (!next) return null;
            nested = next;
        }
        return nested;
    }

    const segments = splitPipeline(expr);
    let value: Value = evaluateHead(segments[0], variables, source, environment);
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
        } else if (fn.startsWith('get ')) {
            const call = /^get\s+"((?:[^"\\]|\\.)*)"(?:\s+(true|false|nil|"[^"]*"|\d+(?:\.\d+)?))?$/.exec(fn);
            if (!call) return null;
            const next: Value = value && lookup(value, call[1]);
            value =
                next !== null && next !== undefined
                    ? next
                    : { kind: 'text', text: unquote(call[2] ?? 'nil'), origin: value?.kind === 'text' || value?.kind === 'mapping' || value?.kind === 'values' ? value.origin : 'default' };
        } else if (fn.startsWith('index ')) {
            value = evaluate(fn, variables, source, environment);
        } else {
            return null; // unknown pipeline stage: refuse to guess
        }
    }
    return value;
}

/** `readFile "path"`, `$var`, and `.Values` heads of an expression. */
function evaluateHead(segment: string, variables: Map<string, Value>, source: SourceFile, environment?: string): Value {
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
    if (text === '.Values' || text === '$.Values' || text === '.StateValues' || text === '$.StateValues' || text === '.Environment.Values') {
        if (!environment) return null; // avoid re-entering the model currently being built
        const state = stateFor(source.uri);
        if (!state) return null;
        const model = valuesModel(state.uri, environment);
        if (!model) return null;
        return { kind: 'values', definitions: model.completionDefinitions, prefix: '', origin: path.basename(state.uri.fsPath) };
    }
    const nested = stripParens(text);
    return nested !== text ? evaluate(nested, variables, source, environment) : null;
}

/** Key lookup over both structured kinds; `null` when absent or non-structured. */
function lookup(value: Value, key: string): Value | null {
    if (value?.kind === 'mapping') {
        const pair = mappingGet(value.mapping, key);
        if (!pair?.value) return null;
        if (pair.value.kind === 'mapping') return { kind: 'mapping', mapping: pair.value, origin: value.origin };
        if (pair.value.kind === 'scalar') return { kind: 'text', text: scalarPathText(pair.value), origin: value.origin };
        return null;
    }
    if (value?.kind === 'values') {
        // Dotted template keys (`get "a.b"`) map onto the separator-joined
        // definition paths.
        const keyPath = key.split('.').join(SEPARATOR);
        const target = value.prefix ? value.prefix + SEPARATOR + keyPath : keyPath;
        const exact = value.definitions.find(definition => definition.path === target);
        if (exact) {
            if (exact.valueKind === 'scalar') return { kind: 'text', text: exact.preview, origin: value.origin };
            if (exact.valueKind === 'map') return { kind: 'values', definitions: value.definitions, prefix: target, origin: value.origin };
            return { kind: 'text', text: 'list', origin: value.origin };
        }
        // A deeper subtree also proves the key exists.
        const deeper = value.definitions.find(definition => definition.path.startsWith(target + SEPARATOR));
        if (deeper) return { kind: 'values', definitions: value.definitions, prefix: target, origin: value.origin };
        return null;
    }
    return null;
}

/** Direct child names of a `values` node. */
function childKeysOf(value: { definitions: ValuesDefinition[]; prefix: string }): string[] {
    const prefix = value.prefix ? value.prefix + SEPARATOR : '';
    const names: string[] = [];
    const seen = new Set<string>();
    for (const definition of value.definitions) {
        if (!definition.path.startsWith(prefix)) continue;
        const rest = definition.path.slice(prefix.length);
        if (!rest) continue;
        const child = rest.split(SEPARATOR)[0];
        if (!seen.has(child)) {
            seen.add(child);
            names.push(child);
        }
    }
    return names;
}

function truthy(value: Value): boolean {
    if (!value) return false;
    if (value.kind === 'text') return value.text !== '' && value.text !== 'false' && value.text !== 'nil';
    return true; // mappings and value trees exist
}

function unquote(literal: string): string {
    if (literal.startsWith('"') && literal.endsWith('"')) return literal.slice(1, -1);
    return literal;
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
