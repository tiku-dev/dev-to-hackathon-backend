import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server as SocketIOServer } from 'socket.io';
import { PresageService } from './services/PresageService';
import { GeminiService } from './services/GeminiService';

dotenv.config();

const PORT = Number(process.env.PORT) || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();
app.use(
  cors({
    origin: [FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: [FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 5e6,
});

const presageService = new PresageService();
const geminiService = new GeminiService();

// Simple in-memory rate limit for /api/triage (max 10 requests per minute per IP)
const triageRateMap = new Map<string, number[]>();

// Health & SDK Diagnostics Endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'VitalSync Tele-Triage Kiosk Backend',
    presage: presageService.getStatus(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    privacyPolicy: 'Ephemeral in-memory processing • SDK aggregate telemetry disabled',
  });
});

// Validated & Rate-Limited REST fallback for Triage Generation
app.post('/api/triage', async (req, res) => {
  const ip = req.ip || 'local';
  const now = Date.now();
  const recent = (triageRateMap.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) {
    res.status(429).json({ error: 'Too many triage requests. Please wait a moment.' });
    return;
  }
  recent.push(now);
  triageRateMap.set(ip, recent);

  const body = req.body;
  if (!body || typeof body.avgPulseRate !== 'number' || typeof body.chiefComplaint !== 'string') {
    res.status(400).json({ error: 'Invalid session summary payload' });
    return;
  }

  try {
    const sanitizedSummary = {
      ...body,
      chiefComplaint: String(body.chiefComplaint).slice(0, 240),
    };
    const report = await geminiService.generateTriageReport(sanitizedSummary);
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to generate triage report' });
  }
});

// Real-Time Socket.io Telemetry Pipeline
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  socket.on(
    'session:start',
    async (options: { mode?: 'webcam' | 'demo'; chiefComplaint?: string }) => {
      const safeComplaint = String(
        options?.chiefComplaint || 'Routine Pre-Consultation Check-In'
      ).slice(0, 240);
      await presageService.startSession(
        socket.id,
        {
          mode: options?.mode === 'demo' ? 'demo' : 'webcam',
          chiefComplaint: safeComplaint,
        },
        (vitalPacket) => {
          socket.emit('stream:vitals', vitalPacket);
        }
      );
    }
  );

  socket.on(
    'stream:frame',
    async (payload: { frame: string | Buffer; timestampUs?: number; isTalkingHint?: boolean }) => {
      await presageService.ingestFrame(socket.id, payload);
    }
  );

  socket.on('session:coregulate', (payload: { active: boolean }) => {
    presageService.triggerCoRegulation(socket.id, Boolean(payload?.active));
  });

  socket.on('session:talking', (payload: { isTalking: boolean }) => {
    presageService.setTalkingArtifact(socket.id, Boolean(payload?.isTalking));
  });

  socket.on('triage:generate', async (customSummary?: any) => {
    const summary = presageService.getSessionSummary(socket.id) || customSummary;
    if (!summary) {
      socket.emit('triage:error', { message: 'No active telemetry baseline found' });
      return;
    }
    const report = await geminiService.generateTriageReport(summary);
    socket.emit('triage:result', { summary, report });
  });

  socket.on('session:purge', async () => {
    await presageService.stopSession(socket.id);
    socket.emit('session:purged', { purgedAt: new Date().toISOString() });
  });

  socket.on('disconnect', async () => {
    await presageService.stopSession(socket.id);
    console.log(`[Socket.io] Client disconnected & RAM purged: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`🩺 VitalSync Backend listening on http://localhost:${PORT}`);
});
