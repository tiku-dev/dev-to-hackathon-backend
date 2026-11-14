import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server as SocketIOServer } from 'socket.io';
import { PresageService } from './services/PresageService';
import { GeminiService } from './services/GeminiService';
import { PaymentService } from './services/PaymentService';

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
app.use(express.json({ limit: '5mb' }));

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
const paymentService = new PaymentService();

// Health & SDK Diagnostics Endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'VitalSync Tele-Triage Kiosk Backend',
    presage: presageService.getStatus(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    privacyPolicy: 'Zero-disk-retention ephemeral RAM pipeline active',
  });
});

// REST fallback for Triage Generation
app.post('/api/triage', async (req, res) => {
  try {
    const report = await geminiService.generateTriageReport(req.body);
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to generate triage report' });
  }
});

// MTN Mobile Money (MoMo) Payment Endpoint
app.post('/api/payments/momo', async (req, res) => {
  try {
    const { phone, country } = req.body || {};
    const receipt = await paymentService.processMtnMomo(phone, country);
    res.json(receipt);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'MoMo payment failed' });
  }
});

// Stripe Express Checkout Endpoint
app.post('/api/payments/stripe', async (_req, res) => {
  try {
    const receipt = await paymentService.processStripeCheckout(FRONTEND_URL);
    res.json(receipt);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Stripe checkout failed' });
  }
});

// Real-Time Socket.io Telemetry Pipeline
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  socket.on(
    'session:start',
    async (options: { mode?: 'webcam' | 'demo'; chiefComplaint?: string }) => {
      await presageService.startSession(
        socket.id,
        {
          mode: options?.mode || 'webcam',
          chiefComplaint: options?.chiefComplaint || 'Routine Tele-Triage Checkup',
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

