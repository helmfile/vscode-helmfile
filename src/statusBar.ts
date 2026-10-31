/**
 * Status bar indicator for the selected Helmfile environment; click to
 * switch — the VSCode counterpart of the IntelliJ environment gutter.
 * The selection is per helmfile project, so the indicator follows the
 * active editor and its tooltip names the project entry.
 */
import * as vscode from 'vscode';
import { projectFor } from './project';
import type { EnvironmentService } from './settings';

export class HelmfileStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly listeners: vscode.Disposable[];

    constructor(private readonly env: EnvironmentService) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
        this.item.name = 'Helmfile environment';
        this.item.command = 'helmfile.selectEnvironmentQuick';
        this.listeners = [
            env.onDidChange(() => this.update()),
            vscode.window.onDidChangeActiveTextEditor(() => this.update()),
        ];
        this.update();
    }

    update(): void {
        const uri = vscode.window.activeTextEditor?.document.uri;
        const project = uri ? projectFor(uri.fsPath) : null;
        this.item.text = `$(layers) helmfile: ${this.env.get(uri)}`;
        const entry = project?.entries.map(entry => vscode.workspace.asRelativePath(entry, false)).join(' › ');
        this.item.tooltip = project
            ? new vscode.MarkdownString(`Helmfile environment: **${this.env.get(uri)}**\n\nEntry: \`${entry}\`\n\nClick to switch.`)
            : 'Current Helmfile environment — click to switch';
        this.item.show();
    }

    dispose(): void {
        this.listeners.forEach(listener => listener.dispose());
        this.item.dispose();
    }
}
