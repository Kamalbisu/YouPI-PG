import { generateHmac, getObserverToken } from '@youpi/common';

export class PaymentObserverClient {
  constructor(options) {
    this.apiBaseUrl = (options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100').replace(/\/+$/, '');
    this.sourceName = options.sourceName;
  }

  async submitObservation(data) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/events`;
    const payload = {
      source: this.sourceName,
      receivingAccountId: data.receivingAccountId,
      amountPaise: data.amountPaise !== undefined ? data.amountPaise.toString() : undefined,
      amount: data.amount,
      observedAt: (data.observedAt instanceof Date ? data.observedAt : new Date(data.observedAt || Date.now())).toISOString(),
      senderVpa: data.senderVpa,
      bankReferenceNumber: data.bankReferenceNumber,
      sender: data.sender || data.rawPayload?.sender || data.rawPayload?.from,
      rawText: data.rawText || data.rawPayload?.text || data.rawPayload?.body,
      rawPayload: data.rawPayload || {}
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getObserverToken()}` },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Observer submit failed [HTTP ${res.status}]: ${errBody}`);
    }

    return await res.json();
  }

  async getActiveWindow() {
    const url = `${this.apiBaseUrl}/api/v1/pollers/active-window`;
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${getObserverToken()}` },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        const data = await res.json();
        return data.sessions || [];
      }
    } catch {}
    return [];
  }

  async submitAndroidSigned(data) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/events`;
    const timestamp = Date.now().toString();

    const bodyObj = {
      deviceId: data.deviceId,
      receivingAccountId: data.receivingAccountId,
      amount: data.amount,
      amountPaise: data.amountPaise !== undefined ? data.amountPaise.toString() : undefined,
      observedAt: (data.observedAt instanceof Date ? data.observedAt : new Date(data.observedAt || Date.now())).toISOString(),
      rawNotification: data.rawNotification || {}
    };

    const bodyString = JSON.stringify(bodyObj);
    const sigPayload = `${bodyString}:${timestamp}`;
    const signature = generateHmac(sigPayload, data.signingKey);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': data.deviceId,
        'X-Timestamp': timestamp,
        'X-Signature': signature
      },
      body: bodyString
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Android observation submit failed [HTTP ${res.status}]: ${errBody}`);
    }

    return await res.json();
  }

  async submitHeartbeat(deviceId) {
    const url = `${this.apiBaseUrl}/api/v1/pollers/android/heartbeat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId
      },
      body: JSON.stringify({ deviceId })
    });
    return await res.json();
  }
}
