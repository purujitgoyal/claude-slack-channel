/**
 * IPC Protocol Types & Line-Delimited JSON Codec
 *
 * Defines the message types for communication between client (dormant)
 * and connected (server) sessions over a Unix domain socket.
 * Messages are encoded as one JSON object per line (newline-delimited).
 *
 * Schemas are defined with Zod; TypeScript types are derived via z.infer<>.
 */

import { z } from 'zod';

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
