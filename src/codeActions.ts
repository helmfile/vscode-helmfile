/**
 * Quick fixes for helmfile diagnostics:
 * - repository warnings → Refresh Helm chart repositories
 * - empty `{{}}` action  → delete it
 * - unclosed action      → insert `}}` at the end of its first line
 * - orphan `}}`          → delete it
 * - outdated version     → bump to the newest cached index version
 * - unknown field        → remove the whole mapping entry
 * - missing values file  → create it (with parent directories)
 * - missing named template → create its define in _helpers.tpl
 * - schema-unknown value key → declare it in values.schema.json
 *
 * Edit computation lives in codeActionEngine.ts (neutral file operations);
 * this provider only decides which fix matches a diagnostic and converts
 * the operations into vscode.WorkspaceEdit entries.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { HELMFILE_DIAGNOSTIC_SOURCE, missingChartDefines, missingFiles, outdatedVersions, schemaUnknownKeys, unknownFields, unusedChartDefines } from './inspection';
import { offsetRange } from './position';
import { chartFileOf, chartTemplateContextFor } from './chartContext';
import { contentStamp, readSource } from './values';
import {
    defineRemovalSpan,
    defineSkeletonOperations,
    extractOperations,
    schemaAdditionOperations,
    valuesAdditionOperations,
    type EngineOperation,
} from './codeActionEngine';

export class HelmfileCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const ours = context.diagnostics.filter(
            diagnostic => diagnostic.source === HELMFILE_DIAGNOSTIC_SOURCE && diagnostic.range.intersection(range) !== undefined,
        );
        for (const diagnostic of ours) {
            if (diagnostic.message.startsWith('Empty Go template action')) {
                const action = new vscode.CodeAction('Delete empty Go template action', vscode.CodeActionKind.QuickFix);
                action.edit = new vscode.WorkspaceEdit();
                action.edit.delete(document.uri, diagnostic.range);
                action.isPreferred = true;
                actions.push(action);
            } else if (diagnostic.message.startsWith('Unclosed Go template action')) {
                const action = new vscode.CodeAction('Insert }} at the end of the line', vscode.CodeActionKind.QuickFix);
                const edit = new vscode.WorkspaceEdit();
                edit.insert(document.uri, document.lineAt(diagnostic.range.start.line).range.end, '}}');
                action.edit = edit;
                action.isPreferred = true;
                actions.push(action);
            } else if (diagnostic.message.startsWith('Unmatched Go template closing')) {
                const action = new vscode.CodeAction('Delete orphan }}', vscode.CodeActionKind.QuickFix);
                const edit = new vscode.WorkspaceEdit();
                edit.delete(document.uri, diagnostic.range);
                action.edit = edit;
                action.isPreferred = true;
                actions.push(action);
            } else {
                const latest = outdatedVersions.get(diagnostic);
                if (latest !== undefined) {
                    const action = new vscode.CodeAction(`Update version to ${latest}`, vscode.CodeActionKind.QuickFix);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(document.uri, diagnostic.range, latest);
                    action.edit = edit;
                    action.isPreferred = true;
                    actions.push(action);
                }
                const span = unknownFields.get(diagnostic);
                if (span) {
                    const action = new vscode.CodeAction('Remove unknown field', vscode.CodeActionKind.QuickFix);
                    const edit = new vscode.WorkspaceEdit();
                    edit.delete(document.uri, document.lineAt(document.positionAt(span.start).line).range.union(document.lineAt(document.positionAt(span.end).line).range));
                    action.edit = edit;
                    actions.push(action);
                }
                const missing = missingFiles.get(diagnostic);
                if (missing) {
                    const action = new vscode.CodeAction(`Create ${vscode.workspace.asRelativePath(missing, false)}`, vscode.CodeActionKind.QuickFix);
                    action.edit = applyOperations([{ kind: 'createFile', file: missing }], document);
                    action.command = { command: 'vscode.open', title: 'Open created file', arguments: [vscode.Uri.file(missing)] };
                    actions.push(action);
                }
                const define = missingChartDefines.get(diagnostic);
                if (define) {
                    const action = new vscode.CodeAction(`Create define "${define.name}"`, vscode.CodeActionKind.QuickFix);
                    action.edit = applyOperations(defineSkeletonOperations(define.name, define.helpers), document);
                    action.command = { command: 'vscode.open', title: 'Open helpers file', arguments: [vscode.Uri.file(define.helpers)] };
                    action.isPreferred = true;
                    actions.push(action);
                }
                const unknown = schemaUnknownKeys.get(diagnostic);
                if (unknown) {
                    const schemaOps = schemaAdditionOperations(unknown.segments, unknown.schemaFile, unknown.type);
                    if (schemaOps) {
                        const action = new vscode.CodeAction(`Declare "${unknown.segments.join('.')}" in values.schema.json`, vscode.CodeActionKind.QuickFix);
                        action.edit = applyOperations(schemaOps, document);
                        action.command = { command: 'vscode.open', title: 'Open schema', arguments: [vscode.Uri.file(unknown.schemaFile)] };
                        actions.push(action);
                    }
                    const valuesOps = valuesAdditionOperations(unknown.segments, unknown.valuesFile);
                    if (valuesOps) {
                        const action = new vscode.CodeAction(`Add "${unknown.segments.join('.')}" to values.yaml`, vscode.CodeActionKind.QuickFix);
                        action.edit = applyOperations(valuesOps, document);
                        action.command = { command: 'vscode.open', title: 'Open values.yaml', arguments: [vscode.Uri.file(unknown.valuesFile)] };
                        actions.push(action);
                    }
                }
                const unused = unusedChartDefines.get(diagnostic);
                if (unused) {
                    const action = new vscode.CodeAction(`Remove unused define "${unused.name}"`, vscode.CodeActionKind.QuickFix);
                    const removal = defineRemovalSpan(document.getText(), unused.start, unused.end);
                    action.edit = applyOperations([{ kind: 'delete', file: document.uri.fsPath, start: removal.start, end: removal.end }], document);
                    actions.push(action);
                }
            }
        }
        // Extract-to-define on any non-empty selection inside a chart template.
        if (!range.isEmpty && chartTemplateContextFor(chartFileOf(document.uri), contentStamp())) {
            const action = new vscode.CodeAction('Extract to named template', vscode.CodeActionKind.RefactorExtract);
            action.command = { command: 'helmfile.extractDefine', title: 'Extract to named template', arguments: [document.uri, range] };
            actions.push(action);
        }
        if (ours.some(diagnostic => diagnostic.code === 'helmfile.refreshRepositories')) {
            const action = new vscode.CodeAction('Refresh Helm chart repositories', vscode.CodeActionKind.QuickFix);
            action.command = { command: 'helmfile.refreshRepositories', title: 'Refresh Helm chart repositories' };
            actions.push(action);
        }
        return actions;
    }
}

/** Current text behind an operation's file: the document itself, open buffers, then disk. */
function textOf(file: string, document: vscode.TextDocument): string {
    if (file === document.uri.fsPath) return document.getText();
    const source = readSource(vscode.Uri.file(file));
    if (source) return source.text;
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

/** Neutral file operations → vscode.WorkspaceEdit. */
function applyOperations(operations: readonly EngineOperation[] | null, document: vscode.TextDocument): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    if (!operations) return edit;
    for (const operation of operations) {
        const uri = vscode.Uri.file(operation.file);
        if (operation.kind === 'createFile') {
            edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
            continue;
        }
        const text = textOf(operation.file, document);
        if (operation.kind === 'insert') {
            edit.insert(uri, offsetRange(text, operation.offset, operation.offset).end, operation.text);
        } else if (operation.kind === 'replace') {
            edit.replace(uri, offsetRange(text, operation.start, operation.end), operation.text);
        } else {
            edit.delete(uri, offsetRange(text, operation.start, operation.end));
        }
    }
    return edit;
}

/* -------- vscode-shaped wrappers kept for callers and tests -------- */

export function buildSchemaAdditionEdit(segments: readonly string[], schemaFile: string, type: string): vscode.WorkspaceEdit | null {
    const operations = schemaAdditionOperations(segments, schemaFile, type);
    return operations ? applyOperations(operations, { uri: vscode.Uri.file(schemaFile), getText: () => '' } as vscode.TextDocument) : null;
}

export function buildValuesAdditionEdit(segments: readonly string[], valuesFile: string): vscode.WorkspaceEdit | null {
    const operations = valuesAdditionOperations(segments, valuesFile);
    return operations ? applyOperations(operations, { uri: vscode.Uri.file(valuesFile), getText: () => '' } as vscode.TextDocument) : null;
}

export function buildExtractEdit(text: string, selection: { start: number; end: number }, name: string, uri: vscode.Uri): vscode.WorkspaceEdit | null {
    const operations = extractOperations(text, uri.fsPath, selection, name);
    return operations ? applyOperations(operations, { uri, getText: () => text } as vscode.TextDocument) : null;
}
