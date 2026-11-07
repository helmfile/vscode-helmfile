/**
 * Editor-neutral folding spans for helmfile YAML: every pair with a block
 * value folds from its key; `---` documents fold as regions in
 * multi-document files.
 */
import { parseTree, walkAll, type YPair } from './yamlTree';

export interface FoldingSpan {
    /** Offset of the fold start (pair key or document start). */
    readonly start: number;
    /** Offset of the fold end (pair value end or document end). */
    readonly end: number;
    /** true for `---` document regions (fold only when spanning several lines). */
    readonly document: boolean;
}

/** Folding spans as offsets; the provider converts them to line ranges. */
export function foldingSpans(text: string): FoldingSpan[] {
    const spans: FoldingSpan[] = [];
    const tree = parseTree(text);
    for (const doc of tree.docs) {
        if (doc.root) {
            walkAll(doc.root, node => {
                if (node.kind !== 'pair') return;
                const pair = node as YPair;
                if (!pair.value) return;
                spans.push({ start: pair.keyStart, end: pair.valueEnd, document: false });
            });
        }
        if (tree.docs.length > 1) spans.push({ start: doc.start, end: doc.end, document: true });
    }
    return spans;
}
