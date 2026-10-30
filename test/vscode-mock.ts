/**
 * Minimal `vscode` API mock so the extension modules can run under plain
 * Node for functional tests (no extension host required). Only the surface
 * actually imported by the modules under test is provided.
 */
class Position {
    constructor(readonly line: number, readonly character: number) {}
}
class Range {
    constructor(readonly start: Position, readonly end: Position) {}
}
class Diagnostic {
    constructor(readonly range: unknown, readonly message: string, readonly severity?: number) {}
}
class Location {
    constructor(readonly uri: Uri, readonly range: any) {}
}
class MarkdownString {
    value = '';
    isTrusted = false;
    appendText(text: string): this { this.value += text; return this; }
    appendMarkdown(text: string): this { this.value += text; return this; }
    appendCodeblock(code: string, language = ''): this { this.value += '\n```' + language + '\n' + code + '\n```\n'; return this; }
}
class Uri {
    scheme = 'file';
    path: string;
    fsPath: string;
    private constructor(path: string) {
        this.path = path;
        this.fsPath = path;
    }
    static file(path: string): Uri { return new Uri(path); }
    static parse(value: string): Uri { return new Uri(value.replace(/^file:\/\//, '')); }
    toString(): string { return 'file://' + this.path; }
}
class EventEmitter<T> {
    listeners = new Set<(e: T) => void>();
    event = (listener: (e: T) => void): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(e: T): void { this.listeners.forEach(l => l(e)); }
    dispose(): void { this.listeners.clear(); }
}
class Disposable {
    constructor(readonly cb: () => void = () => {}) {}
    dispose(): void { this.cb(); }
}
const outputChannel = () => ({
    append: () => {}, appendLine: () => {}, replace: () => {},
    clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
});

export = {
    Uri,
    Position,
    Range,
    Diagnostic,
    Location,
    MarkdownString,
    EventEmitter,
    Disposable,
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    env: {},
    window: {
        activeTextEditor: undefined,
        createOutputChannel: outputChannel,
        showQuickPick: async () => undefined,
        showTextDocument: async () => ({}),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        withProgress: async <T>(_options: unknown, task: () => T) => task(),
    },
    workspace: {
        textDocuments: [] as unknown[],
        workspaceFolders: [] as unknown[],
        findFiles: async () => [] as Uri[],
        getConfiguration: (section?: string) => ({
            get: (key: string): unknown =>
                section === 'helmfile'
                    ? ({ helmfileExecutablePath: 'helmfile', helmExecutablePath: 'helm', protectedEnvironments: 'prod.*', disableAutomaticDownloads: false } as Record<string, unknown>)[key]
                    : undefined,
            update: async () => {},
        }),
        fs: {},
        getWorkspaceFolder: () => undefined,
        registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
        onDidChangeTextDocument: () => ({ dispose: () => {} }),
        onDidSaveTextDocument: () => ({ dispose: () => {} }),
        onDidCloseTextDocument: () => ({ dispose: () => {} }),
    },
    commands: {
        executeCommand: async () => undefined,
        registerCommand: () => ({ dispose: () => {} }),
    },
    languages: {
        registerCompletionItemProvider: () => ({ dispose: () => {} }),
        registerDefinitionProvider: () => ({ dispose: () => {} }),
        registerReferenceProvider: () => ({ dispose: () => {} }),
        registerHoverProvider: () => ({ dispose: () => {} }),
        registerCodeActionsProvider: () => ({ dispose: () => {} }),
        registerCodeLensProvider: () => ({ dispose: () => {} }),
        createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }),
    },
    tasks: { task: () => ({}), Task: class {}, ShellExecution: class {} },
    ProgressLocation: { SourceControl: 1, Window: 10 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
};
