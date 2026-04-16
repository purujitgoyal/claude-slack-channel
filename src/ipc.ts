/**
 * IPC Protocol Types, Codec, Server & Client
 *
 * Defines the message types for communication between client (dormant)
 * and connected (server) sessions over a Unix domain socket.
 * Messages are encoded as one JSON object per line (newline-delimited).
 *
 * IPCServer binds to a Unix socket, accepts client connections, and
 * manages a connection map (sessionId → { label, threadTs, socket }).
 *
 * IPCClient connects to the server, sends register, and resolves on ack.
 *
 * Schemas are defined with Zod; TypeScript types are derived via z.infer<>.
 */

import { existsSync, unlinkSync } from 'node:fs';
import type { Socket as BunSocket } from 'bun';
import { z } from 'zod';
import { buildPermissionBlocks, formatInputPreview, log } from './config.ts';

// ── Client → Connected (server) schemas ────────────────────────────

export const RegisterSchema = z.object({
  type: z.literal('register'),
  sessionId: z.string(),
  label: z.string(),
});

export const SendMessageSchema = z.object({
  type: z.literal('send_message'),
  requestId: z.string(),
  text: z.string(),
});

export const NewThreadSchema = z.object({
  type: z.literal('new_thread'),
  requestId: z.string(),
  text: z.string().optional(),
});

export const ReactSchema = z.object({
  type: z.literal('react'),
  requestId: z.string(),
  emoji: z.string(),
  eventTs: z.string(),
});

export const PermRequestSchema = z.object({
  type: z.literal('perm_request'),
  requestId: z.string(),
  toolName: z.string(),
  description: z.string(),
  inputPreview: z.string(),
});

export const UnregisterSchema = z.object({
  type: z.literal('unregister'),
});

// ── Connected (server) → Client schemas ────────────────────────────

export const RegisterAckSchema = z.object({
  type: z.literal('register_ack'),
  threadTs: z.string(),
});

export const SendAckSchema = z.object({
  type: z.literal('send_ack'),
  requestId: z.string(),
  ts: z.string(),
});

export const NewThreadAckSchema = z.object({
  type: z.literal('new_thread_ack'),
  requestId: z.string(),
  threadTs: z.string(),
});

export const ReactAckSchema = z.object({
  type: z.literal('react_ack'),
  requestId: z.string(),
});

export const PermResponseSchema = z.object({
  type: z.literal('perm_response'),
  requestId: z.string(),
  behavior: z.string(),
});

export const ShutdownSchema = z.object({
  type: z.literal('shutdown'),
});

export const ErrorSchema = z.object({
  type: z.literal('error'),
  requestId: z.string().optional(),
  message: z.string(),
});

// ── Discriminated unions ───────────────────────────────────────────

export const ClientMessageSchema = z.discriminatedUnion('type', [
  RegisterSchema,
  SendMessageSchema,
  NewThreadSchema,
  ReactSchema,
  PermRequestSchema,
  UnregisterSchema,
]);

export const ServerMessageSchema = z.discriminatedUnion('type', [
  RegisterAckSchema,
  SendAckSchema,
  NewThreadAckSchema,
  ReactAckSchema,
  PermResponseSchema,
  ShutdownSchema,
  ErrorSchema,
]);

export const IPCMessageSchema = z.union([
  ClientMessageSchema,
  ServerMessageSchema,
]);

// ── Derived TypeScript types ───────────────────────────────────────

export type RegisterMessage = z.infer<typeof RegisterSchema>;
export type SendMessageMessage = z.infer<typeof SendMessageSchema>;
export type NewThreadMessage = z.infer<typeof NewThreadSchema>;
export type ReactMessage = z.infer<typeof ReactSchema>;
export type PermRequestMessage = z.infer<typeof PermRequestSchema>;
export type UnregisterMessage = z.infer<typeof UnregisterSchema>;

export type RegisterAckMessage = z.infer<typeof RegisterAckSchema>;
export type SendAckMessage = z.infer<typeof SendAckSchema>;
export type NewThreadAckMessage = z.infer<typeof NewThreadAckSchema>;
export type ReactAckMessage = z.infer<typeof ReactAckSchema>;
export type PermResponseMessage = z.infer<typeof PermResponseSchema>;
export type ShutdownMessage = z.infer<typeof ShutdownSchema>;
export type ErrorMessage = z.infer<typeof ErrorSchema>;

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type IPCMessage = z.infer<typeof IPCMessageSchema>;

// ── Codec ───────────────────────────────────────────────────────────

/**
 * Encode a message as a newline-delimited JSON string.
 */
