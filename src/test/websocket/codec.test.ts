import { describe, expect, it } from "vitest";
import {
  WebSocketOpcode,
  parseFrame,
  writeFrame,
  buildClosePayload,
  parseClosePayload,
} from "../../server/core/WebSocketFrameCodec";

describe("WebSocketFrameCodec", () => {
  describe("parseFrame", () => {
    it("should parse an unmasked text frame", () => {
      // FIN=1, opcode=0x1 (text), mask=0, payload_len=5, payload="Hello"
      const buf = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.fin).toBe(true);
      expect(frame!.opcode).toBe(WebSocketOpcode.TEXT);
      expect(frame!.masked).toBe(false);
      expect(frame!.payload.toString()).toBe("Hello");
      expect(frame!.totalLength).toBe(7);
    });

    it("should parse a masked text frame", () => {
      // FIN=1, opcode=0x1, mask=1, payload_len=5
      const maskKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
      const payload = Buffer.from("Hello");
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ maskKey[i % 4];
      }
      const buf = Buffer.concat([
        Buffer.from([0x81, 0x85]), // FIN + TEXT, MASK + len=5
        maskKey,
        masked,
      ]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.fin).toBe(true);
      expect(frame!.opcode).toBe(WebSocketOpcode.TEXT);
      expect(frame!.masked).toBe(true);
      expect(frame!.payload.toString()).toBe("Hello");
      expect(frame!.totalLength).toBe(11);
    });

    it("should parse a binary frame", () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const buf = Buffer.concat([Buffer.from([0x82, 0x03]), payload]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.opcode).toBe(WebSocketOpcode.BINARY);
      expect(frame!.payload).toEqual(payload);
    });

    it("should parse a close frame with code and reason", () => {
      const code = 1000;
      const reason = "Normal";
      const codeBuf = Buffer.alloc(2);
      codeBuf.writeUInt16BE(code, 0);
      const reasonBuf = Buffer.from(reason);
      const payload = Buffer.concat([codeBuf, reasonBuf]);
      const buf = Buffer.concat([
        Buffer.from([0x88, payload.length]),
        payload,
      ]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.opcode).toBe(WebSocketOpcode.CLOSE);
      expect(frame!.payload).toEqual(payload);
    });

    it("should parse a ping frame", () => {
      const payload = Buffer.from("ping");
      const buf = Buffer.concat([Buffer.from([0x89, 0x04]), payload]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.opcode).toBe(WebSocketOpcode.PING);
      expect(frame!.payload.toString()).toBe("ping");
    });

    it("should parse a pong frame", () => {
      const payload = Buffer.from("pong");
      const buf = Buffer.concat([Buffer.from([0x8a, 0x04]), payload]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.opcode).toBe(WebSocketOpcode.PONG);
      expect(frame!.payload.toString()).toBe("pong");
    });

    it("should parse a frame with 16-bit extended length", () => {
      // payload_len=126 means next 2 bytes are the real length
      const payload = Buffer.alloc(300, 0x41); // 300 bytes of 'A'
      const header = Buffer.alloc(4);
      header[0] = 0x82; // FIN + BINARY
      header[1] = 126; // 16-bit extended
      header.writeUInt16BE(300, 2);
      const buf = Buffer.concat([header, payload]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.payload.length).toBe(300);
      expect(frame!.totalLength).toBe(4 + 300);
    });

    it("should parse a frame with 64-bit extended length", () => {
      // payload_len=127 means next 8 bytes are the real length
      const payload = Buffer.alloc(70000, 0x42); // 70000 bytes of 'B'
      const header = Buffer.alloc(10);
      header[0] = 0x82; // FIN + BINARY
      header[1] = 127; // 64-bit extended
      header.writeBigUInt64BE(BigInt(70000), 2);
      const buf = Buffer.concat([header, payload]);
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.payload.length).toBe(70000);
      expect(frame!.totalLength).toBe(10 + 70000);
    });

    it("should return null for incomplete data", () => {
      // Only 1 byte — not enough for even the header
      expect(parseFrame(Buffer.from([0x81]))).toBeNull();
      // Header says 5 bytes payload but only 2 provided
      expect(parseFrame(Buffer.from([0x81, 0x05, 0x48, 0x65]))).toBeNull();
    });

    it("should parse a zero-length payload frame", () => {
      const buf = Buffer.from([0x81, 0x00]); // FIN + TEXT, len=0
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.payload.length).toBe(0);
      expect(frame!.totalLength).toBe(2);
    });

    it("should parse a non-final (fragmented) frame with FIN=0", () => {
      // FIN=0, opcode=0x1 (text)
      const buf = Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c]); // "Hel"
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.fin).toBe(false);
      expect(frame!.opcode).toBe(WebSocketOpcode.TEXT);
      expect(frame!.payload.toString()).toBe("Hel");
    });

    it("should parse a continuation frame (opcode=0x0)", () => {
      // FIN=1, opcode=0x0 (continuation)
      const buf = Buffer.from([0x80, 0x02, 0x6c, 0x6f]); // "lo"
      const frame = parseFrame(buf);
      expect(frame).not.toBeNull();
      expect(frame!.fin).toBe(true);
      expect(frame!.opcode).toBe(WebSocketOpcode.CONTINUATION);
      expect(frame!.payload.toString()).toBe("lo");
    });
  });

  describe("writeFrame", () => {
    it("should write an unmasked text frame", () => {
      const payload = Buffer.from("Hello");
      const buf = writeFrame(WebSocketOpcode.TEXT, payload);
      expect(buf[0]).toBe(0x81); // FIN + TEXT
      expect(buf[1]).toBe(5); // length, no mask
      expect(buf.subarray(2).toString()).toBe("Hello");
    });

    it("should write a non-final frame when fin=false", () => {
      const payload = Buffer.from("Hel");
      const buf = writeFrame(WebSocketOpcode.TEXT, payload, false);
      expect(buf[0]).toBe(0x01); // no FIN + TEXT
      expect(buf[1]).toBe(3);
      expect(buf.subarray(2).toString()).toBe("Hel");
    });

    it("should write a close frame with code", () => {
      const closePayload = buildClosePayload(1000, "bye");
      const buf = writeFrame(WebSocketOpcode.CLOSE, closePayload);
      expect(buf[0]).toBe(0x88); // FIN + CLOSE
      const payloadLen = buf[1];
      expect(payloadLen).toBe(5); // 2 bytes code + 3 bytes "bye"
    });

    it("should write a ping frame", () => {
      const payload = Buffer.from("ping");
      const buf = writeFrame(WebSocketOpcode.PING, payload);
      expect(buf[0]).toBe(0x89); // FIN + PING
      expect(buf[1]).toBe(4);
    });

    it("should write a frame with 16-bit extended length", () => {
      const payload = Buffer.alloc(300, 0x41);
      const buf = writeFrame(WebSocketOpcode.BINARY, payload);
      expect(buf[0]).toBe(0x82); // FIN + BINARY
      expect(buf[1]).toBe(126); // 16-bit marker
      expect(buf.readUInt16BE(2)).toBe(300);
      expect(buf.length).toBe(4 + 300);
    });

    it("should write a frame with 64-bit extended length", () => {
      const payload = Buffer.alloc(70000, 0x42);
      const buf = writeFrame(WebSocketOpcode.BINARY, payload);
      expect(buf[0]).toBe(0x82); // FIN + BINARY
      expect(buf[1]).toBe(127); // 64-bit marker
      expect(buf.readBigUInt64BE(2)).toBe(BigInt(70000));
      expect(buf.length).toBe(10 + 70000);
    });
  });

  describe("buildClosePayload / parseClosePayload", () => {
    it("should round-trip code and reason", () => {
      const payload = buildClosePayload(1001, "Going away");
      const { code, reason } = parseClosePayload(payload);
      expect(code).toBe(1001);
      expect(reason).toBe("Going away");
    });

    it("should handle code without reason", () => {
      const payload = buildClosePayload(1000);
      const { code, reason } = parseClosePayload(payload);
      expect(code).toBe(1000);
      expect(reason).toBe("");
    });

    it("should return 1005 for empty payload", () => {
      const { code, reason } = parseClosePayload(Buffer.alloc(0));
      expect(code).toBe(1005);
      expect(reason).toBe("");
    });

    it("should return 1005 for payload less than 2 bytes", () => {
      const { code, reason } = parseClosePayload(Buffer.from([0x01]));
      expect(code).toBe(1005);
      expect(reason).toBe("");
    });

    it("should handle various close codes", () => {
      for (const testCode of [1000, 1001, 1002, 1003, 1006, 1007, 1008, 1009, 1010, 1011]) {
        const payload = buildClosePayload(testCode);
        const { code } = parseClosePayload(payload);
        expect(code).toBe(testCode);
      }
    });
  });
});
