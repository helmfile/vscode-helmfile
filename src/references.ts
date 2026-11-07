/**
 * Navigation providers: thin vscode adapters over the neutral engine in
 * referenceEngine.ts (which computes file+offset spans and text edits).
 */
import * as vscode from 'vscode';
import { chartFileOf, chartTemplateContextFor, chartTemplateDetected } from './chartContext';
import { offsetRange } from './position';
import {
    allDefinitions,
    contentStamp,
    isHelmfileName,
    readSource,
    resolveValueFiles,
    type SourceFile,
} from './values';
import { EnvironmentService } from './settings';
import { alias, repositoryModel } from './repositories';
import { parents, templateDeclarations } from './templates';
import { parseTree } from './yamlTree';
import {
    chartTemplateDefinitionAt,
    chartTemplateReferenceSpans,
    chartTemplateRenameEdits,
    chartTemplateRenameSpan,
    stateDefinitionAt,
    stateReferenceSpans,
    type EngineLocation,
    type ReferenceDeps,
} from './referenceEngine';

/** File-system and state access for the engine, vscode.Uri flavored. */
const deps: ReferenceDeps = {
    read: file => readSource(vscode.Uri.file(file))?.text,
    allDefinitions: (file, environment) =>
        allDefinitions(vscode.Uri.file(file), environment).map(definition => ({
            path: definition.path,
            originFile: definition.originUri.fsPath,
            keyStart: definition.keyStart,
            keyEnd: definition.keyEnd,
        })),
    resolveValueFiles: (file, text, literal, environment) =>
        resolveValueFiles({ uri: vscode.Uri.file(file), text, tree: parseTree(text) } as SourceFile, literal, environment).map(uri => uri.fsPath),
    templateDeclarations: (file, environment) => {
        const result = new Map<string, { file: string; text: string; keyStart: number; keyEnd: number }>();
        for (const [name, declaration] of templateDeclarations(vscode.Uri.file(file), environment)) {
            result.set(name, {
                file: declaration.source.uri.fsPath,
                text: declaration.source.text,
                keyStart: declaration.pair.keyStart,
                keyEnd: declaration.pair.keyEnd,
            });
        }
        return result;
    },
    parents: (file, text, pair, environment) =>
        parents(pair, { uri: vscode.Uri.file(file), text, tree: parseTree(text) } as SourceFile, environment).map(parent => ({
            file: parent.source.uri.fsPath,
            text: parent.source.text,
            keyStart: parent.pair.keyStart,
            keyEnd: parent.pair.keyEnd,
        })),
    repositoryEntries: (file, environment) =>
        repositoryModel(vscode.Uri.file(file), environment).entries.map(entry => ({
            name: entry.name,
            declarationFile: entry.declarationUri.fsPath,
            targetStart: entry.targetStart,
            targetEnd: entry.targetEnd,
        })),
    alias: (file, chartText) => alias(vscode.Uri.file(file), chartText),
    stateFiles: async () => (await stateFiles()).map(uri => uri.fsPath),
};

let stateFilesCache: { stamp: number; files: vscode.Uri[] } | null = null;

/** Helmfile state files in the workspace plus the active document, cached per content stamp. */
async function stateFiles(): Promise<vscode.Uri[]> {
    const stamp = contentStamp();
    if (stateFilesCache && stateFilesCache.stamp === stamp) return stateFilesCache.files;
    const files = await vscode.workspace.findFiles('**/*.{yaml,yml,gotmpl,tpl}', '**/node_modules/**');
    const result = files.filter(file => isHelmfileName(file.path.split('/').pop() ?? ''));
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && isHelmfileName(active.path.split('/').pop() ?? '') && !result.some(file => file.toString() === active.toString())) {
        result.push(active);
    }
    stateFilesCache = { stamp, files: result };
    return result;
}

/** Engine span → vscode location (open buffers preferred for the text). */
function toLocation(location: EngineLocation): vscode.Location {
    const text = readSource(vscode.Uri.file(location.file))?.text ?? '';
    return new vscode.Location(vscode.Uri.file(location.file), offsetRange(text, location.start, location.end));
}

export class HelmfileDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly env: EnvironmentService) {}

    provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const file = document.uri.fsPath;

        // Chart template files: `include "name"` jumps to its `define`.
        // Values live in the chart's values.yaml, not the Helmfile state
        // (which may sit above the chart).
        const chartTemplate = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
        if (chartTemplate) {
            const span = chartTemplateDefinitionAt(file, text, offset, chartTemplate, this.env.get());
            return span ? toLocation(span) : null;
        }
        if (chartTemplateDetected(chartFileOf(document.uri), contentStamp())) return null;

        const spans = stateDefinitionAt(file, text, offset, this.env.get(), deps);
        return spans ? spans.map(toLocation) : [];
    }
}

export class HelmfileReferencesProvider implements vscode.ReferenceProvider {
    constructor(private readonly env: EnvironmentService) {}

    async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): Promise<vscode.Location[]> {
        const offset = document.offsetAt(position);
        const text = document.getText();
        const file = document.uri.fsPath;

        // Chart template files: references for named templates — on an
        // `include`/`template` name or on the `define` declaration itself.
        const chartTemplate = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
        if (chartTemplate) return chartTemplateReferences(file, text, offset, chartTemplate);
        if (chartTemplateDetected(chartFileOf(document.uri), contentStamp())) return [];

        const spans = await stateReferenceSpans(file, text, offset, this.env.get(), context.includeDeclaration, deps);
        return spans.map(toLocation);
    }
}

/**
 * Named-template references inside a chart: on an `include`/`template`
 * name or on the `define` declaration itself, every declaration and call
 * site of that template across the chart's template files.
 */
export function chartTemplateReferences(currentFile: string, text: string, offset: number, context: Parameters<typeof chartTemplateReferenceSpans>[3]): vscode.Location[] {
    return chartTemplateReferenceSpans(currentFile, text, offset, context, deps).map(toLocation);
}

/** Rename a named template: the `{{ define }}` declaration plus every include/template call. */
export class HelmfileRenameProvider implements vscode.RenameProvider {
    prepareRename(document: vscode.TextDocument, position: vscode.Position): vscode.Range | null {
        const file = document.uri.fsPath;
        const context = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
        if (!context) return null;
        const text = document.getText();
        const offset = document.offsetAt(position);
        const span = chartTemplateRenameSpan(file, text, offset, context);
        return span ? offsetRange(text, span.start, span.end) : null;
    }

    provideRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string): vscode.WorkspaceEdit | null {
        const file = document.uri.fsPath;
        const context = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
        if (!context) return null;
        const text = document.getText();
        const offset = document.offsetAt(position);
        const edits = chartTemplateRenameEdits(file, text, offset, newName, context, deps);
        if (!edits) return null;
        const edit = new vscode.WorkspaceEdit();
        for (const change of edits) {
            const body = readSource(vscode.Uri.file(change.file))?.text ?? '';
            edit.replace(vscode.Uri.file(change.file), offsetRange(body, change.start, change.end), change.newText);
        }
        return edit;
    }
}
