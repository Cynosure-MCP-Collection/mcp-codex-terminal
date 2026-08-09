#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { z } from 'zod';

type ApprovalMode = 'untrusted' | 'on-request' | 'never';
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
type OutputMode = 'clean' | 'raw';

interface SessionOutputView {
    output: string;
    outputMode: OutputMode;
    rawChars: number;
    returnedChars: number;
    truncated: boolean;
}

interface CodexSession {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    createdAt: string;
    cols: number;
    rows: number;
    process: pty.IPty;
    output: string;
    exitCode?: number;
    exitSignal?: number;
}

const MAX_BUFFER_CHARS = 250_000;
const DEFAULT_READ_CHARS = 12_000;
const DEFAULT_READ_LINES = 160;
const sessions = new Map<string, CodexSession>();
const isWindows = platform() === 'win32';

function log(msg: string): void {
    process.stderr.write(`[codex-terminal-mcp ${new Date().toISOString()}] ${msg}\n`);
}

function resolveCwd(cwd?: string): string {
    const resolved = path.resolve(cwd || process.cwd());
    if (!existsSync(resolved)) {
        throw new Error(`Working directory does not exist: ${resolved}`);
    }
    return resolved;
}

function codexCommand(command?: string): string {
    const configured = command?.trim() || process.env.CODEX_CLI_PATH?.trim() || 'codex';
    if (configured.includes('\0')) throw new Error('Invalid Codex command path');
    return configured;
}

function appendCommonCodexArgs(args: string[], opts: {
    cwd?: string;
    model?: string;
    profile?: string;
    approval?: ApprovalMode;
    sandbox?: SandboxMode;
    search?: boolean;
    yolo?: boolean;
    addDirs?: string[];
    config?: string[];
}): void {
    if (opts.cwd) args.push('--cd', opts.cwd);
    if (opts.model) args.push('--model', opts.model);
    if (opts.profile) args.push('--profile', opts.profile);
    if (opts.approval) args.push('--ask-for-approval', opts.approval);
    if (opts.sandbox) args.push('--sandbox', opts.sandbox);
    if (opts.search) args.push('--search');
    if (opts.yolo) args.push('--dangerously-bypass-approvals-and-sandbox');
    for (const dir of opts.addDirs || []) args.push('--add-dir', path.resolve(dir));
    for (const cfg of opts.config || []) args.push('--config', cfg);
}

function trimSessionBuffer(session: CodexSession): void {
    if (session.output.length > MAX_BUFFER_CHARS) {
        session.output = session.output.slice(session.output.length - MAX_BUFFER_CHARS);
    }
}

function stripAnsi(input: string): string {
    return input
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B[PX^_].*?\x1B\\/gs, '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1B[()][A-Za-z0-9]/g, '')
        .replace(/\x1B[=>78]/g, '')
        .replace(/\x1B[@-Z\\-_]/g, '');
}

function normalizeTerminalOutput(input: string): string {
    const text = stripAnsi(input)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    const lines: string[] = [];
    let previous = '';
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/[ \t]+$/g, '');
        if (line === previous && line.trim() !== '') continue;
        lines.push(line);
        previous = line;
    }

    return lines.join('\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function tailLines(input: string, maxLines: number): string {
    const lines = input.split('\n');
    if (lines.length <= maxLines) return input;
    return lines.slice(lines.length - maxLines).join('\n');
}

function lastOutput(session: CodexSession, opts: {
    maxChars?: number;
    clear?: boolean;
    outputMode?: OutputMode;
    maxLines?: number;
} = {}): SessionOutputView {
    const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_READ_CHARS);
    const outputMode = opts.outputMode ?? 'clean';
    const maxLines = Math.max(1, opts.maxLines ?? DEFAULT_READ_LINES);
    const rawChars = session.output.length;
    const source = outputMode === 'raw' ? session.output : normalizeTerminalOutput(session.output);
    const lineLimited = outputMode === 'raw' ? source : tailLines(source, maxLines);
    const output = lineLimited.slice(-maxChars);
    const truncated = output.length < source.length;
    if (opts.clear) session.output = '';
    return {
        output,
        outputMode,
        rawChars,
        returnedChars: output.length,
        truncated,
    };
}

function controlSequence(name: string): string {
    switch (name) {
        case 'enter': return '\r';
        case 'escape': return '\x1b';
        case 'tab': return '\t';
        case 'ctrl-c': return '\x03';
        case 'ctrl-d': return '\x04';
        case 'ctrl-l': return '\x0c';
        case 'ctrl-o': return '\x0f';
        case 'up': return '\x1b[A';
        case 'down': return '\x1b[B';
        case 'right': return '\x1b[C';
        case 'left': return '\x1b[D';
        default: throw new Error(`Unsupported control key: ${name}`);
    }
}

