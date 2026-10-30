/**
 * Code lenses replacing the IntelliJ line markers: an environment switcher on
 * each `environments:` entry (check mark on the active one), run actions on
 * each release name, and template inheritance navigation arrows.
 */
import * as vscode from 'vscode';
import { mappingGet, parseTree, walkAll, type YPair } from './yamlTree';
import type { SourceFile } from './values';
import { isDeclaration as isTemplateDeclaration, inheritanceScalars } from './templates';
import { isRelease } from './releaseTarget';
import { EnvironmentService, mutatingCommandsEnabled } from './settings';

export const HELMFILE_SELECT_ENVIRONMENT = 'helmfile.selectEnvironment';
export const HELMFILE_GOTO_TEMPLATE_PARENT = 'helmfile.gotoTemplateParent';
export const HELMFILE_FIND_TEMPLATE_USAGES = 'helmfile.findTemplateUsages';

const RELEASE_OPERATIONS: readonly { command: string; icon: string; label: string }[] = [
    { command: 'helmfile.templateRelease', icon: 'preview', label: 'Template' },
    { command: 'helmfile.diffRelease', icon: 'diff', label: 'Diff' },
    { command: 'helmfile.applyRelease', icon: 'cloud-upload', label: 'Apply' },
    { command: 'helmfile.destroyRelease', icon: 'trash', label: 'Destroy' },
];

export class HelmfileCodeLensProvider implements vscode.CodeLensProvider {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.emitter.event;

    constructor(private readonly env: EnvironmentService) {}

    fire(): void {
        this.emitter.fire();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        const text = document.getText();
        const tree = parseTree(text);
        const source: SourceFile = { uri: document.uri, text, tree };
        const lenses: vscode.CodeLens[] = [];

        for (const doc of tree.docs) {
            const root = doc.root;
            if (!root) continue;

            // Environment switcher entries.
            const environments = mappingGet(root, 'environments');
            const envMapping = environments?.value;
            if (envMapping && envMapping.kind === 'mapping') {
                for (const pair of envMapping.pairs) {
                    if (!pair.key) continue;
                    const active = pair.key === this.env.get();
                    lenses.push(
                        new vscode.CodeLens(lensRange(document, pair.keyStart, pair.keyEnd), {
                            title: active ? `✓ ${pair.key}` : pair.key,
                            command: HELMFILE_SELECT_ENVIRONMENT,
                            arguments: [document.uri],
                            tooltip: 'Select the Helmfile environment',
                        }),
                    );
                }
            }

            // Release run actions.
            walkAll(root, node => {
                if (node.kind !== 'pair') return;
                const pair = node as YPair;
                if (!isRelease(pair)) return;
                const at = new vscode.Range(document.positionAt(pair.keyStart), document.positionAt(pair.keyStart));
                // Mutating operations (Apply/Destroy) are hidden until the user opts in via settings.
                const operations = mutatingCommandsEnabled()
                    ? RELEASE_OPERATIONS
                    : RELEASE_OPERATIONS.filter(operation => operation.command !== 'helmfile.applyRelease' && operation.command !== 'helmfile.destroyRelease');
                for (const operation of operations) {
                    lenses.push(
                        new vscode.CodeLens(at, {
                            title: `$(${operation.icon}) ${operation.label}`,
                            command: operation.command,
                            arguments: [document.uri, pair.keyStart],
                        }),
                    );
                }
            });

            // Template inheritance arrows.
            for (const item of inheritanceScalars(source)) {
                lenses.push(
                    new vscode.CodeLens(lensRange(document, item.scalar.start, item.scalar.end), {
                        title: '$(arrow-up) parent',
                        command: HELMFILE_GOTO_TEMPLATE_PARENT,
                        arguments: [document.uri, item.scalar.start],
                        tooltip: 'Navigate to the parent template declaration',
                    }),
                );
            }
            walkAll(root, node => {
                if (node.kind !== 'pair') return;
                const pair = node as YPair;
                if (!isTemplateDeclaration(pair) || !pair.key) return;
                const usages = inheritanceScalars(source).filter(item => item.name === pair.key).length;
                if (usages === 0) return;
                lenses.push(
                    new vscode.CodeLens(lensRange(document, pair.keyStart, pair.keyEnd), {
                        title: `$(arrow-down) ${usages}`,
                        command: HELMFILE_FIND_TEMPLATE_USAGES,
                        arguments: [document.uri, pair.keyStart],
                        tooltip: 'Find template usages',
                    }),
                );
            });
        }
        return lenses;
    }
}

function lensRange(document: vscode.TextDocument, start: number, end: number): vscode.Range {
    return new vscode.Range(document.positionAt(start), document.positionAt(end));
}
