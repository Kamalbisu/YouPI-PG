import crypto from 'node:crypto';
import {
  ObserverSource,
  PaymentStatus,
  calculateObservationFingerprint
} from '@youpi/common';
import { extractIntelligentAmount } from './bank-sms-parser.js';
import { ObservationNormalizer } from './normalizer.js';


export class PaymentVerificationPipeline {
  constructor(options) {
    this.db = options.db;
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.customerRepo = options.customerRepo;
    this.attributionEngine = options.attributionEngine;
    this.auditRepo = options.auditRepo;
    this.merchantRepo = options.merchantRepo;
    this.server = options.server || null;
    this.eventEmitter = options.eventEmitter || null;
  }

  process(input) {
    const isTest = Boolean(input.isTest);
    const isProductionMode = process.env.NODE_ENV === 'production' || process.env.YOUPI_MODE === 'production';
    const testModeActive = Boolean(input.testModeActive);
    const MAX_SCAN_CHARS = 8192;
    const rawText = (input.rawText || '').toString().slice(0, MAX_SCAN_CHARS);

    const rawNormalizedSource = (input.source || 'SMS').toUpperCase();
    const isGmailSource = rawNormalizedSource.includes('GMAIL') || rawNormalizedSource.includes('EMAIL');
    const source = isGmailSource ? 'GMAIL' : 'SMS';
    const messageId = input.messageId || (isTest
      ? `TEST-${crypto.randomUUID().slice(0, 8)}`
      : `OBS-${crypto.randomUUID().slice(0, 8)}`);

    let defaultSender = source === 'GMAIL' ? 'alerts@retail.bank.in' : 'BANK-ALERT';
    if (isTest && input.sender === 'TEST') {
      defaultSender = 'TEST';
    }
    const sender = input.sender !== undefined ? input.sender : defaultSender;

    let receivedAt = new Date();
    if (input.receivedAt) {
      const parsedDate = new Date(input.receivedAt);
      if (!isNaN(parsedDate.getTime())) {
        receivedAt = parsedDate;
      }
    }

    const observation = {
      source: source.toLowerCase(),
      message_id: messageId,
      sender,
      received_at: receivedAt.toISOString(),
      body: rawText,
      raw: rawText,
      is_simulated: Boolean(input.isSimulated),
      is_test: isTest
    };

    const stage1 = {
      stage: 1,
      name: 'LOADED',
      status: 'LOADED',
      details: {
        messageId,
        source,
        sender,
        receivedAt: observation.received_at,
        isTest,
        rawPreserved: true
      }
    };

    const buildResult = ({
      finalStatus,
      failingStage,
      failingCondition,
      failingReason,
      stage2,
      stage3,
      stage4,
      stage5,
      stage6,
      parsed,
      session,
      attribution = null
    }) => {
      return {
        success: finalStatus === 'VERIFIED',
        status: finalStatus,
        source,
        messageId,
        receivedAt: observation.received_at,
        amount: parsed?.amount ? `₹${parsed.amount}` : null,
        amountPaise: parsed?.amountPaise ? parsed.amountPaise.toString() : null,
        reference: parsed?.bankReferenceNumber || null,
        sender,
        isTest,
        raw: observation.raw,
        failingStage: failingStage || null,
        failingCondition: failingCondition || null,
        reason: failingCondition || null,
        details: failingReason || null,
        stages: {
          stage1,
          stage2: stage2 || { stage: 2, name: 'FILTER', status: 'PENDING' },
          stage3: stage3 || { stage: 3, name: 'PARSER', status: 'PENDING' },
          stage4: stage4 || { stage: 4, name: 'VERIFICATION', status: 'PENDING' },
          stage5: stage5 || { stage: 5, name: 'SECURITY', status: 'PENDING' },
          stage6: stage6 || { stage: 6, name: 'ATTRIBUTION', status: 'PENDING' }
        },
        session: session ? {
          id: session.id,
          orderId: session.orderId,
          amountPaise: session.amountPaise?.toString(),
          status: session.status
        } : null,
        attribution: attribution || null
      };
    };

    if (input.rawText && typeof input.rawText === 'string' && input.rawText.length > MAX_SCAN_CHARS) {
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 1,
        failingCondition: 'PAYLOAD_TOO_LARGE',
        failingReason: `Transaction notification payload exceeds maximum allowable length of ${MAX_SCAN_CHARS} characters (received ${input.rawText.length}).`
      });
    }

    let session = null;

    const observedVpa = ((rawText.match(/[a-zA-Z0-9._-]{2,64}@[a-zA-Z0-9._-]{2,32}/) || [])[0] || '').toLowerCase() || null;

    if (input.paymentSessionId) {
      session = this.sessionRepo.findById(input.paymentSessionId);
    } else if (input.receivingAccountId) {
      session = this.sessionRepo.findCurrentActiveOrProcessing(input.receivingAccountId);
    }

    if (!session) {
      if (input.receivingAccountId) {
        const row = this.db.queryOne(
          `SELECT * FROM payment_sessions WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING') ORDER BY created_at DESC LIMIT 1`,
          [input.receivingAccountId]
        );
        if (row) session = this.sessionRepo.mapRow(row);
      }
      if (!session && observedVpa) {
        const row = this.db.queryOne(`
          SELECT ps.* FROM payment_sessions ps
          JOIN payment_receiving_accounts ra ON ps.receiving_account_id = ra.id
          WHERE LOWER(ra.upi_id) = ? AND ps.status IN ('ACTIVE', 'PROCESSING')
          ORDER BY ps.created_at DESC LIMIT 1
        `, [observedVpa]);
        if (row) session = this.sessionRepo.mapRow(row);
      }
      if (!session && input.receivingAccountId) {
        const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
        const row = this.db.queryOne(
          `SELECT * FROM payment_sessions WHERE receiving_account_id = ? AND status = 'SUCCESS' AND completed_at >= ? ORDER BY completed_at DESC LIMIT 1`,
          [input.receivingAccountId, sixtySecsAgo]
        );
        if (row) session = this.sessionRepo.mapRow(row);
      }
    }

    let customer = null;
    if (session?.customerId && this.customerRepo) {
      customer = this.customerRepo.findById(session.customerId);
    } else if (input.customerId && this.customerRepo) {
      customer = this.customerRepo.findById(input.customerId);
    } else if (sender && this.customerRepo) {
      customer = this.customerRepo.findByIdentifier(sender);
    }

    let isAttributableToCustomer = false;
    let matchedCustomerChannel = null;
    if (customer) {
      const cleanSenderPhone = (sender || '').replace(/\D/g, '').slice(-10);
      const cleanCustPhone = (customer.mobileNumber || customer.phoneNumber || '').replace(/\D/g, '').slice(-10);
      if (cleanCustPhone.length >= 10 && cleanSenderPhone === cleanCustPhone) {
        isAttributableToCustomer = true;
        matchedCustomerChannel = `PHONE (${customer.mobileNumber})`;
      }

      const cleanSenderEmail = (sender || '').trim().toLowerCase();
      const cleanCustEmail = (customer.email || '').trim().toLowerCase();
      if (cleanCustEmail.length > 3 && (cleanSenderEmail === cleanCustEmail || cleanSenderEmail.includes(cleanCustEmail))) {
        isAttributableToCustomer = true;
        matchedCustomerChannel = `EMAIL (${customer.email})`;
      }

      if (input.submissionIdentity) {
        const sub = input.submissionIdentity;
        if (sub.customerId === customer.id ||
            (sub.phone && cleanCustPhone.length >= 10 && sub.phone.replace(/\D/g, '').slice(-10) === cleanCustPhone) ||
            (sub.email && cleanCustEmail.length > 3 && sub.email.trim().toLowerCase() === cleanCustEmail)) {
          isAttributableToCustomer = true;
          matchedCustomerChannel = `SUBMISSION_IDENTITY (${customer.id})`;
        }
      }
    }

    let stage2;
    if (source === 'SMS') {
      const cleanSender = (sender || '').trim();
      const digitsOnly = cleanSender.replace(/[\s+-]/g, '');

      const isPureNumeric = /^\d+$/.test(digitsOnly) && !/[a-zA-Z]/.test(cleanSender);

      if (isPureNumeric) {
        if (!isAttributableToCustomer) {
          stage2 = {
            stage: 2,
            name: 'FILTER',
            status: 'FAILED',
            reason: 'PERSONAL_SMS_REJECTED',
            details: `Personal SMS from numeric phone numbers (${sender}) is rejected. Bank SMS sender cannot be purely numeric; it must be an alphanumeric or alphabetic sender code.`
          };
          return buildResult({
            finalStatus: 'REJECTED',
            failingStage: 2,
            failingCondition: 'PERSONAL_SMS_REJECTED',
            failingReason: stage2.details,
            stage2
          });
        }
        stage2 = {
          stage: 2,
          name: 'FILTER',
          status: 'FLAGGED_CUSTOMER_SENDER',
          details: `Sender '${sender}' matches customer registered mobile number. Proceeding to fraud verification.`
        };
      } else {
        const isValidSenderCode = /[a-zA-Z]/.test(cleanSender) && /^[a-zA-Z0-9_\-\.]+$/.test(cleanSender);

        if (!isValidSenderCode) {
          stage2 = {
            stage: 2,
            name: 'FILTER',
            status: 'FAILED',
            reason: 'INVALID_SMS_SENDER',
            details: `Invalid SMS sender '${sender}'. Bank SMS sender must be an alphanumeric or pure alphabetic string containing letters (no pure numeric strings or invalid symbols).`
          };
          return buildResult({
            finalStatus: 'REJECTED',
            failingStage: 2,
            failingCondition: 'INVALID_SMS_SENDER',
            failingReason: stage2.details,
            stage2
          });
        }
      }
    } else if (source === 'GMAIL') {
      const emailMatch = sender.match(/<([^>]+)>/);
      const cleanEmail = (emailMatch ? emailMatch[1] : sender).trim();
      let emailDomain = '';
      if (cleanEmail.includes('@')) {
        emailDomain = cleanEmail.split('@')[1]?.toLowerCase().trim().replace(/[>]/g, '');
      } else {
        emailDomain = cleanEmail.toLowerCase().trim().replace(/[>]/g, '');
      }

      const KNOWN_BANK_DOMAINS = new Set([
        'hdfcbank.net', 'hdfcbank.com',
        'icicibank.com',
        'sbi.co.in',
        'axisbank.com',
        'kotak.com', 'kotak.co.in',
        'paytmbank.com', 'paytm.com',
        'yesbank.in', 'pnb.co.in',
        'bankofbaroda.co.in', 'bankofbaroda.com',
        'indusind.com',
        'idfcfirstbank.com', 'idfcbank.com',
        'canarabank.com',
        'unionbankofindia.co.in',
        'federalbank.co.in',
        'idbibank.com'
      ]);
      const isBankDomain =
        emailDomain.endsWith('.bank.in') ||
        emailDomain.endsWith('.fin.in') ||
        emailDomain === 'bank.in' ||
        emailDomain === 'fin.in' ||
        Array.from(KNOWN_BANK_DOMAINS).some(root => emailDomain === root || emailDomain.endsWith('.' + root));
      const allowTestSenders = !isProductionMode;
      const isValidDomain = isBankDomain || (allowTestSenders && (sender === 'TEST' || cleanEmail === 'TEST' || sender === 'gmail-browser-automator' || emailDomain.endsWith('.youpi.local')));

      if (!isValidDomain) {
        if (!isAttributableToCustomer) {
          stage2 = {
            stage: 2,
            name: 'FILTER',
            status: 'FAILED',
            reason: 'INVALID_EMAIL_DOMAIN',
            details: `Invalid or unauthorized email domain '${emailDomain || sender}'. Official Indian bank alerts must originate from domains ending in .bank.in (e.g. alerts@bankname.bank.in).`
          };
          return buildResult({
            finalStatus: 'REJECTED',
            failingStage: 2,
            failingCondition: 'INVALID_EMAIL_DOMAIN',
            failingReason: stage2.details,
            stage2
          });
        }
        stage2 = {
          stage: 2,
          name: 'FILTER',
          status: 'FLAGGED_CUSTOMER_SENDER',
          details: `Sender '${sender}' matches customer registered email. Proceeding to fraud verification.`
        };
      }
    } else {
      stage2 = {
        stage: 2,
        name: 'FILTER',
        status: 'FAILED',
        reason: 'IRRELEVANT_SOURCE',
        details: `Observation source '${source}' is irrelevant or unsupported.`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 2,
        failingCondition: 'IRRELEVANT_SOURCE',
        failingReason: stage2.details,
        stage2
      });
    }

    if (!stage2) {
      stage2 = {
        stage: 2,
        name: 'FILTER',
        status: 'PASSED',
        details: `Sender '${sender}' and channel source '${source}' verified.`
      };
    }

    let stage3;

    const creditKeywords = /(?:credited|credit|cr\b|deposit|deposited|received|transferred)/i;
    if (!creditKeywords.test(rawText)) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'MISSING_CREDIT_INDICATOR',
        details: 'Message lacks required credit indicator (CR, CREDIT, CREDITED, RECEIVED, or DEPOSIT).'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'MISSING_CREDIT_INDICATOR',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    const debitIdx = rawText.search(/\b(?:debited|withdrawn|deducted|spent|paid rs|sent rs)\b/i);
    const creditIdx = rawText.search(creditKeywords);
    if (debitIdx !== -1 && debitIdx < creditIdx) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'DEBIT_NOTIFICATION',
        details: 'Message describes a debit before any credit, so it is not an incoming payment.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'DEBIT_NOTIFICATION',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    const currencyKeywords = /(?:\b(?:rs\.?|inr)\b|₹|(?:rs\.?|inr|₹)\s*\d|\d\s*(?:rs\.?|inr|₹))/i;
    if (!currencyKeywords.test(rawText)) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'MISSING_CURRENCY_INDICATOR',
        details: 'Message lacks required Indian currency indicator (Rs, Rs., ₹, or INR).'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'MISSING_CURRENCY_INDICATOR',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    const labelledRefMatch = rawText.match(/(?:upi\s*ref(?:erence)?\s*(?:no\.?|num)?|utr(?:\s*no\.?)?|rrn(?:\s*no\.?)?|txn\s*(?:id|ref)?|ref\s*no\.?)[\s:=-]+([0-9]{12})\b/i);
    let bankRef = (labelledRefMatch && labelledRefMatch[1]) || input.bankReferenceNumber || input.utr || null;
    if (!bankRef) {
      const ref12Patterns = [
        /(?:upi\s*ref(?:erence)?\s*(?:no\.?|num)?|utr(?:\s*no\.?)?|rrn(?:\s*no\.?)?|txn\s*(?:id|ref)?|ref\s*no\.?)[\s:=-]+([0-9]{12})\b/i,
        /(?:ref\s*no\.?)?[\s:#=-]+([0-9]{12})\b/i,
        /\b([0-9]{12})\b/
      ];
      for (const pat of ref12Patterns) {
        const match = rawText.match(pat);
        if (match && match[1]) {
          bankRef = match[1].trim();
          break;
        }
      }
    }

    if (!bankRef && isGmailSource) {
      const generalRefMatch = rawText.match(/(?:utr|ref(?:\s*no\.?)?|txn\s*(?:id|ref)?|rrn)[:\s#]+([a-zA-Z0-9\-_]{6,35})/i) ||
        rawText.match(/UPI\/CR\/([a-zA-Z0-9\-_]+)/i);
      if (generalRefMatch && generalRefMatch[1]) {
        bankRef = generalRefMatch[1].trim();
      }
    }

    if (!bankRef) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'MISSING_12_DIGIT_REFERENCE',
        details: 'Message lacks mandatory 12-digit UPI transaction reference / UTR / RRN.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'MISSING_12_DIGIT_REFERENCE',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    const parsedAmount = extractIntelligentAmount(rawText);
    if (!parsedAmount || !parsedAmount.amountPaise || parsedAmount.amountPaise <= 0n) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'INVALID_OR_MISSING_AMOUNT',
        details: 'Could not extract valid monetary amount from message body.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'INVALID_OR_MISSING_AMOUNT',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    let senderVpa = null;
    const vpaMatch = rawText.match(/(?:from|by|vpa)\s+([a-zA-Z0-9.\-_]{2,64}@[a-zA-Z0-9.\-_]{2,32})/i);
    if (vpaMatch && vpaMatch[1]) {
      senderVpa = vpaMatch[1].trim().replace(/[.,;]+$/, '');
    }

    const parsedData = {
      amountPaise: parsedAmount.amountPaise,
      amount: parsedAmount.amountStr,
      bankReferenceNumber: bankRef,
      senderVpa,
      receivedAt
    };

    stage3 = {
      stage: 3,
      name: 'PARSER',
      status: 'PARSED',
      details: {
        amount: `₹${parsedData.amount}`,
        amountPaise: parsedData.amountPaise.toString(),
        reference: bankRef,
        senderVpa: senderVpa || undefined
      }
    };

    let stage4;

    if (!session && parsedData?.amountPaise) {
      const scopeByVpa = observedVpa || (parsedData.vpa ? String(parsedData.vpa).toLowerCase() : null);
      if (scopeByVpa) {
        const matchRow = this.db.queryOne(`
          SELECT ps.* FROM payment_sessions ps
          JOIN payment_receiving_accounts ra ON ps.receiving_account_id = ra.id
          WHERE ps.status IN ('ACTIVE', 'PROCESSING')
            AND ps.amount_paise = ?
            AND LOWER(ra.upi_id) = ?
          ORDER BY ps.created_at DESC LIMIT 1
        `, [Number(parsedData.amountPaise), scopeByVpa]);
        if (matchRow) {
          session = this.sessionRepo.mapRow(matchRow);
        }
      }
    }

    if (!session) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'NO_ACTIVE_SESSION',
        details: 'No active or processing payment session was found matching this payment context.'
      };
      return buildResult({
        finalStatus: 'UNRESOLVED',
        failingStage: 4,
        failingCondition: 'NO_ACTIVE_SESSION',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData
      });
    }

    if (input.paymentSessionId && [PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'SESSION_NOT_OPEN',
        details: `Payment session is ${session.status} and can no longer be settled by an observation.`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'SESSION_NOT_OPEN',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    const parseSessionTime = (t) => {
      if (!t) return new Date();
      if (t instanceof Date) return t;
      const str = t.toString().trim();
      if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/.test(str)) {
        return new Date(str.replace(' ', 'T') + 'Z');
      }
      return new Date(str);
    };

    const sessionCreatedAt = session.slotAcquiredAt
      ? parseSessionTime(session.slotAcquiredAt)
      : parseSessionTime(session.createdAt);

    if (receivedAt.getTime() < sessionCreatedAt.getTime() - 1000) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'BEFORE_SESSION_CREATION',
        details: `Observation received timestamp (${receivedAt.toISOString()}) is prior to payment session creation (${sessionCreatedAt.toISOString()}).`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'BEFORE_SESSION_CREATION',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    const activeDeadline = (session.status === PaymentStatus.PROCESSING && (session.processingExpiresAt || session.processing_expires_at))
      ? parseSessionTime(session.processingExpiresAt || session.processing_expires_at)
      : (session.expiresAt || session.expires_at ? parseSessionTime(session.expiresAt || session.expires_at) : null);

    if (activeDeadline) {
      if (receivedAt.getTime() > activeDeadline.getTime()) {
        stage4 = {
          stage: 4,
          name: 'VERIFICATION',
          status: 'FAILED',
          reason: 'SESSION_EXPIRED',
          details: `Observation received timestamp (${receivedAt.toISOString()}) is after payment session expiration (${activeDeadline.toISOString()}).`
        };
        return buildResult({
          finalStatus: 'REJECTED',
          failingStage: 4,
          failingCondition: 'SESSION_EXPIRED',
          failingReason: stage4.details,
          stage2,
          stage3,
          stage4,
          parsed: parsedData,
          session
        });
      }
    }

    if (BigInt(session.amountPaise) !== BigInt(parsedData.amountPaise)) {
      const expectedAmount = (Number(session.amountPaise) / 100).toFixed(2);
      const gotAmount = (Number(parsedData.amountPaise) / 100).toFixed(2);
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'AMOUNT_MISMATCH',
        details: `Payment amount mismatch: session requires ₹${expectedAmount}, but observation contains ₹${gotAmount}.`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'AMOUNT_MISMATCH',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    const receivingAccountId = session.receivingAccountId || input.receivingAccountId || '00000000-0000-0000-0000-000000000002';
    let observerSourceEnum;
    if (isGmailSource) {
      observerSourceEnum = ObserverSource.GMAIL;
    } else if (rawNormalizedSource === ObserverSource.GOOGLE_MESSAGES) {
      observerSourceEnum = ObserverSource.GOOGLE_MESSAGES;
    } else if (rawNormalizedSource === ObserverSource.ANDROID_OBSERVER) {
      observerSourceEnum = ObserverSource.ANDROID_OBSERVER;
    } else {
      observerSourceEnum = ObserverSource.SMS_GATEWAY;
    }
    const fingerprint = calculateObservationFingerprint({
      receivingAccountId,
      amountPaise: parsedData.amountPaise,
      source: observerSourceEnum,
      bankReferenceNumber: bankRef,
      observedAt: receivedAt
    });

    const existingObs = this.obsRepo.findByFingerprint(fingerprint);
    if (existingObs && existingObs.source === observerSourceEnum) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'DUPLICATE_OBSERVATION',
        details: 'Duplicate observation detected. An identical observation fingerprint has already been processed.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'DUPLICATE_OBSERVATION',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    const priorUsedSession = this.db.queryOne(`
      SELECT ps.id, ps.order_id
      FROM payment_sessions ps
      JOIN payment_observations po ON ps.attributed_observation_id = po.id
      WHERE ps.status = 'SUCCESS'
        AND ps.id != ?
        AND po.bank_reference_number = ?
      LIMIT 1
    `, [session.id, bankRef]);

    if (priorUsedSession) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'REFERENCE_ALREADY_USED',
        details: `Transaction reference '${bankRef}' has already been consumed by completed order #${priorUsedSession.order_id}.`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'REFERENCE_ALREADY_USED',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    stage4 = {
      stage: 4,
      name: 'VERIFICATION',
      status: 'VERIFIED',
      details: {
        sessionId: session.id,
        orderId: session.orderId,
        amountMatches: true,
        referenceValid: true,
        temporalWindowValid: true
      }
    };

    let stage5;
    let isFraudulentInjection = false;
    let threatType = null;
    let threatDetails = null;

    if (customer && customer.status === 'BANNED') {
      stage5 = {
        stage: 5,
        name: 'SECURITY',
        status: 'FAILED',
        reason: 'BANNED_IDENTITY',
        details: 'Associated customer identity is permanently banned.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 5,
        failingCondition: 'BANNED_IDENTITY',
        failingReason: stage5.details,
        stage2,
        stage3,
        stage4,
        stage5,
        parsed: parsedData,
        session
      });
    }

    const isSessionActiveOrRecent = Boolean(session && (session.status === 'ACTIVE' || session.status === 'PROCESSING'));

    const hasAssociatedCustomer = Boolean(customer && customer.id);

    const isAttemptingCreditMessage = creditKeywords.test(rawText) && (
      Boolean(bankRef) || Boolean(parsedData?.amountPaise) || currencyKeywords.test(rawText)
    );

    let isNotLegitimateBank = false;
    if (source === 'SMS') {
      const cleanSender = (sender || '').trim();
      const isValidSenderCode = /[a-zA-Z]/.test(cleanSender) && /^[a-zA-Z0-9_\-\.]+$/.test(cleanSender);
      isNotLegitimateBank = !isValidSenderCode || isAttributableToCustomer;
    } else if (source === 'GMAIL') {
      const senderDomain = sender.includes('@') ? sender.split('@')[1]?.toLowerCase().trim() : sender.toLowerCase().trim();
      const isBankDomain = senderDomain.endsWith('.bank.in') || senderDomain === 'bank.in' || (!isProductionMode && sender === 'TEST') || senderDomain === 'hdfcbank.net';
      isNotLegitimateBank = !isBankDomain || isAttributableToCustomer;
    } else {
      isNotLegitimateBank = true;
    }

    const targetsCustomerSession = Boolean(session && (
      session.customerId === customer?.id ||
      input.paymentSessionId === session.id ||
      (parsedData?.amountPaise && session.amountPaise && BigInt(parsedData.amountPaise) === BigInt(session.amountPaise))
    ));

    if (isSessionActiveOrRecent &&
        hasAssociatedCustomer &&
        isAttributableToCustomer &&
        isAttemptingCreditMessage &&
        isNotLegitimateBank &&
        targetsCustomerSession) {
      isFraudulentInjection = true;
      threatType = 'FRAUDULENT_PAYMENT_INJECTION';
      threatDetails = `Customer '${customer.name}' attempted to inject fake payment notification attributable to registered identity (${matchedCustomerChannel}).`;
    }

    const evidence = {
      customerId: customer?.id || null,
      customerName: customer?.name || null,
      customerEmail: customer?.email || null,
      customerPhone: customer?.mobileNumber || null,
      paymentSessionId: session?.id || null,
      orderId: session?.orderId || null,
      sessionState: session?.status || null,
      sessionCreatedAt: session?.createdAt || null,
      sessionAmountPaise: session?.amountPaise?.toString() || null,
      sessionAmountRupees: session?.amountPaise ? (Number(session.amountPaise) / 100).toFixed(2) : null,
      deviceInfo: input.deviceInfo || session?.metadata?.deviceInfo || 'Device Web Client',
      source,
      originatingSender: sender,
      receivedAt: observation.received_at,
      rawMessage: observation.raw,
      normalizedMessage: observation.body,
      extractedAmount: parsedData?.amount ? `₹${parsedData.amount}` : null,
      extractedReference: bankRef || null,
      parserResults: stage3,
      verificationResults: stage4,
      fraudReason: 'FRAUDULENT_PAYMENT_INJECTION',
      detectedAt: new Date().toISOString()
    };

    let autoBanApplied = false;
    let securityDiagnostic = '';

    if (isFraudulentInjection) {
      const isExplicitlySuppressed = Boolean(input.suppressBan);

      if (this.customerRepo && typeof this.customerRepo.createSecurityEvent === 'function') {
        this.customerRepo.createSecurityEvent({
          merchantId: session.merchantId,
          customerId: customer.id,
          paymentSessionId: session.id,
          eventType: 'FRAUDULENT_PAYMENT_INJECTION',
          source,
          sender,
          deviceInfo: evidence.deviceInfo,
          rawMessage: observation.raw,
          normalizedMessage: observation.body,
          extractedAmount: evidence.extractedAmount,
          extractedReference: evidence.extractedReference,
          parserResults: stage3,
          verificationResults: stage4,
          fraudReason: 'FRAUDULENT_PAYMENT_INJECTION',
          metadata: {
            orderId: session.orderId,
            testModeActive,
            autoBanApplied: !isExplicitlySuppressed,
            banSuppressed: Boolean(isExplicitlySuppressed)
          }
        });
      }

      if (isExplicitlySuppressed) {
        autoBanApplied = false;
        securityDiagnostic = 'FRAUDULENT_PAYMENT_INJECTION detected. Automatic banning suppressed by explicit request parameter.';

        stage5 = {
          stage: 5,
          name: 'SECURITY',
          status: 'SUSPICIOUS_FLAGGED',
          isSuspicious: true,
          threatType,
          autoBanApplied: false,
          banSuppressed: true,
          diagnostic: securityDiagnostic,
          details: evidence
        };

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: session.merchantId,
            entityType: 'PAYMENT_SESSION',
            entityId: session.id,
            action: 'TEST_MODE_FRAUD_FLAGGED_BAN_SUPPRESSED',
            actorType: 'SYSTEM',
            details: { threatType, customerId: customer.id, evidence }
          });
        }
      } else {
        autoBanApplied = true;
        this.customerRepo.banCustomer(customer.id, 'FRAUDULENT_PAYMENT_INJECTION', { lastDevice: evidence.deviceInfo });
        securityDiagnostic = 'FRAUDULENT_PAYMENT_INJECTION detected. Associated customer identity has been automatically BANNED by Security Engine.';

        stage5 = {
          stage: 5,
          name: 'SECURITY',
          status: 'FAILED',
          isSuspicious: true,
          threatType,
          autoBanApplied: true,
          reason: 'FRAUDULENT_PAYMENT_INJECTION',
          diagnostic: securityDiagnostic,
          details: evidence
        };

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: session.merchantId,
            entityType: 'CUSTOMER',
            entityId: customer.id,
            action: 'CUSTOMER_AUTOMATICALLY_BANNED',
            actorType: 'SYSTEM',
            details: { threatType, rawText, evidence }
          });
        }

        if (this.server && session?.id) {
          this.server.broadcastSse(session.id, 'status_change', {
            status: 'BLOCKED',
            isBanned: true,
            fraudDetected: true,
            orderId: session.orderId,
            reason: 'FRAUDULENT_PAYMENT_INJECTION',
            blockedNotice: {
              title: 'FRAUDULENT ACTIVITY DETECTED',
              subtitle: 'Payment Session Terminated & Account Suspended',
              message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
              investigating: true
            }
          });
          this.server.broadcastSse(session.id, 'account_blocked', {
            status: 'BLOCKED',
            isBanned: true,
            fraudDetected: true,
            orderId: session.orderId
          });
        }
        if (this.eventEmitter) {
          this.eventEmitter.emit('PAYMENT.FRAUD_BLOCKED', {
            sessionId: session?.id,
            customerId: customer?.id,
            orderId: session?.orderId,
            reason: 'FRAUDULENT_PAYMENT_INJECTION'
          });
        }

        return buildResult({
          finalStatus: 'REJECTED',
          failingStage: 5,
          failingCondition: 'FRAUDULENT_PAYMENT_INJECTION',
          failingReason: securityDiagnostic,
          stage2,
          stage3,
          stage4,
          stage5,
          parsed: parsedData,
          session
        });
      }
    } else {
      stage5 = {
        stage: 5,
        name: 'SECURITY',
        status: 'PASSED',
        isSuspicious: false,
        autoBanApplied: false,
        details: 'Security and fraud pattern scans passed.'
      };
    }

    let stage6;

    if (isFraudulentInjection) {
      stage6 = {
        stage: 6,
        name: 'ATTRIBUTION',
        status: 'FLAGGED_SUSPICIOUS',
        outcomeStatus: 'SUSPICIOUS',
        details: 'Payment held in SUSPICIOUS state (DO NOT PAY). Observation flagged for security review.'
      };

      return buildResult({
        finalStatus: 'SUSPICIOUS',
        failingStage: 5,
        failingCondition: 'FRAUDULENT_PAYMENT_INJECTION',
        failingReason: securityDiagnostic,
        stage2,
        stage3,
        stage4,
        stage5,
        stage6,
        parsed: parsedData,
        session
      });
    }

    const normalized = ObservationNormalizer.normalize({
      source: observerSourceEnum,
      receivingAccountId: session?.receivingAccountId || receivingAccountId,
      rawPayload: {
        ...observation,
        raw: rawText,
        is_test: isTest,
        targetSessionId: session?.id
      },
      amountPaise: parsedData.amountPaise,
      amount: parsedData.amount,
      observedAt: receivedAt,
      senderVpa: parsedData.senderVpa,
      bankReferenceNumber: parsedData.bankReferenceNumber
    });

    const attributionResult = this.attributionEngine
      ? this.attributionEngine.processObservation(normalized)
      : {
          attributed: true,
          outcomeStatus: 'VERIFIED',
          observationId: normalized.id,
          paymentSessionId: session?.id,
          verificationLevel: 1,
          verificationTag: 'DEFAULT'
        };

    stage6 = {
      stage: 6,
      name: 'ATTRIBUTION',
      status: attributionResult.attributed ? 'ATTRIBUTED' : 'UNRESOLVED',
      outcomeStatus: attributionResult.outcomeStatus,
      details: {
        attributed: attributionResult.attributed,
        paymentSessionId: attributionResult.paymentSessionId,
        observationId: attributionResult.observationId,
        attributedSessionId: attributionResult.paymentSessionId,
        outcomeStatus: attributionResult.outcomeStatus,
        verificationLevel: attributionResult.verificationLevel,
        verificationTag: attributionResult.verificationTag
      }
    };

    const finalStatus = attributionResult.attributed ? 'VERIFIED' : 'UNRESOLVED';

    const updatedSession = this.sessionRepo.findById(session.id);

    return buildResult({
      finalStatus,
      stage2,
      stage3,
      stage4,
      stage5,
      stage6,
      parsed: parsedData,
      session: updatedSession || session,
      attribution: attributionResult
    });
  }
}
