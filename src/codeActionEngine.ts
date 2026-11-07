/**
 * Editor-neutral quick-fix edit builders: every fix computes plain file
 * operations (create/insert/replace/delete with offsets) that the
 * codeActions.ts provider converts into vscode.WorkspaceEdit entries.
 */
import * as fs from 'node:fs';
import { mappingGet, parseTree, rootMappings, type YMapping, type YPair } from './yamlTree';

export type EngineOperation =
    | { readonly kind: 'createFile'; readonly file: string }
    | { readonly kind: 'insert'; readonly file: string; readonly offset: number; readonly text: string }
    | { readonly kind: 'replace'; readonly file: string; readonly start: number; readonly end: number; readonly text: string }
    | { readonly kind: 'delete'; readonly file: string; readonly start: number; readonly end: number };

/**
 * Declare a dotted key inside values.schema.json: creates the `properties`
 * chain for the path (existing nodes are kept) and rewrites the file with
 * two-space indentation. Returns null when the file is not valid JSON or an
 * intermediate node is not an object schema.
 */
export function schemaAdditionOperations(segments: readonly string[], schemaFile: string, type: string): EngineOperation[] | null {
    let schema: unknown;
    let existing: string;
    try {
        existing = fs.readFileSync(schemaFile, 'utf8');
        schema = JSON.parse(existing);
    } catch {
        return null;
    }
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return null;
    let node = schema as Record<string, unknown>;
    for (let i = 0; i < segments.length - 1; i++) {
        const properties = typeof node.properties === 'object' && node.properties !== null ? node.properties as Record<string, unknown> : (node.properties = {});
        const next = properties[segments[i]];
        if (next === undefined) {
            node = properties[segments[i]] = { type: 'object', properties: {} } as Record<string, unknown>;
        } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
            node = next as Record<string, unknown>;
        } else {
            return null; // intermediate segment exists as a scalar
        }
    }
    const properties = typeof node.properties === 'object' && node.properties !== null ? node.properties as Record<string, unknown> : (node.properties = {});
    const last = segments[segments.length - 1];
    if (properties[last] === undefined) properties[last] = { type };
    const content = JSON.stringify(schema, null, 2) + '\n';
    return [{ kind: 'replace', file: schemaFile, start: 0, end: existing.length, text: content }];
}

/** Create a `define` skeleton, appended to `_helpers.tpl` (created when missing). */
export function defineSkeletonOperations(name: string, helpers: string): EngineOperation[] {
    const skeleton = `{{- define "${name}" -}}\n\n{{- end -}}\n`;
    if (fs.existsSync(helpers)) {
        const body = fs.readFileSync(helpers, 'utf8');
        const separator = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
        return [{ kind: 'insert', file: helpers, offset: body.length, text: `${separator}${skeleton}` }];
    }
    return [
        { kind: 'createFile', file: helpers },
        { kind: 'insert', file: helpers, offset: 0, text: `{{- define "${name}" -}}\n\n{{- end -}}\n` },
    ];
}

/** Span of the whole `{{ define }}…{{ end }}` block, its indentation and trailing newline. */
export function defineRemovalSpan(text: string, start: number, end: number): { start: number; end: number } {
    let blockStart = start;
    while (blockStart > 0 && (text[blockStart - 1] === ' ' || text[blockStart - 1] === '\t')) blockStart--;
    let blockEnd = end;
    if (text.slice(blockEnd).startsWith('\n')) blockEnd++;
    return { start: blockStart, end: blockEnd };
}

/**
 * Insert a missing `.Values` key chain into the chart's values.yaml.
 * Walks the existing nested mappings as deep as they match, then appends
 * the missing tail (leaf as `null` placeholder) at the right indentation.
 */
export function valuesAdditionOperations(segments: readonly string[], valuesFile: string): EngineOperation[] | null {
    let text = '';
    try {
        text = fs.readFileSync(valuesFile, 'utf8');
    } catch {
        return null;
    }
    const columnOf = (offset: number): number => offset - (text.slice(0, offset).lastIndexOf('\n') + 1);
    const roots = rootMappings(parseTree(text));
    let parent: YMapping | null = roots[0] ?? null;
    let parentColumn = -2; // root children sit at column 0
    let index = 0;
    while (parent && index < segments.length) {
        const pair: YPair | null = mappingGet(parent, segments[index]);
        if (!pair) break; // missing from here on
        if (index === segments.length - 1) return null; // the full chain already exists
        if (pair.value?.kind !== 'mapping') return null; // intermediate holds a scalar — bail out
        parent = pair.value;
        parentColumn = columnOf(pair.keyStart);
        index++;
    }
    const chain: string[] = [];
    for (let i = index; i < segments.length; i++) {
        const indent = ' '.repeat(parentColumn + 2 + 2 * (i - index));
        chain.push(`${indent}${segments[i]}:${i === segments.length - 1 ? ' null' : ''}`);
    }
    if (chain.length === 0) return null;
    if (!parent) {
        // Empty (or non-mapping) values.yaml: start the file.
        return [{ kind: 'insert', file: valuesFile, offset: 0, text: `${chain.join('\n')}\n` }];
    }
    const anchor = parent.pairs.length > 0 ? parent.pairs[parent.pairs.length - 1].end : parent.end;
    return [{ kind: 'insert', file: valuesFile, offset: anchor, text: `\n${chain.join('\n')}` }];
}

/**
 * Replace `selection` with `{{ include "name" . }}` and append the selected
 * text as a `{{ define }}` block at the end of the same file.
 */
export function extractOperations(text: string, file: string, selection: { start: number; end: number }, name: string): EngineOperation[] | null {
    const selected = text.slice(selection.start, selection.end);
    if (selected.trim().length === 0) return null;
    const tail = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    return [
        { kind: 'replace', file, start: selection.start, end: selection.end, text: `{{ include "${name}" . }}` },
        { kind: 'insert', file, offset: text.length, text: `${tail}{{- define "${name}" -}}\n${selected}\n{{- end -}}\n` },
    ];
}
