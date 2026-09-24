const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

class DriveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class DriveStore {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.handles = new Map();
    this.nextHandle = 1;
  }

  resolve(dosPath = "", { allowMissingLast = false } = {}) {
    const normalized = String(dosPath)
      .replace(/^[A-Za-z]:/, "")
      .replaceAll("\\", "/")
      .replace(/^\/+/, "");

    const pieces = normalized.split("/").filter(Boolean);
    if (pieces.some((part) => part === ".." || part === ".")) {
      throw new DriveError("EINVAL", "relative path segments are not allowed");
    }

    let current = this.root;
    for (let i = 0; i < pieces.length; i++) {
      const requested = pieces[i];
      let actual = requested;

      try {
        const entries = fs.readdirSync(current);
        const exact = entries.find((entry) => entry === requested);
        const folded = exact ?? entries.find(
          (entry) => entry.toLocaleLowerCase("en-US") === requested.toLocaleLowerCase("en-US")
        );
        if (folded) actual = folded;
        else if (!(allowMissingLast && i === pieces.length - 1)) {
          actual = requested;
        }
      } catch {
        // The normal filesystem operation below will return the appropriate
        // ENOENT/ENOTDIR. Keep path validation centralized here.
      }

      current = path.resolve(current, actual);
      if (current !== this.root && !current.startsWith(this.root + path.sep)) {
        throw new DriveError("EACCES", "path escapes drive root");
      }
    }

    return current;
  }

  async dispatch(op, args, payload) {
    switch (op) {
      case "open": return this.open(args.path, args.flags);
      case "close": return this.close(args.handle);
      case "read": return this.read(args.handle, args.length, args.position);
      case "write": return this.write(args.handle, payload, args.position);
      case "flush": return this.flush(args.handle);
      case "seek": return this.seek(args.handle, args.offset, args.whence);
      case "stat": return this.stat(args.path);
      case "list": return this.list(args.path);
      case "mkdir": return this.mkdir(args.path);
      case "create": return this.create(args.path);
      case "truncate": return this.truncate(args.path, args.size);
      case "unlink": return this.unlink(args.path);
      case "rmdir": return this.rmdir(args.path);
      case "rename": return this.rename(args.oldPath, args.newPath);
      default: throw new DriveError("ENOSYS", `unsupported operation: ${op}`);
    }
  }

  getHandle(id) {
    const h = this.handles.get(Number(id));
    if (!h) throw new DriveError("EBADF", `invalid handle: ${id}`);
    return h;
  }

  async open(dosPath, flags = "r") {
    const numeric = typeof flags === "number";
    const creates = numeric
      ? Boolean(flags & fs.constants.O_CREAT)
      : /^[wax]/.test(flags) || flags.startsWith("a");

    const full = this.resolve(dosPath, { allowMissingLast: creates });
    if (creates) await fsp.mkdir(path.dirname(full), { recursive: true });

    const file = await fsp.open(full, flags);
    const stat = await file.stat();
    const append = numeric
      ? Boolean(flags & fs.constants.O_APPEND)
      : flags.startsWith("a");

    const h = { file, position: append ? stat.size : 0 };
    const handle = this.nextHandle++;
    this.handles.set(handle, h);
    return { handle, position: h.position, size: stat.size };
  }

  async close(id) {
    const h = this.getHandle(id);
    await h.file.close();
    this.handles.delete(Number(id));
    return {};
  }

  async read(id, length, explicitPosition) {
    const h = this.getHandle(id);
    const size = Math.max(0, Math.min(Number(length) || 0, 1024 * 1024));
    const buffer = Buffer.alloc(size);
    const position = explicitPosition === undefined || explicitPosition === null
      ? h.position
      : Number(explicitPosition);

    const result = await h.file.read(buffer, 0, size, position);
    h.position = position + result.bytesRead;
    return {
      header: { bytesRead: result.bytesRead, position: h.position },
      payload: buffer.subarray(0, result.bytesRead),
    };
  }

  async write(id, payload, explicitPosition) {
    const h = this.getHandle(id);
    const data = Buffer.from(payload);
    const position = explicitPosition === undefined || explicitPosition === null
      ? h.position
      : Number(explicitPosition);

    const result = await h.file.write(data, 0, data.length, position);
    h.position = position + result.bytesWritten;
    return { bytesWritten: result.bytesWritten, position: h.position };
  }

  async flush(id) {
    const h = this.getHandle(id);
    await h.file.sync();
    return {};
  }

  async seek(id, offset, whence = 0) {
    const h = this.getHandle(id);
    const off = Number(offset) || 0;
    let next;
    if (Number(whence) === 0) next = off;
    else if (Number(whence) === 1) next = h.position + off;
    else if (Number(whence) === 2) next = (await h.file.stat()).size + off;
    else throw new DriveError("EINVAL", `invalid whence: ${whence}`);
    if (next < 0) throw new DriveError("EINVAL", "negative seek");
    h.position = next;
    return { position: next };
  }

  async stat(dosPath) {
    const s = await fsp.stat(this.resolve(dosPath));
    return {
      size: s.size,
      directory: s.isDirectory(),
      file: s.isFile(),
      mtimeMs: s.mtimeMs,
    };
  }

  async list(dosPath = "") {
    const full = this.resolve(dosPath);
    const entries = await fsp.readdir(full, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (entry) => {
      const s = await fsp.stat(path.join(full, entry.name));
      return {
        name: entry.name,
        directory: entry.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    }));
    return { entries: out };
  }

  async mkdir(dosPath) {
    await fsp.mkdir(this.resolve(dosPath, { allowMissingLast: true }), { recursive: false });
    return {};
  }

  async create(dosPath) {
    const full = this.resolve(dosPath, { allowMissingLast: true });
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const handle = await fsp.open(full, fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o666);
    await handle.close();
    return {};
  }

  async truncate(dosPath, size = 0) {
    await fsp.truncate(this.resolve(dosPath), Math.max(0, Number(size) || 0));
    return {};
  }

  async unlink(dosPath) {
    await fsp.unlink(this.resolve(dosPath));
    return {};
  }

  async rmdir(dosPath) {
    await fsp.rmdir(this.resolve(dosPath));
    return {};
  }

  async rename(oldPath, newPath) {
    const from = this.resolve(oldPath);
    const to = this.resolve(newPath, { allowMissingLast: true });
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    return {};
  }

  async closeAll() {
    const closes = [];
    for (const h of this.handles.values()) closes.push(h.file.close().catch(() => {}));
    this.handles.clear();
    await Promise.all(closes);
  }
}

module.exports = { DriveStore, DriveError };
