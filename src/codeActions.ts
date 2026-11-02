/**
 * Quick fixes for helmfile diagnostics:
 * - repository warnings → Refresh Helm chart repositories
 * - empty `{{}}` action  → delete it
 * - unclosed action      → insert `}}` at the end of its first line
 * - orphan `}}`          → delete it
 * - outdated version     → bump to the newest cached index version
 * - unknown field        → remove the whole mapping entry
 * - missing values file  → create it (with parent directories)
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { HELMFILE_DIAGNOSTIC_SOURCE, missingChartDefines, missingFiles, outdatedVersions, unknownFields } from './inspection';

export class HelmfileCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const ours = context.diagnostics.filter(
            diagnostic => diagnostic.source === HELMFILE_DIAGNOSTIC_SOURCE && diagnostic.range.intersection(range) !== undefined,
        );
        for (const diagnostic of ours) {
            const edit = new vscode.WorkspaceEdit();
            if (diagnostic.message.startsWith('Empty Go template action')) {
                const action = new vscode.CodeAction('Delete empty Go template action', vscode.CodeActionKind.QuickFix);
                edit.delete(document.uri, diagnostic.range);
                action.edit = edit;
                action.isPreferred = true;
                actions.push(action);
            } else if (diagnostic.message.startsWith('Unclosed Go template action')) {
                const action = new vscode.CodeAction('Insert }} at the end of the line', vscode.CodeActionKind.QuickFix);
                const lineEnd = document.lineAt(diagnostic.range.start.line).range.end;
                edit.insert(document.uri, lineEnd, '}}');
                action.edit = edit;
                action.isPreferred = true;
                actions.push(action);
            } else if (diagnostic.message.startsWith('Unmatched Go template closing')) {
                const action = new vscode.CodeAction('Delete orphan }}', vscode.CodeActionKind.QuickFix);
                edit.delete(document.uri, diagnostic.range);
                action.edit = edit;
                action.isPreferred = true;
                actions.push(action);
            } else {
                const latest = outdatedVersions.get(diagnostic);
                if (latest !== undefined) {
                    const action = new vscode.CodeAction(`Update version to ${latest}`, vscode.CodeActionKind.QuickFix);
                    edit.replace(document.uri, diagnostic.range, latest);
                    action.edit = edit;
                    action.isPreferred = true;
                    actions.push(action);
                }
                const span = unknownFields.get(diagnostic);
                if (span) {
                    const action = new vscode.CodeAction('Remove unknown field', vscode.CodeActionKind.QuickFix);
                    edit.delete(document.uri, document.lineAt(document.positionAt(span.start).line).range.union(document.lineAt(document.positionAt(span.end).line).range));
                    action.edit = edit;
                    actions.push(action);
                }
                const missing = missingFiles.get(diagnostic);
                if (missing) {
                    const action = new vscode.CodeAction(`Create ${vscode.workspace.asRelativePath(missing, false)}`, vscode.CodeActionKind.QuickFix);
                    action.edit = createFileEdit(vscode.Uri.file(missing));
                    action.command = { command: 'vscode.open', title: 'Open created file', arguments: [vscode.Uri.file(missing)] };
                    actions.push(action);
                }
                const define = missingChartDefines.get(diagnostic);
                if (define) {
                    const action = new vscode.CodeAction(`Create define "${define.name}"`, vscode.CodeActionKind.QuickFix);
                    action.edit = createDefineEdit(define.name, define.helpers);
                    action.command = { command: 'vscode.open', title: 'Open helpers file', arguments: [vscode.Uri.file(define.helpers)] };
                    action.isPreferred = true;
                    actions.push(action);
                }
            }
        }
        if (ours.some(diagnostic => diagnostic.code === 'helmfile.refreshRepositories')) {
            const action = new vscode.CodeAction('Refresh Helm chart repositories', vscode.CodeActionKind.QuickFix);
            action.command = { command: 'helmfile.refreshRepositories', title: 'Refresh Helm chart repositories' };
            actions.push(action);
        }
        return actions;
    }
}

function createFileEdit(uri: vscode.Uri): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
    return edit;
}

/** Edit creating a `define` skeleton, appended to `_helpers.tpl` (created when missing). */
function createDefineEdit(name: string, helpers: string): vscode.WorkspaceEdit {
    const skeleton = `{{- define "${name}" -}}\n\n{{- end -}}\n`;
    const edit = new vscode.WorkspaceEdit();
    const uri = vscode.Uri.file(helpers);
    if (fs.existsSync(helpers)) {
        const body = fs.readFileSync(helpers, 'utf8');
        const lines = body.split('\n');
        const last = Math.max(0, lines.length - 1);
        const position = new vscode.Position(last, lines[last]?.length ?? 0);
        const separator = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
        edit.insert(uri, position, `${separator}${skeleton}`);
    } else {
        edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), `{{- define "${name}" -}}\n\n{{- end -}}\n`);
    }
    return edit;
}
