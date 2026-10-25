import { isValidTransition, isTerminalStatus, VALID_TRANSITIONS } from '@youpi/common';

export { VALID_TRANSITIONS, isValidTransition, isTerminalStatus };

export function assertValidTransition(currentState, nextState) {
  if (!isValidTransition(currentState, nextState)) {
    throw new Error(
      `Illegal payment state transition: Cannot move from '${currentState}' to '${nextState}'.`
    );
  }
}

export function toPublicOutcome(status) {
  switch (status) {
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILED':
      return 'FAILED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      throw new Error(`Status '${status}' is an internal non-terminal state and cannot be mapped to a public outcome.`);
  }
}