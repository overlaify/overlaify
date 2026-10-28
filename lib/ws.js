// Just enough WebSocket server for `overlaify dev`: the SDK in OBS connects to /api/live/:room and receives
// action keys as text frames, the same protocol as the hosted LiveRoom. No dependencies, text frames only.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Completes the handshake for an HTTP 'upgrade' request. Returns a socket wrapper, or null if it isn't a WebSocket. */
export function acceptWebSocket(req, socket, { onMessage, onClose }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);

  let buf = Buffer.alloc(0);
  let closed = false;
  const ws = {
    send(text) { if (!closed) socket.write(frame(0x1, Buffer.from(text))); },
    close() { if (!closed) { socket.write(frame(0x8, Buffer.alloc(0))); socket.end(); } }
  };
  const done = () => { if (!closed) { closed = true; onClose(ws); } };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = parse(buf);
      if (!f) break;
      buf = buf.subarray(f.length);
      if (f.opcode === 0x1) onMessage(ws, f.payload.toString('utf8'));
      else if (f.opcode === 0x9) socket.write(frame(0xA, f.payload));
      else if (f.opcode === 0x8) { ws.close(); done(); return; }
    }
  });
  socket.on('close', done);
  socket.on('error', done);
  return ws;
}

// One complete frame at the start of buf: { opcode, payload, length }, or null if more bytes are needed.
// Client frames are always masked. Fragmented messages aren't supported; the SDK never sends them.
function parse(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const mask = masked ? buf.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, length: at + len };
}

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), bigLen(len)]);
  return Buffer.concat([head, payload]);
}

function bigLen(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
