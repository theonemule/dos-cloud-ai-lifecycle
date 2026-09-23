(() => {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function encodePacket(header, payload = new Uint8Array(0)) {
    const h = textEncoder.encode(JSON.stringify(header));
    const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const out = new Uint8Array(4 + h.length + p.length);
    new DataView(out.buffer).setUint32(0, h.length, false);
    out.set(h, 4);
    out.set(p, 4 + h.length);
    return out;
  }

  function decodePacket(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
    const header = JSON.parse(textDecoder.decode(data.subarray(4, 4 + headerLength)));
    return { header, payload: data.subarray(4 + headerLength) };
  }

  class RemoteDriveClient {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.nextId = 1;
      this.pending = new Map();
    }

    connect() {
      if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(this.url);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => { this.ws = ws; resolve(); };
        ws.onerror = reject;
        ws.onmessage = (event) => {
          const { header, payload } = decodePacket(event.data);
          const p = this.pending.get(header.id);
          if (!p) return;
          this.pending.delete(header.id);
          if (header.ok) p.resolve({ header, payload });
          else {
            const err = new Error(header.error || "remote drive error");
            err.code = header.code;
            p.reject(err);
          }
        };
        ws.onclose = () => {
          for (const p of this.pending.values()) p.reject(new Error("remote drive disconnected"));
          this.pending.clear();
        };
      });
    }

    request(op, args = {}, payload = new Uint8Array(0)) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("remote drive is not connected"));
      }
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(encodePacket({ id, op, ...args }, payload));
      });
    }

    async open(path, flags = "r") { return (await this.request("open", { path, flags })).header; }
    async close(handle) { return (await this.request("close", { handle })).header; }
    async read(handle, length) { return await this.request("read", { handle, length }); }
    async write(handle, bytes) { return (await this.request("write", { handle }, bytes)).header; }
    async seek(handle, offset, whence = 0) { return (await this.request("seek", { handle, offset, whence })).header; }
    async stat(path) { return (await this.request("stat", { path })).header; }
    async list(path = "") { return (await this.request("list", { path })).header.entries; }
    async mkdir(path) { return (await this.request("mkdir", { path })).header; }
    async unlink(path) { return (await this.request("unlink", { path })).header; }
    async rmdir(path) { return (await this.request("rmdir", { path })).header; }
    async rename(oldPath, newPath) { return (await this.request("rename", { oldPath, newPath })).header; }
  }

  window.RemoteDriveClient = RemoteDriveClient;
})();
