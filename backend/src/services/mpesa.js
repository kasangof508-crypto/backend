import { config } from '../config.js';
import { HttpError } from '../utils/http.js';

let cachedToken;
let tokenExpiresAt = 0;

const apiBase = () => {
  if (config.mpesa.environment === 'sandbox') return 'https://sandbox.safaricom.co.ke';
  if (config.mpesa.environment === 'production') return 'https://api.safaricom.co.ke';
  throw new HttpError(503, 'M-Pesa environment must be sandbox or production');
};

export function normalizeKenyanPhone(phone) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  else if (digits.startsWith('7') || digits.startsWith('1')) digits = `254${digits}`;
  if (!/^254[17]\d{8}$/.test(digits)) throw new HttpError(400, 'Enter a valid Kenyan mobile number for M-Pesa');
  return digits;
}

export function assertMpesaConfigured() {
  const { consumerKey, consumerSecret, shortcode, passkey, callbackUrl } = config.mpesa;
  if (!['sandbox', 'production'].includes(config.mpesa.environment)) {
    throw new HttpError(503, 'M-Pesa environment must be sandbox or production');
  }
  if (!consumerKey || !consumerSecret || !shortcode || !passkey || !callbackUrl) {
    throw new HttpError(503, 'M-Pesa STK Push is not configured. Contact the system administrator.');
  }
  let callback;
  try { callback = new URL(callbackUrl); }
  catch { throw new HttpError(503, 'M-Pesa callback URL is invalid'); }
  if (callback.protocol !== 'https:' || callback.search || callback.hash) {
    throw new HttpError(503, 'M-Pesa callback must be a public HTTPS URL without query parameters');
  }
  if (!callback.pathname.replace(/\/+$/, '').endsWith('/api/v1/payments/mpesa/callback')) {
    throw new HttpError(503, 'M-Pesa callback URL must end in /api/v1/payments/mpesa/callback');
  }
  if (!['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'].includes(config.mpesa.transactionType)) {
    throw new HttpError(503, 'M-Pesa transaction type is invalid');
  }
}

async function getAccessToken(base) {
  if (cachedToken && tokenExpiresAt > Date.now() + 30_000) return cachedToken;
  const { consumerKey, consumerSecret } = config.mpesa;
  let response;
  try {
    response = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, 'Could not connect to M-Pesa');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) throw new HttpError(502, 'M-Pesa authentication failed');
  cachedToken = body.access_token;
  tokenExpiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
  return cachedToken;
}

function darajaTimestamp() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

export async function initiateStkPush({ saleId, phone, amount }) {
  assertMpesaConfigured();
  const timestamp = darajaTimestamp();
  const base = apiBase();
  const accessToken = await getAccessToken(base);
  const callbackUrl = `${config.mpesa.callbackUrl.replace(/\/+$/, '')}/${config.mpesa.callbackToken}`;
  let response;
  try {
    response = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        BusinessShortCode: config.mpesa.shortcode,
        Password: Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${timestamp}`).toString('base64'),
        Timestamp: timestamp,
        TransactionType: config.mpesa.transactionType,
        Amount: amount,
        PartyA: phone,
        PartyB: config.mpesa.shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: `SAFM${saleId}`,
        TransactionDesc: 'Farm produce sale',
      }),
    });
  } catch {
    throw new HttpError(503, 'M-Pesa did not confirm the payment request; check the transaction before retrying');
  }
  const body = await response.json().catch(() => null);
  if (response.status >= 500) {
    throw new HttpError(503, 'M-Pesa did not confirm the payment request; check the transaction before retrying');
  }
  if (!response.ok || body?.ResponseCode !== '0' || !body?.CheckoutRequestID || !body?.MerchantRequestID) {
    throw new HttpError(502, 'M-Pesa could not start the payment request');
  }
  return {
    checkoutRequestId: body.CheckoutRequestID,
    merchantRequestId: body.MerchantRequestID,
    customerMessage: body.CustomerMessage,
  };
}