export function encode(msg: IPCMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Line-delimited JSON decoder.
 *
 * Accumulates raw bytes from socket data events and splits on newline
 * boundaries. Each complete line is parsed as JSON. Handles the classic
 * TCP framing problem: data events don't align with message boundaries,
 * and multi-byte UTF-8 characters may be split across chunks.
 */
export class LineBuffer {
  private chunks: Buffer[] = [];
  private totalLen = 0;

  /**
   * Feed a chunk of data from the socket. Returns an array of parsed
   * messages for each complete line found. Invalid JSON lines are
   * returned as `{ type: 'error', message: '...' }` instead of throwing.
   * Valid JSON that doesn't match any known message schema is also
   * returned as an error message.
   */
  feed(chunk: Buffer): IPCMessage[] {
    this.chunks.push(chunk);
    this.totalLen += chunk.length;

    // Combine all accumulated chunks into one buffer
    const buf = Buffer.concat(this.chunks, this.totalLen);

    // Find the last newline — everything after it is an incomplete line
    const lastNewline = buf.lastIndexOf(0x0a); // '\n'
    if (lastNewline === -1) {
      // No complete line yet — keep accumulating
      return [];
    }

    // Split: complete portion (up to and including last \n) vs remainder
    const complete = buf.subarray(0, lastNewline + 1);
    const remainder = buf.subarray(lastNewline + 1);

    // Store the remainder for next feed()
    if (remainder.length > 0) {
      this.chunks = [Buffer.from(remainder)];
      this.totalLen = remainder.length;
    } else {
      this.chunks = [];
      this.totalLen = 0;
    }

    // Decode the complete portion as UTF-8 and split into lines
    const text = complete.toString('utf-8');
    const lines = text.split('\n');
    const messages: IPCMessage[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      try {
        const parsed = JSON.parse(trimmed);
        const result = IPCMessageSchema.safeParse(parsed);
        if (result.success) {
          messages.push(result.data);
        } else {
          messages.push({
            type: 'error',
            message: `Validation failed: ${result.error.message}`,
          });
        }
      } catch {
        messages.push({
          type: 'error',
          message: `Invalid JSON: ${trimmed}`,
        });
      }
    }

    return messages;
  }
}

// ── IPCServer ──────────────────────────────────────────────────────────

/** Options for constructing an IPCServer */
export interface IPCServerOptions {
  socketPath: string;
  poster: (opts: {
    text: string;
    blocks?: any[];
    thread_ts?: string;
  }) => Promise<string | undefined>;
  messageUpdater: (
    channel: string,
    ts: string,
    text: string,
    blocks?: any[],
  ) => Promise<void>;
  reacter: (channel: string, emoji: string, ts: string) => Promise<void>;
  channelId: string;
}

/** Entry in the server's connection map */
export interface ClientEntry {
  label: string;
  threadTs: string;
  socket: BunSocket<SocketContext>;
}

/** Per-socket context attached by Bun */
interface SocketContext {
  lineBuffer: LineBuffer;
  sessionId?: string;
}

/** Entry in the permission routing map — tracks pending perm requests from clients */
export interface PermRouteEntry {
  sessionId: string;
  slackTs: string;
  timestamp: number;
  toolName: string;
  description: string;
  inputPreview: string;
}

/**
 * IPC Server — binds to a Unix domain socket, accepts client connections,
 * handles registration, and maintains a connection map.
 */
export class IPCServer {
  readonly clients: Map<string, ClientEntry> = new Map();
  readonly permRouting: Map<string, PermRouteEntry> = new Map();
  private listener: ReturnType<typeof Bun.listen> | null = null;
  private readonly opts: IPCServerOptions;

  constructor(opts: IPCServerOptions) {
    this.opts = opts;
  }

  /** Bind to the Unix socket. Unlinks stale socket files before binding. */
  async start(): Promise<void> {
    const { socketPath } = this.opts;

    // Clean up stale socket file
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // If unlink fails, the listen call below will throw
      }
    }

    this.listener = Bun.listen<SocketContext>({
      unix: socketPath,
      socket: {
        open: (socket) => {
          socket.data = { lineBuffer: new LineBuffer() };
        },
        data: (socket, data) => {
          this.handleData(socket, data as Buffer);
        },
        close: (socket) => {
          this.handleClose(socket);
        },
        error: (_socket, err) => {
          // Log but don't crash
          console.error('[IPCServer] socket error:', err);
        },
      },
    });
  }

  /** Handle incoming data from a client socket */
  private handleData(socket: BunSocket<SocketContext>, data: Buffer): void {
    const messages = socket.data.lineBuffer.feed(data);
    for (const msg of messages) {
      if (msg.type === 'register') {
        this.handleRegister(socket, msg as RegisterMessage).catch((err) =>
          log(`register handler error: ${err}`),
        );
      } else if (msg.type === 'send_message') {
        this.handleSendMessage(socket, msg as SendMessageMessage).catch((err) =>
          log(`send_message handler error: ${err}`),
        );
      } else if (msg.type === 'new_thread') {
        this.handleNewThread(socket, msg as NewThreadMessage).catch((err) =>
          log(`new_thread handler error: ${err}`),
        );
      } else if (msg.type === 'react') {
        this.handleReact(socket, msg as ReactMessage).catch((err) =>
          log(`react handler error: ${err}`),
        );
      } else if (msg.type === 'perm_request') {
        this.handlePermRequest(socket, msg as PermRequestMessage).catch((err) =>
          log(`perm_request handler error: ${err}`),
        );
      }
    }
  }

  /** Handle a register message: create thread header, store client, send ack */
  private async handleRegister(
    socket: BunSocket<SocketContext>,
    msg: RegisterMessage,
  ): Promise<void> {
    const { sessionId, label } = msg;

    try {
      const threadTs = await this.opts.poster({
        text: `\u{1F4E1} Session connected: ${label}`,
      });

      if (!threadTs) {
        const errMsg: ErrorMessage = {
          type: 'error',
          message: 'Failed to create thread header — poster returned no ts',
        };
        socket.write(encode(errMsg));
        return;
      }

      // Store in context for close handler
      socket.data.sessionId = sessionId;

      // Store in connection map
      this.clients.set(sessionId, { label, threadTs, socket });

      // Send ack
      const ack: RegisterAckMessage = {
        type: 'register_ack',
        threadTs,
      };
      socket.write(encode(ack));
    } catch (err) {
      const errMsg: ErrorMessage = {
        type: 'error',
        message: `Register failed: ${err}`,
      };
      socket.write(encode(errMsg));
    }
  }

  /** Handle a send_message request: post text in the client's thread, send ack */
  private async handleSendMessage(
    socket: BunSocket<SocketContext>,
    msg: SendMessageMessage,
  ): Promise<void> {
    const sessionId = socket.data.sessionId;
    const client = sessionId ? this.clients.get(sessionId) : undefined;

    if (!client) {
      const errMsg: ErrorMessage = {
        type: 'error',
        requestId: msg.requestId,
        message: 'Not registered',
      };
      socket.write(encode(errMsg));
      return;
    }

    try {
      const ts = await this.opts.poster({
        text: msg.text,
        thread_ts: client.threadTs,
      });

      const ack: SendAckMessage = {
        type: 'send_ack',
        requestId: msg.requestId,
        ts: ts ?? '',
      };
      socket.write(encode(ack));
    } catch (err) {
      const errMsg: ErrorMessage = {
        type: 'error',
        requestId: msg.requestId,
        message: `send_message failed: ${err}`,
      };
      socket.write(encode(errMsg));
    }
  }

  /** Handle a new_thread request: create a new thread for the client, send ack */
  private async handleNewThread(
    socket: BunSocket<SocketContext>,
    msg: NewThreadMessage,
  ): Promise<void> {
    const sessionId = socket.data.sessionId;
    const client = sessionId ? this.clients.get(sessionId) : undefined;

    if (!client) {
      const errMsg: ErrorMessage = {
        type: 'error',
        requestId: msg.requestId,
        message: 'Not registered',
      };
      socket.write(encode(errMsg));
      return;
    }

    try {
      // Create a new thread header for this client
      const threadTs = await this.opts.poster({
        text: msg.text ?? `📡 Session continued: ${client.label}`,
      });

      if (!threadTs) {
        const errMsg: ErrorMessage = {
          type: 'error',
          requestId: msg.requestId,
          message: 'Failed to create new thread — poster returned no ts',
        };
        socket.write(encode(errMsg));
        return;
      }

      // Update the client's threadTs in the connection map
      client.threadTs = threadTs;

      const ack: NewThreadAckMessage = {
        type: 'new_thread_ack',
        requestId: msg.requestId,
        threadTs,
      };
      socket.write(encode(ack));
    } catch (err) {
      const errMsg: ErrorMessage = {
        type: 'error',
        requestId: msg.requestId,
        message: `new_thread failed: ${err}`,
      };
      socket.write(encode(errMsg));
    }
  }

  /** Handle a react request: add an emoji reaction, send ack */
  private async handleReact(
    socket: BunSocket<SocketContext>,
    msg: ReactMessage,
  ): Promise<void> {
    const sessionId = socket.data.sessionId;
    if (!sessionId || !this.clients.has(sessionId)) {
      const errMsg: ErrorMessage = {
        type: 'error',
        requestId: msg.requestId,
        message: 'Not registered',
      };
      socket.write(encode(errMsg));
      return;
    }

    try {
      await this.opts.reacter(this.opts.channelId, msg.emoji, msg.eventTs);

      const ack: ReactAckMessage = {
        type: 'react_ack',
        requestId: msg.requestId,
      };
      socket.write(encode(ack));
    } catch (err) {
      const errMsg: ErrorMessage = {
        type: 'error',
        requestId: msg.requestId,
        message: `react failed: ${err}`,
      };
      socket.write(encode(errMsg));
    }
  }

  /** Handle a perm_request from a client: post buttons to client's thread, store in routing map */
  private async handlePermRequest(
    socket: BunSocket<SocketContext>,
    msg: PermRequestMessage,
  ): Promise<void> {
    const sessionId = socket.data.sessionId;
    const client = sessionId ? this.clients.get(sessionId) : undefined;

    if (!client || !sessionId) {
      log('perm_request from unregistered client — ignoring');
      return;
    }

    const { requestId, toolName, description, inputPreview } = msg;
    const preview = formatInputPreview(toolName, inputPreview);

    try {
      const slackTs = await this.opts.poster({
        text: `Claude wants to use \`${toolName}\` — tap Allow or Deny`,
        blocks: buildPermissionBlocks(
          requestId,
          toolName,
          description,
          preview,
        ),
        thread_ts: client.threadTs,
      });

      // Store in routing map for verdict routing (Task 8)
      this.permRouting.set(requestId, {
        sessionId,
        slackTs: slackTs ?? '',
        timestamp: Date.now(),
        toolName,
        description,
        inputPreview: preview,
      });

      log(
        `perm_request ${requestId} (${toolName}) posted to client ${sessionId}'s thread`,
      );
    } catch (err) {
      log(`perm_request ${requestId} failed: ${err}`);
    }
  }

  /** Handle client socket close: remove from connection map */
  private handleClose(socket: BunSocket<SocketContext>): void {
    const sessionId = socket.data?.sessionId;
    if (sessionId) {
      this.clients.delete(sessionId);
    }
  }

  /** Send a message to a specific client by sessionId */
  sendTo(sessionId: string, msg: ServerMessage): boolean {
    const entry = this.clients.get(sessionId);
    if (!entry) return false;
    try {
      entry.socket.write(encode(msg));
      return true;
    } catch (err) {
      log(`sendTo(${sessionId}) write failed: ${err}`);
      return false;
    }
  }

  /** Broadcast a shutdown message to all connected clients */
  broadcastShutdown(): void {
    const shutdownMsg: ShutdownMessage = { type: 'shutdown' };
    const encoded = encode(shutdownMsg);
    for (const entry of this.clients.values()) {
      try {
        entry.socket.write(encoded);
      } catch {
        // Client may already be disconnected
      }
    }
  }

  /** Close the server: broadcast shutdown, close all sockets, unlink file */
  async close(): Promise<void> {
    this.broadcastShutdown();

    // Give clients a moment to receive shutdown before closing sockets
    await new Promise((resolve) => setTimeout(resolve, 10));

    for (const entry of this.clients.values()) {
      try {
        entry.socket.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.permRouting.clear();

    if (this.listener) {
      this.listener.stop();
      this.listener = null;
    }

    // Unlink socket file
    const { socketPath } = this.opts;
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
  }
}

// ── IPCClient ──────────────────────────────────────────────────────────

/** Options for constructing an IPCClient */
export interface IPCClientOptions {
  socketPath: string;
  sessionId: string;
  label: string;
  onMessage?: (msg: ServerMessage) => void;
  onPermResponse?: (requestId: string, behavior: string) => void;
  onDisconnect?: () => void;
  connectTimeoutMs?: number;
}

/** Default timeout for IPC request/response round-trips (30 seconds). */
const IPC_REQUEST_TIMEOUT = 30_000;

/**
 * IPC Client — connects to a Unix domain socket, sends register,
 * and resolves when register_ack is received.
 *
 * Also provides request/response helpers (sendMessage, newThread,
 * addReaction) that generate a requestId, send a message, and return
 * a promise that resolves when a matching ack arrives from the server.
 */
export class IPCClient {
  private socket: BunSocket<{ lineBuffer: LineBuffer }> | null = null;
  private readonly opts: IPCClientOptions;
  private pending = new Map<
    string,
    { resolve: (msg: ServerMessage) => void; reject: (err: Error) => void }
  >();

  constructor(opts: IPCClientOptions) {
    this.opts = opts;
  }

  /**
   * Connect to the IPC server. Sends register and resolves with the
   * threadTs from the register_ack. Rejects on timeout or connection error.
   */
  connect(): Promise<string> {
    const timeoutMs = this.opts.connectTimeoutMs ?? 10_000;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn();
      };

      timer = setTimeout(() => {
        settle(() => reject(new Error('IPC connect timed out')));
      }, timeoutMs);

      Bun.connect<{ lineBuffer: LineBuffer }>({
        unix: this.opts.socketPath,
        socket: {
          open: (socket) => {
            socket.data = { lineBuffer: new LineBuffer() };
            this.socket = socket;

            // Send register
            const regMsg: RegisterMessage = {
              type: 'register',
              sessionId: this.opts.sessionId,
              label: this.opts.label,
            };
            socket.write(encode(regMsg));
          },
          data: (socket, data) => {
            const messages = socket.data.lineBuffer.feed(data as Buffer);
            for (const msg of messages) {
              // Check if this is a response to a pending request
              const reqId = (msg as any).requestId as string | undefined;
              if (reqId && this.pending.has(reqId)) {
                const entry = this.pending.get(reqId)!;
                this.pending.delete(reqId);
                if (msg.type === 'error') {
                  entry.reject(new Error((msg as ErrorMessage).message));
                } else {
                  entry.resolve(msg as ServerMessage);
                }
                continue;
              }

              // Dispatch perm_response to dedicated callback
              if (msg.type === 'perm_response') {
                const pr = msg as PermResponseMessage;
                this.opts.onPermResponse?.(pr.requestId, pr.behavior);
              }

              // Dispatch to onMessage callback
              this.opts.onMessage?.(msg as ServerMessage);

              if (msg.type === 'register_ack') {
                settle(() => resolve((msg as RegisterAckMessage).threadTs));
              }
            }
          },
          close: () => {
            this.socket = null;
            // Reject all pending requests
            for (const entry of this.pending.values()) {
              entry.reject(new Error('IPC connection closed'));
            }
            this.pending.clear();
            settle(() => reject(new Error('IPC connection closed before ack')));
            this.opts.onDisconnect?.();
          },
          error: (_socket, err) => {
            settle(() => reject(err));
          },
          connectError: (_socket, err) => {
            settle(() => reject(err));
          },
        },
      }).catch((err) => {
        settle(() => reject(err));
      });
    });
  }

  /** Send a client message to the server */
  send(msg: ClientMessage): void {
    if (!this.socket) {
      throw new Error('Not connected');
    }
    this.socket.write(encode(msg));
  }

  /**
   * Send a message via the connected session's Slack bridge.
   * Returns the Slack message `ts` from the ack.
   */
  async sendMessage(text: string): Promise<string> {
    const requestId = crypto.randomUUID();
    const ack = await this.request(requestId, {
      type: 'send_message',
      requestId,
      text,
    });
    return (ack as SendAckMessage).ts;
  }

  /**
   * Start a new thread via the connected session's Slack bridge.
   * Returns the new thread's `threadTs` from the ack.
   */
  async newThread(text?: string): Promise<string> {
    const requestId = crypto.randomUUID();
    const ack = await this.request(requestId, {
      type: 'new_thread',
      requestId,
      text,
    });
    return (ack as NewThreadAckMessage).threadTs;
  }

  /**
   * Add a reaction to a Slack message via the connected session's bridge.
   */
  async addReaction(emoji: string, eventTs: string): Promise<void> {
    const requestId = crypto.randomUUID();
    await this.request(requestId, {
      type: 'react',
      requestId,
      emoji,
      eventTs,
    });
  }

  /**
   * Send a permission request to the server. Fire-and-forget — no ack expected.
   * The response comes later as `perm_response` via the `onPermResponse` callback.
   */
  sendPermRequest(
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
  ): void {
    this.send({
      type: 'perm_request',
      requestId,
      toolName,
      description,
      inputPreview,
    });
  }

  /**
   * Send a client message and wait for a matching ack (by requestId).
   * Rejects after IPC_REQUEST_TIMEOUT if no ack arrives.
   */
  private request(
    requestId: string,
    msg: ClientMessage,
  ): Promise<ServerMessage> {
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('IPC request timed out'));
      }, IPC_REQUEST_TIMEOUT);

      this.pending.set(requestId, {
        resolve: (ack) => {
          clearTimeout(timer);
          resolve(ack);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.send(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  /** Close the client connection */
  close(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    // Reject all pending requests
    for (const entry of this.pending.values()) {
      entry.reject(new Error('IPC client closed'));
    }
    this.pending.clear();
  }
}
