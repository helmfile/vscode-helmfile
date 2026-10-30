import * as vscode from 'vscode';

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
 * The active Helmfile environment, saved per workspace like the IntelliJ
 * plugin's project-level setting.
 */
export class EnvironmentService implements vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<string>();
    readonly onDidChange = this.emitter.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    get(): string {
        return this.context.workspaceState.get<string>('helmfile.environment') || 'default';
    }

    set(environment: string): void {
        if (environment === this.get()) return;
        void this.context.workspaceState.update('helmfile.environment', environment);
        this.emitter.fire(environment);
    }

    dispose(): void {
        this.emitter.dispose();
    }
}
