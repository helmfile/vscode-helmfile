/**
 * Editor-neutral selection chains (expand selection): identifier → dotted
 * value path → whole `{{ action }}` → YAML pair → mapping → document.
 */
import { TemplateScanner } from './templateScanner';
import { tokenizeAction } from './semanticTokens';
import { nodeAt, parseTree, type TreeNode } from './yamlTree';

/** Nested selection spans for one offset, innermost first. */
export function selectionChain(text: string, offset: number): Array<readonly [number, number]> {
    const actions = TemplateScanner.scan(text);
    const tree = parseTree(text);
    const chain: Array<readonly [number, number]> = [];
    const push = (start: number, end: number): void => {
        const last = chain[chain.length - 1];
        if (last) {
            if (start > last[0] || end < last[1]) return; // does not contain the previous range
            if (start === last[0] && end === last[1]) return; // duplicate
        }
        chain.push([start, end]);
    };
    push(offset, Math.min(offset + 1, text.length));

    // Word around the caret (identifiers, dotted paths, chart refs).
    let wordStart = offset;
    let wordEnd = offset;
    while (wordStart > 0 && /[A-Za-z0-9_.$-]/.test(text[wordStart - 1] ?? '')) wordStart--;
    while (wordEnd < text.length && /[A-Za-z0-9_.$-]/.test(text[wordEnd] ?? '')) wordEnd++;
    if (wordEnd > wordStart) push(wordStart, wordEnd);

    // Inside an action: exact token (path/identifier boundary) then the whole action.
    for (const action of actions) {
        if (offset < action.start || offset > action.end) continue;
        for (const token of tokenizeAction(text, action)) {
            if (offset >= token.start && offset <= token.end) {
                push(token.start, token.end);
                break;
            }
        }
        push(action.start, action.end);
        break;
    }

    // YAML structure: node → pair → enclosing mappings.
    let node: TreeNode | null = text.length > 0 ? nodeAt(tree, Math.min(offset, text.length - 1)) : null;
    while (node) {
        push(node.start, node.end);
        node = node.parent;
    }

    push(0, text.length);
    return chain;
}
