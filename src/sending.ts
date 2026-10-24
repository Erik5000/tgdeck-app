import type * as Td from 'tdlib-types';
import type { Chat, SendInput } from './protocol.ts';
import { OperationError } from './errors.ts';

export const MAX_TEXT_LENGTH = 4096;
const validId = (value: unknown): value is string => typeof value === 'string'
  && /^-?[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

export function validateSend(value: unknown): asserts value is SendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperationError('invalidRequest');
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.some(key => !['requestId', 'chatId', 'text', 'replyTo'].includes(key))
    || typeof body.requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(body.requestId)
    || !validId(body.chatId) || typeof body.text !== 'string' || !body.text.trim()) throw new OperationError('invalidRequest');
  if (body.text.length > MAX_TEXT_LENGTH) throw new OperationError('textTooLong');
  if ('replyTo' in body) {
    const reply = body.replyTo;
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new OperationError('invalidRequest');
    const target = reply as Record<string, unknown>;
    if (Object.keys(target).length !== 2 || target.chatId !== body.chatId
      || !validId(target.messageId) || Number(target.messageId) <= 0) throw new OperationError('invalidRequest');
  }
}

export function memberCanSend(status: Td.ChatMemberStatus, permissions: Td.chatPermissions, channel = false): boolean {
  switch (status._) {
    case 'chatMemberStatusCreator': return status.is_member;
    case 'chatMemberStatusAdministrator': return !channel || status.rights.can_post_messages;
    case 'chatMemberStatusMember': return !channel && permissions.can_send_basic_messages;
    case 'chatMemberStatusRestricted': return !channel && status.is_member
      && permissions.can_send_basic_messages && status.permissions.can_send_basic_messages;
    default: return false;
  }
}

/** Read current rights; TDLib still enforces the final permission check on send. */
export async function writeAccess(raw: Td.chat, invoke: Td.Invoke, onlyLocal = true): Promise<Pick<Chat, 'canSend' | 'sendRestriction' | 'replyOnly'>> {
  const denied = { canSend: false, sendRestriction: 'readOnly' } as const;
  if (raw.type._ === 'chatTypeSecret' || raw.block_list?._ === 'blockListMain') return denied;
  if (raw.type._ === 'chatTypePrivate') {
    const result = await invoke({ _: 'canSendMessageToUser', user_id: raw.type.user_id, only_local: onlyLocal });
    if (result._ === 'canSendMessageToUserResultUserHasPaidMessages') return { canSend: false, sendRestriction: 'paid' };
    return result._ === 'canSendMessageToUserResultOk' ? { canSend: true } : denied;
  }
  const group = raw.type._ === 'chatTypeBasicGroup'
    ? await invoke({ _: 'getBasicGroup', basic_group_id: raw.type.basic_group_id })
    : await invoke({ _: 'getSupergroup', supergroup_id: raw.type.supergroup_id });
  if (group._ === 'basicGroup' && !group.is_active) return denied;
  if (group._ === 'supergroup' && group.is_direct_messages_group) return denied;
  const admin = ['chatMemberStatusCreator', 'chatMemberStatusAdministrator'].includes(group.status._);
  if (group._ === 'supergroup' && group.paid_message_star_count > 0 && !admin) return { canSend: false, sendRestriction: 'paid' };
  if (group._ === 'supergroup' && group.is_broadcast_group && !admin) return denied;
  if (!memberCanSend(group.status, raw.permissions, group._ === 'supergroup' && group.is_channel)) return denied;
  return { canSend: true, ...(group._ === 'supergroup' && group.is_forum ? { replyOnly: true } : {}) };
}
