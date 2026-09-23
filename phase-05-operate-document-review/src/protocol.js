const { TextEncoder, TextDecoder } = require("node:util");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodePacket(header, payload = new Uint8Array(0)) {
  const headerBytes = encoder.encode(JSON.stringify(header));
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = Buffer.allocUnsafe(4 + headerBytes.length + payloadBytes.length);
  out.writeUInt32BE(headerBytes.length, 0);
  Buffer.from(headerBytes).copy(out, 4);
  Buffer.from(payloadBytes).copy(out, 4 + headerBytes.length);
  return out;
}

function decodePacket(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (data.length < 4) throw new Error("packet too short");
  const headerLength = data.readUInt32BE(0);
  if (headerLength > 64 * 1024) throw new Error("header too large");
  if (headerLength < 2 || 4 + headerLength > data.length) {
    throw new Error("invalid header length");
  }
  const header = JSON.parse(decoder.decode(data.subarray(4, 4 + headerLength)));
  const payload = new Uint8Array(data.subarray(4 + headerLength));
  return { header, payload };
}

module.exports = { encodePacket, decodePacket };
