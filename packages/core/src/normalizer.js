import { ObserverSource, ObservationAttributionStatus, toPaise, calculateObservationFingerprint } from '@youpi/common';

export function extractIntelligentPaise(text) {
  if (!text || typeof text !== 'string') return null;

  const prefixMatch = text.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (prefixMatch && prefixMatch[1]) {
    const clean = prefixMatch[1].replace(/,/g, '');
    try { return toPaise(clean); } catch {}
  }

  const suffixMatch = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|inr|₹)/i);
  if (suffixMatch && suffixMatch[1]) {
    const clean = suffixMatch[1].replace(/,/g, '');
    try { return toPaise(clean); } catch {}
  }

  const creditProximityMatch = text.match(/(?:credited|received|deposit|payment|paid|transferred|upi|cr)[\s\w:]*?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)[\s\w:]*?(?:credited|received|deposit|payment|paid|transferred|upi|cr)/i);
  if (creditProximityMatch) {
    const rawVal = creditProximityMatch[1] || creditProximityMatch[2];
    if (rawVal) {
      const clean = rawVal.replace(/,/g, '');
      if (/^\d+(\.\d{1,2})?$/.test(clean) && Number(clean) < 10000000 && Number(clean) > 0) {
        try { return toPaise(clean); } catch {}
      }
    }
  }

  const standaloneDecimal = text.match(/\b(\d{1,6}\.\d{2})\b/);
  if (standaloneDecimal && standaloneDecimal[1]) {
    try { return toPaise(standaloneDecimal[1]); } catch {}
  }

  return null;
}

const REFERENCE_REGEX = /(?:utr|ref(?:\s*no\.?)?|txn(?:\s*(?:id|#))?|transaction\s*id|rrn|reference(?:\s*no\.?)?|upi(?:\s*(?:ref|reference|txn))?)[:\s#]+([a-zA-Z0-9\-_]{6,35})/i;

const SENDER_VPA_REGEX = /(?:from|by|vpa|upi\s*id)[\s:]+(?:[a-zA-Z\s]+[\(\[])?([a-zA-Z0-9.\-_]{2,100}@[a-zA-Z0-9.\-_]{2,64})/i;

export class ObservationNormalizer {
  static normalize(input) {
    if (!input.receivingAccountId) {
      throw new Error('Observation normalization failed: receivingAccountId is required.');
    }
    if (!input.source || !Object.values(ObserverSource).includes(input.source)) {
      throw new Error(`Observation normalization failed: invalid or unknown source '${input.source}'.`);
    }

    const payload = input.rawPayload || {};
    const textContent = (payload.text || payload.body || payload.notificationText || payload.snippet || '').toString();

    let finalAmountPaise;
    if (input.amountPaise !== undefined && input.amountPaise !== null && input.amountPaise !== '') {
      finalAmountPaise = BigInt(input.amountPaise);
    } else if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
      finalAmountPaise = toPaise(input.amount);
    } else {
      const extracted = extractIntelligentPaise(textContent);
      if (!extracted) {
        throw new Error(`Observation normalization failed: could not extract valid monetary amount from payload text: "${textContent}"`);
      }
      finalAmountPaise = extracted;
    }

    let observedAtDate;
    if (input.observedAt) {
      observedAtDate = input.observedAt instanceof Date ? input.observedAt : new Date(input.observedAt);
    } else if (payload.timestamp || payload.postTime || payload.date) {
      const rawTs = payload.timestamp || payload.postTime || payload.date;
      observedAtDate = new Date(typeof rawTs === 'number' ? rawTs : rawTs.toString());
    } else {
      observedAtDate = new Date();
    }

    if (isNaN(observedAtDate.getTime())) {
      observedAtDate = new Date();
    }

    let bankRef = input.bankReferenceNumber;
    if (!bankRef && textContent) {
      const refMatch = textContent.match(REFERENCE_REGEX);
      if (refMatch && refMatch[1]) {
        bankRef = refMatch[1].trim();
      }
    }

    let senderVpa = input.senderVpa;
    if (!senderVpa && textContent) {
      const vpaMatch = textContent.match(SENDER_VPA_REGEX);
      if (vpaMatch && vpaMatch[1]) {
        senderVpa = vpaMatch[1].trim().replace(/[.,;]+$/, '');
      }
    }

    const fingerprintHash = calculateObservationFingerprint({
      receivingAccountId: input.receivingAccountId,
      amountPaise: finalAmountPaise,
      source: input.source,
      bankReferenceNumber: bankRef,
      observedAt: observedAtDate
    });

    return {
      receivingAccountId: input.receivingAccountId,
      source: input.source,
      amountPaise: finalAmountPaise,
      observedAt: observedAtDate,
      senderVpa: senderVpa || undefined,
      bankReferenceNumber: bankRef || undefined,
      fingerprintHash,
      attributionStatus: ObservationAttributionStatus.UNATTRIBUTED,
      rawPayload: payload
    };
  }
}
