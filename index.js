const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3001;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Create HTTP server
const server = http.createServer((req, res) => {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Handle file uploads
  if (req.method === 'POST' && req.url === '/upload') {
    upload.single('file')(req, res, (err) => {
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      
      if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file uploaded' }));
        return;
      }

      const fileInfo = {
        id: uuidv4(),
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        path: req.file.path
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fileInfo));
    });
    return;
  }

  // Handle file downloads
  if (req.method === 'GET' && req.url.startsWith('/files/')) {
    const filename = req.url.replace('/files/', '');
    const filepath = path.join(uploadsDir, filename);
    
    if (fs.existsSync(filepath)) {
      const stat = fs.statSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      fs.createReadStream(filepath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

// Store connected clients and their info
const clients = new Map();
const HEARTBEAT_INTERVAL_MS = 5000;

function broadcastOnlineDevices() {
  const devices = Array.from(clients.values()).map(client => ({
    id: client.id,
    name: client.name,
    lastSeen: Date.now(),
    isOnline: true,
  }));
  
  console.log('Broadcasting online devices to', clients.size, 'clients:', devices);
  
  // Only broadcast if we have devices
  if (devices.length > 0) {
    const message = JSON.stringify({ type: 'online-devices', devices });
    let sentCount = 0;
    for (const ws of clients.keys()) {
      if (ws.readyState === 1) { // Only send to open connections
        ws.send(message);
        sentCount++;
      }
    }
    console.log(`Sent online devices update to ${sentCount} clients`);
  } else {
    console.log('No devices to broadcast');
  }
}

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection established from:', req.socket.remoteAddress);
  console.log('Total connected clients:', clients.size);
  // Mark connection alive and setup heartbeat
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  // Helper to register or update client info
  function registerOrUpdateClient(id, name) {
    if (!id) {
      id = uuidv4();
    }
    if (!name) {
      name = `User-${id.slice(0, 4)}`;
    }
    console.log('Registering/updating client:', { id, name });
    clients.set(ws, { id, name });
    
    // Wait a bit before broadcasting to ensure all clients are registered
    setTimeout(() => {
      broadcastOnlineDevices();
    }, 200); // Increased delay for better stability
  }

  ws.on('message', (data) => {
    console.log('Received from client:', data);
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.error('Failed to parse message:', e);
      return;
    }
    
    if ((msg.type === 'init' || msg.type === 'update-name') && msg.id && msg.name) {
      console.log('Processing init/update-name:', msg);
      registerOrUpdateClient(msg.id, msg.name);
    } else if (msg.type === 'message') {
      const client = clients.get(ws);
      if (client) {
        const chatMsg = {
          type: 'message',
          id: uuidv4(),
          senderId: client.id,
          senderName: client.name,
          content: msg.content || '',
          timestamp: Date.now(),
          receiverId: msg.receiverId || null,
          messageType: msg.messageType || 'text',
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          fileId: msg.fileId,
        };
        const chatMsgStr = JSON.stringify(chatMsg);
        if (msg.receiverId) {
          // One-to-one: send only to receiver and sender (each once)
          const sentTo = new Set(); // Track who we've sent to
          for (const [wsClient, info] of clients.entries()) {
            if ((info.id === msg.receiverId || info.id === client.id) && !sentTo.has(info.id)) {
              if (wsClient.readyState === 1) { // Only send to open connections
                wsClient.send(chatMsgStr);
                console.log('Sent to client:', info.name, chatMsgStr);
                sentTo.add(info.id);
              }
            }
          }
        } else {
          // Broadcast: send to all (each once)
          const sentTo = new Set(); // Track who we've sent to
          for (const [wsClient, info] of clients.entries()) {
            if (!sentTo.has(info.id)) {
              if (wsClient.readyState === 1) { // Only send to open connections
                wsClient.send(chatMsgStr);
                console.log('Sent to client:', info.name, chatMsgStr);
                sentTo.add(info.id);
              }
            }
          }
        }
      }
    } else if (msg.type === 'read-receipt') {
      // Handle read receipts
      const client = clients.get(ws);
      if (client && msg.messageId && msg.receiverId) {
        const readReceipt = {
          type: 'read-receipt',
          messageId: msg.messageId,
          senderId: client.id, // Who read the message
          receiverId: client.id, // Who read the message (for the frontend to match)
          originalSenderId: msg.receiverId, // Who originally sent the message
          timestamp: Date.now(),
        };
        const readReceiptStr = JSON.stringify(readReceipt);
        
        // Send read receipt to the original sender
        for (const [wsClient, info] of clients.entries()) {
          if (info.id === msg.receiverId && wsClient.readyState === 1) {
            wsClient.send(readReceiptStr);
            console.log('Sent read receipt to:', info.name, readReceiptStr);
          }
        }
      }
    } else {
      console.log('Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      console.log('Client disconnected:', client.name);
    }
    clients.delete(ws);
    // Broadcast immediately so others see the update right away
    broadcastOnlineDevices();
  });
});

// Heartbeat to detect dead connections quickly
const heartbeatInterval = setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) {
      const client = clients.get(ws);
      console.log('Terminating unresponsive client:', client?.name || 'unknown');
      clients.delete(ws);
      try {
        ws.terminate();
      } catch (e) {
        // ignore
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      // ignore
    }
  }
  // After cleaning up, broadcast current state
  broadcastOnlineDevices();
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