function runProcess(command: string, args: string[], opts: {
    cwd: string;
    timeoutMs: number;
    input?: string;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawnChild(command, args, {
            cwd: opts.cwd,
            shell: false,
            env: process.env,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Command timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);

        child.stdout?.on('data', chunk => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', chunk => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr });
        });

        if (opts.input !== undefined) {
            child.stdin?.end(opts.input);
        }
    });
}

function jsonText(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

const server = new McpServer({
    name: 'Codex Terminal',
    version: '1.0.0',
    title: 'Codex Terminal',
    description: 'Start and control OpenAI Codex CLI coding sessions.',
    icons: [{ src: 'https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/mcp-codex-terminal/icon.png', mimeType: 'image/png' }],
});

const approvalSchema = z.enum(['untrusted', 'on-request', 'never']);
const sandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
const outputModeSchema = z.enum(['clean', 'raw']);

server.registerTool(
    'check_codex_cli',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Check whether the Codex CLI is available and report its version.',
        inputSchema: {
            codex_command: z.string().optional().describe('Codex executable path or command name. Defaults to CODEX_CLI_PATH or codex.'),
        },
    },
    async ({ codex_command }) => {
        try {
            const command = codexCommand(codex_command);
            const result = await runProcess(command, ['--version'], {
                cwd: process.cwd(),
                timeoutMs: 10_000,
            });
            return {
                content: [{ type: 'text', text: jsonText({ command, available: result.code === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: result.code }) }],
                isError: result.code !== 0,
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Codex CLI check failed: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'codex_exec',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Run Codex non-interactively with codex exec and return stdout/stderr. This is best for one-shot coding tasks or scripted automation.',
        inputSchema: {
            prompt: z.string().min(1).describe('Task prompt to pass to codex exec.'),
            cwd: z.string().optional().describe('Working directory for the Codex run. Defaults to this MCP process working directory.'),
            codex_command: z.string().optional().describe('Codex executable path or command name. Defaults to CODEX_CLI_PATH or codex.'),
            model: z.string().optional().describe('Optional model override, passed as --model.'),
            profile: z.string().optional().describe('Optional Codex profile, passed as --profile.'),
            approval: approvalSchema.optional().describe('Approval mode, passed as --ask-for-approval.'),
            sandbox: sandboxSchema.optional().default('read-only').describe('Sandbox mode. Codex exec defaults read-only; choose workspace-write for edits.'),
            search: z.boolean().optional().default(false).describe('Enable live web search for this run.'),
            yolo: z.boolean().optional().default(false).describe('Pass --dangerously-bypass-approvals-and-sandbox. Use only in isolated trusted environments.'),
            add_dirs: z.array(z.string()).optional().default([]).describe('Additional directories to grant access with --add-dir.'),
            config: z.array(z.string()).optional().default([]).describe('Raw Codex -c/--config key=value overrides.'),
            json: z.boolean().optional().default(false).describe('Pass --json to stream JSONL events.'),
            output_last_message_path: z.string().optional().describe('Optional path for -o/--output-last-message.'),
            stdin: z.string().optional().describe('Optional stdin context to pipe to codex exec.'),
            timeout_ms: z.number().int().min(1_000).max(3_600_000).optional().default(600_000).describe('Maximum runtime in milliseconds.'),
        },
    },
    async ({ prompt, cwd, codex_command, model, profile, approval, sandbox, search, yolo, add_dirs, config, json, output_last_message_path, stdin, timeout_ms }) => {
        try {
            const resolvedCwd = resolveCwd(cwd);
            const command = codexCommand(codex_command);
            const args = ['exec'];
            appendCommonCodexArgs(args, {
                model,
                profile,
                approval,
                sandbox,
                search,
                yolo,
                addDirs: add_dirs,
                config,
            });
            if (json) args.push('--json');
            if (output_last_message_path) args.push('--output-last-message', path.resolve(resolvedCwd, output_last_message_path));
            args.push(prompt);

            const result = await runProcess(command, args, { cwd: resolvedCwd, timeoutMs: timeout_ms, input: stdin });
            return {
                content: [{
                    type: 'text',
                    text: jsonText({
                        command,
                        args,
                        cwd: resolvedCwd,
                        exitCode: result.code,
                        signal: result.signal,
                        stdout: result.stdout,
                        stderr: result.stderr,
                    }),
                }],
                isError: result.code !== 0,
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `codex exec failed: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'start_codex_session',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Start an interactive Codex CLI terminal session in a PTY. Use read_codex_session and send_codex_input to interact with it.',
        inputSchema: {
            prompt: z.string().optional().describe('Optional initial prompt to pass to codex.'),
            cwd: z.string().optional().describe('Working directory for the Codex session. Defaults to this MCP process working directory.'),
            codex_command: z.string().optional().describe('Codex executable path or command name. Defaults to CODEX_CLI_PATH or codex.'),
            model: z.string().optional().describe('Optional model override, passed as --model.'),
            profile: z.string().optional().describe('Optional Codex profile, passed as --profile.'),
            approval: approvalSchema.optional().default('on-request').describe('Approval mode for the interactive session.'),
            sandbox: sandboxSchema.optional().default('workspace-write').describe('Sandbox mode for the interactive session.'),
            search: z.boolean().optional().default(false).describe('Enable live web search for this session.'),
            yolo: z.boolean().optional().default(false).describe('Pass --dangerously-bypass-approvals-and-sandbox. Use only in isolated trusted environments.'),
            add_dirs: z.array(z.string()).optional().default([]).describe('Additional directories to grant access with --add-dir.'),
            config: z.array(z.string()).optional().default([]).describe('Raw Codex -c/--config key=value overrides.'),
            no_alt_screen: z.boolean().optional().default(true).describe('Pass --no-alt-screen so output is easier to capture.'),
            cols: z.number().int().min(40).max(240).optional().default(120).describe('PTY columns.'),
            rows: z.number().int().min(10).max(80).optional().default(32).describe('PTY rows.'),
            initial_read_ms: z.number().int().min(0).max(10_000).optional().default(1000).describe('Milliseconds to wait before returning initial output.'),
            output_mode: outputModeSchema.optional().default('clean').describe('Return clean readable terminal text by default, or raw PTY bytes for debugging.'),
            max_chars: z.number().int().min(1).max(MAX_BUFFER_CHARS).optional().default(DEFAULT_READ_CHARS).describe('Maximum characters to return from the initial output.'),
            max_lines: z.number().int().min(1).max(2_000).optional().default(DEFAULT_READ_LINES).describe('Maximum cleaned terminal lines to return before applying max_chars. Ignored for raw output.'),
        },
    },
    async ({ prompt, cwd, codex_command, model, profile, approval, sandbox, search, yolo, add_dirs, config, no_alt_screen, cols, rows, initial_read_ms, output_mode, max_chars, max_lines }) => {
        try {
            const resolvedCwd = resolveCwd(cwd);
            const command = codexCommand(codex_command);
            const args: string[] = [];
            appendCommonCodexArgs(args, {
                model,
                profile,
                approval,
                sandbox,
                search,
                yolo,
                addDirs: add_dirs,
                config,
            });
            if (no_alt_screen) args.push('--no-alt-screen');
            if (prompt) args.push(prompt);

            const term = pty.spawn(command, args, {
                name: isWindows ? 'xterm' : 'xterm-256color',
                cols,
                rows,
                cwd: resolvedCwd,
                env: process.env as Record<string, string>,
            });

            const id = randomUUID();
            const session: CodexSession = {
                id,
                command,
                args,
                cwd: resolvedCwd,
                createdAt: new Date().toISOString(),
                cols,
                rows,
                process: term,
                output: '',
            };
            sessions.set(id, session);

            term.onData(data => {
                session.output += data;
                trimSessionBuffer(session);
            });
            term.onExit(({ exitCode, signal }) => {
                session.exitCode = exitCode;
                session.exitSignal = signal;
                session.output += `\n[Codex session exited: code=${exitCode} signal=${signal}]\n`;
                trimSessionBuffer(session);
            });

            if (initial_read_ms) {
                await new Promise(resolve => setTimeout(resolve, initial_read_ms));
            }

            return {
                content: [{
                    type: 'text',
                    text: jsonText({
                        sessionId: id,
                        command,
                        args,
                        cwd: resolvedCwd,
                        running: session.exitCode === undefined,
                        ...lastOutput(session, { maxChars: max_chars, outputMode: output_mode, maxLines: max_lines }),
                    }),
                }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to start Codex session: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'read_codex_session',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Read buffered terminal output from a running or recently exited interactive Codex session.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_codex_session.'),
            max_chars: z.number().int().min(1).max(MAX_BUFFER_CHARS).optional().default(DEFAULT_READ_CHARS).describe('Maximum characters to return from the end of the buffer.'),
            max_lines: z.number().int().min(1).max(2_000).optional().default(DEFAULT_READ_LINES).describe('Maximum cleaned terminal lines to return before applying max_chars. Ignored for raw output.'),
            output_mode: outputModeSchema.optional().default('clean').describe('Return clean readable terminal text by default, or raw PTY bytes for debugging.'),
            clear: z.boolean().optional().default(false).describe('Clear the session buffer after reading.'),
        },
    },
    async ({ session_id, max_chars, max_lines, output_mode, clear }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Codex session: ${session_id}` }], isError: true };
        }
        return {
            content: [{
                type: 'text',
                text: jsonText({
                    sessionId: session.id,
                    running: session.exitCode === undefined,
                    exitCode: session.exitCode,
                    exitSignal: session.exitSignal,
                    ...lastOutput(session, { maxChars: max_chars, maxLines: max_lines, outputMode: output_mode, clear }),
                }),
            }],
        };
    },
);

