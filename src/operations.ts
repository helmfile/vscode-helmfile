/**
 * Interactive release operations: port of HelmfileReleaseDialog,
 * HelmfileReleaseAction, HelmfileTemplateRun, HelmfileDiffRun and
 * HelmfileApplyReview (diff-first apply with a one-shot approval).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EnvironmentService, settings } from './settings';
import { environmentNames, isHelmfileName, readSource } from './values';
import {
    buildCommand,
    channel,
    commandProblem,
    confirmProtected,
    isProtectedEnvironment,
    protectionProblem,
    runHelmfile,
    reportRunFailure,
    type HelmfileCommandSpec,
    type HelmfileOperationKind,
} from './execution';
import { OutputViewer, parseDiffOutput, parseTemplateOutput, diffPartial } from './outputs';
import { declarationAt, literal } from './releaseTarget';

const OPERATION_LABELS: Record<HelmfileOperationKind, string> = {
    template: 'Template',
    diff: 'Diff',
    apply: 'Apply',
    destroy: 'Destroy',
};

const templateViewer = new OutputViewer('template');
const diffViewer = new OutputViewer('diff');

/** Tools → Helmfile: Select Environment. */
export async function selectEnvironment(env: EnvironmentService, uri?: vscode.Uri): Promise<void> {
    const target = uri ?? activeStateFile();
    const names = target ? environmentNames(target, env.get()) : [env.get()];
    const picked = await vscode.window.showQuickPick(names, { placeHolder: 'Select the Helmfile environment' });
    if (picked === undefined || picked === env.get()) return;
    env.set(picked);
    void vscode.window.showInformationMessage(`Helmfile: environment set to '${picked}'.`);
}

/** Run an operation against a release (targeted from the editor when available). */
export async function runReleaseOperation(env: EnvironmentService, operation: HelmfileOperationKind, wholeState: boolean, uri?: vscode.Uri, offset?: number): Promise<void> {
    const target = wholeState ? null : releaseTargetAt(uri ?? activeStateFile(), offset);
    const stateFile = (uri ?? activeStateFile())?.fsPath;
    if (!stateFile) {
        void vscode.window.showWarningMessage('Helmfile: open a helmfile state file first.');
        return;
    }
    const inputs = await collectInputs(env, vscode.Uri.file(stateFile), operation, target?.name ?? '');
    if (!inputs) return;

    const command: HelmfileCommandSpec = {
        file: stateFile,
        release: wholeState ? '' : inputs.release,
        namespace: wholeState ? '' : inputs.namespace,
        environment: inputs.environment,
        operation,
    };
    await execute(command);
}

interface DialogInputs {
    readonly environment: string;
    readonly release: string;
    readonly namespace: string;
}

/** Port of HelmfileReleaseDialog: environment → release → namespace → preview. */
async function collectInputs(env: EnvironmentService, uri: vscode.Uri, operation: HelmfileOperationKind, suggestedRelease: string): Promise<DialogInputs | null> {
    const names = environmentNames(uri, env.get());
    const environment =
        (await vscode.window.showQuickPick(names, { placeHolder: `Helmfile environment (${OPERATION_LABELS[operation]})`, ignoreFocusOut: true })) ?? null;
    if (environment === null) return null;

    const release = await vscode.window.showInputBox({
        prompt: `Release name (${OPERATION_LABELS[operation]})`,
        value: suggestedRelease,
        placeHolder: 'release name',
        ignoreFocusOut: true,
        title: 'For templated release names enter the rendered name',
    });
    if (release === undefined) return null;

    const namespace = await vscode.window.showInputBox({
        prompt: 'Namespace (optional, distinguishes same-name releases)',
        placeHolder: 'namespace',
        ignoreFocusOut: true,
    });
    if (namespace === undefined) return null;

    return { environment, release: release.trim(), namespace: namespace.trim() };
}

/** Port of HelmfileExecution.start() including diff-first apply review. */
async function execute(command: HelmfileCommandSpec): Promise<void> {
    const problem = commandProblem(command) ?? protectionProblem(settings().protectedEnvironments);
    if (problem) {
        void vscode.window.showErrorMessage(`Helmfile: ${problem}`);
        return;
    }
    if (isProtectedEnvironment(command.environment, settings().protectedEnvironments)) {
        if (!(await confirmProtected(command, settings().protectedEnvironments))) return;
    }

    if (command.operation === 'apply') {
        await runApplyReview(command);
        return;
    }
    await runDirect(command);
}

