/**
 * Position-aware YAML tree built on the `yaml` package, ported from the
 * IntelliJ plugin's use of the JetBrains YAML PSI. Positions are character
 * offsets into the original document text. Go template actions must be
 * masked with TemplateScanner.mask() before parsing when the caller needs
 * to look inside templated keys or values.
 */

import { Alias, Document, Node, Pair, Scalar, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';
import { TemplateScanner } from './templateScanner';

export interface YScalar {
    readonly kind: 'scalar';
    readonly start: number;
    readonly end: number;
    readonly raw: string;
    /** Decoded scalar value as text; empty for null. */
    readonly value: string;
    readonly parent: TreeNode | null;
}

export interface YMapping {
    readonly kind: 'mapping';
    readonly start: number;
    readonly end: number;
    readonly pairs: YPair[];
    readonly parent: TreeNode | null;
}

export interface YSequence {
    readonly kind: 'sequence';
    readonly start: number;
    readonly end: number;
    readonly items: YNode[];
    readonly parent: TreeNode | null;
}

export interface YPair {
    readonly kind: 'pair';
    readonly key: string;
    readonly keyStart: number;
    readonly keyEnd: number;
    readonly value: YNode | null;
    readonly valueStart: number;
    readonly valueEnd: number;
    readonly start: number;
    readonly end: number;
    readonly parent: YMapping;
}

export type YNode = YScalar | YMapping | YSequence;
export type TreeNode = YNode | YPair;

export interface YDoc {
    readonly root: YNode | null;
    readonly start: number;
    readonly end: number;
}

export interface YTree {
    readonly docs: YDoc[];
    /** Parse errors collected from every document (offsets are text offsets). */
    readonly errors: readonly YTreeError[];
}

export interface YTreeError {
    readonly message: string;
    readonly offset: number;
    readonly end: number;
}

export function parseTree(text: string): YTree {
    const errors: YTreeError[] = [];
    let documents: Document.Parsed[];
    try {
        documents = parseAllDocuments(text, { logLevel: 'silent', strict: false });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { docs: [{ root: null, start: 0, end: text.length }], errors: [{ message, offset: 0, end: text.length }] };
    }
    const docs: YDoc[] = [];
    for (const doc of documents) {
        for (const problem of doc.errors) {
            const pos = (problem as { pos?: [number, number] }).pos;
            const start = pos?.[0] ?? doc.range?.[0] ?? 0;
            const end = pos?.[1] ?? start;
            errors.push({ message: problem.message, offset: start, end: end > start ? end : start + 1 });
        }
        const root = doc.contents ? buildNode(doc.contents, text, null, new Set<Node>(), doc) : null;
        docs.push({ root, start: root?.start ?? 0, end: root?.end ?? text.length });
    }
    return { docs: docs.length ? docs : [{ root: null, start: 0, end: text.length }], errors };
}

export function buildNode(node: Node, text: string, parent: TreeNode | null, visiting: Set<Node>, doc?: Document): YNode {
    const resolved = node instanceof Alias && doc ? resolveAlias(node, doc, visiting) : node;
    const range = node.range ?? resolved.range ?? [0, 0, 0];
    const start = range[0];
    const end = Math.max(range[1], range[2]);
    if (isMap(resolved)) {
        const mapping: YMapping = { kind: 'mapping', start, end, pairs: [], parent };
        mappingPairsMutable(mapping).push(...resolved.items.filter(pair => pair.key).map(pair => buildPair(pair as Pair, text, mapping, visiting, doc)));
        return mapping;
    }
    if (isSeq(resolved)) {
        const sequence: YSequence = { kind: 'sequence', start, end, items: [], parent };
        sequenceItemsMutable(sequence).push(...resolved.items.filter((item): item is Node => item != null).map(item => buildNode(item, text, sequence, visiting, doc)));
        return sequence;
    }
    const scalar = resolved as Scalar;
    const raw = text.slice(start, end);
    return { kind: 'scalar', start, end, raw, value: scalarValue(scalar), parent };
}

function buildPair(pair: Pair, text: string, parent: YMapping, visiting: Set<Node>, doc?: Document): YPair {
    const key = pair.key as Node;
    const keyRange = key.range ?? [0, 0, 0];
    const value = pair.value as Node | null;
    const valueRange = value?.range;
    const valueStart = valueRange ? valueRange[0] : keyRange[1];
    const valueEnd = valueRange ? Math.max(valueRange[1], valueRange[2]) : keyRange[1];
    const node: YPair = {
        kind: 'pair',
        key: scalarKey(key),
        keyStart: keyRange[0],
        keyEnd: Math.max(keyRange[1], keyRange[2]),
        value: null,
        valueStart,
        valueEnd,
        start: keyRange[0],
        end: Math.max(keyRange[1], keyRange[2], valueEnd),
        parent,
    };
    if (value) (node as { value: YNode | null }).value = buildNode(value, text, node, visiting, doc);
    return node;
}

function resolveAlias(alias: Alias, doc: Document, visiting: Set<Node>): Node {
    if (visiting.has(alias)) return alias;
    visiting.add(alias);
    let node: Node = alias;
    for (let i = 0; i < 32 && node instanceof Alias; i++) {
        const resolved = node.resolve(doc);
        if (!resolved) break;
        node = resolved;
    }
    return node;
}

function scalarValue(scalar: Scalar): string {
    if (scalar.value == null) return '';
    return String(scalar.value);
}

function scalarKey(key: Node): string {
    if (isScalar(key)) return scalarValue(key);
    return '';
}

/** YamlFileValues.pathText: raw text without quotes when it contains a template. */
export function scalarPathText(node: YScalar | YNode | null): string {
    if (!node || node.kind !== 'scalar') return '';
    const raw = node.raw.trim();
    if (!raw.includes('{{')) return node.value;
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
        return raw.substring(1, raw.length - 1);
    }
    return raw;
}

