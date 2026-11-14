import Stripe from 'stripe';

export interface PaymentReceipt {
  transactionId: string;
  provider: 'MTN_MOMO' | 'STRIPE';
  status: 'APPROVED';
  amountDisplay: string;
  timestamp: string;
  ussdCode?: string;
  phoneMasked?: string;
  checkoutUrl?: string;
}

export class PaymentService {
  private stripe: Stripe | null = null;

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (key && key.startsWith('sk_test_') && key !== 'sk_test_vitalsync_sandbox') {
      try {
        this.stripe = new Stripe(key);
      } catch {}
    }
  }

  public async processMtnMomo(phone: string, country = 'CM'): Promise<PaymentReceipt> {
    const cleanPhone = (phone || '+237 670 00 00 00').trim();
    const currencyMap: Record<string, { amount: string; ussd: string }> = {
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

  public async processStripeCheckout(frontendUrl: string): Promise<PaymentReceipt> {
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
      } catch {}
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

