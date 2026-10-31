/**
 * Release templates and `inherit` navigation. Port of HelmfileTemplates from
 * the IntelliJ plugin. Template mappings are shared across base states.
 */

import * as vscode from 'vscode';
import { SourceFile, contentStamp, readSource, resolveValueFiles, stateFor } from './values';
import { YMapping, YPair, YScalar, ancestors, mappingGet, rootMappings, scalarPathText, walkAll } from './yamlTree';

export interface TemplateDeclaration {
    readonly pair: YPair;
    readonly source: SourceFile;
}

export function isInheritance(scalar: YScalar): boolean {
    const path = ancestors(scalar);
    return (
        path.length === 3 &&
        path[0] === 'releases' &&
        path[1] === 'inherit' &&
        path[2] === 'template'
    ) || (
        path.length === 4 &&
        path[0] === 'templates' &&
        path[2] === 'inherit' &&
        path[3] === 'template'
    );
}

export function isDeclaration(pair: YPair | null): boolean {
    return !!pair && ancestors(pair).length === 1 && ancestors(pair)[0] === 'templates';
}

const declarationCache = new Map<string, Map<string, TemplateDeclaration>>();
let declarationCacheStamp = -1;

export function templateDeclarations(uri: vscode.Uri, environment: string): Map<string, TemplateDeclaration> {
    const stamp = contentStamp();
    if (stamp !== declarationCacheStamp) {
        // Content changed: earlier generations would otherwise stay referenced
        // forever (every keystroke produces a new stamp key).
        declarationCache.clear();
        declarationCacheStamp = stamp;
    }
    const source = readSource(uri);
    const cacheKey = `${source?.uri.toString() ?? uri.toString()}|${environment}|${stamp}`;
    const cached = declarationCache.get(cacheKey);
    if (cached) return cached;
    const result = new Map<string, TemplateDeclaration>();
    collect(stateFor(uri), result, new Set(), 0, environment);
    declarationCache.set(cacheKey, result);
    return result;
}

function collect(source: SourceFile | null, result: Map<string, TemplateDeclaration>, visiting: Set<string>, depth: number, environment: string): void {
    if (!source || depth > 40 || visiting.has(source.uri.toString())) return;
    visiting.add(source.uri.toString());
    try {
        for (const root of rootMappings(source.tree)) {
            const bases = mappingGet(root, 'bases');
            if (bases?.value && bases.value.kind === 'sequence') {
                for (const item of bases.value.items) {
                    if (item.kind !== 'scalar') continue;
                    for (const base of resolveValueFiles(source, scalarPathText(item), environment)) {
                        collect(readSource(base), result, visiting, depth + 1, environment);
                    }
                }
            }
            const templates = mappingGet(root, 'templates');
            if (templates?.value && templates.value.kind === 'mapping') {
                for (const template of templates.value.pairs) result.set(template.key, { pair: template, source });
            }
        }
    } finally {
        visiting.delete(source.uri.toString());
    }
}

/** Owner `name:` key (release) or `templates:` declaration of an inherit item. */
export function owner(scalar: YScalar): YPair | null {
    // inherit[].template -> inherit -> release mapping or template mapping.
    const templatePair = scalar.parent;
    if (!templatePair || templatePair.kind !== 'pair') return null;
    const inheritPair = templatePair.parent?.parent;
    if (!inheritPair || inheritPair.kind !== 'pair' || inheritPair.key !== 'inherit') return null;
    const mapping = inheritPair.parent;
    if (!mapping || mapping.kind !== 'mapping') return null;
    // The mapping's parent pair is the template declaration when nested.
    const grandParent = mapping.parent;
    if (grandParent && grandParent.kind === 'pair' && isDeclaration(grandParent)) return grandParent;
    return mappingGet(mapping, 'name');
}

export function parents(declaration: YPair, source: SourceFile, environment: string): TemplateDeclaration[] {
    const mapping: YMapping | null =
        isDeclaration(declaration) && declaration.value && declaration.value.kind === 'mapping'
            ? declaration.value
            : declaration.parent && declaration.parent.kind === 'mapping'
              ? declaration.parent
              : null;
    if (!mapping) return [];
    const inherit = mappingGet(mapping, 'inherit');
    if (!inherit?.value || inherit.value.kind !== 'sequence') return [];
    const declarations = templateDeclarations(source.uri, environment);
    const result: TemplateDeclaration[] = [];
    for (const item of inherit.value.items) {
        if (item.kind !== 'mapping') continue;
        const templatePair = mappingGet(item, 'template');
        const templateScalar = templatePair?.value && templatePair.value.kind === 'scalar' ? templatePair.value : null;
        if (!templateScalar || !isInheritance(templateScalar)) continue;
        const parent = declarations.get(scalarPathText(templateScalar));
        if (parent && !result.some(existing => existing.pair === parent.pair)) result.push(parent);
    }
    return result;
}

/** All inheritance scalars in every source document, for usage search. */
export function inheritanceScalars(source: SourceFile): { scalar: YScalar; name: string }[] {
    const result: { scalar: YScalar; name: string }[] = [];
    for (const doc of source.tree.docs) {
        if (!doc.root) continue;
        walkAll(doc.root, node => {
            if (node.kind === 'scalar' && isInheritance(node)) result.push({ scalar: node, name: scalarPathText(node) });
        });
    }
    return result;
}