/** HelmfileSchema.ancestors: keys from the root down, excluding the node itself. */
export function ancestors(node: TreeNode | null): string[] {
    const result: string[] = [];
    for (let current = node?.parent ?? null; current; current = current.parent) {
        if (current.kind === 'pair') result.push(current.key);
    }
    return result.reverse();
}

/** HelmfileSchema.completionPath: mapping-key path of the line being typed, or null. */
export function parseCompletionPath(text: string, offset: number): string[] | null {
    const line = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    const prefix = text.substring(line, offset);
    if (!/^[ \t]*(?:-\s*)?[A-Za-z_]*$/.test(prefix)) return null;
    const indentation = prefix.replace(/[A-Za-z_]*$/, '');
    const source = TemplateScanner.mask(text.substring(0, line)) + indentation + '__helmfile_completion__: null\n';
    const tree = parseTree(source);
    const sentinel = findPair(tree, '__helmfile_completion__');
    return sentinel ? ancestors(sentinel) : null;
}

export function findPair(tree: YTree, key: string): YPair | null {
    for (const doc of tree.docs) {
        if (!doc.root) continue;
        const found = walk(doc.root, node => node.kind === 'pair' && node.key === key ? node : null);
        if (found) return found;
    }
    return null;
}

/** Depth-first search returning the first non-null visitor result. */
export function walk<T>(node: TreeNode, visit: (node: TreeNode) => T | null): T | null {
    const result = visit(node);
    if (result != null) return result;
    if (node.kind === 'mapping') {
        for (const pair of node.pairs) {
            const found = walk(pair, visit);
            if (found != null) return found;
            if (pair.value) {
                const nested = walk(pair.value, visit);
                if (nested != null) return nested;
            }
        }
    } else if (node.kind === 'sequence') {
        for (const item of node.items) {
            const found = walk(item, visit);
            if (found != null) return found;
        }
    } else if (node.kind === 'pair' && node.value) {
        return walk(node.value, visit);
    }
    return null;
}

export function walkAll(node: TreeNode, visit: (node: TreeNode) => void): void {
    walk(node, n => {
        visit(n);
        return null;
    });
}

/** Innermost node containing the offset (pairs preferred over their values). */
export function nodeAt(tree: YTree, offset: number): TreeNode | null {
    let best: TreeNode | null = null;
    for (const doc of tree.docs) {
        if (!doc.root || offset < doc.start || offset > doc.end) continue;
        walk(doc.root, node => {
            const start = node.kind === 'pair' ? node.keyStart : node.start;
            const end = node.kind === 'pair' ? node.end : node.end;
            if (offset >= start && offset <= end) {
                if (!best || span(node) <= span(best)) best = node;
            }
            return null;
        });
    }
    return best;
}

function span(node: TreeNode): number {
    return node.kind === 'pair' ? node.end - node.start : node.end - node.start;
}

/** Innermost pair whose key range contains the offset. */
export function pairKeyAt(tree: YTree, offset: number): YPair | null {
    const node = nodeAt(tree, offset);
    if (node && node.kind === 'pair' && offset >= node.keyStart && offset <= node.keyEnd) return node;
    return null;
}

export function mappingGet(mapping: YNode | null, key: string): YPair | null {
    if (!mapping || mapping.kind !== 'mapping') return null;
    if (!mapping) return null;
    for (const pair of mapping.pairs) if (pair.key === key) return pair;
    return null;
}

export function mappingValues(mapping: YMapping | null): YNode[] {
    if (!mapping) return [];
    return mapping.pairs.map(pair => pair.value).filter((value): value is YNode => value != null);
}

export function isMappingValue(mapping: YMapping | null, key: string): YMapping | null {
    const value = mappingGet(mapping, key)?.value;
    return value && value.kind === 'mapping' ? value : null;
}

/** HelmfileValues.roots: top-level mappings of every document. */
export function rootMappings(tree: YTree): YMapping[] {
    return tree.docs.map(doc => doc.root).filter((root): root is YMapping => !!root && root.kind === 'mapping');
}

/* Mutable helpers used only during construction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mappingPairsMutable(mapping: YMapping): YPair[] {
    return (mapping as any).pairs as YPair[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sequenceItemsMutable(sequence: YSequence): YNode[] {
    return (sequence as any).items as YNode[];
}
