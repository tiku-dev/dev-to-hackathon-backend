"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresageService = void 0;
const sharp_1 = __importDefault(require("sharp"));
const path_1 = __importDefault(require("path"));
class PresageService {
    sessions = new Map();
    smartSpectraModule = null;
    sdkLoadStatus = 'fallback';
    sdkLoadDetail = 'Initializing @smartspectra/node-sdk...';
    constructor() {
        this.initSdkModule();
    }
    async initSdkModule() {
        try {
            const winBinPath = path_1.default.resolve(__dirname, '../../node_modules/@smartspectra/node-sdk-win32-x64');
            if (process.env.PATH && !process.env.PATH.includes(winBinPath)) {
                process.env.PATH = `${winBinPath}${path_1.default.delimiter}${process.env.PATH}`;
            }
            const mod = await Promise.resolve().then(() => __importStar(require('@smartspectra/node-sdk')));
            this.smartSpectraModule = mod;
            this.sdkLoadStatus = 'loaded';
            this.sdkLoadDetail = `@smartspectra/node-sdk v${mod.SmartSpectraSDK?.version || '3.4.0'} native bindings loaded`;
            console.log('[PresageService] ✅', this.sdkLoadDetail);
        }
        catch (err) {
            this.sdkLoadStatus = 'fallback';
            const reason = err?.message?.split('\n')[0] || 'native addon unavailable';
            this.sdkLoadDetail = `Native C++ SDK unavailable (${reason}) — Demo Simulation Mode available`;
            console.warn('[PresageService] ⚠️', this.sdkLoadDetail);
        }
    }
    getStatus() {
        return {
            sdkInstalled: this.sdkLoadStatus === 'loaded',
            apiKeyConfigured: Boolean(process.env.PRESAGE_API_KEY),
            detail: this.sdkLoadDetail,
        };
    }
    async startSession(socketId, options, onVitals) {
        await this.stopSession(socketId);
        const state = {
            socketId,
            mode: options.mode,
            chiefComplaint: options.chiefComplaint || 'General Pre-Consultation Check-In',
            startTimeMs: Date.now(),
            coRegulating: false,
            coRegCompleted: false,
            sdkInstance: null,
            sdkActive: false,
            lastSdkMetricTimeMs: 0,
            lastFrameTimestampUs: Date.now() * 1000,
            isProcessingFrame: false,
            validationCode: 0,
            validationHint: null,
            prevFrameGreenMean: null,
            prevFrameRedMean: null,
            opticalMotionScore: 0,
            talkingSimulatedOrDetected: false,
            latestSdkValues: {
                pulseRate: null,
                pulseConfidence: null,
                pulseStable: false,
                hrvRmssd: null,
                breathingRate: null,
                breathingStable: false,
                arterialWaveform: null,
                breathingTrace: null,
                inhaleExhaleRatio: null,
                isTalking: false,
                blinkDetected: false,
            },
            history: [],
        };
        if (options.mode === 'webcam' && this.smartSpectraModule && process.env.PRESAGE_API_KEY) {
            try {
                const { SmartSpectraSDK, breathingMetrics, cardioMetrics, faceMetrics, decodeMetrics, FrameTransform, } = this.smartSpectraModule;
                const requestedMetrics = [
                    ...(breathingMetrics || []),
                    ...(cardioMetrics || []),
                    ...(faceMetrics || []),
                ];
                const sdk = new SmartSpectraSDK({
                    apiKey: process.env.PRESAGE_API_KEY,
                    enableTelemetry: false, // Opt out of aggregate SDK telemetry for patient privacy
                    ...(requestedMetrics.length > 0 ? { requestedMetrics } : {}),
                });
                if (typeof sdk.useCustomInput === 'function') {
                    sdk.useCustomInput(FrameTransform?.kNone ?? 0);
                }
                sdk.on('validationStatus', (code, _ts, hint) => {
                    state.validationCode = code;
                    state.validationHint = code === 0 ? null : hint || null;
                });
                sdk.on('error', (code, message) => {
                    console.warn(`[PresageService] SDK warning (code ${code}): ${message}`);
                });
                sdk.on('metrics', (buffer) => {
                    try {
                        const decoded = decodeMetrics ? decodeMetrics(buffer) : buffer;
                        if (!decoded || Buffer.isBuffer(decoded))
                            return;
                        state.lastSdkMetricTimeMs = Date.now();
                        state.sdkActive = true;
                        // Exact protobuf field mappings from @smartspectra/node-sdk/js/messages/generated.d.ts:
                        // ICardio: pulseRate (IMeasurementWithConfidence[]), arterialPressureTrace (IMeasurementWithConfidence[]), hrv (IHrv[])
                        const latestPulseObj = decoded.cardio?.pulseRate?.at?.(-1);
                        const latestArterialObj = decoded.cardio?.arterialPressureTrace?.at?.(-1);
                        const latestHrvObj = decoded.cardio?.hrv?.at?.(-1);
                        // IBreathing: rate (IMeasurementWithConfidence[]), upperTrace (IMeasurement[]), inhaleExhaleRatio (IMeasurement[])
                        const latestBreathRateObj = decoded.breathing?.rate?.at?.(-1);
                        const latestBreathTraceObj = decoded.breathing?.upperTrace?.at?.(-1);
                        const latestIeRatioObj = decoded.breathing?.inhaleExhaleRatio?.at?.(-1);
                        // IFace: talking (IDetectionStatus[] -> .detected), blinking (IDetectionStatus[] -> .detected)
                        const latestTalkingObj = decoded.face?.talking?.at?.(-1);
                        const latestBlinkingObj = decoded.face?.blinking?.at?.(-1);
                        if (typeof latestPulseObj?.value === 'number') {
                            state.latestSdkValues.pulseRate = Math.round(latestPulseObj.value);
                            state.latestSdkValues.pulseStable = Boolean(latestPulseObj.stable);
                            if (typeof latestPulseObj.confidence === 'number') {
                                state.latestSdkValues.pulseConfidence = Number(latestPulseObj.confidence.toFixed(2));
                            }
                        }
                        if (typeof latestHrvObj?.rmssd === 'number') {
                            state.latestSdkValues.hrvRmssd = Math.round(latestHrvObj.rmssd);
                        }
                        if (typeof latestArterialObj?.value === 'number') {
                            state.latestSdkValues.arterialWaveform = Number(latestArterialObj.value.toFixed(3));
                        }
                        if (typeof latestBreathRateObj?.value === 'number') {
                            state.latestSdkValues.breathingRate = Math.round(latestBreathRateObj.value);
                            state.latestSdkValues.breathingStable = Boolean(latestBreathRateObj.stable);
                        }
                        if (typeof latestBreathTraceObj?.value === 'number') {
                            state.latestSdkValues.breathingTrace = Number(latestBreathTraceObj.value.toFixed(3));
                        }
                        if (typeof latestIeRatioObj?.value === 'number') {
                            state.latestSdkValues.inhaleExhaleRatio = Number(latestIeRatioObj.value.toFixed(2));
                        }
                        if (typeof latestTalkingObj?.detected === 'boolean') {
                            state.latestSdkValues.isTalking = latestTalkingObj.detected;
                        }
                        if (typeof latestBlinkingObj?.detected === 'boolean') {
                            state.latestSdkValues.blinkDetected = latestBlinkingObj.detected;
                        }
                    }
                    catch {
                        // Ignore malformed individual protobuf packet
                    }
                });
                if (typeof sdk.start === 'function') {
                    sdk.start();
                }
                state.sdkInstance = sdk;
            }
            catch (sdkInitErr) {
                console.warn('[PresageService] SmartSpectra live session fallback:', sdkInitErr?.message || sdkInitErr);
            }
        }
        this.sessions.set(socketId, state);
        // Emit 15Hz (every 66ms) telemetry packets
        state.intervalTimer = setInterval(() => {
            const packet = this.computeNextTelemetryPacket(state);
            state.history.push(packet);
            if (state.history.length > 900) {
                state.history.shift();
            }
            onVitals(packet);
        }, 66);
    }
    async ingestFrame(socketId, payload) {
        const state = this.sessions.get(socketId);
        if (!state || state.isProcessingFrame)
            return; // Backpressure guard: drop frame if previous frame is still decoding
        state.isProcessingFrame = true;
        try {
            const rawInput = typeof payload.frame === 'string'
                ? Buffer.from(payload.frame.replace(/^data:image\/\w+;base64,/, ''), 'base64')
                : Buffer.isBuffer(payload.frame)
                    ? payload.frame
                    : Buffer.from(payload.frame);
            if (rawInput.length < 64)
                return;
            // Preserve full camera resolution (up to 640x480) for SmartSpectra ROI landmarks
            const { data: rgbBuffer, info } = await (0, sharp_1.default)(rawInput)
                .removeAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            const rawTs = payload.timestampUs || Date.now() * 1000;
            const timestampUs = Math.max(state.lastFrameTimestampUs + 1000, rawTs);
            state.lastFrameTimestampUs = timestampUs;
            if (state.sdkInstance && typeof state.sdkInstance.sendFrame === 'function') {
                const PixelFormat = this.smartSpectraModule?.PixelFormat;
                const kRGB = PixelFormat?.kRGB ?? 0;
                const stride = info.width * 3;
                try {
                    state.sdkInstance.sendFrame(rgbBuffer, info.width, info.height, stride, kRGB, timestampUs);
                }
                catch { }
            }
            // Compute frame-to-frame motion score from RGB pixels
            let rSum = 0;
            let gSum = 0;
            const step = 24;
            let samples = 0;
            for (let i = 0; i < rgbBuffer.length - 2; i += step) {
                rSum += rgbBuffer[i];
                gSum += rgbBuffer[i + 1];
                samples++;
            }
            if (samples > 0) {
                const rMean = rSum / samples;
                const gMean = gSum / samples;
                if (state.prevFrameGreenMean !== null && state.prevFrameRedMean !== null) {
                    const deltaG = Math.abs(gMean - state.prevFrameGreenMean);
                    const deltaR = Math.abs(rMean - state.prevFrameRedMean);
                    const motion = (deltaG + deltaR) / 2;
                    state.opticalMotionScore = state.opticalMotionScore * 0.75 + motion * 0.25;
                }
                state.prevFrameGreenMean = gMean;
                state.prevFrameRedMean = rMean;
            }
            if (typeof payload.isTalkingHint === 'boolean') {
                state.talkingSimulatedOrDetected = payload.isTalkingHint;
            }
        }
        catch {
            // Ignore corrupt frame
        }
        finally {
            state.isProcessingFrame = false;
        }
    }
    triggerCoRegulation(socketId, active) {
        const state = this.sessions.get(socketId);
        if (!state)
            return;
        if (active && !state.coRegulating) {
            const latest = state.history.at(-1);
            if (latest && latest.pulseRate !== null) {
                state.preCoRegSnapshot = {
                    pulse: latest.pulseRate,
                    hrv: latest.hrv ?? 42,
                    breathing: latest.breathingRate ?? 16,
                };
            }
            state.coRegulating = true;
            state.coRegCompleted = false;
            state.coRegStartTimeMs = Date.now();
        }
        else if (!active && state.coRegulating) {
            state.coRegulating = false;
            const latest = state.history.at(-1);
            if (latest && latest.pulseRate !== null) {
                state.postCoRegSnapshot = {
                    pulse: latest.pulseRate,
                    hrv: latest.hrv ?? 48,
                    breathing: latest.breathingRate ?? 12,
                };
            }
        }
    }
    setTalkingArtifact(socketId, isTalking) {
        const state = this.sessions.get(socketId);
        if (!state)
            return;
        state.talkingSimulatedOrDetected = isTalking;
    }
    computeNextTelemetryPacket(state) {
        const nowMs = Date.now();
        const elapsedSeconds = Number(((nowMs - state.startTimeMs) / 1000).toFixed(2));
        const t = elapsedSeconds;
        // Auto-stop 15-second Guided Breathing Co-Regulation when 15s completes
        let coRegRemainingSeconds = 0;
        if (state.coRegulating && state.coRegStartTimeMs) {
            const coRegElapsed = (nowMs - state.coRegStartTimeMs) / 1000;
            if (coRegElapsed >= 15) {
                state.coRegulating = false;
                state.coRegCompleted = true;
                const latest = state.history.at(-1);
                if (latest && latest.pulseRate !== null) {
                    state.postCoRegSnapshot = {
                        pulse: latest.pulseRate,
                        hrv: latest.hrv ?? 50,
                        breathing: latest.breathingRate ?? 10,
                    };
                }
            }
            else {
                coRegRemainingSeconds = Math.ceil(15 - coRegElapsed);
            }
        }
        const sdkLive = state.mode === 'webcam' &&
            state.sdkActive &&
            nowMs - state.lastSdkMetricTimeMs < 4000;
        const isSimulated = !sdkLive;
        const engineSource = sdkLive
            ? 'smartspectra-sdk-live'
            : 'smartspectra-simulated-demo';
        // In Demo Mode (or when native SDK is not emitting live metrics), generate clearly labeled simulated physiological values
        let coRegFactor = 0;
        if (state.coRegStartTimeMs) {
            const coRegElapsed = (nowMs - state.coRegStartTimeMs) / 1000;
            coRegFactor = Math.min(1, Math.max(0, coRegElapsed / 15));
        }
        const rsaModulation = Math.sin(t * 0.45) * 2.0;
        const simHr = Math.round(86 - coRegFactor * 9 + rsaModulation);
        const simHrv = Math.round(40 + coRegFactor * 14 + Math.cos(t * 0.3) * 2);
        const simBreathingRate = Math.round(state.coRegulating ? 6 + (1 - coRegFactor) * 5 : 16 - coRegFactor * 4);
        const simIeRatio = Number((state.coRegulating ? 0.67 : 0.85).toFixed(2));
        const pulseRate = sdkLive ? state.latestSdkValues.pulseRate : simHr;
        const pulseConfidence = sdkLive ? state.latestSdkValues.pulseConfidence : 0.92;
        const hrv = sdkLive ? state.latestSdkValues.hrvRmssd : simHrv;
        const breathingRate = sdkLive ? state.latestSdkValues.breathingRate : simBreathingRate;
        const inhaleExhaleRatio = sdkLive
            ? state.latestSdkValues.inhaleExhaleRatio
            : simIeRatio;
        // Arterial pressure trace (cardio.arterialPressureTrace)
        const activeBpm = pulseRate ?? 78;
        const bps = activeBpm / 60;
        const cardiacPhase = (t * bps) % 1;
        const systolicPeak = Math.exp(-Math.pow((cardiacPhase - 0.22) / 0.08, 2)) * 1.15;
        const dicroticNotch = Math.exp(-Math.pow((cardiacPhase - 0.48) / 0.12, 2)) * 0.45;
        const syntheticArterial = Number((systolicPeak + dicroticNotch - 0.35).toFixed(3));
        const arterialWaveform = sdkLive
            ? state.latestSdkValues.arterialWaveform ?? syntheticArterial
            : syntheticArterial;
        // Upper-chest respiratory trace (breathing.upperTrace)
        const activeRpm = breathingRate ?? 15;
        const respFreqHz = state.coRegulating ? 0.1 : activeRpm / 60;
        const syntheticResp = Number((Math.sin(t * respFreqHz * 2 * Math.PI) * 0.85).toFixed(3));
        const breathingTrace = sdkLive
            ? state.latestSdkValues.breathingTrace ?? syntheticResp
            : syntheticResp;
        const motionArtifact = state.opticalMotionScore > 5.0 || state.validationCode === 12;
        const isTalking = state.latestSdkValues.isTalking || state.talkingSimulatedOrDetected;
        const blinkDetected = state.latestSdkValues.blinkDetected || (!sdkLive && Math.floor(t * 15) % 65 === 0);
        // Compute Signal Quality from SDK validation/confidence when live
        let signalQuality = sdkLive
            ? state.validationCode === 0
                ? Math.round((state.latestSdkValues.pulseConfidence ?? 0.88) * 100)
                : 45
            : 92;
        if (isTalking)
            signalQuality = Math.max(40, signalQuality - 25);
        if (motionArtifact)
            signalQuality = Math.max(35, signalQuality - 30);
        // Real-time human-sensing guidance message prioritizing official SDK validationStatus hints
        let guidanceMessage = sdkLive
            ? 'SmartSpectra optical lock active — streaming live cardio & respiratory traces'
            : 'Simulated Demo Telemetry active — streaming modeled SmartSpectra signals';
        if (state.validationHint) {
            guidanceMessage = `SmartSpectra Coach: ${state.validationHint}`;
        }
        else if (isTalking) {
            guidanceMessage =
                'Speech detected (face.talking) — please pause speaking for cleaner optical pulse lock';
        }
        else if (motionArtifact) {
            guidanceMessage =
                'Head movement detected — please hold still with your face centered in the frame';
        }
        else if (state.coRegulating) {
            const cyclePos = t % 10;
            guidanceMessage =
                cyclePos < 4
                    ? `Paced Breathing (${coRegRemainingSeconds}s left): Inhale slowly through your nose (4s)...`
                    : `Paced Breathing (${coRegRemainingSeconds}s left): Exhale gently (6s)...`;
        }
        else if (sdkLive && pulseRate === null) {
            guidanceMessage =
                'Acquiring initial SmartSpectra pulse lock — keep face centered & well-lit...';
        }
        return {
            timestampUs: nowMs * 1000,
            elapsedSeconds,
            engineSource,
            isSimulated,
            pulseRate,
            pulseConfidence,
            hrv,
            breathingRate,
            arterialWaveform,
            breathingTrace,
            inhaleExhaleRatio,
            signalQuality,
            isTalking,
            blinkDetected,
            motionArtifact,
            validationHint: state.validationHint,
            coRegulating: state.coRegulating,
            coRegRemainingSeconds,
            guidanceMessage,
        };
    }
    getSessionSummary(socketId) {
        const state = this.sessions.get(socketId);
        if (!state || state.history.length === 0)
            return null;
        // Exclude the first 3 seconds of warm-up when calculating averages if enough history exists
        const stableWindow = state.history.filter((p) => p.elapsedSeconds >= 3);
        const packets = stableWindow.length > 0 ? stableWindow : state.history;
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
        const pulses = packets
            .map((p) => p.pulseRate)
            .filter((v) => typeof v === 'number');
        const hrvs = packets
            .map((p) => p.hrv)
            .filter((v) => typeof v === 'number');
        const breathings = packets
            .map((p) => p.breathingRate)
            .filter((v) => typeof v === 'number');
        const ieRatios = packets
            .map((p) => p.inhaleExhaleRatio)
            .filter((v) => typeof v === 'number');
        const qualities = packets.map((p) => p.signalQuality);
        const talkingCount = packets.filter((p) => p.isTalking).length;
        const latest = packets.at(-1);
        const postSnapshot = state.postCoRegSnapshot || {
            pulse: latest.pulseRate ?? avg(pulses) ?? 78,
            hrv: latest.hrv ?? avg(hrvs) ?? 45,
            breathing: latest.breathingRate ?? avg(breathings) ?? 14,
        };
        return {
            chiefComplaint: state.chiefComplaint,
            scanDurationSeconds: Math.round(latest.elapsedSeconds),
            engineSource: latest.engineSource,
            isSimulated: latest.isSimulated,
            avgPulseRate: pulses.length ? avg(pulses) : 78,
            minPulseRate: pulses.length ? Math.min(...pulses) : 74,
            maxPulseRate: pulses.length ? Math.max(...pulses) : 82,
            avgHrv: hrvs.length ? avg(hrvs) : 44,
            avgBreathingRate: breathings.length ? avg(breathings) : 15,
            avgInhaleExhaleRatio: ieRatios.length
                ? Number((ieRatios.reduce((a, b) => a + b, 0) / ieRatios.length).toFixed(2))
                : null,
            avgSignalQuality: avg(qualities),
            talkingEventsCount: talkingCount,
            coRegulationPerformed: Boolean(state.preCoRegSnapshot),
            preCoRegPulse: state.preCoRegSnapshot?.pulse,
            postCoRegPulse: state.preCoRegSnapshot ? postSnapshot.pulse : undefined,
            preCoRegHrv: state.preCoRegSnapshot?.hrv,
            postCoRegHrv: state.preCoRegSnapshot ? postSnapshot.hrv : undefined,
            preCoRegBreathing: state.preCoRegSnapshot?.breathing,
            postCoRegBreathing: state.preCoRegSnapshot ? postSnapshot.breathing : undefined,
        };
    }
    async stopSession(socketId) {
        const state = this.sessions.get(socketId);
        if (!state)
            return;
        if (state.intervalTimer) {
            clearInterval(state.intervalTimer);
        }
        if (state.sdkInstance) {
            try {
                if (typeof state.sdkInstance.stopAsync === 'function') {
                    await state.sdkInstance.stopAsync();
                }
                else if (typeof state.sdkInstance.stop === 'function') {
                    state.sdkInstance.stop();
                }
                if (typeof state.sdkInstance.destroy === 'function') {
                    await state.sdkInstance.destroy();
                }
            }
            catch { }
        }
        state.history = [];
        this.sessions.delete(socketId);
    }
}
exports.PresageService = PresageService;