async function runDirect(command: HelmfileCommandSpec): Promise<void> {
    const built = buildCommand(command);
    channel().appendLine(`$ ${built.display}`);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `helmfile ${command.operation}`, cancellable: true }, (_progress, token) => runHelmfile(built, token));
    if (result.cancelled) {
        void vscode.window.showInformationMessage(`Helmfile: ${OPERATION_LABELS[command.operation]} was stopped.`);
        return;
    }
    const exit = command.operation === 'diff' && result.exitCode === 2 ? 0 : result.exitCode;
    if (exit !== 0) {
        reportRunFailure(built, result);
        return;
    }
    if (command.operation === 'template') {
        const parsed = parseTemplateOutput(result.stdout);
        await templateViewer.showTemplate(parsed, command.environment);
        return;
    }
    if (command.operation === 'diff') {
        await showDiffResult(diffViewer, result.stdout, command, undefined);
        return;
    }
    // destroy: report completion.
    void vscode.window.showInformationMessage(`Helmfile: destroy completed for ${command.release || 'all releases'} (${command.environment}).`);
}

/** Apply = review the diff, then continue with the real apply once. */
async function runApplyReview(command: HelmfileCommandSpec): Promise<void> {
    // Port of HelmfileApplyReview: diff first; the apply continues only through
    // the "Apply reviewed changes" action, once, on an unchanged state file.
    const diffBuilt = buildCommand({ ...command, operation: 'diff' });
    channel().appendLine(`$ ${diffBuilt.display}`);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'helmfile diff (apply review)', cancellable: true }, (_progress, token) => runHelmfile(diffBuilt, token));
    if (result.cancelled) {
        void vscode.window.showInformationMessage('Helmfile: apply was stopped.');
        return;
    }
    const exit = result.exitCode === 2 ? 0 : result.exitCode;
    if (exit !== 0) {
        reportRunFailure(diffBuilt, result);
        return;
    }
    const mtime = fs.existsSync(command.file) ? fs.statSync(command.file).mtimeMs : 0;
    await showDiffResult(diffViewer, result.stdout, command, () => continueApply(command, mtime));
}

async function continueApply(command: HelmfileCommandSpec, reviewedMtime: number): Promise<void> {
    if (fs.existsSync(command.file) && fs.statSync(command.file).mtimeMs !== reviewedMtime) {
        void vscode.window.showWarningMessage('Helmfile: the state file changed since the review. Run the operation again to review the latest diff.');
        return;
    }
    const built = buildCommand({ ...command, operation: 'apply' });
    channel().appendLine(`$ ${built.display}`);
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'helmfile apply', cancellable: true }, (_progress, token) => runHelmfile(built, token));
    if (result.exitCode !== 0 && !result.cancelled) {
        reportRunFailure(built, result);
        return;
    }
    void vscode.window.showInformationMessage(`Helmfile: apply completed for ${command.release || 'all releases'} (${command.environment}).`);
}

async function showDiffResult(viewer: OutputViewer, stdout: string, command: HelmfileCommandSpec, review?: () => Promise<void>): Promise<void> {
    const parsed = parseDiffOutput(stdout);
    if (parsed.resources.length === 0) {
        if (stdout.trim().length > 0) {
            void vscode.window.showWarningMessage('Helmfile: the diff output could not be parsed; showing the raw output in the Helmfile output channel.');
            channel().appendLine(stdout);
        }
        void vscode.window.showInformationMessage(`Helmfile: no changes for ${command.release || 'all releases'} (${command.environment}).`);
        return;
    }
    if (diffPartial(parsed)) {
        void vscode.window.showWarningMessage('Helmfile: the comparison is partial; some output could not be parsed.');
    }
    const scope = command.release ? `release ${command.release}${command.namespace ? `, namespace ${command.namespace}` : ''}` : 'all releases';
    await viewer.showDiff(parsed, scope, command.environment, review ? { command: 'Apply reviewed changes', run: review } : undefined);
}

function activeStateFile(): vscode.Uri | undefined {
    const active = vscode.window.activeTextEditor?.document;
    if (active && (active.languageId === 'helmfile' || isHelmfileName(path.basename(active.uri.fsPath)))) return active.uri;
    return vscode.workspace.textDocuments.find(document => isHelmfileName(path.basename(document.uri.fsPath)))?.uri;
}

function releaseTargetAt(uri: vscode.Uri | undefined, offset: number | undefined): { name: string } | null {
    if (!uri || offset === undefined) return null;
    const source = readSource(uri);
    if (!source) return null;
    const namePair = declarationAt(source, offset);
    if (!namePair) return null;
    const name = literal(namePair);
    return name ? { name } : null;
}

export function disposeOperations(): void {
    templateViewer.dispose();
    diffViewer.dispose();
}
