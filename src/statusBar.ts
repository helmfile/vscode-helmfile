/**
 * Status bar indicator for the selected Helmfile environment; click to
 * switch — the VSCode counterpart of the IntelliJ environment gutter.
 */
import * as vscode from 'vscode';
import type { EnvironmentService } from './settings';

export class HelmfileStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly listener: vscode.Disposable;

    constructor(private readonly env: EnvironmentService) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 200);
        this.item.name = 'Helmfile environment';
        this.item.command = 'helmfile.selectEnvironmentQuick';
        this.listener = env.onDidChange(() => this.update());
        this.update();
    }

    update(): void {
        this.item.text = `$(layers) helmfile: ${this.env.get()}`;
        this.item.tooltip = 'Current Helmfile environment — click to switch';
        this.item.show();
    }

    dispose(): void {
        this.listener.dispose();
        this.item.dispose();
    }
}
