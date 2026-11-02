/**
 * Chart support verification, run in real VSCode with OUR extension active:
 *  1. Chart template files (templates/*.yaml|tpl, NOTES.txt) are claimed by
 *     the Helmfile language (so YAML validators stop flagging {{ }}).
 *  2. No diagnostics on chart files.
 *  3. Chart-aware completion (.Chart./.Values. from values.yaml) and hover.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

const results: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
}

async function main(): Promise<void> {
    const log = (m: string): void => { console.log(`[it] ${m}`); };
    const root = process.env.CHART_WS!;
    log('workspace: ' + root);
    const ext = vscode.extensions.getExtension('helmfile-dev.vscode-helmfile');
    if (ext && !ext.isActive) { try { await ext.activate(); } catch (e) { log('activate threw: ' + String(e)); } }
    log('extension active: ' + !!ext?.isActive);

    // 1. Language claims.
    const open = async (rel: string): Promise<vscode.TextDocument> => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, rel)));
        await vscode.window.showTextDocument(doc);
        await new Promise(r => setTimeout(r, 800));
        return doc;
    };
    for (const [rel, expected] of [
        ['charts/mychart/templates/deployment.yaml', 'helmfile'],
        ['charts/mychart/templates/_helpers.tpl', 'helmfile'],
        ['charts/mychart/templates/NOTES.txt', 'helmfile'],
        ['charts/mychart/templates/ingress.yaml', 'helmfile'],
        ['charts/mychart/Chart.yaml', 'yaml'],
        ['charts/mychart/values.yaml', 'yaml'],
        ['helmfile.yaml', 'helmfile'],
    ] as const) {
        const doc = await open(rel);
        check(`languageId ${rel}=${expected}`, doc.languageId === expected, doc.languageId);
        const diags = vscode.languages.getDiagnostics(doc.uri).filter(d => d.source === 'helmfile');
        check(`diagnostics clean ${rel}`, diags.length === 0, diags.map(d => `${d.range.start.line + 1} ${d.message.slice(0, 80)}`).join(' ; '));
    }

    // 2. Completion inside a chart template: .Chart. builtins, .Values. keys.
    const template = await open('charts/mychart/templates/deployment.yaml');
    const at = async (insert: string, trigger: (doc: vscode.TextDocument) => vscode.Position): Promise<string[]> => {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(template.uri, new vscode.Position(0, 0), insert);
        await vscode.workspace.applyEdit(edit);
        const pos = trigger(template);
        const items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', template.uri, pos);
        const labels = items.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
        const undo = new vscode.WorkspaceEdit();
        undo.delete(template.uri, new vscode.Range(0, 0, 0, insert.length));
        await vscode.workspace.applyEdit(undo);
        return labels;
    };
    const chartLabels = await at('{{ .Chart.', doc => new vscode.Position(0, 10));
    check('completion .Chart. builtins', chartLabels.includes('Name') && chartLabels.includes('AppVersion'), JSON.stringify(chartLabels.slice(0, 6)));
    const valuesLabels = await at('{{ .Values.', doc => new vscode.Position(0, 11));
    check('completion .Values. chart keys', valuesLabels.includes('image') && valuesLabels.includes('replicaCount'), JSON.stringify(valuesLabels.slice(0, 8)));
    const rootLabels = await at('{{ .', doc => new vscode.Position(0, 4));
    check('completion chart roots', rootLabels.includes('.Chart') && rootLabels.includes('.Release') && !rootLabels.includes('.Environment.Name'), JSON.stringify(rootLabels.filter(l => l.startsWith('.')).slice(0, 10)));
    // Review regressions: next-segment builtin completion, $ root context.
    const capLabels = await at('{{ .Capabilities.', doc => new vscode.Position(0, 17));
    check('completion .Capabilities. offers KubeVersion', capLabels.includes('KubeVersion') && !capLabels.includes('Version'), JSON.stringify(capLabels.slice(0, 8)));
    const dollarLabels = await at('{{ $.Values.image.', doc => new vscode.Position(0, 18));
    check('completion $.Values completes chart keys', dollarLabels.includes('repository') && dollarLabels.includes('tag'), JSON.stringify(dollarLabels.slice(0, 6)));

    // 3. Hover.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(template.uri, new vscode.Position(0, 0), '{{ .Chart.Name }} {{ .Values.image.tag }}\n');
    await vscode.workspace.applyEdit(edit);
    const hovers: string[] = [];
    for (const col of [5, 29]) {
        const hover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', template.uri, new vscode.Position(0, col));
        hovers.push(hover && hover.length ? hover.map(h => h.contents.map(c => (c as { value?: string }).value ?? String(c)).join('')).join('') : '(none)');
    }
    check('hover .Chart.Name', hovers[0].includes('Name of the chart'), hovers[0].slice(0, 120));
    check('hover .Values.image.tag', hovers[1].includes('chart default') || hovers[1].includes('latest'), hovers[1].slice(0, 120));
    const funcEdit = new vscode.WorkspaceEdit();
    funcEdit.insert(template.uri, new vscode.Position(0, 0), '{{ toYaml .Values }}\n');
    await vscode.workspace.applyEdit(funcEdit);
    const funcHover = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', template.uri, new vscode.Position(0, 4));
    const funcText = funcHover && funcHover.length ? funcHover.map(h => h.contents.map(c => (c as { value?: string }).value ?? String(c)).join('')).join('') : '(none)';
    check('hover toYaml documented in chart files', funcText.toLowerCase().includes('yaml'), funcText.slice(0, 120));
    const funcUndo = new vscode.WorkspaceEdit();
    funcUndo.delete(template.uri, new vscode.Range(0, 0, 1, 0));
    await vscode.workspace.applyEdit(funcUndo);
    const undo = new vscode.WorkspaceEdit();
    undo.delete(template.uri, new vscode.Range(0, 0, 1, 0));
    await vscode.workspace.applyEdit(undo);
    await template.save();

    for (const line of results) log(line);
    const failed = results.filter(r => r.startsWith('FAIL'));
    log(failed.length === 0 ? 'ALL CHART CHECKS PASSED' : `${failed.length} CHART CHECKS FAILED`);
    log('DONE');
}

export function run(): Promise<void> {
    return main().catch(error => {
        console.error('[it] suite crashed:', error);
        for (const line of results) console.log('[it] ' + line);
        process.exitCode = 1;
    });
}
