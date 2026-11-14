"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiService = void 0;
const genai_1 = require("@google/genai");
const GEMINI_2X_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
];
class GeminiService {
    ai = null;
    workingModel = null;
    unavailableModels = new Set();
    constructor() {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
            try {
                this.ai = new genai_1.GoogleGenAI({ apiKey });
            }
            catch {
                console.warn('[GeminiService] Initialized with rule-based summary fallback');
            }
        }
    }
    async generateTriageReport(summary) {
        if (this.ai) {
            try {
                const prompt = `You are a non-diagnostic pre-consultation wellness & physiological intake assistant summarizing contactless optical signals captured via the Presage SmartSpectra SDK.
IMPORTANT RULES:
- Do NOT diagnose any medical condition or recommend medical treatment.
- Frame all observations as neutral, non-diagnostic physiological context for the patient and their clinician.
- Report exact numbers from the input without inventing changes.

Session Telemetry Summary:
${JSON.stringify(summary, null, 2)}

Return ONLY a valid JSON object matching this exact structure:
{
  "observationLevel": "Steady Baseline" | "Elevated Sympathetic Arousal Observed" | "Notable Physiological Variance — Discuss with Clinician",
  "autonomicState": "1-sentence neutral observation of pulse (${summary.avgPulseRate} BPM), RMSSD HRV (${summary.avgHrv} ms), and breathing rate (${summary.avgBreathingRate} RPM)",
  "patientSummary": "2-3 warm, reassuring, strictly non-diagnostic sentences summarizing the recorded signals for the user",
  "clinicianSbar": {
    "situation": "Visit reason and recorded baseline vital sign headline",
    "background": "${summary.scanDurationSeconds}s SmartSpectra scan (${summary.isSimulated ? 'Simulated Demo Mode' : 'Live Optical Capture'}, mean SQI ${summary.avgSignalQuality}%)",
    "assessment": "Neutral summary of pulse (${summary.avgPulseRate} BPM), HRV RMSSD (${summary.avgHrv} ms), breathing (${summary.avgBreathingRate} RPM), and inhale/exhale ratio (${summary.avgInhaleExhaleRatio ?? 'N/A'})",
    "recommendation": "Non-diagnostic pre-consultation intake context to discuss during the visit"
  },
  "coRegulationAnalysis": "Exact comparison of pre- vs post-paced-breathing values if coRegulationPerformed is true, or note that paced breathing was not used",
  "suggestedQuestions": ["Question 1", "Question 2", "Question 3"]
}`;
                const candidates = [
                    this.workingModel,
                    process.env.GEMINI_MODEL,
                    ...GEMINI_2X_MODELS,
                ].filter((m, i, arr) => Boolean(m) && arr.indexOf(m) === i && !this.unavailableModels.has(m));
                let text;
                let usedModel = candidates[0] ?? GEMINI_2X_MODELS[0];
                let lastErr;
                for (const modelName of candidates) {
                    try {
                        const response = await this.ai.models.generateContent({
                            model: modelName,
                            contents: prompt,
                            config: {
                                responseMimeType: 'application/json',
                            },
                        });
                        if (response.text) {
                            text = response.text;
                            usedModel = modelName;
                            this.workingModel = modelName;
                            break;
                        }
                    }
                    catch (modelErr) {
                        lastErr = modelErr;
                        const msg = String(modelErr?.message || modelErr);
                        if (msg.includes('"code":404') || msg.includes('NOT_FOUND')) {
                            this.unavailableModels.add(modelName);
                        }
                        console.warn(`[GeminiService] ${modelName} failed: ${msg.slice(0, 160)}`);
                    }
                }
                if (!text && lastErr) {
                    throw lastErr;
                }
                if (text) {
                    const parsed = JSON.parse(text);
                    return {
                        generatedAt: new Date().toISOString(),
                        aiEngine: `Google ${usedModel} (@google/genai)`,
                        isSimulatedData: Boolean(summary.isSimulated),
                        observationLevel: parsed.observationLevel || 'Steady Baseline',
                        autonomicState: parsed.autonomicState,
                        patientSummary: parsed.patientSummary,
                        clinicianSbar: parsed.clinicianSbar,
                        coRegulationAnalysis: parsed.coRegulationAnalysis,
                        suggestedQuestions: parsed.suggestedQuestions || [],
                        disclaimer: 'Not a medical device. This summary provides non-diagnostic physiological observations captured via Presage SmartSpectra and formatted by Google Gemini for informational pre-consultation context only.',
                    };
                }
            }
            catch (err) {
                console.warn('[GeminiService] Live API call fell back to rule-based summary:', err?.message || err);
            }
        }
        return this.buildRuleBasedReport(summary);
    }
    buildRuleBasedReport(summary) {
        const isElevated = summary.avgPulseRate >= 90 || summary.avgHrv < 35;
        const isNotable = summary.avgPulseRate >= 102 || summary.avgBreathingRate >= 22;
        const observationLevel = isNotable
            ? 'Notable Physiological Variance — Discuss with Clinician'
            : isElevated
                ? 'Elevated Sympathetic Arousal Observed'
                : 'Steady Baseline';
        const hrDelta = summary.coRegulationPerformed &&
            summary.preCoRegPulse !== undefined &&
            summary.postCoRegPulse !== undefined
            ? summary.postCoRegPulse - summary.preCoRegPulse
            : null;
        const hrvDelta = summary.coRegulationPerformed &&
            summary.preCoRegHrv !== undefined &&
            summary.postCoRegHrv !== undefined
            ? summary.postCoRegHrv - summary.preCoRegHrv
            : null;
        const sourceLabel = summary.isSimulated
            ? 'Simulated Demo Mode'
            : 'Live SmartSpectra Optical Capture';
        const autonomicState = `Observed mean pulse of ${summary.avgPulseRate} BPM (range ${summary.minPulseRate}–${summary.maxPulseRate} BPM), RMSSD HRV of ${summary.avgHrv} ms, and breathing rate of ${summary.avgBreathingRate} RPM (${sourceLabel}).`;
        const patientSummary = summary.coRegulationPerformed && hrDelta !== null
            ? `Your ${summary.scanDurationSeconds}-second pre-consultation scan (${sourceLabel}, ${summary.avgSignalQuality}% signal quality) recorded an average pulse of ${summary.avgPulseRate} BPM and breathing rate of ${summary.avgBreathingRate} breaths per minute. During the 15-second paced breathing exercise, your pulse moved from ${summary.preCoRegPulse} BPM to ${summary.postCoRegPulse} BPM (${hrDelta >= 0 ? `+${hrDelta}` : hrDelta} BPM).`
            : `Your ${summary.scanDurationSeconds}-second pre-consultation scan (${sourceLabel}, ${summary.avgSignalQuality}% signal quality) recorded an average pulse of ${summary.avgPulseRate} BPM, HRV (RMSSD) of ${summary.avgHrv} ms, and a breathing rate of ${summary.avgBreathingRate} breaths per minute.`;
        const coRegulationAnalysis = summary.coRegulationPerformed && hrDelta !== null && hrvDelta !== null
            ? `15s paced breathing completed (0.1 Hz guide). Pulse changed from ${summary.preCoRegPulse} BPM to ${summary.postCoRegPulse} BPM (Δ ${hrDelta >= 0 ? `+${hrDelta}` : hrDelta} BPM); RMSSD HRV changed from ${summary.preCoRegHrv} ms to ${summary.postCoRegHrv} ms (Δ ${hrvDelta >= 0 ? `+${hrvDelta}` : hrvDelta} ms); breathing rate shifted from ${summary.preCoRegBreathing} RPM to ${summary.postCoRegBreathing} RPM.`
            : `Guided paced breathing was not activated during this ${summary.scanDurationSeconds}s session.`;
        return {
            generatedAt: new Date().toISOString(),
            aiEngine: 'Rule-based summary (Gemini unavailable)',
            isSimulatedData: Boolean(summary.isSimulated),
            observationLevel,
            autonomicState,
            patientSummary,
            clinicianSbar: {
                situation: `Pre-consultation check-in for "${summary.chiefComplaint}". Mean pulse ${summary.avgPulseRate} BPM (range ${summary.minPulseRate}–${summary.maxPulseRate} BPM), breathing rate ${summary.avgBreathingRate} RPM.`,
                background: `${summary.scanDurationSeconds}s contactless scan (${sourceLabel}, mean SQI ${summary.avgSignalQuality}%, speech artifact frames: ${summary.talkingEventsCount}).`,
                assessment: `RMSSD HRV recorded at ${summary.avgHrv} ms; inhale/exhale ratio ${summary.avgInhaleExhaleRatio ?? 'N/A'}. ${coRegulationAnalysis}`,
                recommendation: 'Review these non-diagnostic baseline observations alongside the patient’s self-reported visit context during the consultation.',
            },
            coRegulationAnalysis,
            suggestedQuestions: [
                `Regarding "${summary.chiefComplaint}", when did you first notice this and what seems to make it better or worse?`,
                'How does your current resting energy or breathing feel compared to your typical day-to-day baseline?',
                'Have you recently had caffeine, strenuous exercise, or changes in sleep that might influence your resting pulse?',
            ],
            disclaimer: 'Not a medical device. This summary provides non-diagnostic physiological observations captured via Presage SmartSpectra for informational pre-consultation context only.',
        };
    }
}
exports.GeminiService = GeminiService;
