function handleIpxUpgrade({ req, socket, head, user, launchId, webSocketServer, multiplayer }) {
  return multiplayer.authorizeSocket(user, launchId).then(() => {
    webSocketServer.handleUpgrade(req, socket, head, ws => {
      let attached;
      try {
        attached = multiplayer.attachSocket(user, launchId, ws);
      } catch {
        try { ws.close(1008, "multiplayer WebSocket rejected"); } catch {}
        return;
      }

      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          try { ws.close(1003, "binary IPX frames required"); } catch {}
          return;
        }
        const frame = Buffer.from(data);
        if (frame.length < 5 || frame.length > 64 * 1024 + 4) {
          try { ws.close(1009, "invalid IPX relay frame"); } catch {}
          return;
        }
        const targetPeerId = frame.readUInt32BE(0);
        if (!targetPeerId || targetPeerId === attached.member.peerId) return;
        multiplayer.relay(launchId, targetPeerId, frame.subarray(4));
      });

      ws.on("close", code => multiplayer.detachSocket(launchId, ws, code));
    });
  });
}

module.exports = { handleIpxUpgrade };
