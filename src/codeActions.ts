/**
 * Quick fixes for helmfile diagnostics:
 * - repository warnings → Refresh Helm chart repositories
 * - empty `{{}}` action  → delete it
 * - unclosed action      → insert `}}` at the end of its first line
 * - orphan `}}`          → delete it
 */
import * as vscode from 'vscode';
import { HELMFILE_DIAGNOSTIC_SOURCE } from './inspection';

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
