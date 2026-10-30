/**
 * HTTP(S) repository access for Helm index files and OCI tag lists. Port of
 * HelmfileRepositoryDownload from the IntelliJ plugin. Never runs Helm or
 * modifies its repositories; honors the VSCode proxy configuration.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Access } from './repositories';
import { ChartIndex } from './chartIndex';

const LIMIT = 32 * 1024 * 1024;
const READ_TIMEOUT = 10000;
const REDIRECT_LIMIT = 5;

interface Response {
    readonly status: number;
    readonly challenge: string | null;
    readonly next: string | null;
    readonly body: string;
}

export async function loadRepository(access: Access, chart: string, token?: vscode.CancellationToken): Promise<ChartIndex> {
    const options = await requestOptions(access);
    if (!access.oci) {
        const base = new URL(access.url);
        const index = new URL(base.pathname.replace(/\/+$/, '') + '/index.yaml', base);
        const response = await get(index, access, options, null, token);
        requireSuccess(response);
        return ChartIndex.parse(response.body);
    }
    const url = access.url.replace(/^(?:oci|https?):\/\//, '');
    const source = new URL((access.plainHttp ? 'http://' : 'https://') + url.replace(/\/+$/, '') + '/' + chart);
    let next: URL | null = new URL('/v2' + source.pathname + '/tags/list', source);
    next.search = 'n=1000';
    const versions: string[] = [];
    const visited = new Set<string>();
    let bearerToken: string | null = null;
    while (next) {
        if (token?.isCancellationRequested) throw new Error('Cancelled');
        if (!visited.add(next.toString()) || visited.size > 50) throw new Error('OCI tag pagination limit exceeded');
        let response = await get(next, access, options, bearerToken, token);
        if (response.status === 401 && bearerToken === null) {
            bearerToken = await bearer(response.challenge, next, access, options, token);
            if (bearerToken != null) response = await get(next, access, options, bearerToken, token);
        }
        requireSuccess(response);
        let parsed: unknown;
        try {
            parsed = JSON.parse(response.body);
        } catch {
            throw new Error('Invalid OCI tags response');
        }
        if (typeof parsed !== 'object' || parsed === null || !('tags' in (parsed as object))) throw new Error('Invalid OCI tags response');
        const tags = (parsed as { tags?: unknown }).tags;
        if (Array.isArray(tags)) {
            for (const tag of tags) {
                const version = String(tag).replace(/_/g, '+');
                if (/^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) versions.push(version);
            }
        }
        const current: URL = next;
        next = null;
        if (response.next) {
            const match = /<([^>]+)>;\s*rel="?next"?/.exec(response.next);
            if (match) {
                next = new URL(match[1], current);
                if (!sameOrigin(current, next)) throw new Error('OCI tags redirected to another registry');
            }
        }
    }
    return ChartIndex.oci(chart, versions);
}

async function bearer(challenge: string | null, registry: URL, access: Access, options: https.RequestOptions, token?: vscode.CancellationToken): Promise<string | null> {
    if (!challenge || !/^Bearer /i.test(challenge)) return null;
    const parameters = new Map<string, string>();
    const pattern = /(\w+)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    const rest = challenge.substring(7);
    while ((match = pattern.exec(rest))) parameters.set(match[1], match[2]);
    const realm = parameters.get('realm');
    if (!realm) return null;
    const tokenUri = new URL(realm);
    // Cross-host authentication services are common for public OCI registries. Never
    // forward registry credentials there unless passCredentials was explicitly enabled.
    if (tokenUri.protocol !== 'https:' && !(sameOrigin(registry, tokenUri) && access.plainHttp)) return null;
    const params = tokenUri.searchParams;
    for (const key of ['service', 'scope']) {
        const value = parameters.get(key);
        if (value != null && !params.has(key)) params.append(key, value);
    }
    const response = await get(tokenUri, access, options, null, token, registry);
    requireSuccess(response);
    let parsed: unknown;
    try {
        parsed = JSON.parse(response.body);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = (parsed as { token?: unknown; access_token?: unknown });
    const result = value.token ?? value.access_token;
    return typeof result === 'string' ? result : null;
}

function requireSuccess(response: Response): void {
    if (response.status !== 200) {
        const meaning =
            response.status === 401 ? ' Unauthorized' : response.status === 403 ? ' Forbidden' : response.status === 404 ? ' Not Found' : response.status === 429 ? ' Too Many Requests' : '';
        throw new Error(`Repository returned HTTP ${response.status}${meaning}`);
    }
}

async function get(
    uri: URL,
    access: Access,
    options: https.RequestOptions,
    token: string | null,
    cancellationToken?: vscode.CancellationToken,
    credentialsOrigin?: URL,
): Promise<Response> {
    return await getWithOrigin(uri, access, options, token, credentialsOrigin ?? uri, cancellationToken);
}

async function getWithOrigin(
    uri: URL,
    access: Access,
    options: https.RequestOptions,
    token: string | null,
    credentialsOrigin: URL,
    cancellationToken?: vscode.CancellationToken,
): Promise<Response> {
    let current = uri;
    for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect++) {
        if (cancellationToken?.isCancellationRequested) throw new Error('Cancelled');
        const response = await once(current, access, options, token, credentialsOrigin, cancellationToken);
        if (response.status >= 300 && response.status < 400 && response.next) {
            const location = new URL(response.next, current);
            if (location.protocol !== 'http:' && location.protocol !== 'https:') throw new Error('Unsupported repository redirect');
            if (current.protocol === 'https:' && location.protocol !== 'https:') throw new Error('Unsupported repository redirect');
            current = location;
            continue;
        }
        return response;
    }
    throw new Error('Repository redirect limit exceeded');
}

async function once(
    uri: URL,
    access: Access,
    options: https.RequestOptions,
    token: string | null,
    credentialsOrigin: URL,
    cancellationToken?: vscode.CancellationToken,
): Promise<Response> {
    const headers: Record<string, string> = {};
    const credentials = sameOrigin(credentialsOrigin, uri) || access.passCredentials;
    if (credentials && token != null) headers.Authorization = 'Bearer ' + token;
    else if (credentials && (access.username !== '' || access.password !== '')) {
        headers.Authorization = 'Basic ' + Buffer.from(access.username + ':' + access.password, 'utf8').toString('base64');
    }
    const request: http.RequestOptions = {
        headers,
        method: 'GET',
    };
    const agent = await agentFor(uri, options);
    return await new Promise<Response>((resolve, reject) => {
        const requester = uri.protocol === 'https:' ? https.request : http.request;
        const call = requester(
            {
                ...request,
                protocol: uri.protocol,
                hostname: uri.hostname,
                port: uri.port,
                path: uri.pathname + uri.search,
                agent,
                timeout: READ_TIMEOUT,
                ...(uri.protocol === 'https:' && (options.ca || options.cert || options.key || options.rejectUnauthorized === false)
                    ? { rejectUnauthorized: options.rejectUnauthorized, ca: options.ca, cert: options.cert, key: options.key }
                    : {}),
            },
            response => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    if (cancellationToken?.isCancellationRequested) {
                        response.destroy();
                        reject(new Error('Cancelled'));
                        return;
                    }
                    size += chunk.length;
                    if (size > LIMIT) {
                        response.destroy();
                        reject(new Error('Repository response exceeds 32 MiB'));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        challenge: headerLine(response, 'www-authenticate'),
                        // The Link header doubles as the redirect location holder.
                        next: headerLine(response, 'link') ?? headerLine(response, 'location'),
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
                response.on('error', reject);
            },
        );
        call.on('timeout', () => {
            call.destroy(new Error('Socket timeout'));
        });
        call.on('error', reject);
        cancellationToken?.onCancellationRequested(() => call.destroy(new Error('Cancelled')));
        call.end();
    });
}

function sameOrigin(left: URL, right: URL): boolean {
    return left.protocol === right.protocol && left.hostname === right.hostname && portOf(left) === portOf(right);
}

function headerLine(response: http.IncomingMessage, name: string): string | null {
    const value = response.headers[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
    return null;
}

function portOf(uri: URL): number {
    if (uri.port) return Number(uri.port);
    return uri.protocol === 'https:' ? 443 : 80;
}

async function requestOptions(access: Access): Promise<https.RequestOptions> {
    const options: https.RequestOptions = {};
    if (access.skipTLSVerify) options.rejectUnauthorized = false;
    if (access.caFile) {
        try {
            options.ca = [fs.readFileSync(path.resolve(access.caFile), 'utf8')];
        } catch {
            throw new Error(`Cannot read repository caFile: ${access.caFile}`);
        }
    }
    if (access.certFile || access.keyFile) {
        if (!access.certFile || !access.keyFile) throw new Error('Both certFile and keyFile are required');
        try {
            options.cert = fs.readFileSync(path.resolve(access.certFile), 'utf8');
            const pem = fs.readFileSync(path.resolve(access.keyFile), 'utf8');
            if (!pem.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('Client key must use unencrypted PKCS#8 PEM format');
            options.key = pem;
        } catch (error) {
            if (error instanceof Error && !error.message.startsWith('Client key')) throw new Error(`Cannot read repository client certificate: ${access.certFile}`);
            throw error;
        }
    }
    return options;
}

/* ---------------- proxy support (http.proxy / http.proxySupport) ---------------- */

