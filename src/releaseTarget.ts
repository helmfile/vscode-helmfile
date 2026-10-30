/**
 * Release declarations under the editor cursor. Port of HelmfileReleaseTarget
 * from the IntelliJ plugin.
 */

import { isHelmfileName, readSource, SourceFile } from './values';
import { YMapping, YPair, ancestors, mappingGet, nodeAt, scalarPathText, TreeNode } from './yamlTree';

export function isRelease(pair: YPair): boolean {
    if (pair.key !== 'name') return false;
    const path = ancestors(pair);
    return path.length === 1 && path[0] === 'releases';
}

/** Nearest enclosing release `name:` pair at or above the offset. */
export function declarationAt(source: SourceFile, offset: number): YPair | null {
    const position = Math.max(0, Math.min(offset, source.text.length - 1));
    const node = nodeAt(source.tree, position);
    if (!node) return null;
    for (let current: TreeNode | null = node; current; current = current.parent) {
        if (current.kind === 'pair' && current.key === 'name' && isRelease(current)) return current;
    }
    return null;
}

/** Plain release name; templated names resolve to "". */
export function literal(namePair: YPair | null): string {
    if (!namePair?.value || namePair.value.kind !== 'scalar') return '';
    const value = scalarPathText(namePair.value);
    return value.includes('{{') ? '' : value;
}

export function namespace(namePair: YPair | null): string {
    if (!namePair) return '';
    const release = namePair.parent;
    const namespacePair = release ? mappingGet(release, 'namespace') : null;
    if (namespacePair) return literal(namespacePair);
    const root = rootMappingOf(namePair);
    const rootNamespace = root ? mappingGet(root, 'namespace') : null;
    return rootNamespace ? literal(rootNamespace) : '';
}

/** Document top-level mapping, mirroring YAMLDocument.getTopLevelValue(). */
export function rootMappingOf(node: TreeNode): YMapping | null {
    let current: TreeNode | null = node;
    while (current?.parent) current = current.parent;
    return current && current.kind === 'mapping' ? current : null;
}

export interface ReleaseTarget {
    readonly source: SourceFile;
    readonly namePair: YPair;
}

export function releaseTargetAt(uri: import('vscode').Uri, offset: number): ReleaseTarget | null {
    const source = readSource(uri);
    if (!source || !isHelmfileName(source.uri.fsPath.split('/').pop() ?? '')) return null;
    if (!source.text.length) return null;
    const namePair = declarationAt(source, offset);
    return namePair ? { source, namePair } : null;
}
