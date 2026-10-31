import * as vscode from 'vscode';
import { projectScope } from './project';

export interface HelmfileSettings {
    readonly helmfileExecutable: string;
    readonly helmExecutable: string;
    readonly protectedEnvironments: string;
    readonly disableDownloads: boolean;
}

export function settings(): HelmfileSettings {
    const configuration = vscode.workspace.getConfiguration('helmfile');
    return {
        helmfileExecutable: configuration.get<string>('helmfileExecutablePath') || 'helmfile',
        helmExecutable: configuration.get<string>('helmExecutablePath') || 'helm',
        protectedEnvironments: configuration.get<string>('protectedEnvironments') ?? 'prod.*',
        disableDownloads: configuration.get<boolean>('disableAutomaticDownloads') ?? false,
    };
}

export function repositoryDownloadsEnabled(): boolean {
    return !settings().disableDownloads;
}

/**
 * Mutating operations (apply/destroy) are opt-in: they change the cluster,
 * so their commands and code lenses stay disabled until the user enables
 * `helmfile.enableMutatingCommands`.
 */
export function mutatingCommandsEnabled(): boolean {
    return vscode.workspace.getConfiguration('helmfile').get<boolean>('enableMutatingCommands') ?? false;
}

/**
 * The active Helmfile environment, saved per helmfile project (the
 * directory holding the entry state) like the IntelliJ plugin's
 * project-level setting; unrelated projects in one workspace keep
 * independent selections.
 */
export class EnvironmentService implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<string>();
    readonly onDidChange = this.emitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    get(uri?: vscode.Uri): string {
        return this.context.workspaceState.get<string>(this.key(uri)) || 'default';
    }

    set(environment: string, uri?: vscode.Uri): void {
        const key = this.key(uri);
        if (environment === this.context.workspaceState.get<string>(key)) return;
        void this.context.workspaceState.update(key, environment);
        this.emitter.fire(environment);
    }

    private key(uri?: vscode.Uri): string {
        const scope = uri ?? vscode.window.activeTextEditor?.document.uri;
        const file = scope?.fsPath;
        return file ? 'helmfile.environment:' + projectScope(file) : 'helmfile.environment';
    }

    dispose(): void {
        this.emitter.dispose();
    }
}
