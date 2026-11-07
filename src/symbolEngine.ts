/**
 * Editor-neutral document symbols (outline / breadcrumbs): releases,
 * repositories, environments and templates of a helmfile state, plus the
 * YAML outline for chart template files. Positions are text offsets.
 */
import { mappingGet, parseTree, rootMappings, scalarPathText, type YMapping, type YPair } from './yamlTree';
import { TemplateScanner } from './templateScanner';

export interface HelmfileSymbol {
    readonly name: string;
    readonly kind: 'release' | 'repository' | 'environment' | 'template' | 'file' | 'yamlKey';
    readonly detail: string;
    readonly start: number;
    readonly end: number;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    readonly children: readonly HelmfileSymbol[];
}

export function helmfileSymbols(text: string): HelmfileSymbol[] {
    const symbols: HelmfileSymbol[] = [];
    for (const root of rootMappings(parseTree(text))) {
        for (const pair of root.pairs) {
            const value = pair.value;
            if (!value) continue;
            if (pair.key === 'releases' && value.kind === 'sequence') {
                for (const item of value.items) {
                    if (item.kind !== 'mapping') continue;
                    const symbol = itemSymbol(item, 'release');
                    if (symbol) symbols.push(symbol);
                }
            } else if (pair.key === 'repositories' && value.kind === 'sequence') {
                for (const item of value.items) {
                    if (item.kind !== 'mapping') continue;
                    const symbol = itemSymbol(item, 'repository');
                    if (symbol) symbols.push(symbol);
                }
            } else if (pair.key === 'templates' && value.kind === 'mapping') {
                for (const child of value.pairs) {
                    symbols.push({
                        name: child.key,
                        kind: 'template',
                        detail: 'template',
                        start: child.start,
                        end: child.end,
                        selectionStart: child.keyStart,
                        selectionEnd: child.keyEnd,
                        children: [],
                    });
                }
            } else if (pair.key === 'environments' && value.kind === 'mapping') {
                for (const child of value.pairs) {
                    const children: HelmfileSymbol[] = [];
                    const values = child.value && child.value.kind === 'mapping'
                        ? mappingGet(child.value, 'values')
                        : null;
                    if (values && values.value && values.value.kind === 'sequence') {
                        for (const entry of values.value.items) {
                            if (entry.kind !== 'scalar') continue;
                            const name = scalarPathText(entry);
                            if (!name) continue;
                            children.push({
                                name,
                                kind: 'file',
                                detail: 'values file',
                                start: entry.start,
                                end: entry.end,
                                selectionStart: entry.start,
                                selectionEnd: entry.end,
                                children: [],
                            });
                        }
                    }
                    symbols.push({
                        name: child.key,
                        kind: 'environment',
                        detail: 'environment',
                        start: child.start,
                        end: child.end,
                        selectionStart: child.keyStart,
                        selectionEnd: child.keyEnd,
                        children,
                    });
                }
            }
        }
    }
    return symbols;
}

function itemSymbol(mapping: YMapping, kind: HelmfileSymbol['kind']): HelmfileSymbol | null {
    const namePair = mappingGet(mapping, 'name');
    const chartPair = kind === 'release' ? mappingGet(mapping, 'chart') : null;
    const name = namePair && namePair.value && namePair.value.kind === 'scalar'
        ? scalarPathText(namePair.value) || namePair.key
        : null;
    if (!name) return null;
    const detail = kind === 'release' && chartPair && chartPair.value && chartPair.value.kind === 'scalar'
        ? scalarPathText(chartPair.value) || ''
        : '';
    const selection = namePair ?? firstPair(mapping);
    return {
        name,
        kind,
        detail,
        start: mapping.start,
        end: mapping.end,
        selectionStart: selection.keyStart,
        selectionEnd: selection.valueEnd,
        children: [],
    };
}

function firstPair(mapping: YMapping): YPair {
    return mapping.pairs[0];
}

/** Upper bound on outline nodes for one chart template file. */
const OUTLINE_BUDGET = 500;

/**
 * YAML structure outline for chart template files: template actions are
 * masked so `{{ .Values.x }}` placeholders do not break key names.
 */
export function chartYamlSymbols(text: string): HelmfileSymbol[] {
    const masked = TemplateScanner.mask(text);
    const tree = parseTree(masked);
    let budget = OUTLINE_BUDGET;
    const visit = (mapping: YMapping): HelmfileSymbol[] => {
        const symbols: HelmfileSymbol[] = [];
        for (const pair of mapping.pairs) {
            if (budget-- <= 0) break;
            const value = pair.value;
            let children: HelmfileSymbol[] = [];
            if (value?.kind === 'mapping') {
                children = visit(value);
            } else if (value?.kind === 'sequence') {
                for (const item of value.items) {
                    if (budget <= 0 || item.kind !== 'mapping') continue;
                    children = children.concat(visit(item));
                }
            }
            symbols.push({
                name: pair.key,
                kind: 'yamlKey',
                detail: '',
                start: pair.start,
                end: pair.end,
                selectionStart: pair.keyStart,
                selectionEnd: pair.keyEnd,
                children,
            });
        }
        return symbols;
    };
    return rootMappings(tree).flatMap(visit);
}
