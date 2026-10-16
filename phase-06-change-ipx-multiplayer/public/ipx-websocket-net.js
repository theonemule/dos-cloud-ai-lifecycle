(function () {
  function dispatchStatus(detail) {
    window.dispatchEvent(new CustomEvent("doscloud-ipx-status", { detail }));
  }

  window.createIpxWebSocketNet = function createIpxWebSocketNet(multiplayer, launchId) {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const url = protocol + "//" + location.host + "/ws/ipx?launch=" + encodeURIComponent(launchId);
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      const inbox = [];
      const connected = new Set();
      const hostWaiters = [];
      const roomReadyWaiters = [];
      let roomReady = false;
      let peerId = 0;
      let hostPeerId = Number(multiplayer.hostPeerId || 1);
      let hostOnline = multiplayer.role === "host";
      let settled = false;

      function resolveHostWaiters() {
        if (!hostOnline || !hostPeerId) return;
        while (hostWaiters.length) {
          hostWaiters.shift()([{ alias: "host", peerId: hostPeerId }]);
        }
      }

      function markRoomReady(detail = {}) {
        if (roomReady) return;
        roomReady = true;
        while (roomReadyWaiters.length) roomReadyWaiters.shift()();
        dispatchStatus({
          state: "room-ready",
          roomCode: multiplayer.code,
          expectedPlayers: multiplayer.expectedPlayers,
          ...detail,
        });
      }

      const net = {
        get peerId() { return peerId; },
        connected,
        get roomReady() { return roomReady; },
        waitForRoomReady() {
          if (roomReady) return Promise.resolve();
          return new Promise(resolveReady => roomReadyWaiters.push(resolveReady));
        },
        wait() {},
        registerAlias() { return Promise.resolve(); },
        unregisterAlias() {},
        queryAliases(query) {
          if (query !== "=host") return Promise.resolve([]);
          if (hostOnline && hostPeerId) {
            return Promise.resolve([{ alias: "host", peerId: hostPeerId }]);
          }
          return new Promise(resolveAlias => hostWaiters.push(resolveAlias));
        },
        sendBinary(data, targetPeerId) {
          if (ws.readyState !== WebSocket.OPEN) return 0;
          if (!targetPeerId || targetPeerId === peerId) return 0;
          if (ws.bufferedAmount > 2 * 1024 * 1024) return 0;
          const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
          const frame = new Uint8Array(payload.length + 4);
          new DataView(frame.buffer).setUint32(0, Number(targetPeerId), false);
          frame.set(payload, 4);
          ws.send(frame);
          connected.add(Number(targetPeerId));
          return payload.length || 1;
        },
        recvBinary() {
          return inbox.shift() || null;
        },
        disconnect(targetPeerId) {
          connected.delete(Number(targetPeerId));
        },
        shutdown() {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, "DOS runtime closed");
          }
        },
      };

      ws.addEventListener("message", event => {
        if (typeof event.data === "string") {
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === "welcome") {
            peerId = Number(message.peerId);
            hostPeerId = Number(message.hostPeerId || 1);
            hostOnline = Boolean(message.hostOnline) || message.role === "host";
            for (const peer of message.peers || []) {
              if (Number(peer.peerId) !== peerId) connected.add(Number(peer.peerId));
              if (peer.role === "host") hostOnline = true;
            }
            resolveHostWaiters();
            if (message.roomReady) markRoomReady({ connectedPlayers: (message.peers || []).length });
            dispatchStatus({ state: "connected", peerId, roomCode: message.roomCode, role: message.role });
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(net);
            }
          } else if (message.type === "peer-joined") {
            const id = Number(message.peerId);
            if (id && id !== peerId) connected.add(id);
            if (message.role === "host") {
              hostPeerId = id;
              hostOnline = true;
              resolveHostWaiters();
            }
            dispatchStatus({ state: "peer-joined", peerId: id, role: message.role });
          } else if (message.type === "room-ready") {
            markRoomReady({
              connectedPlayers: Number(message.connectedPlayers || multiplayer.expectedPlayers),
            });
          } else if (message.type === "peer-left") {
            const id = Number(message.peerId);
            connected.delete(id);
            if (message.role === "host" || id === hostPeerId) hostOnline = false;
            dispatchStatus({ state: "peer-left", peerId: id, role: message.role });
          }
          return;
        }

        const frame = new Uint8Array(event.data);
        if (frame.length < 5) return;
        const sourcePeerId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
        const payload = frame.slice(4);
        connected.add(sourcePeerId);
        inbox.push({ data: payload, peerId: sourcePeerId });
      });

      ws.addEventListener("close", event => {
        connected.clear();
        hostOnline = false;
        dispatchStatus({ state: "disconnected", code: event.code, reason: event.reason || "" });
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("IPX WebSocket closed before the room was ready"));
        }
      });

      ws.addEventListener("error", () => {
        dispatchStatus({ state: "error" });
      });

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error("Timed out connecting to the multiplayer IPX relay"));
      }, 10000);
    });
  };
})();
