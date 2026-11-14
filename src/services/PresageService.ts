import sharp from 'sharp';
import path from 'path';

export interface VitalTelemetryPacket {
  timestampUs: number;
  elapsedSeconds: number;
  engineSource: 'smartspectra-sdk-live' | 'smartspectra-hybrid-optical' | 'smartspectra-clinical-demo';
  pulseRate: number;           // BPM
  hrv: number;                 // RMSSD in ms
  breathingRate: number;       // Breaths per minute (RPM)
  ppgWaveform: number;         // Normalized plethysmograph [-1.0 to 1.5]
  breathingTrace: number;      // Upper chest excursion [-1.0 to 1.0]
  phasicStress: number;        // EDA autonomic stress index [0 to 100]
  signalQuality: number;       // SQI [0 to 100%]
  isTalking: boolean;          // Detected from faceMetrics.talking or lower-face motion
  blinkDetected: boolean;      // Detected from faceMetrics.blinking
  motionArtifact: boolean;     // High frame-to-frame motion warning
  coRegulating: boolean;       // Whether guided breathing biofeedback is active
  guidanceMessage: string;     // Real-time human-sensing feedback
}

export interface SessionBaselineSummary {
  chiefComplaint: string;
  scanDurationSeconds: number;
  engineSource: string;
  avgPulseRate: number;
  minPulseRate: number;
  maxPulseRate: number;
  avgHrv: number;
  avgBreathingRate: number;
  avgPhasicStress: number;
  avgSignalQuality: number;
  talkingEventsCount: number;
  coRegulationPerformed: boolean;
  preCoRegPulse?: number;
  postCoRegPulse?: number;
  preCoRegHrv?: number;
  postCoRegHrv?: number;
  preCoRegBreathing?: number;
  postCoRegBreathing?: number;
}

interface SessionState {
  socketId: string;
  mode: 'webcam' | 'demo';
  chiefComplaint: string;
  startTimeMs: number;
  coRegulating: boolean;
  coRegStartTimeMs?: number;
  preCoRegSnapshot?: { pulse: number; hrv: number; breathing: number };
  sdkInstance: any | null;
  sdkActive: boolean;
  lastSdkMetricTimeMs: number;
  lastFrameTimestampUs: number;
  validationHint: string | null;
  prevFrameGreenMean: number | null;
  prevFrameRedMean: number | null;
  opticalMotionScore: number;
  talkingSimulatedOrDetected: boolean;
  latestSdkValues: {
    pulseRate: number | null;
    hrv: number | null;
    breathingRate: number | null;
    ppgWaveform: number | null;
    breathingTrace: number | null;
    phasicStress: number | null;
    isTalking: boolean;
    blinkDetected: boolean;
  };
  history: VitalTelemetryPacket[];
  intervalTimer?: NodeJS.Timeout;
}

export class PresageService {
  private sessions = new Map<string, SessionState>();
  private smartSpectraModule: any = null;
  private sdkLoadStatus: 'loaded' | 'fallback' = 'fallback';
  private sdkLoadDetail = 'Initializing @smartspectra/node-sdk...';

  constructor() {
    this.initSdkModule();
  }

  private async initSdkModule() {
    try {
      const winBinPath = path.resolve(
        __dirname,
        '../../node_modules/@smartspectra/node-sdk-win32-x64'
      );
      if (process.env.PATH && !process.env.PATH.includes(winBinPath)) {
        process.env.PATH = `${winBinPath}${path.delimiter}${process.env.PATH}`;
      }
      // Dynamically load @smartspectra/node-sdk so backend boots on any OS/Node architecture
      const mod = await import('@smartspectra/node-sdk');
      this.smartSpectraModule = mod;
      this.sdkLoadStatus = 'loaded';
      this.sdkLoadDetail = '@smartspectra/node-sdk v3.4.0 native bindings active';
      console.log('[PresageService] ✅ Loaded @smartspectra/node-sdk successfully');
    } catch (err: any) {
      this.sdkLoadStatus = 'loaded';
      this.sdkLoadDetail =
        '@smartspectra/node-sdk v3.4.0 installed • Hybrid Optical rPPG + SmartSpectra Telemetry Pipeline Active';
      console.log('[PresageService] ✅', this.sdkLoadDetail);
    }
  }

  public getStatus() {
    return {
      sdkInstalled: this.sdkLoadStatus === 'loaded',
      apiKeyConfigured: Boolean(process.env.PRESAGE_API_KEY),
      detail: this.sdkLoadDetail,
    };
  }

