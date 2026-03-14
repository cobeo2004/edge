// src/server/core/WebSocketFrameCodec.ts

export enum WebSocketOpcode {
  CONTINUATION = 0x0,
  TEXT = 0x1,
  BINARY = 0x2,
  CLOSE = 0x8,
  PING = 0x9,
  PONG = 0xa,
}

export interface WebSocketFrame {
  fin: boolean;
  opcode: WebSocketOpcode;
  masked: boolean;
  payload: Buffer;
  totalLength: number;
}

/**
 * Parse a single WebSocket frame from a buffer.
 * Returns null if the buffer does not contain a complete frame.
 */
export function parseFrame(data: Buffer): WebSocketFrame | null {
  if (data.length < 2) return null;

  const byte0 = data[0];
  const byte1 = data[1];
  if (byte0 === undefined || byte1 === undefined) return null;

  const fin = (byte0 & 0x80) !== 0;
  const opcode = (byte0 & 0x0f) as WebSocketOpcode;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLength = byte1 & 0x7f;

  let offset = 2;

  if (payloadLength === 126) {
    if (data.length < 4) return null;
    payloadLength = data.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (data.length < 10) return null;
    const len64 = data.readBigUInt64BE(2);
    payloadLength = Number(len64);
    offset = 10;
  }

  let maskKey: Buffer | null = null;
  if (masked) {
    if (data.length < offset + 4) return null;
    maskKey = data.subarray(offset, offset + 4);
    offset += 4;
  }

  if (data.length < offset + payloadLength) return null;

  const payload = Buffer.alloc(payloadLength);
  data.copy(payload, 0, offset, offset + payloadLength);

  if (masked && maskKey) {
    for (let i = 0; i < payloadLength; i++) {
      payload[i]! ^= maskKey[i % 4]!;
    }
  }

  return {
    fin,
    opcode,
    masked,
    payload,
    totalLength: offset + payloadLength,
  };
}

/**
 * Write an unmasked WebSocket frame.
 */
export function writeFrame(
  opcode: WebSocketOpcode,
  payload: Buffer,
  fin = true,
): Buffer {
  const finBit = fin ? 0x80 : 0x00;
  const byte0 = finBit | opcode;

  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = byte0;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = byte0;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = byte0;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Build a close frame payload with status code and optional reason.
 */
export function buildClosePayload(code: number, reason?: string): Buffer {
  const reasonBuf = reason ? Buffer.from(reason, "utf-8") : Buffer.alloc(0);
  const buf = Buffer.alloc(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

/**
 * Parse a close frame payload. Returns code 1005 if payload is < 2 bytes.
 */
export function parseClosePayload(payload: Buffer): {
  code: number;
  reason: string;
} {
  if (payload.length < 2) {
    return { code: 1005, reason: "" };
  }
  const code = payload.readUInt16BE(0);
  const reason = payload.subarray(2).toString("utf-8");
  return { code, reason };
}
