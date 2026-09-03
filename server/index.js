/**
 * VOXA — Signaling Server
 * ---------------------------------------------------------------------------
 * Responsabilidade UNICA: handshake WebRTC (SDP/ICE), presenca e relay de chat.
 * Nenhum byte de audio/video passa por aqui — tudo e P2P entre os clientes.
 * Sem Express, sem ORM, sem middleware. http nativo + socket.io.
 * Consumo tipico: ~35 MB de RAM, roda no free tier de qualquer PaaS.
 */
import { createServer } from "node:http";
import { Server } from "socket.io";

const PORT = Number(process.env.PORT || 3001);
const ORIGIN = process.env.ORIGIN || "*";

/**
 * Senha da sala. Sem ela, qualquer um que descubra o endereco do signaling
 * entra no servidor e escuta a conversa. Defina VOXA_TOKEN no host e distribua
 * o mesmo valor para quem for usar o app.
 * Vazio = servidor aberto (ok pra rodar em localhost, nao pra expor na internet).
 */
const TOKEN = process.env.VOXA_TOKEN || "";
if (!TOKEN) {
  console.warn("[voxa-signaling] AVISO: rodando sem VOXA_TOKEN — servidor aberto.");
}

/** @type {Map<string, {id:string,user:object,state:object,voice:string|null}>} */
const clients = new Map();
/** @type {Map<string, Set<string>>} canalDeVoz -> socketIds */
const voiceChannels = new Map();

const GUILD = "guild:main";
const DEFAULT_STATE = { muted: false, deafened: false, sharing: false, speaking: false };

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        clients: clients.size,
        voiceChannels: [...voiceChannels].map(([id, s]) => ({ id, peers: s.size })),
        uptime: Math.round(process.uptime()),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
      })
    );
    return;
  }
  res.writeHead(404).end();
});

const io = new Server(httpServer, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] },
  // Handshake e mensagens curtas: websocket direto, sem polling (menos overhead).
  transports: ["websocket"],
  perMessageDeflate: false,
  maxHttpBufferSize: 1e6,
  pingInterval: 20000,
  pingTimeout: 25000,
});

function roster() {
  return [...clients.values()].map((c) => ({
    id: c.id,
    user: c.user,
    state: c.state,
    voice: c.voice,
  }));
}

function broadcastRoster() {
  io.to(GUILD).emit("roster", roster());
}

function leaveVoice(socket, { silent = false } = {}) {
  const client = clients.get(socket.id);
  if (!client || !client.voice) return;
  const channelId = client.voice;
  const room = voiceChannels.get(channelId);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) voiceChannels.delete(channelId);
  }
  socket.leave(`voice:${channelId}`);
  client.voice = null;
  client.state = { ...client.state, sharing: false, speaking: false };
  socket.to(`voice:${channelId}`).emit("voice:peer-left", { id: socket.id, channelId });
  if (!silent) broadcastRoster();
}

io.on("connection", (socket) => {
  socket.join(GUILD);

  socket.on("hello", (payload = {}, ack) => {
    if (TOKEN && payload?.token !== TOKEN) {
      if (typeof ack === "function") ack({ error: "token-invalido" });
      socket.disconnect(true);
      return;
    }
    const user = {
      id: String(payload?.user?.id || socket.id).slice(0, 64),
      name: String(payload?.user?.name || "anon").slice(0, 32),
      color: String(payload?.user?.color || "#5865F2").slice(0, 9),
    };
    clients.set(socket.id, { id: socket.id, user, state: { ...DEFAULT_STATE }, voice: null });
    if (typeof ack === "function") ack({ selfId: socket.id, roster: roster() });
    broadcastRoster();
  });

  // ---- Voz / Tela -------------------------------------------------------
  socket.on("voice:join", ({ channelId } = {}, ack) => {
    const client = clients.get(socket.id);
    if (!client || !channelId) return;
    if (client.voice === channelId) return;
    leaveVoice(socket, { silent: true });

    const room = voiceChannels.get(channelId) || new Set();
    const peers = [...room]
      .map((id) => clients.get(id))
      .filter(Boolean)
      .map((c) => ({ id: c.id, user: c.user, state: c.state }));

    room.add(socket.id);
    voiceChannels.set(channelId, room);
    socket.join(`voice:${channelId}`);
    client.voice = channelId;

    // O novo entrante recebe a lista e e o "impolite" (quem faz a oferta).
    if (typeof ack === "function") ack({ channelId, peers });
    socket.to(`voice:${channelId}`).emit("voice:peer-joined", {
      id: socket.id,
      user: client.user,
      state: client.state,
      channelId,
    });
    broadcastRoster();
  });

  socket.on("voice:leave", () => leaveVoice(socket));

  // Relay puro de SDP/ICE. Servidor nao inspeciona nem armazena.
  socket.on("signal", ({ to, data } = {}) => {
    if (!to || !data) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("state", (patch = {}) => {
    const client = clients.get(socket.id);
    if (!client) return;
    client.state = {
      ...client.state,
      ...("muted" in patch ? { muted: !!patch.muted } : {}),
      ...("deafened" in patch ? { deafened: !!patch.deafened } : {}),
      ...("sharing" in patch ? { sharing: !!patch.sharing } : {}),
      ...("speaking" in patch ? { speaking: !!patch.speaking } : {}),
    };
    io.to(GUILD).emit("peer:state", { id: socket.id, state: client.state });
  });

  // ---- Chat de texto ----------------------------------------------------
  socket.on("chat:send", (msg = {}) => {
    const client = clients.get(socket.id);
    if (!client || !msg.channelId || !msg.content) return;
    const out = {
      id: String(msg.id || `${Date.now()}-${socket.id}`),
      channelId: String(msg.channelId).slice(0, 64),
      content: String(msg.content).slice(0, 4000),
      authorId: client.user.id,
      authorName: client.user.name,
      authorColor: client.user.color,
      createdAt: new Date().toISOString(),
    };
    io.to(GUILD).emit("chat:new", out);
  });

  socket.on("chat:typing", ({ channelId } = {}) => {
    const client = clients.get(socket.id);
    if (!client || !channelId) return;
    socket.to(GUILD).emit("chat:typing", { channelId, name: client.user.name });
  });

  socket.on("disconnect", () => {
    leaveVoice(socket, { silent: true });
    clients.delete(socket.id);
    broadcastRoster();
  });
});

httpServer.listen(PORT, () => {
  console.log(`[voxa-signaling] ws://localhost:${PORT}  (health: /health)`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    io.close(() => httpServer.close(() => process.exit(0)));
  });
}
