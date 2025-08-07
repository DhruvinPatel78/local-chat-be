const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const wss = new WebSocket.Server({ port: 3001 });

// Store connected clients and their info
const clients = new Map();

function broadcastOnlineDevices() {
  const devices = Array.from(clients.values()).map(client => ({
    id: client.id,
    name: client.name,
    lastSeen: Date.now(),
    isOnline: true,
  }));
  const message = JSON.stringify({ type: 'online-devices', devices });
  for (const ws of clients.keys()) {
    ws.send(message);
  }
}

wss.on('connection', (ws) => {
  // Helper to register or update client info
  function registerOrUpdateClient(id, name) {
    if (!id) {
      id = uuidv4();
    }
    if (!name) {
      name = `User-${id.slice(0, 4)}`;
    }
    clients.set(ws, { id, name });
    broadcastOnlineDevices();
  }

  ws.on('message', (data) => {
    console.log('Received from client:', data);
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }
    if ((msg.type === 'init' || msg.type === 'update-name') && msg.id && msg.name) {
      registerOrUpdateClient(msg.id, msg.name);
    } else if (msg.type === 'message') {
      const client = clients.get(ws);
      if (client) {
        const chatMsg = {
          type: 'message',
          id: uuidv4(),
          senderId: client.id,
          senderName: client.name,
          content: msg.content,
          timestamp: Date.now(),
          receiverId: msg.receiverId || null,
        };
        const chatMsgStr = JSON.stringify(chatMsg);
        if (msg.receiverId) {
          // One-to-one: send only to receiver and sender
          for (const [wsClient, info] of clients.entries()) {
            if (info.id === msg.receiverId || info.id === client.id) {
              wsClient.send(chatMsgStr);
              console.log('Sent to client:', chatMsgStr);
            }
          }
        } else {
          // Broadcast: send to all
          for (const wsClient of clients.keys()) {
            wsClient.send(chatMsgStr);
            console.log('Sent to client:', chatMsgStr);
          }
        }
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastOnlineDevices();
  });
});

console.log('WebSocket server running on ws://localhost:3001');