let proxyAgent: Promise<(protocol: string) => http.Agent | undefined> | null = null;

async function agentFor(uri: URL, options: https.RequestOptions): Promise<http.Agent | undefined> {
    const tlsUsed = uri.protocol === 'https:' && (options.rejectUnauthorized === false || !!options.ca || !!options.cert);
    if (tlsUsed) return undefined; // custom TLS needs a direct socket; skip proxy
    const resolver = (proxyAgent ??= loadProxyAgent());
    const select = await resolver;
    return select(uri.protocol);
}

function loadProxyAgent(): Promise<(protocol: string) => http.Agent | undefined> {
    const config = vscode.workspace.getConfiguration('http');
    const configured = config.get<string>('proxy') ?? '';
    // VSCode falls back to the environment when http.proxy is unset (http.proxySupport).
    const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? '';
    const proxy = configured || fromEnv;
    const strictSsl = config.get<boolean>('proxyStrictSSL', true);
    if (!proxy) return Promise.resolve(() => undefined);
    const parsed = new URL(proxy.includes('://') ? proxy : 'http://' + proxy);
    const agent = new ProxyTunnelAgent(parsed.hostname, Number(parsed.port || 80), strictSsl);
    return Promise.resolve((protocol: string) => (protocol === 'https:' ? agent : undefined));
}

