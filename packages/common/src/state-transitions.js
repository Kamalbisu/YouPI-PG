import { PaymentStatus } from './enums.js';

export const VALID_TRANSITIONS = Object.freeze({
  [PaymentStatus.INITIATED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.QUEUED,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED,
    PaymentStatus.SUCCESS
  ],
  [PaymentStatus.QUEUED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED,
    PaymentStatus.SUCCESS
  ],
  [PaymentStatus.ACTIVE]: [
    PaymentStatus.PROCESSING,
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED
  ],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED
  ],
  [PaymentStatus.SUCCESS]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.EXPIRED]: [],
  [PaymentStatus.CANCELLED]: []
});

export const TERMINAL_STATES = Object.freeze([
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELLED
]);

export const SLOT_OCCUPYING_STATES = Object.freeze([
  PaymentStatus.ACTIVE,
  PaymentStatus.PROCESSING
]);

export function isValidTransition(currentState, nextState) {
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(nextState);
}

export function isTerminalStatus(status) {
  return TERMINAL_STATES.includes(status);
}

export function holdsSlot(status) {
  return SLOT_OCCUPYING_STATES.includes(status);
}