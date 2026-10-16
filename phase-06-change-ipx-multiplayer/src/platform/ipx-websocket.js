const MAX_CONTROL_BYTES = 256;

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
          // The only client-originated control message is the host announcing that
          // its emulator's IPX server is accepting registrations. Everything else
          // on the text channel is a protocol violation.
          const text = Buffer.from(data);
          let message = null;
          if (text.length <= MAX_CONTROL_BYTES) {
            try { message = JSON.parse(text.toString("utf8")); } catch {}
          }
          if (message && message.type === "ipx-server-ready") {
            multiplayer.markHostReady(launchId, ws);
            return;
          }
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
