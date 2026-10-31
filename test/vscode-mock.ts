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
class Hover {
    constructor(readonly contents: unknown, readonly range?: unknown) {}
}

class MarkdownString {
    value = '';
    isTrusted = false;
    constructor(value = '') { this.value = value; }
    appendText(text: string): this { this.value += text; return this; }
    appendMarkdown(text: string): this { this.value += text; return this; }
    appendCodeblock(code: string, language = ''): this { this.value += '\n```' + language + '\n' + code + '\n```\n'; return this; }
}
class SnippetString {
    constructor(readonly value = '') {}
}
class CompletionItem {
    label: string;
    kind?: number;
    detail?: string;
    documentation?: unknown;
    insertText?: string | SnippetString;
    sortText?: string;
    filterText?: string;
    tags?: number[];
    command?: { command: string; title: string };
    constructor(label: string, kind?: number) { this.label = label; this.kind = kind; }
}
class CompletionList {
    isIncomplete = false;
    items: CompletionItem[];
    constructor(items: CompletionItem[] = [], isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; }
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
class CodeLens {
    command?: { title: string; command: string; arguments?: unknown[] };
    constructor(readonly range: { start: unknown; end: unknown }, command?: { title: string; command: string; arguments?: unknown[] }) {
        this.command = command;
    }
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
class ThemeIcon {
    constructor(readonly id: string) {}
}
class SemanticTokensLegend {
    constructor(readonly tokenTypes: readonly string[], readonly tokenModifiers: readonly string[] = []) {}
}
class SemanticTokensBuilder {
    private slots: number[] = [];
    private lastLine = 0;
    private lastChar = 0;
    constructor(_legend?: SemanticTokensLegend) {}
    push(line: number, char: number, length: number, tokenType: number, _tokenModifiers = 0): void {
        const deltaLine = line - this.lastLine;
        const deltaChar = deltaLine === 0 ? char - this.lastChar : char;
        this.slots.push(deltaLine, deltaChar, length, tokenType, _tokenModifiers);
        this.lastLine = line;
        this.lastChar = char;
    }
    build(): { data: number[] } {
        return { data: this.slots };
    }
}
class DocumentSymbol {
    children: DocumentSymbol[] = [];
    constructor(readonly name: string, readonly detail: string, readonly kind: number, readonly range: any, readonly selectionRange: any) {}
}
class FoldingRange {
    constructor(readonly start: number, readonly end: number, readonly kind?: number) {}
}
class SelectionRange {
    constructor(readonly range: any, readonly parent?: SelectionRange) {}
}
class CodeAction {
    edit?: unknown;
    command?: unknown;
    isPreferred?: boolean;
    constructor(readonly title: string, readonly kind?: unknown) {}
}
class CodeActionKind {
    static QuickFix = new CodeActionKind('quickfix');
    constructor(readonly value: string) {}
}
class WorkspaceEdit {
    private readonly edits: unknown[] = [];
    delete(_uri: unknown, _range: unknown): void { this.edits.push({ type: 'delete' }); }
    insert(_uri: unknown, _position: unknown, _text: string): void { this.edits.push({ type: 'insert', text: _text }); }
    get size(): number { return this.edits.length; }
}
class StatusBarSpaceItem {
    text = '';
    tooltip: unknown;
    command?: string;
    name = '';
    show(): void {}
    hide(): void {}
    dispose(): void {}
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
    Hover,
    MarkdownString,
    SnippetString,
    CompletionItem,
    CompletionList,
    CompletionItemKind: {
        Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6,
        Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13,
        Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19,
        Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24,
    },
    CompletionItemTag: { Deprecated: 1 },
    EventEmitter,
    CodeLens,
    Disposable,
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: { File: 1, Module: 2, Class: 4, Enum: 10, Package: 8 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeIcon,
    SemanticTokensLegend,
    SemanticTokensBuilder,
    DocumentSymbol,
    FoldingRange,
    SelectionRange,
    CodeAction,
    CodeActionKind,
    WorkspaceEdit,
    env: {},
    window: {
        activeTextEditor: undefined,
        createOutputChannel: outputChannel,
        createStatusBarItem: () => new StatusBarSpaceItem(),
        showQuickPick: async () => undefined,
        showTextDocument: async () => ({}),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        withProgress: async <T>(_options: unknown, task: () => T) => task(),
        onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    },
    workspace: {
        textDocuments: [] as unknown[],
        workspaceFolders: [] as unknown[],
        findFiles: async () => [] as Uri[],
        asRelativePath: (pathOrUri: string | Uri): string => (typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath),
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
        onDidOpenTextDocument: () => ({ dispose: () => {} }),
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
        registerDocumentSemanticTokensProvider: () => ({ dispose: () => {} }),
        registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
        registerFoldingRangeProvider: () => ({ dispose: () => {} }),
        registerSelectionRangeProvider: () => ({ dispose: () => {} }),
        createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }),
    },
    tasks: { task: () => ({}), Task: class {}, ShellExecution: class {} },
    ProgressLocation: { SourceControl: 1, Window: 10 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
};
