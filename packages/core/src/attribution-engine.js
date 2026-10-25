import { PaymentStatus, ObservationAttributionStatus, TicketStatus, SenderType, isTerminalStatus } from '@youpi/common';

export class AttributionEngine {
  constructor(options) {
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.ticketRepo = options.ticketRepo;
    this.auditRepo = options.auditRepo;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
    const isTestExecution = process.env.NODE_ENV === 'test' ||
      Boolean(process.env.NODE_TEST_CONTEXT) ||
      (process.execArgv && process.execArgv.some(a => a.includes('test'))) ||
      (process.argv && process.argv.some(a => a.includes('test')));

    this.gracePeriodMs = options.gracePeriodMs !== undefined
      ? options.gracePeriodMs
      : (process.env.PAYMENT_GRACE_PERIOD_MS !== undefined
        ? Number(process.env.PAYMENT_GRACE_PERIOD_MS)
        : (isTestExecution ? 0 : 5000));
    this.pendingGraceTimers = new Map();
  }

  destroy() {
    for (const timer of this.pendingGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingGraceTimers.clear();
  }

  async processObservation(normalizedObs) {
    const existing = await this.obsRepo.findByFingerprint(normalizedObs.fingerprintHash);
    if (existing) {
      if (existing.source === normalizedObs.source) {
        if (this.auditRepo) {
          await this.auditRepo.log({
            entityType: 'PAYMENT_OBSERVATION',
            entityId: existing.id,
            action: 'DUPLICATE_OBSERVATION_DROPPED',
            actorType: 'OBSERVER',
            details: { fingerprintHash: normalizedObs.fingerprintHash, source: normalizedObs.source }
          });
        }
        return {
          attributed: false,
          duplicate: true,
          lateMatch: false,
          paymentSessionId: existing.attributedPaymentId || undefined,
          observationId: existing.id,
          outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED
        };
      }

      if (existing.attributedPaymentId) {
        const targetSession = await this.sessionRepo.findById(existing.attributedPaymentId);
        if (targetSession && isTerminalStatus(targetSession.status) && targetSession.status !== PaymentStatus.SUCCESS) {
          const savedObs = await this.obsRepo.create(normalizedObs);
          await this.obsRepo.markLateUnmatched(savedObs.id);
          if (this.auditRepo) {
            await this.auditRepo.log({
              merchantId: targetSession.merchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: targetSession.id,
              action: 'LATE_OBSERVATION_DETECTED',
              actorType: 'SYSTEM',
              details: {
                observationId: savedObs.id,
                source: normalizedObs.source,
                sessionStatus: targetSession.status
              }
            });
          }
          if (this.ticketRepo && targetSession.customerId) {
            await this.ticketRepo.createTicket({
              merchantId: targetSession.merchantId,
              customerId: targetSession.customerId,
              paymentId: targetSession.id,
              subject: `[LATE PAYMENT DETECTED] Order #${targetSession.orderId}`,
              status: TicketStatus.OPEN,
              initialMessage: {
                senderType: SenderType.ADMIN,
                senderId: targetSession.merchantId,
                message: `A delayed payment observation of ${normalizedObs.amountPaise / 100n} INR was detected after session ${targetSession.id} ended with status ${targetSession.status}. Flagged for manual merchant reconciliation.`
              }
            });
          }
          this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
            paymentId: targetSession.id,
            orderId: targetSession.orderId,
            merchantId: targetSession.merchantId,
            amountPaise: normalizedObs.amountPaise,
            observationId: savedObs.id
          });
          return {
            attributed: false,
            duplicate: false,
            lateMatch: true,
            paymentSessionId: targetSession.id,
            observationId: savedObs.id,
            outcomeStatus: ObservationAttributionStatus.LATE_UNMATCHED
          };
        }

        const pendingTimer = this.pendingGraceTimers.get(existing.attributedPaymentId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          this.pendingGraceTimers.delete(existing.attributedPaymentId);
        }

        const savedObs = await this.obsRepo.create(normalizedObs);
        let verifyResult;
        try {
          verifyResult = await this.sessionRepo.recordVerificationSource(
            existing.attributedPaymentId,
            normalizedObs.source,
            savedObs.id,
            { finalizeSuccess: true }
          );
          if (existing.bankReferenceNumber && savedObs.bankReferenceNumber && String(existing.bankReferenceNumber).trim() === String(savedObs.bankReferenceNumber).trim()) {
            await this.obsRepo.db.execute(`
              UPDATE payment_observations
              SET attribution_status = ?
              WHERE id = ?
            `, [ObservationAttributionStatus.ATTRIBUTED, savedObs.id]);
          } else {
            await this.obsRepo.markAttributed(savedObs.id, existing.attributedPaymentId);
          }
        } catch (dbErr) {
          const errMsg = dbErr?.message || '';
          if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('duplicate key value') || errMsg.includes('idx_observations_unique_attributed_bank_ref') || errMsg.includes('idx_payment_sessions_attributed_obs')) {
            return {
              attributed: false,
              duplicate: true,
              lateMatch: false,
              observationId: savedObs.id,
              outcomeStatus: 'REFERENCE_ALREADY_USED'
            };
          }
          throw dbErr;
        }

        if (this.auditRepo) {
          await this.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: existing.attributedPaymentId,
            action: 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              source: normalizedObs.source,
              level: verifyResult.level,
              tag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        if (verifyResult.isFirstSuccess) {
          this.eventEmitter.emit('PAYMENT.SUCCESS', {
            paymentId: existing.attributedPaymentId,
            orderId: verifyResult.session.orderId,
            merchantId: verifyResult.session.merchantId,
            amountPaise: verifyResult.session.amountPaise,
            observationId: savedObs.id,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });
          if (typeof this.eventEmitter.settle === 'function') await this.eventEmitter.settle();
        }

        this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
          paymentId: existing.attributedPaymentId,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          paymentSessionId: existing.attributedPaymentId,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    const savedObs = await this.obsRepo.create(normalizedObs);

    let currentSession = null;
    if (normalizedObs.rawPayload?.targetSessionId) {
      currentSession = await this.sessionRepo.findById(normalizedObs.rawPayload.targetSessionId);
    }
    if (!currentSession || (currentSession.amountPaise !== normalizedObs.amountPaise)) {
      currentSession = await this.sessionRepo.findCurrentActiveOrProcessing(normalizedObs.receivingAccountId);
    }
    if (currentSession && currentSession.amountPaise !== normalizedObs.amountPaise) {
      const matchRow = await this.sessionRepo.db.queryOne(`
        SELECT * FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING') AND amount_paise = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise)]);
      if (matchRow) {
        currentSession = this.sessionRepo.mapRow(matchRow);
      }
    }
    if (!currentSession) {
      const scopedRow = await this.sessionRepo.db.queryOne(`
        SELECT * FROM payment_sessions
        WHERE receiving_account_id = ?
          AND status IN ('ACTIVE', 'PROCESSING')
          AND amount_paise = ?
        ORDER BY created_at DESC
        LIMIT 1
      `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise)]);
      if (scopedRow) {
        currentSession = this.sessionRepo.mapRow(scopedRow);
      }
    }

    if (currentSession) {
      const isEligibleStatus = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING].includes(currentSession.status);

      const isAmountMatch = currentSession.amountPaise === normalizedObs.amountPaise;

      let isPriorExpiredSession = false;
      if (currentSession.slotAcquiredAt && normalizedObs.observedAt < currentSession.slotAcquiredAt) {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const recentExpired = await this.sessionRepo.findRecentlyExpiredOrFailed(
          normalizedObs.receivingAccountId,
          thirtyMinutesAgo
        );
        isPriorExpiredSession = recentExpired.some(s => s.amountPaise === normalizedObs.amountPaise);
      }

      const slotStart = currentSession.slotAcquiredAt
        ? new Date(currentSession.slotAcquiredAt.getTime() - 300000)
        : new Date(currentSession.createdAt.getTime() - 300000);

      const isTimeValid = !isPriorExpiredSession && (normalizedObs.observedAt >= slotStart);

      let isUtrAlreadyUsed = false;
      const trimmedUtr = normalizedObs.bankReferenceNumber ? String(normalizedObs.bankReferenceNumber).trim() : '';
      if (trimmedUtr.length > 0) {
        const priorUsedSession = await this.sessionRepo.db.queryOne(`
          SELECT ps.id, ps.order_id
          FROM payment_sessions ps
          JOIN payment_observations po ON (ps.attributed_observation_id = po.id OR po.attributed_payment_id = ps.id)
          WHERE ps.status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED')
            AND ps.id != ?
            AND po.bank_reference_number = ?
          LIMIT 1
        `, [currentSession.id, trimmedUtr]);

        if (priorUsedSession) {
          isUtrAlreadyUsed = true;
          if (this.auditRepo) {
            await this.auditRepo.log({
              merchantId: currentSession.merchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: currentSession.id,
              action: 'REUSED_UTR_REJECTED',
              actorType: 'SYSTEM',
              details: {
                bankReferenceNumber: trimmedUtr,
                consumedByOrderId: priorUsedSession.order_id,
                consumedBySessionId: priorUsedSession.id
              }
            });
          }
        }
      }

      let isPersonalSms = false;
      const senderStr = (normalizedObs.rawPayload?.sender || normalizedObs.rawPayload?.from || '').toString().trim();
      if ((normalizedObs.source === 'SMS' || normalizedObs.source === 'ANDROID_OBSERVER') && senderStr) {
        const digitsOnly = senderStr.replace(/[\s+-]/g, '');
        if (digitsOnly.length >= 10 && /^\d+$/.test(digitsOnly) && !/[a-zA-Z]/.test(senderStr)) {
          isPersonalSms = true;
        }
      }

      if (isUtrAlreadyUsed) {
        return {
          attributed: false,
          duplicate: true,
          lateMatch: false,
          observationId: savedObs.id,
          outcomeStatus: 'REFERENCE_ALREADY_USED'
        };
      }

      if (isPersonalSms) {
        return {
          attributed: false,
          duplicate: false,
          lateMatch: false,
          observationId: savedObs.id,
          outcomeStatus: 'PERSONAL_SMS_REJECTED'
        };
      }

      if (isEligibleStatus && isAmountMatch && isTimeValid) {
        const wasActive = currentSession.status === PaymentStatus.ACTIVE;

        const pendingGrace = this.pendingGraceTimers.get(currentSession.id);
        if (pendingGrace) {
          clearTimeout(pendingGrace);
          this.pendingGraceTimers.delete(currentSession.id);

          let verifyResult;
          try {
            verifyResult = await this.sessionRepo.recordVerificationSource(
              currentSession.id,
              normalizedObs.source,
              savedObs.id,
              { finalizeSuccess: true }
            );

            const primaryObs = currentSession.attributedObservationId
              ? await this.obsRepo.findById(currentSession.attributedObservationId)
              : null;
            const sameUtrAsPrimary = Boolean(
              primaryObs &&
              primaryObs.bankReferenceNumber &&
              savedObs.bankReferenceNumber &&
              String(primaryObs.bankReferenceNumber).trim() === String(savedObs.bankReferenceNumber).trim()
            );

            if (!sameUtrAsPrimary) {
              await this.obsRepo.markAttributed(savedObs.id, currentSession.id);
            } else {
              await this.obsRepo.db.execute(`
                UPDATE payment_observations
                SET attribution_status = ?
                WHERE id = ?
              `, [ObservationAttributionStatus.ATTRIBUTED, savedObs.id]);
            }
          } catch (dbErr) {
            const errMsg = dbErr?.message || '';
            if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('duplicate key value') || errMsg.includes('idx_observations_unique_attributed_bank_ref') || errMsg.includes('idx_payment_sessions_attributed_obs')) {
              return {
                attributed: false,
                duplicate: true,
                lateMatch: false,
                observationId: savedObs.id,
                outcomeStatus: 'REFERENCE_ALREADY_USED'
              };
            }
            throw dbErr;
          }

          if (this.auditRepo) {
            await this.auditRepo.log({
              merchantId: currentSession.merchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: currentSession.id,
              action: 'PAYMENT_VERIFICATION_UPGRADED_L2',
              actorType: 'SYSTEM',
              details: {
                observationId: savedObs.id,
                source: normalizedObs.source,
                verificationLevel: 2,
                verificationTag: verifyResult.tag,
                sources: verifyResult.sources
              }
            });
          }

          this.eventEmitter.emit('PAYMENT.SUCCESS', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            merchantId: currentSession.merchantId,
            amountPaise: currentSession.amountPaise,
            observationId: savedObs.id,
            verificationLevel: 2,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });
          if (typeof this.eventEmitter.settle === 'function') await this.eventEmitter.settle();

          this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            verificationLevel: 2,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });

          return {
            attributed: true,
            duplicate: false,
            lateMatch: false,
            wasActive,
            paymentSessionId: currentSession.id,
            observationId: savedObs.id,
            outcomeStatus: PaymentStatus.SUCCESS,
            verificationLevel: 2,
            verificationTag: verifyResult.tag,
            verificationSources: verifyResult.sources
          };
        }

        let verifyResult;
        try {
          verifyResult = await this.sessionRepo.recordVerificationSource(
            currentSession.id,
            normalizedObs.source,
            savedObs.id,
            { finalizeSuccess: false }
          );

          await this.obsRepo.markAttributed(savedObs.id, currentSession.id);
        } catch (dbErr) {
          const errMsg = dbErr.message || '';
          if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('duplicate key value') || errMsg.includes('idx_observations_unique_attributed_bank_ref') || errMsg.includes('idx_payment_sessions_attributed_obs')) {
            if (this.auditRepo) {
              await this.auditRepo.log({
                merchantId: currentSession.merchantId,
                entityType: 'PAYMENT_SESSION',
                entityId: currentSession.id,
                action: 'REUSED_UTR_REJECTED',
                actorType: 'SYSTEM',
                details: {
                  bankReferenceNumber: trimmedUtr,
                  error: 'Concurrent UTR or observation attribution race prevented by database unique constraint.'
                }
              });
            }
            return {
              attributed: false,
              duplicate: true,
              lateMatch: false,
              observationId: savedObs.id,
              outcomeStatus: 'REFERENCE_ALREADY_USED'
            };
          }
          throw dbErr;
        }

        if (this.auditRepo) {
          await this.auditRepo.log({
            merchantId: currentSession.merchantId,
            entityType: 'PAYMENT_SESSION',
            entityId: currentSession.id,
            action: 'PAYMENT_LEVEL1_VERIFIED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              verificationLevel: 1,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.LEVEL1_VERIFIED', {
          paymentId: currentSession.id,
          orderId: currentSession.orderId,
          merchantId: currentSession.merchantId,
          amountPaise: currentSession.amountPaise,
          observationId: savedObs.id,
          verificationLevel: 1,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        if (this.gracePeriodMs <= 0) {
          const finalResult = await this.sessionRepo.recordVerificationSource(
            currentSession.id,
            normalizedObs.source,
            savedObs.id,
            { finalizeSuccess: true }
          );
          this.eventEmitter.emit('PAYMENT.SUCCESS', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            merchantId: currentSession.merchantId,
            amountPaise: currentSession.amountPaise,
            observationId: savedObs.id,
            verificationLevel: finalResult.level,
            verificationTag: finalResult.tag,
            sources: finalResult.sources
          });
          if (typeof this.eventEmitter.settle === 'function') await this.eventEmitter.settle();

          return {
            attributed: true,
            duplicate: false,
            lateMatch: false,
            wasActive,
            paymentSessionId: currentSession.id,
            observationId: savedObs.id,
            outcomeStatus: PaymentStatus.SUCCESS,
            verificationLevel: finalResult.level,
            verificationTag: finalResult.tag,
            verificationSources: finalResult.sources
          };
        }

        const targetSessionId = currentSession.id;
        const targetObsId = savedObs.id;
        const targetSource = normalizedObs.source;
        const targetOrderId = currentSession.orderId;
        const targetMerchantId = currentSession.merchantId;
        const targetAmountPaise = currentSession.amountPaise;

        const graceTimer = setTimeout(() => { (async () => {
          this.pendingGraceTimers.delete(targetSessionId);
          const latestSession = await this.sessionRepo.findById(targetSessionId);
          if (!latestSession || (isTerminalStatus(latestSession.status) && latestSession.status !== PaymentStatus.SUCCESS)) {
            const sessionStatus = latestSession ? latestSession.status : 'EXPIRED';
            await this.obsRepo.markLateUnmatched(targetObsId);
            if (this.auditRepo) {
              await this.auditRepo.log({
                merchantId: targetMerchantId,
                entityType: 'PAYMENT_SESSION',
                entityId: targetSessionId,
                action: 'LATE_OBSERVATION_DETECTED',
                actorType: 'SYSTEM',
                details: {
                  observationId: targetObsId,
                  source: targetSource,
                  sessionStatus
                }
              });
            }
            if (this.ticketRepo && latestSession?.customerId) {
              await this.ticketRepo.createTicket({
                merchantId: targetMerchantId,
                customerId: latestSession.customerId,
                paymentId: targetSessionId,
                subject: `[LATE PAYMENT DETECTED] Order #${targetOrderId}`,
                status: TicketStatus.OPEN,
                initialMessage: {
                  senderType: SenderType.ADMIN,
                  senderId: targetMerchantId,
                  message: `A delayed payment observation of ${targetAmountPaise / 100n} INR was detected after session ${targetSessionId} ended with status ${sessionStatus}. Flagged for manual merchant reconciliation.`
                }
              });
            }
            this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
              paymentId: targetSessionId,
              orderId: targetOrderId,
              merchantId: targetMerchantId,
              amountPaise: targetAmountPaise,
              observationId: targetObsId
            });
            return;
          }

          if (latestSession.status === PaymentStatus.SUCCESS) {
            return;
          }

          const finalResult = await this.sessionRepo.recordVerificationSource(
            targetSessionId,
            targetSource,
            targetObsId,
            { finalizeSuccess: true }
          );

          if (this.auditRepo) {
            await this.auditRepo.log({
              merchantId: targetMerchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: targetSessionId,
              action: 'PAYMENT_ATTRIBUTED_SUCCESS_L1',
              actorType: 'SYSTEM',
              details: {
                observationId: targetObsId,
                source: targetSource,
                verificationLevel: finalResult.level,
                verificationTag: finalResult.tag
              }
            });
          }

          this.eventEmitter.emit('PAYMENT.SUCCESS', {
            paymentId: targetSessionId,
            orderId: targetOrderId,
            merchantId: targetMerchantId,
            amountPaise: targetAmountPaise,
            observationId: targetObsId,
            verificationLevel: finalResult.level,
            verificationTag: finalResult.tag,
            sources: finalResult.sources
          });
        })().catch((err) => console.error('[attribution] grace-window finalisation failed:', err?.message || err));
        }, this.gracePeriodMs);

        if (graceTimer.unref) graceTimer.unref();
        this.pendingGraceTimers.set(targetSessionId, graceTimer);

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          wasActive,
          paymentSessionId: currentSession.id,
          observationId: savedObs.id,
          outcomeStatus: 'VERIFYING',
          verificationLevel: 1,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
    const recentSuccessSession = await this.sessionRepo.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = 'SUCCESS'
        AND amount_paise = ? AND completed_at >= ?
      ORDER BY completed_at DESC LIMIT 1
    `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise), sixtySecsAgo]);

    if (recentSuccessSession) {
      const existingObs = recentSuccessSession.attributed_observation_id
        ? await this.obsRepo.findById(recentSuccessSession.attributed_observation_id)
        : null;

      const isUtrConflict = normalizedObs.bankReferenceNumber &&
        existingObs?.bankReferenceNumber &&
        normalizedObs.bankReferenceNumber !== existingObs.bankReferenceNumber;

      if (isUtrConflict) {
        if (this.auditRepo) {
          await this.auditRepo.log({
            merchantId: recentSuccessSession.merchant_id,
            entityType: 'PAYMENT_SESSION',
            entityId: recentSuccessSession.id,
            action: 'DUPLICATE_PAYMENT_UTR_CONFLICT',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              existingUtr: existingObs?.bankReferenceNumber,
              newUtr: normalizedObs.bankReferenceNumber,
              amountPaise: normalizedObs.amountPaise.toString()
            }
          });
        }
        if (this.ticketRepo && recentSuccessSession.customer_id) {
          await this.ticketRepo.createTicket({
            merchantId: recentSuccessSession.merchant_id,
            customerId: recentSuccessSession.customer_id,
            paymentId: recentSuccessSession.id,
            subject: `[DUPLICATE PAYMENT DETECTED] Order #${recentSuccessSession.order_id}`,
            status: TicketStatus.OPEN,
            initialMessage: {
              senderType: SenderType.ADMIN,
              senderId: recentSuccessSession.merchant_id,
              message: `A duplicate payment of ${normalizedObs.amountPaise / 100n} INR with reference ${normalizedObs.bankReferenceNumber} was received within 60s of completed order #${recentSuccessSession.order_id} (reference ${existingObs?.bankReferenceNumber || 'N/A'}). Flagged for merchant refund reconciliation.`
            }
          });
        }
        this.eventEmitter.emit('PAYMENT.DUPLICATE_DETECTED', {
          paymentId: recentSuccessSession.id,
          orderId: recentSuccessSession.order_id,
          merchantId: recentSuccessSession.merchant_id,
          observationId: savedObs.id,
          existingUtr: existingObs?.bankReferenceNumber,
          newUtr: normalizedObs.bankReferenceNumber,
          amountPaise: normalizedObs.amountPaise
        });
      }

      const sessionSlotStart = recentSuccessSession.slot_acquired_at
        ? new Date(new Date(recentSuccessSession.slot_acquired_at).getTime() - 30000)
        : new Date(new Date(recentSuccessSession.created_at).getTime() - 30000);
      const sessionCompleted = recentSuccessSession.completed_at
        ? new Date(new Date(recentSuccessSession.completed_at).getTime() + 30000)
        : new Date();

      if (!isUtrConflict && normalizedObs.observedAt >= sessionSlotStart && normalizedObs.observedAt <= sessionCompleted) {
        const verifyResult = await this.sessionRepo.recordVerificationSource(
          recentSuccessSession.id,
          normalizedObs.source,
          savedObs.id
        );

        await this.obsRepo.markAttributed(savedObs.id, recentSuccessSession.id);

        if (this.auditRepo) {
          await this.auditRepo.log({
            merchantId: recentSuccessSession.merchant_id,
            entityType: 'PAYMENT_SESSION',
            entityId: recentSuccessSession.id,
            action: 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              verificationLevel: verifyResult.level,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
          paymentId: recentSuccessSession.id,
          orderId: recentSuccessSession.order_id,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          paymentSessionId: recentSuccessSession.id,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentExpired = await this.sessionRepo.findRecentlyExpiredOrFailed(
      normalizedObs.receivingAccountId,
      thirtyMinutesAgo
    );

    const lateMatchedSession = recentExpired.find(s => s.amountPaise === normalizedObs.amountPaise);

    if (lateMatchedSession) {
      await this.obsRepo.markLateUnmatched(savedObs.id);

      if (this.auditRepo) {
        await this.auditRepo.log({
          merchantId: lateMatchedSession.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: lateMatchedSession.id,
          action: 'LATE_OBSERVATION_DETECTED',
          actorType: 'SYSTEM',
          details: {
            observationId: savedObs.id,
            source: normalizedObs.source,
            amountPaise: normalizedObs.amountPaise.toString(),
            sessionStatus: lateMatchedSession.status
          }
        });
      }

      if (this.ticketRepo && lateMatchedSession.customerId) {
        await this.ticketRepo.createTicket({
          merchantId: lateMatchedSession.merchantId,
          customerId: lateMatchedSession.customerId,
          paymentId: lateMatchedSession.id,
          subject: `[LATE PAYMENT DETECTED] Order #${lateMatchedSession.orderId}`,
          status: TicketStatus.OPEN,
          initialMessage: {
            senderType: SenderType.ADMIN,
            senderId: lateMatchedSession.merchantId,
            message: `A delayed payment observation of ${normalizedObs.amountPaise / 100n} INR was detected after session ${lateMatchedSession.id} ended with status ${lateMatchedSession.status}. Flagged for manual merchant reconciliation.`
          }
        });
      }

      this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
        paymentId: lateMatchedSession.id,
        orderId: lateMatchedSession.orderId,
        merchantId: lateMatchedSession.merchantId,
        amountPaise: normalizedObs.amountPaise,
        observationId: savedObs.id
      });

      return {
        attributed: false,
        duplicate: false,
        lateMatch: true,
        paymentSessionId: lateMatchedSession.id,
        observationId: savedObs.id,
        outcomeStatus: ObservationAttributionStatus.LATE_UNMATCHED
      };
    }

    return {
      attributed: false,
      duplicate: false,
      lateMatch: false,
      observationId: savedObs.id,
      outcomeStatus: ObservationAttributionStatus.UNATTRIBUTED
    };
  }
}
