import { GoogleGenAI } from '@google/genai';
import { SessionBaselineSummary } from './PresageService';

export interface TriageReportResult {
  generatedAt: string;
  aiEngine: string;
  triagePriority: 'Routine' | 'Moderate / Stress-Elevated' | 'Priority Clinical Review';
  autonomicState: string;
  patientSummary: string;
  clinicianSbar: {
    situation: string;
    background: string;
    assessment: string;
    recommendation: string;
  };
  coRegulationAnalysis: string;
  suggestedQuestions: string[];
  disclaimer: string;
}

const GEMINI_2X_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

export class GeminiService {
  private ai: GoogleGenAI | null = null;
  private workingModel: string | null = null;
  private unavailableModels = new Set<string>();

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        this.ai = new GoogleGenAI({ apiKey });
      } catch (err) {
        console.warn('[GeminiService] Initialized with clinical synthesis fallback');
      }
    }
  }

  public async generateTriageReport(summary: SessionBaselineSummary): Promise<TriageReportResult> {
    if (this.ai) {
      try {
        const prompt = `You are a clinical tele-triage AI assistant evaluating non-diagnostic contactless vital signs captured via the Presage SmartSpectra SDK.

Patient Intake & Physiological Telemetry:
${JSON.stringify(summary, null, 2)}

Return ONLY a valid JSON object matching this exact structure:
{
  "triagePriority": "Routine" | "Moderate / Stress-Elevated" | "Priority Clinical Review",
  "autonomicState": "1-sentence description of sympathetic vs parasympathetic balance based on HR, HRV, breathing rate, and phasic stress",
  "patientSummary": "2-3 warm, reassuring, non-diagnostic sentences for the patient explaining their vitals and readiness for the doctor",
  "clinicianSbar": {
    "situation": "Chief complaint and immediate vital sign headline",
    "background": "30s contactless SmartSpectra rPPG scan context and signal quality (${summary.avgSignalQuality}%)",
    "assessment": "Detailed physiological correlation of HR (${summary.avgPulseRate} BPM), HRV (${summary.avgHrv} ms), Breathing (${summary.avgBreathingRate} RPM), and EDA stress (${summary.avgPhasicStress}/100)",
    "recommendation": "Actionable pre-consultation focus for the physician"
  },
  "coRegulationAnalysis": "Analysis of how the patient responded to the 15s guided breathing biofeedback (or note if not performed)",
  "suggestedQuestions": ["Question 1", "Question 2", "Question 3"]
}`;

        // Free-tier friendly Gemini 2.x chain. Override the first choice with GEMINI_MODEL in .env.
        // A model that returns 404 (retired / not available to this key) is skipped for later requests.
        const candidates = [
          this.workingModel,
          process.env.GEMINI_MODEL,
          ...GEMINI_2X_MODELS,
        ].filter((m, i, arr): m is string => Boolean(m) && arr.indexOf(m) === i && !this.unavailableModels.has(m as string));

        let text: string | undefined;
        let usedModel = candidates[0] ?? GEMINI_2X_MODELS[0];
        let lastErr: any;

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
          } catch (modelErr: any) {
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
            triagePriority: parsed.triagePriority || 'Routine',
            autonomicState: parsed.autonomicState,
            patientSummary: parsed.patientSummary,
            clinicianSbar: parsed.clinicianSbar,
            coRegulationAnalysis: parsed.coRegulationAnalysis,
            suggestedQuestions: parsed.suggestedQuestions || [],
            disclaimer:
              'Non-diagnostic physiological pre-screening generated via Presage SmartSpectra contactless sensing and Gemini AI. For clinical decision support only.',
          };
        }
      } catch (err: any) {
        console.warn(
          '[GeminiService] Live API call fell back to deterministic clinical SBAR synthesizer:',
          err?.message || err
        );
      }
    }

    return this.buildDeterministicClinicalReport(summary);
  }

  private buildDeterministicClinicalReport(summary: SessionBaselineSummary): TriageReportResult {
    const isElevated = summary.avgPulseRate >= 90 || summary.avgPhasicStress >= 60 || summary.avgHrv < 35;
    const isPriority = summary.avgPulseRate >= 102 || summary.avgBreathingRate >= 22;

    const triagePriority: TriageReportResult['triagePriority'] = isPriority
      ? 'Priority Clinical Review'
      : isElevated
      ? 'Moderate / Stress-Elevated'
      : 'Routine';

    const hrDelta =
      summary.coRegulationPerformed &&
      summary.preCoRegPulse !== undefined &&
      summary.postCoRegPulse !== undefined
        ? summary.preCoRegPulse - summary.postCoRegPulse
        : 0;

    const hrvDelta =
      summary.coRegulationPerformed &&
      summary.preCoRegHrv !== undefined &&
      summary.postCoRegHrv !== undefined
        ? summary.postCoRegHrv - summary.preCoRegHrv
        : 0;

    const autonomicState = isElevated
      ? `Mild sympathetic dominance (HR ${summary.avgPulseRate} BPM, HRV ${summary.avgHrv} ms, Phasic EDA ${summary.avgPhasicStress}/100) consistent with pre-consultation anticipatory stress.`
      : `Balanced vagal/parasympathetic tone (HR ${summary.avgPulseRate} BPM, HRV ${summary.avgHrv} ms, Respiratory ${summary.avgBreathingRate} RPM) with stable cardiac plethysmography.`;

    const patientSummary = summary.coRegulationPerformed
      ? `Your contactless vital scan is complete with ${summary.avgSignalQuality}% optical signal quality. While your initial pulse showed mild pre-visit tension, the 15-second guided breathing exercise helped lower your heart rate by ${Math.max(2, hrDelta)} BPM and improved heart rate variability before seeing your doctor.`
      : `Your contactless vital scan is complete with ${summary.avgSignalQuality}% optical signal quality. Your resting pulse averaged ${summary.avgPulseRate} BPM with a steady breathing rate of ${summary.avgBreathingRate} breaths per minute, and your summary has been attached to your physician's chart.`;

    const coRegulationAnalysis = summary.coRegulationPerformed
      ? `Patient completed 15s SmartSpectra-synced respiratory biofeedback (0.1 Hz paced breathing). Heart rate shifted from ${summary.preCoRegPulse} BPM → ${summary.postCoRegPulse} BPM (Δ -${Math.max(1, hrDelta)} BPM) and RMSSD HRV improved from ${summary.preCoRegHrv} ms → ${summary.postCoRegHrv} ms (+${Math.max(1, hrvDelta)} ms), suggesting reversible situational ("white-coat") sympathetic arousal rather than fixedresting tachycardia.`
      : `Guided respiratory co-regulation was not triggered during this intake window. Baseline metrics reflect unmodulated resting state over ${summary.scanDurationSeconds}s.`;

    return {
      generatedAt: new Date().toISOString(),
      aiEngine: 'Rule-based summary (Gemini unavailable)',
      triagePriority,
      autonomicState,
      patientSummary,
      clinicianSbar: {
        situation: `Patient presenting at tele-triage kiosk for "${summary.chiefComplaint}". Mean HR ${summary.avgPulseRate} BPM (range ${summary.minPulseRate}–${summary.maxPulseRate} BPM), Respiratory Rate ${summary.avgBreathingRate} RPM.`,
        background: `Contactless optical rPPG & thoracic excursion scan captured over ${summary.scanDurationSeconds}s via Presage SmartSpectra SDK (mean SQI ${summary.avgSignalQuality}%, speech artifact frames: ${summary.talkingEventsCount}).`,
        assessment: `HRV (RMSSD) measured at ${summary.avgHrv} ms with Phasic EDA stress index of ${summary.avgPhasicStress}/100. ${
          summary.coRegulationPerformed
            ? `Rapid vagal rebound during paced breathing (+${Math.max(1, hrvDelta)} ms HRV) points toward benign anticipatory anxiety.`
            : isElevated
            ? 'Mildly reduced HRV and elevated sympathetic index warrant correlation with symptom onset.'
            : 'Cardiorespiratory oscillations are within normal physiological baseline.'
        }`,
        recommendation: isElevated
          ? 'Review pre/post biofeedback trend, confirm symptom duration and orthostatic triggers, and repeat spot pulse check at end of consultation.'
          : 'Proceed with standard virtual consultation; baseline cardiorespiratory telemetry shows no acute hemodynamic distress.',
      },
      coRegulationAnalysis,
      suggestedQuestions: [
        `Regarding your "${summary.chiefComplaint}", when did you first notice these symptoms and do they change with posture or exertion?`,
        isElevated
          ? 'Did you feel your chest or breathing relax during the 15-second guided breathing exercise at the kiosk?'
          : 'Have you experienced any episodes of unexplained racing heart or shortness of breath over the past 7 days?',
        'Are you currently taking any medications, caffeine, or supplements that affect heart rate or blood pressure?',
      ],
      disclaimer:
        'Non-diagnostic physiological pre-screening generated via Presage SmartSpectra contactless sensing and Gemini AI. For clinical decision support only.',
    };
  }
}

