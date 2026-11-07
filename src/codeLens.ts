/**
 * Code lens provider: converts the neutral lens computations into VSCode
 * lenses (the IntelliJ line markers equivalent).
 */
import * as vscode from 'vscode';
import { chartFileOf, chartTemplateContextFor } from './chartContext';
import {
    chartRenderLens,
    computeStateLenses,
    HELMFILE_FIND_TEMPLATE_USAGES,
    HELMFILE_GOTO_TEMPLATE_PARENT,
    HELMFILE_RENDER_CHART_TEMPLATE,
    HELMFILE_SELECT_ENVIRONMENT,
    type LensComputation,
} from './lensEngine';

export { HELMFILE_FIND_TEMPLATE_USAGES, HELMFILE_GOTO_TEMPLATE_PARENT, HELMFILE_RENDER_CHART_TEMPLATE, HELMFILE_SELECT_ENVIRONMENT };
import { mutatingCommandsEnabled, type EnvironmentService } from './settings';
import { contentStamp, type SourceFile } from './values';
import { parseTree } from './yamlTree';

export class HelmfileCodeLensProvider implements vscode.CodeLensProvider {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.emitter.event;

    constructor(private readonly env: EnvironmentService) {}

    fire(): void {
        this.emitter.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const chartTemplate = chartTemplateContextFor(chartFileOf(document.uri), contentStamp());
        const toLens = (lens: LensComputation): vscode.CodeLens => {
            const range = new vscode.Range(document.positionAt(lens.start), document.positionAt(lens.end));
            const command: vscode.Command = {
                title: lens.title,
                command: lens.command,
                arguments: [document.uri, ...lens.args],
                tooltip: lens.tooltip,
            };
            return new vscode.CodeLens(range, command);
        };
        if (chartTemplate) {
            // Chart template files: a single render action instead of state lenses.
            return [toLens(chartRenderLens(chartTemplate.name))];
        }
        const text = document.getText();
        const source: SourceFile = { uri: document.uri, text, tree: parseTree(text) };
        return computeStateLenses(source, this.env.get(), mutatingCommandsEnabled()).map(toLens);
    }
}
