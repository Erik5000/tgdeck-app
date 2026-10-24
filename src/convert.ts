import type * as Td from 'tdlib-types';
import type { Chat, Message, FileRef } from './protocol.ts';
import { telegramError } from './errors.ts';

// Keyed by TDLib type names, so that a misspelled key fails the type check.
const contentLabels: Partial<Record<Td.MessageContent['_'], string>> = {
  messagePhoto: 'Photo', messageVideo: 'Video', messageAnimation: 'GIF',
  messageAudio: 'Audio', messageVoiceNote: 'Voice message', messageVideoNote: 'Video message',
  messageDocument: 'File', messageSticker: 'Sticker', messagePoll: 'Poll', messageChecklist: 'Checklist',
  messageLocation: 'Location', messageLiveLocation: 'Live location', messageVenue: 'Venue',
  messageContact: 'Contact', messageGame: 'Game', messageInvoice: 'Invoice', messageStory: 'Story',
  messagePaidMedia: 'Paid media', messageGiveaway: 'Giveaway', messageCall: 'Call',
  messageExpiredPhoto: 'Expired photo', messageExpiredVideo: 'Expired video',
  messageExpiredVideoNote: 'Expired video message', messageExpiredVoiceNote: 'Expired voice message',
  messageUnsupported: 'Unsupported message',
};

export function convertChat(chat: Td.chat): Chat | undefined {
  if (chat.type._ === 'chatTypeSecret') return undefined;
  const type = chat.type._ === 'chatTypePrivate' ? 'private'
    : chat.type._ === 'chatTypeSupergroup' && chat.type.is_channel ? 'channel' : 'group';
  return { id: String(chat.id), title: chat.title, type, canSend: false };
}

export function messageText(content: Td.MessageContent): string {
  if (content._ === 'messageText') return content.text.text;
  if (content._ === 'messageAnimatedEmoji' || content._ === 'messageDice') return content.emoji;
  if ('caption' in content && content.caption?.text) return content.caption.text;
  return contentLabels[content._] ?? 'Service message';
}

export function convertMessage(message: Td.message, chat: Chat, sender: string, avatar?: FileRef): Message {
  return {
    key: `${chat.id}:${message.id}`, id: String(message.id), chat,
    sender: { name: message.is_outgoing ? 'You' : sender, ...(avatar ? { avatar } : {}) }, date: message.date,
    edited: message.edit_date > 0, own: message.is_outgoing,
    text: messageText(message.content), entities: [], mentioned: message.contains_unread_mention,
    ...(message.reply_to?._ === 'messageReplyToMessage' && message.reply_to.message_id
      ? { replyTo: { chatId: String(message.reply_to.chat_id || message.chat_id), messageId: String(message.reply_to.message_id) } } : {}),
    ...(message.sending_state?._ === 'messageSendingStatePending' ? { delivery: 'pending' as const }
      : message.sending_state?._ === 'messageSendingStateFailed'
        ? { delivery: 'failed' as const, sendError: { error: telegramError(message.sending_state.error).code,
          ...(message.sending_state.retry_after > 0 ? { retryAfter: Math.ceil(message.sending_state.retry_after) } : {}) } } : {}),
  };
}
