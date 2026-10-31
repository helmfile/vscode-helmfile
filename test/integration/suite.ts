/**
 * Integration suite that runs INSIDE a real VSCode instance (driven by
 * test/integration/run.ts through @vscode/test-electron). Verifies language
 * assignment and go-to-definition against examples/helmfile.yaml.gotmpl.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as assert from 'node:assert';

async function main(): Promise<void> {
    const examplesDir = path.resolve(__dirname, '../../examples');
    const file = vscode.Uri.file(path.join(examplesDir, 'helmfile.yaml.gotmpl'));
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();

    const log = (message: string): void => { console.log(`[it] ${message}`); };
    const failures: string[] = [];
    const check = (name: string, ok: boolean, detail: string): void => {
        log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
        if (!ok) failures.push(name);
    };

    // 0. Language assignment: the file must be claimed by our 'helmfile' language.
    check('languageId=helmfile', doc.languageId === 'helmfile', `got '${doc.languageId}'`);

    // 1. Extension activated.
    const ext = vscode.extensions.getExtension('helmfile-dev.vscode-helmfile');
    if (ext && !ext.isActive) {
        try { await ext.activate(); } catch (e) { log('activate() threw: ' + String(e)); }
    }
    check('extension active', !!ext?.isActive, String(ext?.isActive));
    await new Promise(resolve => setTimeout(resolve, 1500));

    const definitionsAt = async (offset: number): Promise<vscode.Location[]> =>
        (await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, doc.positionAt(offset))) as vscode.Location[];

    // 2. Values path navigation: {{ .StateValues.namespace }} → environment values definitions.
    const stateValuesOffset = text.indexOf('.StateValues.namespace');
    if (stateValuesOffset < 0) {
        check('.StateValues.namespace found in fixture', false, 'fixture content mismatch');
    } else {
        const defs = await definitionsAt(stateValuesOffset + '.StateValues.names'.length);
        check('StateValues.namespace definition', defs.length > 0, `offset=${stateValuesOffset} defs=${defs.length}`);
        if (defs.length) log(`  → ${defs.map(d => `${vscode.workspace.asRelativePath(d.uri)}:${d.range.start.line + 1}`).join(', ')}`);
    }

    // 3. Chart alias navigation: chart: fluent-bit/fluent-bit → repositories[].name declaration.
    const chartOffset = text.indexOf('chart: fluent-bit/fluent-bit');
    const chartValueOffset = chartOffset >= 0 ? chartOffset + 'chart: '.length + 'fluent'.length : -1;
    if (chartValueOffset < 0) {
        check('chart: fluent-bit/fluent-bit found in fixture', false, 'fixture content mismatch');
    } else {
        const defs = await definitionsAt(chartValueOffset);
        check('chart alias definition', defs.length > 0, `defs=${defs.length}`);
        if (defs.length) {
            const line = doc.lineAt(defs[0].range.start).text;
            log(`  → ${vscode.workspace.asRelativePath(defs[0].uri)}:${defs[0].range.start.line + 1} ${line.trim()}`);
            check('chart alias target is repository declaration', /name:\s*fluent-bit/.test(line), line.trim());
        }
    }

    // 4. Template inheritance navigation: inherit template `simple`.
    const inheritOffset = text.indexOf('template: simple');
    if (inheritOffset < 0) {
        check('template: simple found in fixture', false, 'fixture content mismatch');
    } else {
        const defs = await definitionsAt(inheritOffset + 'template: '.length + 1);
        check('inherit template definition', defs.length > 0, `defs=${defs.length}`);
        if (defs.length) log(`  → line ${defs[0].range.start.line + 1}`);
    }

    // 5. Hover on a values path resolves a definition markdown.
    const hoverOffset = text.indexOf('.StateValues.versions.utils');
    if (hoverOffset >= 0) {
        const hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, doc.positionAt(hoverOffset + 3))) as vscode.Hover[];
        check('hover on values path', (hovers?.length ?? 0) > 0, `hovers=${hovers?.length ?? 0}`);
    }

    // 6. Syntax diagnostics on a scratch copy with an unclosed {{ action and
    //    a broken YAML indent: tracked documents must report both.
    const fs = await import('node:fs');
    const scratch = path.join(examplesDir, 'helmfile-diag-check.yaml.gotmpl');
    fs.writeFileSync(scratch, text + '\n  - name: zz\n    routerInstances:  .Values | get "mysql.routerInstances" 2 }}\n    chart: {{ if .Values.x }} {{ .Values.y\n');
    try {
        const scratchUri = vscode.Uri.file(scratch);
        const sdoc = await vscode.workspace.openTextDocument(scratchUri);
        await vscode.window.showTextDocument(sdoc);
        await new Promise(resolve => setTimeout(resolve, 1500));
        const scratchDiags = vscode.languages.getDiagnostics(scratchUri);
        check('unclosed {{ warned', scratchDiags.some(d => d.message.includes('Unclosed Go template action')), JSON.stringify(scratchDiags.map(d => d.message.slice(0, 40))));
        check('unclosed block warned', scratchDiags.some(d => d.message.includes('Unclosed Go template block')), JSON.stringify(scratchDiags.map(d => d.message.slice(0, 40))));
        check('orphan }} warned', scratchDiags.some(d => d.message.includes('Unmatched Go template closing')), JSON.stringify(scratchDiags.map(d => d.message.slice(0, 40))));
    } finally {
        fs.unlinkSync(scratch);
    }

    // 6b. Completion replace ranges: accepting `.Values` after typing `.`
    //     must replace the dot (regression: `..Values` doubling).
    const dotScratch = path.join(examplesDir, 'helmfile-dot-completion-check.yaml.gotmpl');
    fs.writeFileSync(dotScratch, 'releases:\n  - name: a\n    chart: b\n    values:\n      - x: {{ .');
    try {
        const dotUri = vscode.Uri.file(dotScratch);
        const ddoc = await vscode.workspace.openTextDocument(dotUri);
        await vscode.window.showTextDocument(ddoc);
        const pos = ddoc.positionAt(ddoc.getText().length);
        const items = (await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', dotUri, pos)) as { items?: vscode.CompletionItem[] };
        const dotItem = (items?.items ?? []).find(i => (typeof i.label === 'string' ? i.label : String((i.label as { label: string }).label)) === '.Values');
        check('dot path completion offered', dotItem != null, `labels=${(items?.items ?? []).slice(0, 6).map(i => i.label).join(',')}`);
        if (dotItem) {
            const range = dotItem.range as vscode.Range | { inserting: vscode.Range; replacing: vscode.Range } | undefined;
            const replacing = range && 'start' in range ? range : range?.replacing;
            const line = ddoc.lineAt(pos.line);
            const startChar = replacing?.start.character ?? -1;
            // The replace range must start at the typed dot (last char of the line).
            check('dot completion replaces the dot', line.text.endsWith('.') && startChar === line.text.length - 1, `startChar=${startChar} line='${line.text}'`);
        }
    } finally {
        fs.unlinkSync(dotScratch);
    }

    // 7. VSCode-native features: symbols, folding, smart select, code actions.
    // (Semantic tokens have no built-in execute command; covered by unit tests.)
    const actionOffset = text.indexOf('{{ if or .Values.x .Values.y }}');
    const probeOffset = actionOffset >= 0 ? actionOffset + 6 : text.indexOf('{{');
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
    check('document symbols produced', (symbols?.length ?? 0) > 0 && symbols.some(s => s.kind === vscode.SymbolKind.Package), JSON.stringify(symbols?.map(s => s.name).slice(0, 5)));
    const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', doc.uri);
    check('folding ranges produced', (folds?.length ?? 0) > 0, `folds=${folds?.length ?? 0}`);
    const selection = await vscode.commands.executeCommand<vscode.SelectionRange[]>('vscode.executeSelectionRangeProvider', doc.uri, [doc.positionAt(probeOffset)]);
    check('selection range chain grows', (selection?.length ?? 0) === 1 && !!selection[0].parent, `chain=${!!selection?.[0]?.parent}`);
    const codeActions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(doc.positionAt(probeOffset), doc.positionAt(probeOffset)));
    check('code actions resolve', Array.isArray(codeActions), `actions=${codeActions?.length ?? 0}`);

    if (failures.length) {
        console.error(`[it] ${failures.length} failure(s): ${failures.join(', ')}`);
        process.exitCode = 1;
    } else {
        log('all integration checks passed');
    }
}

export function run(): Promise<void> {
    return main().catch(error => {
        console.error('[it] suite crashed:', error);
        process.exitCode = 1;
    });
}
