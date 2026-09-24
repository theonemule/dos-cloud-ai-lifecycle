const crypto = require("node:crypto");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeId() {
  return crypto.randomBytes(18).toString("base64url");
}

function normalizeCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
}

function makeCode(length = 6) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function createMultiplayerService({ catalog, library, launch, logger, roomTtlMs = 2 * 60 * 60 * 1000 }) {
  const roomsById = new Map();
  const roomsByCode = new Map();
  const launchMembership = new Map();

  function activeMembers(room) {
    return [...room.members.values()];
  }

  function publicRoom(room) {
    return {
      id: room.id,
      code: room.code,
      gameId: room.gameId,
      expectedPlayers: room.expectedPlayers,
      maxPlayers: room.maxPlayers,
      players: room.members.size,
      expiresAt: room.expiresAt,
    };
  }

  function ensureIpxGame(gameId) {
    const manifest = catalog.get(gameId);
    if (!manifest.capabilities?.ipx || manifest.multiplayer?.transport !== "ipx") {
      throw httpError("this game does not have an IPX multiplayer launch profile", 409, "EIPXUNSUPPORTED");
    }
    return manifest;
  }

  async function requireInstalled(user, gameId) {
    if (!await library.getInstalled(user.id, gameId)) {
      throw httpError("game must be installed before joining multiplayer", 409, "ENOTINSTALLED");
    }
  }

  function uniqueCode() {
    for (let i = 0; i < 50; i++) {
      const code = makeCode();
      if (!roomsByCode.has(code)) return code;
    }
    throw new Error("unable to allocate multiplayer room code");
  }

  async function host(user, { gameId, players = 2 } = {}) {
    cleanup();
    const manifest = ensureIpxGame(gameId);
    await requireInstalled(user, gameId);
    const maxPlayers = Math.max(2, Number(manifest.capabilities?.maxPlayers || 2));
    const expectedPlayers = Number(players);
    if (!Number.isInteger(expectedPlayers) || expectedPlayers < 2 || expectedPlayers > maxPlayers) {
      throw httpError("players must be between 2 and " + maxPlayers, 400, "EPLAYERS");
    }

    const session = await launch.create(user, { mode: "game", gameId });
    const now = Date.now();
    const expiresAt = new Date(Math.min(Date.parse(session.expiresAt), now + roomTtlMs)).toISOString();
    const room = {
      id: makeId(),
      code: uniqueCode(),
      gameId,
      hostUserId: user.id,
      expectedPlayers,
      maxPlayers,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      nextPeerId: 2,
      members: new Map(),
    };
    const member = {
      userId: user.id,
      launchId: session.id,
      role: "host",
      peerId: 1,
      ws: null,
    };
    room.members.set(session.id, member);
    roomsById.set(room.id, room);
    roomsByCode.set(room.code, room);
    launchMembership.set(session.id, { roomId: room.id, member });

    logger.info("multiplayer_room_created", {
      roomId: room.id,
      roomCode: room.code,
      gameId,
      userId: user.id,
      expectedPlayers,
    });
    return { room: publicRoom(room), session };
  }

  async function join(user, { code } = {}) {
    cleanup();
    const normalized = normalizeCode(code);
    const room = roomsByCode.get(normalized);
    if (!room || Date.parse(room.expiresAt) <= Date.now()) {
      throw httpError("multiplayer room not found or expired", 404, "EROOMNOTFOUND");
    }
    if (room.members.size >= room.expectedPlayers) {
      throw httpError("multiplayer room is full", 409, "EROOMFULL");
    }
    ensureIpxGame(room.gameId);
    await requireInstalled(user, room.gameId);
    const session = await launch.create(user, { mode: "game", gameId: room.gameId });
    const member = {
      userId: user.id,
      launchId: session.id,
      role: "client",
      peerId: room.nextPeerId++,
      ws: null,
    };
    room.members.set(session.id, member);
    launchMembership.set(session.id, { roomId: room.id, member });
    logger.info("multiplayer_room_joined", {
      roomId: room.id,
      roomCode: room.code,
      gameId: room.gameId,
      userId: user.id,
      peerId: member.peerId,
    });
    return { room: publicRoom(room), session };
  }

  function getMembership(user, launchId) {
    cleanup();
    const found = launchMembership.get(launchId);
    if (!found) return null;
    const room = roomsById.get(found.roomId);
    if (!room || found.member.userId !== user.id) return null;
    return { room, member: found.member };
  }

  async function authorizeSocket(user, launchId) {
    await launch.getOwned(user, launchId);
    const found = getMembership(user, launchId);
    if (!found) throw httpError("launch session is not part of a multiplayer room", 403, "ENOTMULTIPLAYER");
    return found;
  }

  function decorateLaunchConfig(user, launchId, config) {
    const found = getMembership(user, launchId);
    if (!found) return config;
    const { room, member } = found;
    const manifest = catalog.get(room.gameId);
    const profile = manifest.multiplayer || {};
    const folderParts = ["\\GAMES", manifest.install.folder];
    if (profile.workingDirectory) folderParts.push(profile.workingDirectory);
    const command = profile.command || manifest.launch.command;
    const args = (profile.arguments || []).map(value => String(value)
      .replaceAll("{players}", String(room.expectedPlayers))
      .replaceAll("{code}", room.code));

    return {
      ...config,
      autoexec: [
        "mount c /remote/" + launchId,
        "c:",
        "cd " + folderParts.join("\\"),
        command + (args.length ? " " + args.join(" ") : ""),
      ],
      multiplayer: {
        transport: "websocket-ipx",
        roomId: room.id,
        code: room.code,
        role: member.role,
        peerId: member.peerId,
        hostPeerId: 1,
        expectedPlayers: room.expectedPlayers,
        maxPlayers: room.maxPlayers,
        instructions: profile.instructions || "Keep this window open while the multiplayer game is active.",
      },
    };
  }

  function sendControl(ws, payload) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  function attachSocket(user, launchId, ws) {
    const found = getMembership(user, launchId);
    if (!found) throw httpError("multiplayer membership not found", 403, "ENOTMULTIPLAYER");
    const { room, member } = found;
    if (member.ws && member.ws !== ws) {
      try { member.ws.close(1012, "replaced by a newer multiplayer connection"); } catch {}
    }
    member.ws = ws;

    const online = activeMembers(room).filter(next => next.ws && next.ws.readyState === next.ws.OPEN);
    const host = activeMembers(room).find(next => next.role === "host");
    sendControl(ws, {
      type: "welcome",
      peerId: member.peerId,
      hostPeerId: host?.peerId || 1,
      hostOnline: Boolean(host?.ws && host.ws.readyState === host.ws.OPEN),
      roomCode: room.code,
      role: member.role,
      peers: online.map(next => ({ peerId: next.peerId, role: next.role })),
    });

    for (const next of online) {
      if (next !== member) {
        sendControl(next.ws, { type: "peer-joined", peerId: member.peerId, role: member.role });
      }
    }
    logger.info("ipx_ws_connected", {
      roomId: room.id,
      roomCode: room.code,
      userId: user.id,
      launchId,
      peerId: member.peerId,
      role: member.role,
    });
    return { room, member };
  }

  function detachSocket(launchId, ws, code) {
    const found = launchMembership.get(launchId);
    if (!found) return;
    const room = roomsById.get(found.roomId);
    if (!room || found.member.ws !== ws) return;
    found.member.ws = null;
    for (const next of activeMembers(room)) {
      if (next !== found.member && next.ws) {
        sendControl(next.ws, { type: "peer-left", peerId: found.member.peerId, role: found.member.role });
      }
    }
    logger.info("ipx_ws_disconnected", {
      roomId: room.id,
      roomCode: room.code,
      launchId,
      peerId: found.member.peerId,
      role: found.member.role,
      code,
    });
  }

  function relay(launchId, targetPeerId, payload) {
    const found = launchMembership.get(launchId);
    if (!found) return false;
    const room = roomsById.get(found.roomId);
    if (!room) return false;
    const source = found.member;
    const target = activeMembers(room).find(member => member.peerId === targetPeerId);
    if (!target || target === source || !target.ws || target.ws.readyState !== target.ws.OPEN) return false;
    if (target.ws.bufferedAmount > 2 * 1024 * 1024) return false;
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(source.peerId >>> 0, 0);
    Buffer.from(payload).copy(frame, 4);
    target.ws.send(frame, { binary: true });
    logger.debug("ipx_frame_relayed", {
      roomId: room.id,
      sourcePeerId: source.peerId,
      targetPeerId,
      bytes: payload.length,
    });
    return true;
  }

  function cleanup() {
    const now = Date.now();
    for (const room of [...roomsById.values()]) {
      if (Date.parse(room.expiresAt) > now) continue;
      for (const member of room.members.values()) {
        launchMembership.delete(member.launchId);
        if (member.ws) {
          try { member.ws.close(1008, "multiplayer room expired"); } catch {}
        }
      }
      roomsById.delete(room.id);
      roomsByCode.delete(room.code);
      logger.info("multiplayer_room_expired", { roomId: room.id, roomCode: room.code });
    }
  }

  function close() {
    for (const room of roomsById.values()) {
      for (const member of room.members.values()) {
        if (member.ws) {
          try { member.ws.terminate(); } catch {}
        }
      }
    }
    roomsById.clear();
    roomsByCode.clear();
    launchMembership.clear();
  }

  return {
    host,
    join,
    getMembership,
    authorizeSocket,
    decorateLaunchConfig,
    attachSocket,
    detachSocket,
    relay,
    cleanup,
    close,
    normalizeCode,
  };
}

module.exports = { createMultiplayerService, normalizeCode };
