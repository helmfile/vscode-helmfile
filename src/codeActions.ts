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
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { HELMFILE_DIAGNOSTIC_SOURCE, missingChartDefines, missingFiles, outdatedVersions, schemaUnknownKeys, unknownFields, unusedChartDefines } from './inspection';;
import { offsetRange } from './position';
import { mappingGet, parseTree, rootMappings, type YMapping, type YPair } from './yamlTree';
import { chartFileOf, chartTemplateContextFor } from './chartContext';
import { contentStamp } from './values';

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
                const unknown = schemaUnknownKeys.get(diagnostic);
                if (unknown) {
                    const edit = buildSchemaAdditionEdit(unknown.segments, unknown.schemaFile, unknown.type);
                    if (edit) {
                        const action = new vscode.CodeAction(`Declare "${unknown.segments.join('.')}" in values.schema.json`, vscode.CodeActionKind.QuickFix);
                        action.edit = edit;
                        action.command = { command: 'vscode.open', title: 'Open schema', arguments: [vscode.Uri.file(unknown.schemaFile)] };
                        actions.push(action);
                    }
                    const valuesEdit = buildValuesAdditionEdit(unknown.segments, unknown.valuesFile);
                    if (valuesEdit) {
                        const action = new vscode.CodeAction(`Add "${unknown.segments.join('.')}" to values.yaml`, vscode.CodeActionKind.QuickFix);
                        action.edit = valuesEdit;
                        action.command = { command: 'vscode.open', title: 'Open values.yaml', arguments: [vscode.Uri.file(unknown.valuesFile)] };
                        actions.push(action);
                    }
                }
                const unused = unusedChartDefines.get(diagnostic);
                if (unused) {
                    const action = new vscode.CodeAction(`Remove unused define "${unused.name}"`, vscode.CodeActionKind.QuickFix);
                    action.edit = removeDefineEdit(document, unused.start, unused.end);
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

function createFileEdit(uri: vscode.Uri): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
    return edit;
}

/**
 * Edit declaring a dotted key inside values.schema.json: creates the
 * `properties` chain for the path (existing nodes are kept) and rewrites
 * the file with two-space indentation. Returns null when the file is not
 * valid JSON or an intermediate node is not an object schema.
 */
export function buildSchemaAdditionEdit(segments: readonly string[], schemaFile: string, type: string): vscode.WorkspaceEdit | null {
    let schema: unknown;
    try {
        schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
    } catch {
        return null;
    }
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return null;
    let node = schema as Record<string, unknown>;
    for (let i = 0; i < segments.length - 1; i++) {
        const properties = typeof node.properties === 'object' && node.properties !== null ? node.properties as Record<string, unknown> : (node.properties = {});
        const next = properties[segments[i]];
        if (next === undefined) {
            node = properties[segments[i]] = { type: 'object', properties: {} } as Record<string, unknown>;
        } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
            node = next as Record<string, unknown>;
        } else {
            return null; // intermediate segment exists as a scalar
        }
    }
    const properties = typeof node.properties === 'object' && node.properties !== null ? node.properties as Record<string, unknown> : (node.properties = {});
    const last = segments[segments.length - 1];
    if (properties[last] === undefined) properties[last] = { type };
    const content = JSON.stringify(schema, null, 2) + '\n';
    const lines = content.split('\n');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(vscode.Uri.file(schemaFile), new vscode.Range(0, 0, lines.length - 1, lines[lines.length - 1].length), content);
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

/** Delete the whole `{{ define }}…{{ end }}` block, its indentation and trailing newline. */
function removeDefineEdit(document: vscode.TextDocument, start: number, end: number): vscode.WorkspaceEdit {
    const text = document.getText();
    let blockStart = start;
    while (blockStart > 0 && (text[blockStart - 1] === ' ' || text[blockStart - 1] === '\t')) blockStart--;
    let blockEnd = end;
    if (text.slice(blockEnd).startsWith('\n')) blockEnd++;
    const edit = new vscode.WorkspaceEdit();
    edit.delete(document.uri, offsetRange(text, blockStart, blockEnd));
    return edit;
}

/**
 * Insert a missing `.Values` key chain into the chart's values.yaml.
 * Walks the existing nested mappings as deep as they match, then appends
 * the missing tail (leaf as `null` placeholder) at the right indentation.
 */
export function buildValuesAdditionEdit(segments: readonly string[], valuesFile: string): vscode.WorkspaceEdit | null {
    let text = '';
    try {
        text = fs.readFileSync(valuesFile, 'utf8');
    } catch {
        return null;
    }
    const columnOf = (offset: number): number => offset - (text.slice(0, offset).lastIndexOf('\n') + 1);
    const roots = rootMappings(parseTree(text));
    let parent: YMapping | null = roots[0] ?? null;
    let parentColumn = -2; // root children sit at column 0
    let index = 0;
    while (parent && index < segments.length) {
        const pair: YPair | null = mappingGet(parent, segments[index]);
        if (!pair) break; // missing from here on
        if (index === segments.length - 1) return null; // the full chain already exists
        if (pair.value?.kind !== 'mapping') return null; // intermediate holds a scalar — bail out
        parent = pair.value;
        parentColumn = columnOf(pair.keyStart);
        index++;
    }
    const chain: string[] = [];
    for (let i = index; i < segments.length; i++) {
        const indent = ' '.repeat(parentColumn + 2 + 2 * (i - index));
        chain.push(`${indent}${segments[i]}:${i === segments.length - 1 ? ' null' : ''}`);
    }
    if (chain.length === 0) return null;
    const edit = new vscode.WorkspaceEdit();
    if (!parent) {
        // Empty (or non-mapping) values.yaml: start the file.
        edit.insert(vscode.Uri.file(valuesFile), new vscode.Position(0, 0), `${chain.join('\n')}\n`);
        return edit;
    }
    const anchor = parent.pairs.length > 0 ? parent.pairs[parent.pairs.length - 1].end : parent.end;
    edit.insert(vscode.Uri.file(valuesFile), offsetRange(text, anchor, anchor).end, `\n${chain.join('\n')}`);
    return edit;
}

/**
 * Replace `selection` with `{{ include "name" . }}` and append the selected
 * text as a `{{ define }}` block at the end of the file.
 */
export function buildExtractEdit(text: string, selection: { start: number; end: number }, name: string, uri: vscode.Uri): vscode.WorkspaceEdit | null {
    const selected = text.slice(selection.start, selection.end);
    if (selected.trim().length === 0) return null;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, offsetRange(text, selection.start, selection.end), `{{ include "${name}" . }}`);
    const tail = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    edit.insert(uri, offsetRange(text, text.length, text.length).end, `${tail}{{- define "${name}" -}}\n${selected}\n{{- end -}}\n`);
    return edit;
}
