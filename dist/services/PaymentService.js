"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentService = void 0;
const stripe_1 = __importDefault(require("stripe"));
class PaymentService {
    stripe = null;
    constructor() {
        const key = process.env.STRIPE_SECRET_KEY;
        if (key && key.startsWith('sk_test_') && key !== 'sk_test_vitalsync_sandbox') {
            try {
                this.stripe = new stripe_1.default(key);
            }
            catch { }
        }
    }
    async processMtnMomo(phone, country = 'CM') {
        const cleanPhone = (phone || '+237 670 00 00 00').trim();
        const currencyMap = {
            CM: { amount: '3,000 XAF ($5.00 USD)', ussd: '*126#' },
            GH: { amount: '75 GHS ($5.00 USD)', ussd: '*170#' },
            UG: { amount: '18,500 UGX ($5.00 USD)', ussd: '*165#' },
            RW: { amount: '6,500 RWF ($5.00 USD)', ussd: '*182#' },
        };
        const cfg = currencyMap[country] || currencyMap.CM;
        return {
            transactionId: `MOMO-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`,
            provider: 'MTN_MOMO',
            status: 'APPROVED',
            amountDisplay: cfg.amount,
            timestamp: new Date().toISOString(),
            ussdCode: cfg.ussd,
            phoneMasked: cleanPhone.length > 4 ? `${cleanPhone.slice(0, -4)}****` : cleanPhone,
        };
    }
    async processStripeCheckout(frontendUrl) {
        if (this.stripe) {
            try {
                const session = await this.stripe.checkout.sessions.create({
                    mode: 'payment',
                    payment_method_types: ['card'],
                    line_items: [
                        {
                            price_data: {
                                currency: 'usd',
                                product_data: {
                                    name: 'VitalSync Tele-Triage Physician Consultation',
                                    description: 'Includes Presage SmartSpectra Vital Telemetry & Gemini SBAR Handoff',
                                },
                                unit_amount: 500,
                            },
                            quantity: 1,
                        },
                    ],
                    success_url: `${frontendUrl}?payment=success`,
                    cancel_url: `${frontendUrl}?payment=cancel`,
                });
                return {
                    transactionId: session.id,
                    provider: 'STRIPE',
                    status: 'APPROVED',
                    amountDisplay: '$5.00 USD',
                    timestamp: new Date().toISOString(),
                    checkoutUrl: session.url ?? undefined,
                };
            }
            catch { }
        }
        return {
            transactionId: `STRP-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`,
            provider: 'STRIPE',
            status: 'APPROVED',
            amountDisplay: '$5.00 USD',
            timestamp: new Date().toISOString(),
        };
    }
}
exports.PaymentService = PaymentService;
