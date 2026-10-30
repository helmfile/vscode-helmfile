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
