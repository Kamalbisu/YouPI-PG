import { extractIntelligentAmount } from './bank-sms-parser.js';

export { extractIntelligentAmount };

export class BankEmailParser {
  static parse(email) {
    if (!email) return null;
    const combinedText = `${email.subject || ''} ${email.body || ''}`.trim();
    if (!combinedText) return null;

    const creditKeywords = new RegExp(
      '\\b(?:credited|credit|received|deposit(?:ed)?|payment\\s+received|upi\\/cr' +
      '|transferred\\s+to\\s+(?:your\\s+)?(?:a\\/c|account|wallet)' +
      '|payment\\s+of\\s+(?:(?:rs\\b\\.?|inr\\b)\\s*)?[\\d,.]+\\s+(?:has\\s+been\\s+)?made\\s+to\\s+(?:your\\s+)?(?:a\\/c|account|wallet)' +
      '|added\\s+to\\s+(?:your\\s+)?(?:account|wallet))\\b',
      'i'
    );
    if (!creditKeywords.test(combinedText)) {
      return null;
    }

    const debitIdx = combinedText.search(/\b(?:debited|withdrawn|deducted|spent|paid rs|sent rs)\b/i);
    const creditIdx = combinedText.search(/\b(?:credited|credit|received|deposit|deposited)\b/i);
    if (debitIdx !== -1 && (creditIdx === -1 || debitIdx < creditIdx)) {
      return null;
    }

    const extractedAmount = extractIntelligentAmount(combinedText);
    if (!extractedAmount) {
      return null;
    }

    let bankRef;
    const refMatch = combinedText.match(/(?:utr|ref(?:\s*no)?|txn(?:\s*id)?|rrn)[:\s#]+([a-zA-Z0-9\-_]{6,35})/i);
    if (refMatch && refMatch[1]) {
      bankRef = refMatch[1].trim();
    } else {
      const upiCrMatch = combinedText.match(/UPI\/CR\/([a-zA-Z0-9\-_]+)/i);
      if (upiCrMatch && upiCrMatch[1]) {
        bankRef = upiCrMatch[1].trim();
      } else {
        const d12Match = combinedText.match(/\b([0-9]{12})\b/);
        if (d12Match && d12Match[1]) {
          bankRef = d12Match[1].trim();
        }
      }
    }

    let senderVpa;
    const vpaMatch = combinedText.match(/(?:from|by|vpa)\s+([a-zA-Z0-9.\-_]{2,100}@[a-zA-Z0-9.\-_]{2,64})/i);
    if (vpaMatch && vpaMatch[1]) {
      senderVpa = vpaMatch[1].trim().replace(/[.,;]+$/, '');
    }

    let observedAt = new Date();
    if (email.date) {
      const parsedDate = new Date(email.date);
      if (!isNaN(parsedDate.getTime())) {
        observedAt = parsedDate;
      }
    }

    return {
      amountPaise: extractedAmount.amountPaise,
      amount: extractedAmount.amountStr,
      bankReferenceNumber: bankRef,
      senderVpa,
      observedAt,
      rawSnippet: combinedText.substring(0, 300)
    };
  }
}