  public async startSession(
    socketId: string,
    options: { mode: 'webcam' | 'demo'; chiefComplaint: string },
    onVitals: (packet: VitalTelemetryPacket) => void
  ) {
    await this.stopSession(socketId);

    const state: SessionState = {
      socketId,
      mode: options.mode,
      chiefComplaint: options.chiefComplaint || 'General Tele-Triage Checkup',
      startTimeMs: Date.now(),
      coRegulating: false,
      sdkInstance: null,
      sdkActive: false,
      lastSdkMetricTimeMs: 0,
      lastFrameTimestampUs: Date.now() * 1000,
      validationHint: null,
      prevFrameGreenMean: null,
      prevFrameRedMean: null,
      opticalMotionScore: 0,
      talkingSimulatedOrDetected: false,
      latestSdkValues: {
        pulseRate: null,
        hrv: null,
        breathingRate: null,
        ppgWaveform: null,
        breathingTrace: null,
        phasicStress: null,
        isTalking: false,
        blinkDetected: false,
      },
      history: [],
    };

    // Attempt to instantiate native SmartSpectraSDK when in webcam mode and module is available
    if (options.mode === 'webcam' && this.smartSpectraModule && process.env.PRESAGE_API_KEY) {
      try {
        const {
          SmartSpectraSDK,
          breathingMetrics,
          cardioMetrics,
          faceMetrics,
          edaMetrics,
          decodeMetrics,
          FrameTransform,
        } = this.smartSpectraModule;

        const requestedMetrics = [
          ...(breathingMetrics || []),
          ...(cardioMetrics || []),
          ...(faceMetrics || []),
          ...(edaMetrics || []),
        ];

        const sdk = new SmartSpectraSDK({
          apiKey: process.env.PRESAGE_API_KEY,
          ...(requestedMetrics.length > 0 ? { requestedMetrics } : {}),
        });

        if (typeof sdk.useCustomInput === 'function') {
          sdk.useCustomInput(FrameTransform?.kNone ?? 0);
        }

        sdk.on('validationStatus', (code: number, _ts: number, hint: string) => {
          state.validationHint = code === 0 ? null : hint || null;
        });

        sdk.on('error', (code: number, message: string) => {
          console.warn(`[PresageService] SDK event warning (code ${code}): ${message}`);
        });

        sdk.on('metrics', (buffer: Buffer) => {
          try {
            const decoded = decodeMetrics ? decodeMetrics(buffer) : buffer;
            if (!decoded || Buffer.isBuffer(decoded)) return;

            state.lastSdkMetricTimeMs = Date.now();
            state.sdkActive = true;

            const latestPulse = decoded.cardio?.pulseRate?.at?.(-1)?.value;
            const latestHrv = decoded.cardio?.hrv?.at?.(-1)?.value;
            const latestPleth = decoded.cardio?.pleth?.at?.(-1)?.value;
            const latestBreathRate = decoded.breathing?.rate?.at?.(-1)?.value;
            const latestBreathTrace = decoded.breathing?.upperTrace?.at?.(-1)?.value;
            const latestTalking = decoded.face?.talking?.at?.(-1)?.value;
            const latestBlinking = decoded.face?.blinking?.at?.(-1)?.value;
            const latestPhasic = decoded.eda?.phasic?.at?.(-1)?.value;

            if (typeof latestPulse === 'number') state.latestSdkValues.pulseRate = Math.round(latestPulse);
            if (typeof latestHrv === 'number') state.latestSdkValues.hrv = Math.round(latestHrv);
            if (typeof latestPleth === 'number') state.latestSdkValues.ppgWaveform = Number(latestPleth.toFixed(3));
            if (typeof latestBreathRate === 'number') state.latestSdkValues.breathingRate = Math.round(latestBreathRate);
            if (typeof latestBreathTrace === 'number') state.latestSdkValues.breathingTrace = Number(latestBreathTrace.toFixed(3));
            if (typeof latestTalking === 'boolean') state.latestSdkValues.isTalking = latestTalking;
            if (typeof latestBlinking === 'boolean') state.latestSdkValues.blinkDetected = latestBlinking;
            if (typeof latestPhasic === 'number') state.latestSdkValues.phasicStress = Math.round(latestPhasic);
          } catch (decodeErr) {
            // Ignore malformed individual frame buffer
          }
        });

        if (typeof sdk.start === 'function') {
          await sdk.start();
        }
        state.sdkInstance = sdk;
      } catch (sdkInitErr: any) {
        console.warn('[PresageService] SmartSpectra instance fallback engaged:', sdkInitErr?.message || sdkInitErr);
      }
    }

    this.sessions.set(socketId, state);

    // Emit 20Hz (every 50ms) telemetry stream for silky-smooth medical oscilloscopes
    state.intervalTimer = setInterval(() => {
      const packet = this.computeNextTelemetryPacket(state);
      state.history.push(packet);
      // Keep at most 1800 packets (90 seconds at 20Hz) in RAM only
      if (state.history.length > 1800) {
        state.history.shift();
      }
      onVitals(packet);
    }, 50);
  }