server.registerTool(
    'send_codex_input',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Send text or a control key to an interactive Codex session.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_codex_session.'),
            text: z.string().optional().default('').describe('Text to send to the Codex terminal.'),
            submit: z.boolean().optional().default(true).describe('Append Enter after text, useful for sending a prompt from the composer.'),
            control: z.enum(['enter', 'escape', 'tab', 'ctrl-c', 'ctrl-d', 'ctrl-l', 'ctrl-o', 'up', 'down', 'left', 'right']).optional().describe('Optional control key to send after text.'),
            read_after_ms: z.number().int().min(0).max(10_000).optional().default(1000).describe('Milliseconds to wait before returning new output.'),
            max_chars: z.number().int().min(1).max(MAX_BUFFER_CHARS).optional().default(DEFAULT_READ_CHARS).describe('Maximum characters of output to return.'),
            max_lines: z.number().int().min(1).max(2_000).optional().default(DEFAULT_READ_LINES).describe('Maximum cleaned terminal lines to return before applying max_chars. Ignored for raw output.'),
            output_mode: outputModeSchema.optional().default('clean').describe('Return clean readable terminal text by default, or raw PTY bytes for debugging.'),
        },
    },
    async ({ session_id, text, submit, control, read_after_ms, max_chars, max_lines, output_mode }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Codex session: ${session_id}` }], isError: true };
        }
        if (session.exitCode !== undefined) {
            return { content: [{ type: 'text', text: `Codex session has exited: ${session_id}` }], isError: true };
        }

        try {
            if (text) session.process.write(text);
            if (submit) session.process.write('\r');
            if (control) session.process.write(controlSequence(control));
            if (read_after_ms) {
                await new Promise(resolve => setTimeout(resolve, read_after_ms));
            }
            return {
                content: [{
                    type: 'text',
                    text: jsonText({
                        sessionId: session.id,
                        running: session.exitCode === undefined,
                        ...lastOutput(session, { maxChars: max_chars, maxLines: max_lines, outputMode: output_mode }),
                    }),
                }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to send input: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'stop_codex_session',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        description: 'Stop an interactive Codex session.',
        inputSchema: {
            session_id: z.string().describe('Session ID returned by start_codex_session.'),
            force: z.boolean().optional().default(false).describe('Kill the PTY immediately instead of sending Ctrl+C first.'),
        },
    },
    async ({ session_id, force }) => {
        const session = sessions.get(session_id);
        if (!session) {
            return { content: [{ type: 'text', text: `Unknown Codex session: ${session_id}` }], isError: true };
        }
        try {
            if (session.exitCode === undefined) {
                if (!force) session.process.write('\x03');
                session.process.kill();
            }
            sessions.delete(session_id);
            return { content: [{ type: 'text', text: `Stopped Codex session ${session_id}.` }] };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to stop Codex session: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

server.registerTool(
    'list_codex_sessions',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'List interactive Codex sessions currently tracked by this MCP process.',
        inputSchema: {},
    },
    async () => ({
        content: [{
            type: 'text',
            text: jsonText([...sessions.values()].map(session => ({
                sessionId: session.id,
                command: session.command,
                args: session.args,
                cwd: session.cwd,
                createdAt: session.createdAt,
                running: session.exitCode === undefined,
                exitCode: session.exitCode,
                exitSignal: session.exitSignal,
                bufferedChars: session.output.length,
            }))),
        }],
    }),
);

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Codex Terminal MCP server running on stdio');
}

process.on('exit', () => {
    for (const session of sessions.values()) {
        try { session.process.kill(); } catch { /* best effort */ }
    }
});

main().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
});
