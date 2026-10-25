import { toPaise } from '@youpi/common';

export function extractIntelligentAmount(text) {
  if (!text || typeof text !== 'string') return null;

  const normalizedText = text.replace(/\s+/g, ' ');

  const balancePattern = /(?:(?:avl\b|avail\b|available\b|tot\b|total\b|ledger\b|clear\b|curr\b|current\b)\s*(?:bal\b|balance\b|limit\b)?|bal\b|balance\b)[\s:=-]*(?:(?:rs\b\.?|inr\b)|₹)?[\s:=-]*[\d,]+(?:\.\d{1,2})?/gi;
  const sanitizedText = normalizedText.replace(balancePattern, ' ').trim();

  const directCreditMatch = sanitizedText.match(/(?:credited\s*(?:with|by|for)?|received|deposit(?:ed)?)\s*[:=-]?\s*(?:(?:rs\b\.?|inr\b)|₹)?[\s:=-]*([\d,]+(?:\.\d{1,2})?)/i) ||
    sanitizedText.match(/(?:(?:rs\b\.?|inr\b)|₹)[\s:=-]*([\d,]+(?:\.\d{1,2})?)\s*(?:(?:has\s+been|is)\s+)?(?:credited|received|deposited)/i);
  if (directCreditMatch && (directCreditMatch[1] || directCreditMatch[2])) {
    const clean = (directCreditMatch[1] || directCreditMatch[2]).replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  const prefixMatch = sanitizedText.match(/(?:(?:rs\b\.?|inr\b)|₹)[\s:=-]*([\d,]+(?:\.\d{1,2})?)/i);
  if (prefixMatch && prefixMatch[1]) {
    const clean = prefixMatch[1].replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  const suffixMatch = sanitizedText.match(/(?:^|[^\w.])([\d,]+(?:\.\d{1,2})?)[\s:=-]*(?:(?:rs\b\.?|inr\b)|₹)/i);
  if (suffixMatch && suffixMatch[1]) {
    const clean = suffixMatch[1].replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  const creditProximityMatch = sanitizedText.match(/(?:credited|received|deposit|cr)[\s\w:]*?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)[\s\w:]*?(?:credited|received|deposit|cr)/i);
  if (creditProximityMatch) {
    const rawVal = creditProximityMatch[1] || creditProximityMatch[2];
    if (rawVal) {
      const clean = rawVal.replace(/,/g, '');
      if (/^\d+(\.\d{1,2})?$/.test(clean) && Number(clean) < 10000000 && Number(clean) > 0) {
        try {
          return { amountStr: clean, amountPaise: toPaise(clean) };
        } catch {}
      }
    }
  }

  const standaloneDecimal = sanitizedText.match(/\b(\d{1,6}\.\d{2})\b/);
  if (standaloneDecimal && standaloneDecimal[1]) {
    const clean = standaloneDecimal[1];
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  return null;
}

export class BankSmsParser {
  static parse(sms) {
    const MAX_SCAN_CHARS = 4096;
    const text = (sms.text || '').trim().slice(0, MAX_SCAN_CHARS);
    if (!text) return null;

    const creditKeywords = new RegExp(
      '\\b(?:credited|received|deposit(?:ed)?|payment\\s+received|money\\s+received|upi\\/cr' +
      '|transferred\\s+to\\s+(?:your\\s+)?(?:a\\/c|account|wallet)' +
      '|payment\\s+of\\s+(?:(?:rs\\b\\.?|inr\\b)\\s*)?[\\d,.]+\\s+(?:has\\s+been\\s+)?made\\s+to\\s+(?:your\\s+)?(?:a\\/c|account|wallet)' +
      '|added\\s+to\\s+(?:your\\s+)?(?:account|wallet))\\b',
      'i'
    );
    if (!creditKeywords.test(text)) {
      return null;
    }

    const debitIdx = text.search(/\b(?:debited|withdrawn|deducted|spent|paid rs|sent rs)\b/i);
    const creditIdx = text.search(/\b(?:credited|received|deposit|deposited)\b/i);
    if (debitIdx !== -1 && (creditIdx === -1 || debitIdx < creditIdx)) {
      return null;
    }

    const extractedAmount = extractIntelligentAmount(text);
    if (!extractedAmount) {
      return null;
    }

    let bankRef;
    const utrPatterns = [
      /(?:upi\s*ref(?:erence)?\s*(?:no\.?|num)?|utr(?:\s*no\.?)?|rrn(?:\s*no\.?)?|txn\s*(?:id|ref|#)?|transaction\s*id|ref\s*no\.?)[\s:=-]+([a-zA-Z0-9\-_]{6,35})/i,
      /(?:upi\/(?:[0-9]+\/|cr\/)([a-zA-Z0-9\-_]{6,35}))/i,
      /\b(?:ref(?:\s*(?:no\.?|id|#))?)[:\s#=-]+([a-zA-Z0-9\-_]{6,35})/i,
      /\b([0-9]{12})\b/
    ];

    for (const pat of utrPatterns) {
      const match = text.match(pat);
      if (match && match[1]) {
        bankRef = match[1].trim();
        break;
      }
    }

    let senderVpa;
    const vpaMatch = text.match(/(?:from|by|vpa|upi\s*id)[\s:]+(?:[a-zA-Z\s]+[\(\[])?([a-zA-Z0-9.\-_]{2,64}@[a-zA-Z0-9.\-_]{2,32})/i);
    if (vpaMatch && vpaMatch[1]) {
      senderVpa = vpaMatch[1].trim().replace(/[.,;]+$/, '');
    }

    let observedAt = new Date();
    if (sms.timestamp) {
      const parsed = new Date(sms.timestamp);
      if (!isNaN(parsed.getTime())) {
        observedAt = parsed;
      }
    }

    return {
      amountPaise: extractedAmount.amountPaise,
      amount: extractedAmount.amountStr,
      bankReferenceNumber: bankRef,
      senderVpa,
      observedAt,
      rawText: text
    };
  }
}
