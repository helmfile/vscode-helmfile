/**
 * Readable download failures without exposing authentication in notifications
 * or console output. Port of HelmfileDownloadDiagnostics from the IntelliJ
 * plugin.
 */

import { Access } from './repositories';

const OUTPUT_LIMIT = 32768;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const USER_INFO = /(\b(?:https?|oci):\/\/)[^\s/@]+@/gi;
const AUTHORIZATION = /(\b(?:proxy-)?authorization\s*:\s*)(?:Basic|Bearer)\s+[^\s]+/gim;
const SECRET_PARAMETER = /((?:[?&]|\b)(?:access[_-]?token|private[_-]?token|auth[_-]?token|token|password|passwd|api[_-]?key|client[_-]?secret)["']?\s*(?:=|:)\s*["']?)[^\s&"'<>]+/gi;
const AUTH_ARGUMENT = /(--(?:username|password)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;

export function clean(text: string | null | undefined, access: Access | null): string {
    let result = (text ?? '').replace(ANSI, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (access && access.password) {
        const encoded = encodeURIComponent(access.password);
        const basic = Buffer.from(access.username + ':' + access.password, 'utf8').toString('base64');
        for (const secret of [basic, encoded.replace(/\+/g, '%20'), encoded, access.password]) {
            if (secret) result = result.split(secret).join('[redacted]');
        }
    }
    result = result.replace(USER_INFO, '$1[redacted]@');
    result = result.replace(AUTHORIZATION, '$1[redacted]');
    result = result.replace(SECRET_PARAMETER, '$1[redacted]');
    result = result.replace(AUTH_ARGUMENT, '$1[redacted]');
    result = result.trim();
    if (result.length > OUTPUT_LIMIT) {
        const marker = '\n[Output truncated; first and last sections shown]\n';
        const first = Math.floor((OUTPUT_LIMIT - marker.length) / 2);
        result = result.substring(0, first) + marker + result.substring(result.length - (OUTPUT_LIMIT - marker.length - first));
    }
    return result;
}

export function reason(error: unknown, access: Access | null): string {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    for (let cause: unknown = error; cause != null && seen.size < 4 && !seen.has(cause); cause = (cause as { cause?: unknown })?.cause) {
        seen.add(cause);
        const message = (cause as Error)?.message;
        if (message && message.trim() && !messages.includes(message)) messages.push(message);
    }
    return clean(messages.length === 0 ? (error as Error)?.name ?? String(error) : messages.join(': '), access);
}

export interface ProcessOutput {
    readonly stdout: string;
    readonly stderr: string;
}

export function processFailure(status: string, output: ProcessOutput, access: Access | null): string {
    const stderr = clean(output.stderr, access);
    const stdout = clean(output.stdout, access);
    const lines = [...stderr.split('\n'), ...stdout.split('\n')].map(line => line.trim());
    const reasonLine =
        lines.find(line => line.toLowerCase().startsWith('error:')) ??
        lines.find(line => line !== '') ??
        'Helm produced no output.';
    return (
        status +
        ': ' +
        preview(reasonLine) +
        (stderr.trim() === '' ? '' : '\n\nHelm standard error:\n' + stderr) +
        (stdout.trim() === '' ? '' : '\n\nHelm standard output:\n' + stdout)
    );
}

export function preview(message: string): string {
    const firstLine = message.split('\n')[0] ?? message;
    return firstLine.length <= 600 ? firstLine : firstLine.substring(0, 600) + '…';
}
