"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const socket_io_1 = require("socket.io");
const PresageService_1 = require("./services/PresageService");
const GeminiService_1 = require("./services/GeminiService");
const PaymentService_1 = require("./services/PaymentService");
dotenv_1.default.config();
const PORT = Number(process.env.PORT) || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const app = (0, express_1.default)();
app.use((0, cors_1.default)({
    origin: [FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
}));
app.use(express_1.default.json({ limit: '5mb' }));
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: [FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
        methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 5e6,
});
const presageService = new PresageService_1.PresageService();
const geminiService = new GeminiService_1.GeminiService();
const paymentService = new PaymentService_1.PaymentService();
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
    }
    catch (err) {
        res.status(500).json({ error: err?.message || 'Failed to generate triage report' });
    }
});
// MTN Mobile Money (MoMo) Payment Endpoint
app.post('/api/payments/momo', async (req, res) => {
    try {
        const { phone, country } = req.body || {};
        const receipt = await paymentService.processMtnMomo(phone, country);
        res.json(receipt);
    }
    catch (err) {
        res.status(500).json({ error: err?.message || 'MoMo payment failed' });
    }
});
// Stripe Express Checkout Endpoint
app.post('/api/payments/stripe', async (_req, res) => {
    try {
        const receipt = await paymentService.processStripeCheckout(FRONTEND_URL);
        res.json(receipt);
    }
    catch (err) {
        res.status(500).json({ error: err?.message || 'Stripe checkout failed' });
    }
});
// Real-Time Socket.io Telemetry Pipeline
io.on('connection', (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}`);
    socket.on('session:start', async (options) => {
        await presageService.startSession(socket.id, {
            mode: options?.mode || 'webcam',
            chiefComplaint: options?.chiefComplaint || 'Routine Tele-Triage Checkup',
        }, (vitalPacket) => {
            socket.emit('stream:vitals', vitalPacket);
        });
    });
    socket.on('stream:frame', async (payload) => {
        await presageService.ingestFrame(socket.id, payload);
    });
    socket.on('session:coregulate', (payload) => {
        presageService.triggerCoRegulation(socket.id, Boolean(payload?.active));
    });
    socket.on('session:talking', (payload) => {
        presageService.setTalkingArtifact(socket.id, Boolean(payload?.isTalking));
    });
    socket.on('triage:generate', async (customSummary) => {
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
