/**
 * Helmfile command construction and execution: port of HelmfileCommand and
 * HelmfileExecution. stdout is captured (bounded), stderr streams to an
 * output channel; protected environments require explicit confirmation.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { settings } from './settings';
import { clean, preview as previewMessage, reason } from './downloadDiagnostics';

export type HelmfileOperationKind = 'template' | 'diff' | 'apply' | 'destroy';

export interface HelmfileCommandSpec {
    /** Absolute state file path. */
    readonly file: string;
    /** Release name or empty for the whole state. */
    readonly release: string;
    readonly namespace: string;
    readonly environment: string;
    readonly operation: HelmfileOperationKind;
    /** Extra environment variables for the child process. */
    readonly variables?: Record<string, string>;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Port of HelmfileCommand.problem(): validation errors, empty when valid. */
export function commandProblem(command: HelmfileCommandSpec): string | null {
    if (!path.isAbsolute(command.file)) return 'The state file must be an absolute path';
    if (command.release && !NAME_PATTERN.test(command.release)) return 'Invalid release name';
    if (command.namespace && !NAME_PATTERN.test(command.namespace)) return 'Invalid namespace';
    if (command.operation === 'diff' && !command.release && command.namespace) return 'The whole state cannot be scoped to a namespace';
    if (!command.environment || /\s/.test(command.environment)) return 'Invalid environment name';
    return null;
}

/** `--selector name=<release>[,namespace=<namespace>]`. */
export function selectorOf(command: HelmfileCommandSpec): string {
    let selector = `name=${command.release}`;
    if (command.namespace) selector += `,namespace=${command.namespace}`;
    return selector;
}

export interface BuiltCommand {
    readonly executable: string;
    readonly args: string[];
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly display: string;
}

/** Port of HelmfileCommand.commandLine(). */
export function buildCommand(command: HelmfileCommandSpec): BuiltCommand {
    const executable = settings().helmfileExecutable;
    const args = ['--file', command.file, '--environment', command.environment];
    if (command.release) args.push('--selector', selectorOf(command));
    args.push('--interactive=false');
    const env: Record<string, string> = { ...(command.variables ?? {}) };
    if (command.operation === 'diff') {
        args.push('--no-color', 'diff', '--context', '-1', '--output', 'diff', '--detailed-exitcode', '--concurrency', '1');
        env['HELM_DIFF_COLOR'] = 'false';
        env['HELM_DIFF_OUTPUT_CONTEXT'] = '-1';
        env['HELM_DIFF_TOOL'] = '';
    } else if (command.operation === 'template') {
        args.push('--no-color', 'template');
    } else {
        args.push(command.operation);
    }
    const display = ['helmfile', ...args.map(arg => (arg.includes(' ') ? `"${arg}"` : arg))].join(' ');
    return { executable, args, cwd: path.dirname(command.file), env, display };
}

/** Port of HelmfileExecution.protectionProblem(). */
export function protectionProblem(regex: string): string | null {
    try {
        new RegExp(`^(?:${regex})$`);
        return null;
    } catch (error) {
        return `Invalid protected environments pattern: ${reason(error, null)}`;
    }
}

export function isProtectedEnvironment(environment: string, regex: string): boolean {
    if (!regex) return false;
    try {
        return new RegExp(`^(?:${regex})$`).test(environment);
    } catch {
        return false;
    }
}

export interface RunResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly cancelled: boolean;
}

const OUTPUT_LIMIT = 32 * 1024 * 1024;

/** Kill the helmfile process and (POSIX) its whole process group. */
function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
    if (process.platform !== 'win32' && child.pid) {
        try {
            process.kill(-child.pid, 'SIGTERM');
            return;
        } catch {
            // Group already gone — fall through to the direct kill.
        }
    }
    child.kill();
}

/**
 * Run helmfile capturing stdout (bounded) and streaming stderr. Exit code 2
 * from a detailed diff is normalized to 0 by the caller when appropriate.
 */
export function runHelmfile(built: BuiltCommand, token?: vscode.CancellationToken): Promise<RunResult> {
    return new Promise(resolve => {
        const child = spawn(built.executable, built.args, {
            cwd: built.cwd,
            env: { ...process.env, ...built.env },
            // New process group so cancelling kills helm/helm-diff children too,
            // not just the helmfile parent.
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let cancelled = false;
        const onStdout = (chunk: Buffer): void => {
            if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
        };
        const onStderr = (chunk: Buffer): void => {
            if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8');
            channel().append(chunk.toString('utf8'));
        };
        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        token?.onCancellationRequested(() => {
            cancelled = true;
            killTree(child);
        });
        child.on('error', error => {
            channel().appendLine(`Failed to start ${built.executable}: ${reason(error, null)}`);
            resolve({ exitCode: null, stdout, stderr: stderr + String((error as Error).message), cancelled });
        });
        child.on('close', code => {
            resolve({ exitCode: code, stdout, stderr, cancelled });
        });
    });
}

let outputChannel: vscode.OutputChannel | undefined;

export function channel(): vscode.OutputChannel {
    outputChannel ??= vscode.window.createOutputChannel('Helmfile', { log: true });
    return outputChannel;
}

/** Release the shared output channel (extension shutdown). */
export function disposeChannel(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}

/** Confirm a protected environment run; false aborts. */
export async function confirmProtected(command: HelmfileCommandSpec, regex: string): Promise<boolean> {
    const scope = command.release ? `release '${command.release}'${command.namespace ? ` in namespace '${command.namespace}'` : ''}` : 'all releases';
    // 'Cancel' first: the modal's default (Enter) action must be the safe one,
    // matching the IntelliJ plugin's Cancel-by-default confirmation.
    const choice = await vscode.window.showWarningMessage(
        `Environment '${command.environment}' is protected by '${regex}'.`,
        {
            modal: true,
            detail: `Action: ${command.operation}\nScope: ${scope}\nState file: ${path.basename(command.file)}\n\nRun this action?`,
        },
        'Cancel',
        'Run',
    );
    return choice === 'Run';
}

/** Show a compact error notification for a failed run. */
export function reportRunFailure(built: BuiltCommand, result: RunResult): void {
    const message = previewMessage(clean(result.stderr || result.stdout, null) || `helmfile exited with code ${result.exitCode}`);
    void vscode.window.showErrorMessage(`Helmfile: ${message}`, 'Show Output').then(choice => {
        if (choice === 'Show Output') channel().show();
    });
}