/**
 * HTTPS agent that tunnels through an HTTP proxy with CONNECT, honoring the
 * user's http.proxy / http.proxyStrictSSL settings and HTTPS_PROXY variables.
 * https.Agent delegates the TLS handshake to createConnection, so the tunnel
 * socket is wrapped here before it is handed back.
 */
class ProxyTunnelAgent extends https.Agent {
    constructor(private readonly proxyHost: string, private readonly proxyPort: number, private readonly strictSsl: boolean) {
        super({ rejectUnauthorized: strictSsl });
    }

    createConnection(options: http.RequestOptions, callback?: (error: Error | null, stream: net.Socket) => void): net.Socket | null {
        if (!callback) return null;
        const host = String(options.host ?? options.hostname ?? '');
        const port = Number(options.port ?? 443);
        const servername = String((options as tls.ConnectionOptions).servername ?? host);
        const socket = net.connect({ host: this.proxyHost, port: this.proxyPort });
        const fail = (error: Error): void => {
            socket.destroy();
            callback(error, undefined as never);
        };
        socket.once('error', fail);
        socket.once('connect', () => {
            socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
        });
        // The CONNECT response may arrive in several TCP chunks; only after the
        // blank line is the tunnel established and TLS may start.
        let header = '';
        const onResponse = (chunk: Buffer): void => {
            header += chunk.toString('utf8');
            if (!header.includes('\r\n\r\n')) {
                if (header.length > 8192) fail(new Error('Proxy CONNECT response too large'));
                return;
            }
            socket.removeListener('data', onResponse);
            socket.removeListener('error', fail);
            socket.pause();
            const statusLine = header.substring(0, header.indexOf('\r\n'));
            const statusCode = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1];
            if (!statusCode || Number(statusCode) < 200 || Number(statusCode) > 299) {
                fail(new Error('Proxy CONNECT failed: ' + statusLine));
                return;
            }
            const tlsSocket = tls.connect(
                { socket, servername, rejectUnauthorized: this.strictSsl },
                () => callback(null, tlsSocket),
            );
            tlsSocket.once('error', (error: Error) => {
                tlsSocket.destroy();
                callback(error, undefined as never);
            });
        };
        socket.on('data', onResponse);
        // The connection must only be delivered through the callback: returning
        // the raw socket synchronously would make node treat it as the final
        // (TLS) request socket.
        return null;
    }
}
