import type { ApiError } from './protocol.ts';

type ErrorCode = ApiError['error'];

const MAX_RETRY_AFTER_SECONDS = 86400;

export class OperationError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfter?: number;
  constructor(code: ErrorCode, status = 400, retryAfter?: number) {
    super(code);
    this.name = 'OperationError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// A Map, not an object literal: SDK text must never match prototype keys.
const knownErrors = new Map<string, ErrorCode>([
  ['API_ID_INVALID', 'invalidCredentials'], ['API_HASH_INVALID', 'invalidCredentials'],
  ['PHONE_NUMBER_INVALID', 'invalidPhone'], ['PHONE_CODE_INVALID', 'invalidCode'],
  ['PHONE_CODE_EMPTY', 'invalidCode'], ['PHONE_CODE_EXPIRED', 'expiredCode'],
  ['PASSWORD_HASH_INVALID', 'invalidPassword'], ['EMAIL_ADDRESS_INVALID', 'invalidEmail'],
  ['EMAIL_CODE_INVALID', 'invalidCode'], ['EMAIL_CODE_EXPIRED', 'expiredCode'],
  ['CHAT_WRITE_FORBIDDEN', 'sendForbidden'], ['CHAT_SEND_PLAIN_FORBIDDEN', 'sendForbidden'],
  ['USER_BANNED_IN_CHANNEL', 'sendForbidden'], ['CHAT_ADMIN_REQUIRED', 'sendForbidden'],
  ['USER_IS_BLOCKED', 'sendForbidden'], ['USER_PRIVACY_RESTRICTED', 'sendForbidden'],
  ['MESSAGE_TOO_LONG', 'textTooLong'], ['REPLY_MESSAGE_ID_INVALID', 'replyUnavailable'],
  ['MESSAGE_ID_INVALID', 'replyUnavailable'], ['TOPIC_CLOSED', 'replyUnavailable'],
  ['ALLOW_PAYMENT_REQUIRED', 'paidMessage'],
]);

// TDLib reports flood waits as code 429 "Too Many Requests: retry after N".
// Raw MTProto errors use FLOOD_WAIT_N.
const floodWait = /^(?:Too Many Requests: retry after |FLOOD_WAIT_|SLOWMODE_WAIT_)(\d+)$/;

// Never forward SDK text. TDLib's 406 messages must not be processed/displayed.
export function telegramError(error: unknown): OperationError {
  if (!error || typeof error !== 'object') return new OperationError('unavailable', 503);
  const value = error as { code?: unknown; message?: unknown };
  if (value.code === 406) return new OperationError('unavailable', 503);
  const message = value.message;
  if (typeof message !== 'string') return new OperationError('unavailable', 503);
  const known = knownErrors.get(message);
  if (known) return new OperationError(known);
  const wait = floodWait.exec(message);
  if (wait) return new OperationError('rateLimited', 429, Math.min(Number(wait[1]), MAX_RETRY_AFTER_SECONDS));
  if (value.code === 429) return new OperationError('rateLimited', 429);
  return new OperationError('unavailable', 503);
}