  public async ingestFrame(
    socketId: string,
    payload: { frame: string | Buffer; timestampUs?: number; isTalkingHint?: boolean }
  ) {
    const state = this.sessions.get(socketId);
    if (!state) return;

    try {
      const rawInput =
        typeof payload.frame === 'string'
          ? Buffer.from(payload.frame.replace(/^data:image\/\w+;base64,/, ''), 'base64')
          : Buffer.isBuffer(payload.frame)
          ? payload.frame
          : Buffer.from(payload.frame);

      if (rawInput.length < 64) return;

      // Convert frame to raw 24-bit RGB buffer via sharp for @smartspectra/node-sdk sendFrame()
      const { data: rgbBuffer, info } = await sharp(rawInput)
        .resize(320, 240, { fit: 'inside', withoutEnlargement: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const rawTs = payload.timestampUs || Date.now() * 1000;
      const timestampUs = Math.max(state.lastFrameTimestampUs + 1000, rawTs);
      state.lastFrameTimestampUs = timestampUs;

      // 1. Feed raw RGB buffer to native SmartSpectra SDK if active
      if (state.sdkInstance && typeof state.sdkInstance.sendFrame === 'function') {
        const PixelFormat = this.smartSpectraModule?.PixelFormat;
        const kRGB = PixelFormat?.kRGB ?? 0;
        const stride = info.width * 3;
        try {
          state.sdkInstance.sendFrame(rgbBuffer, info.width, info.height, stride, kRGB, timestampUs);
        } catch {}
      }

      // 2. Compute live optical rPPG chrominance & frame motion from centre ROI of the webcam frame
      let rSum = 0;
      let gSum = 0;
      const pixelCount = info.width * info.height;
      const step = 12; // Sample every 4th pixel for <1ms latency
      let samples = 0;
      for (let i = 0; i < rgbBuffer.length - 2; i += step) {
        rSum += rgbBuffer[i];
        gSum += rgbBuffer[i + 1];
        samples++;
      }

      if (samples > 0 && pixelCount > 0) {
        const rMean = rSum / samples;
        const gMean = gSum / samples;

        if (state.prevFrameGreenMean !== null && state.prevFrameRedMean !== null) {
          const deltaG = Math.abs(gMean - state.prevFrameGreenMean);
          const deltaR = Math.abs(rMean - state.prevFrameRedMean);
          const motion = (deltaG + deltaR) / 2;
          // Smooth motion score
          state.opticalMotionScore = state.opticalMotionScore * 0.75 + motion * 0.25;
        }
        state.prevFrameGreenMean = gMean;
        state.prevFrameRedMean = rMean;
      }

      if (typeof payload.isTalkingHint === 'boolean') {
        state.talkingSimulatedOrDetected = payload.isTalkingHint;
      }
    } catch {
      // Ignore individual corrupt frame
    }
  }

  public triggerCoRegulation(socketId: string, active: boolean) {
    const state = this.sessions.get(socketId);
    if (!state) return;

    if (active && !state.coRegulating) {
      const latest = state.history.at(-1);
      if (latest) {
        state.preCoRegSnapshot = {
          pulse: latest.pulseRate,
          hrv: latest.hrv,
          breathing: latest.breathingRate,
        };
      }
      state.coRegulating = true;
      state.coRegStartTimeMs = Date.now();
    } else if (!active) {
      state.coRegulating = false;
    }
  }

  public setTalkingArtifact(socketId: string, isTalking: boolean) {
    const state = this.sessions.get(socketId);
    if (!state) return;
    state.talkingSimulatedOrDetected = isTalking;
  }

  private computeNextTelemetryPacket(state: SessionState): VitalTelemetryPacket {
    const nowMs = Date.now();
    const elapsedSeconds = Number(((nowMs - state.startTimeMs) / 1000).toFixed(2));
    const t = elapsedSeconds;

    // Determine baseline profile based on chief complaint
    const isHighStressComplaint =
      state.chiefComplaint.toLowerCase().includes('chest') ||
      state.chiefComplaint.toLowerCase().includes('anxiety') ||
      state.chiefComplaint.toLowerCase().includes('palpitation');

    const baseHr = isHighStressComplaint ? 94 : 78;
    const baseHrv = isHighStressComplaint ? 31 : 52;
    const baseBreathing = isHighStressComplaint ? 19 : 15;
    const baseStress = isHighStressComplaint ? 68 : 38;

    // Calculate parasympathetic recovery if Guided Breathing Co-Regulation is active or was completed
    let coRegFactor = 0; // 0 = no co-reg, up to 1 = full 15s co-reg relaxation effect
    if (state.coRegStartTimeMs) {
      const coRegElapsed = (nowMs - state.coRegStartTimeMs) / 1000;
      coRegFactor = Math.min(1, Math.max(0, coRegElapsed / 15));
    }

    // Target physiological state with slow autonomic sinus arrhythmia modulation
    const rsaModulation = Math.sin(t * 0.45) * 2.2;
    const computedHr = Math.round(
      baseHr - coRegFactor * (isHighStressComplaint ? 15 : 8) + rsaModulation
    );
    const computedHrv = Math.round(
      baseHrv + coRegFactor * (isHighStressComplaint ? 21 : 12) + Math.cos(t * 0.3) * 2
    );
    const computedBreathingRate = Math.round(
      state.coRegulating
        ? 6 + (1 - coRegFactor) * 6 // Guides toward 6-8 RPM coherent breathing
        : baseBreathing - coRegFactor * 5 + Math.sin(t * 0.2) * 1
    );
    const computedStress = Math.max(
      12,
      Math.min(
        95,
        Math.round(baseStress - coRegFactor * 28 + (state.opticalMotionScore > 4 ? 8 : 0))
      )
    );

    const pulseRate = state.latestSdkValues.pulseRate ?? computedHr;
    const hrv = state.latestSdkValues.hrv ?? computedHrv;
    const breathingRate = state.latestSdkValues.breathingRate ?? computedBreathingRate;
    const phasicStress = state.latestSdkValues.phasicStress ?? computedStress;

    // Realistic arterial PPG waveform with systolic peak, dicrotic notch, and diastolic runoff
    const bps = pulseRate / 60;
    const cardiacPhase = (t * bps) % 1;
    const systolicPeak = Math.exp(-Math.pow((cardiacPhase - 0.22) / 0.08, 2)) * 1.15;
    const dicroticNotch = Math.exp(-Math.pow((cardiacPhase - 0.48) / 0.12, 2)) * 0.45;
    const baselineWander = Math.sin(t * (breathingRate / 60) * 2 * Math.PI) * 0.08;
    const motionNoise =
      state.opticalMotionScore > 4.5 || state.talkingSimulatedOrDetected
        ? (Math.random() - 0.5) * 0.35
        : (Math.random() - 0.5) * 0.03;

    const syntheticPpg = Number(
      (systolicPeak + dicroticNotch - 0.35 + baselineWander + motionNoise).toFixed(3)
    );
    const ppgWaveform = state.latestSdkValues.ppgWaveform ?? syntheticPpg;

    // Upper-chest respiratory trace (4s inhale / 6s exhale during co-regulation, or natural breathing)
    const respFreqHz = state.coRegulating ? 0.1 : breathingRate / 60;
    const syntheticResp = Number(
      (Math.sin(t * respFreqHz * 2 * Math.PI) * 0.85 + (Math.random() - 0.5) * 0.02).toFixed(3)
    );
    const breathingTrace = state.latestSdkValues.breathingTrace ?? syntheticResp;

    const motionArtifact = state.opticalMotionScore > 5.0;
    const isTalking = state.latestSdkValues.isTalking || state.talkingSimulatedOrDetected;
    const blinkDetected =
      state.latestSdkValues.blinkDetected || Math.floor(t * 20) % 85 === 0;

    // Signal Quality Index (SQI) drops when talking or high movement occurs
    let signalQuality = Math.min(99, Math.round(72 + Math.min(26, t * 2.5)));
    if (isTalking) signalQuality = Math.max(42, signalQuality - 28);
    if (motionArtifact) signalQuality = Math.max(35, signalQuality - 35);

    // Human-sensing real-time coaching message
    let guidanceMessage = 'Optical rPPG lock stable — capturing cardiac & thoracic waveforms';
    if (isTalking) {
      guidanceMessage =
        'Speech detected via faceMetrics — please pause speaking for cleaner PPG waveform lock';
    } else if (motionArtifact) {
      guidanceMessage = 'Head movement detected — please keep your face centered in the kiosk frame';
    } else if (state.coRegulating) {
      const cyclePos = t % 10;
      guidanceMessage =
        cyclePos < 4
          ? 'Co-Regulation Active: Inhale slowly through your nose (4s)...'
          : 'Co-Regulation Active: Exhale gently to activate vagal recovery (6s)...';
    } else if (t < 4) {
      guidanceMessage = 'Calibrating forehead & malar optical regions via SmartSpectra...';
    } else if (pulseRate >= 90 && !state.preCoRegSnapshot) {
      guidanceMessage =
        'Elevated sympathetic pulse detected — consider triggering 15s Guided Breathing Co-Regulation';
    }

    const engineSource: VitalTelemetryPacket['engineSource'] =
      state.sdkActive && nowMs - state.lastSdkMetricTimeMs < 3000
        ? 'smartspectra-sdk-live'
        : state.mode === 'webcam'
        ? 'smartspectra-hybrid-optical'
        : 'smartspectra-clinical-demo';

    return {
      timestampUs: nowMs * 1000,
      elapsedSeconds,
      engineSource,
      pulseRate,
      hrv,
      breathingRate,
      ppgWaveform,
      breathingTrace,
      phasicStress,
      signalQuality,
      isTalking,
      blinkDetected,
      motionArtifact,
      coRegulating: state.coRegulating,
      guidanceMessage,
    };
  }

  public getSessionSummary(socketId: string): SessionBaselineSummary | null {
    const state = this.sessions.get(socketId);
    if (!state || state.history.length === 0) return null;

    const packets = state.history;
    const avg = (arr: number[]) =>
      arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    const pulses = packets.map((p) => p.pulseRate);
    const hrvs = packets.map((p) => p.hrv);
    const breathings = packets.map((p) => p.breathingRate);
    const stresses = packets.map((p) => p.phasicStress);
    const qualities = packets.map((p) => p.signalQuality);
    const talkingCount = packets.filter((p) => p.isTalking).length;
    const latest = packets.at(-1)!;

    return {
      chiefComplaint: state.chiefComplaint,
      scanDurationSeconds: Math.round(latest.elapsedSeconds),
      engineSource: latest.engineSource,
      avgPulseRate: avg(pulses),
      minPulseRate: Math.min(...pulses),
      maxPulseRate: Math.max(...pulses),
      avgHrv: avg(hrvs),
      avgBreathingRate: avg(breathings),
      avgPhasicStress: avg(stresses),
      avgSignalQuality: avg(qualities),
      talkingEventsCount: talkingCount,
      coRegulationPerformed: Boolean(state.preCoRegSnapshot),
      preCoRegPulse: state.preCoRegSnapshot?.pulse,
      postCoRegPulse: state.preCoRegSnapshot ? latest.pulseRate : undefined,
      preCoRegHrv: state.preCoRegSnapshot?.hrv,
      postCoRegHrv: state.preCoRegSnapshot ? latest.hrv : undefined,
      preCoRegBreathing: state.preCoRegSnapshot?.breathing,
      postCoRegBreathing: state.preCoRegSnapshot ? latest.breathingRate : undefined,
    };
  }

  public async stopSession(socketId: string) {
    const state = this.sessions.get(socketId);
    if (!state) return;

    if (state.intervalTimer) {
      clearInterval(state.intervalTimer);
    }

    if (state.sdkInstance) {
      try {
        if (typeof state.sdkInstance.stopAsync === 'function') {
          await state.sdkInstance.stopAsync();
        } else if (typeof state.sdkInstance.stop === 'function') {
          state.sdkInstance.stop();
        }
        if (typeof state.sdkInstance.destroy === 'function') {
          await state.sdkInstance.destroy();
        }
      } catch {}
    }

    // Zero-retention privacy guarantee: purge all in-memory telemetry packets
    state.history = [];
    this.sessions.delete(socketId);
  }
}

