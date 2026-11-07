/**
 * Document symbol provider: converts neutral symbols into the VSCode
 * outline tree.
 */
import * as vscode from 'vscode';
import { chartFileOf, chartTemplateDetected } from './chartContext';
import { scanDefines } from './chartDefines';
import { contentStamp, isHelmfileName } from './values';
import { chartYamlSymbols, helmfileSymbols, type HelmfileSymbol } from './symbolEngine';

const KIND_MAP: Record<HelmfileSymbol['kind'], vscode.SymbolKind> = {
    release: vscode.SymbolKind.Package,
    repository: vscode.SymbolKind.Module,
    environment: vscode.SymbolKind.Enum,
    template: vscode.SymbolKind.Class,
    file: vscode.SymbolKind.File,
    yamlKey: vscode.SymbolKind.Field,
};

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
        const text = document.getText();
        const isChartTemplate = chartTemplateDetected(chartFileOf(document.uri), contentStamp());
        const symbols: vscode.DocumentSymbol[] = isChartTemplate
            ? [] // chart templates have no state symbols; show the YAML outline below
            : helmfileSymbols(text).map(attach);
        const defines = isChartTemplate || isHelmfileName(document.uri.fsPath)
            ? scanDefines(text, document.uri.fsPath)
            : [];
        if (isChartTemplate) {
            for (const symbol of chartYamlSymbols(text)) symbols.push(attach(symbol));
        }
        for (const define of defines) {
            symbols.push(attach({
                name: define.name,
                kind: 'template',
                detail: 'define',
                start: define.start,
                end: define.end,
                selectionStart: define.start,
                selectionEnd: define.end,
                children: [],
            }));
        }
        return symbols;
    }
}
