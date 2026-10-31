/**
 * Document symbols (outline / breadcrumbs): releases, repositories,
 * environments and templates of a helmfile state, the VSCode counterpart
 * of the IntelliJ structure view.
 */
import * as vscode from 'vscode';
import { mappingGet, parseTree, rootMappings, scalarPathText, type YMapping, type YPair } from './yamlTree';

export interface HelmfileSymbol {
    readonly name: string;
    readonly kind: 'release' | 'repository' | 'environment' | 'template' | 'file';
    readonly detail: string;
    readonly start: number;
    readonly end: number;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    readonly children: readonly HelmfileSymbol[];
}

const KIND_MAP: Record<HelmfileSymbol['kind'], vscode.SymbolKind> = {
    release: vscode.SymbolKind.Package,
    repository: vscode.SymbolKind.Module,
    environment: vscode.SymbolKind.Enum,
    template: vscode.SymbolKind.Class,
    file: vscode.SymbolKind.File,
};

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

export class HelmfileDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const position = (offset: number): vscode.Position => document.positionAt(offset);
        const convert = (symbol: HelmfileSymbol): vscode.DocumentSymbol => new vscode.DocumentSymbol(
            symbol.name,
            symbol.detail,
            KIND_MAP[symbol.kind],
            new vscode.Range(position(symbol.start), position(symbol.end)),
            new vscode.Range(position(symbol.selectionStart), position(symbol.selectionEnd)),
        );
        const attach = (symbol: HelmfileSymbol): vscode.DocumentSymbol => {
            const result = convert(symbol);
            for (const child of symbol.children) result.children.push(attach(child));
            return result;
        };
        return helmfileSymbols(document.getText()).map(attach);
    }
}
