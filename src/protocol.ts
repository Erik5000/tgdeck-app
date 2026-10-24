// Wire contract: JSON-safe values only. IDs stay strings to preserve precision.
export type Mode = 'demo' | 'telegram';
export type Connection = 'connected' | 'connecting' | 'updating';
export type Chat = { id: string; title: string; type: 'channel' | 'group' | 'private'; canSend: boolean;
  sendRestriction?: 'readOnly' | 'paid' | 'unavailable'; replyOnly?: boolean };
export type TextEntity = {
  offset: number;
  length: number;
  type: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'link' | 'spoiler' | 'mention' | 'hashtag' | 'customEmoji';
  url?: string;
};
export type FileRef = { id: string; name?: string; mimeType: string; size: number };
export type Media =
  | { kind: 'photo' | 'video' | 'gif' | 'voice' | 'videoNote' | 'file' | 'sticker'; file: FileRef; preview?: FileRef; width?: number; height?: number; duration?: number }
  | { kind: 'poll'; question: string; options: string[] }
  | { kind: 'location'; latitude: number; longitude: number }
  | { kind: 'contact'; name: string; phone: string };
export type Message = {
  key: string;
  id: string;
  chat: Chat;
  sender: { name: string; avatar?: FileRef };
  date: number; // Unix seconds
  edited: boolean;
  own: boolean;
  text: string;
  entities: TextEntity[]; // Telegram's UTF-16 offsets
  media?: Media;
  replyTo?: { chatId: string; messageId: string; topicId?: string };
  forwardFrom?: string;
  topicName?: string;
  mentioned?: boolean;
  delivery?: 'pending' | 'failed';
  sendError?: ApiError;
};
export type ColumnFilter =
  | { type: 'chat'; chatId: string }
  | { type: 'folder'; folderId: string }
  | { type: 'search'; keywords: string[]; folderId?: string }
  | { type: 'mentions' };
export type Column = {
  id: string;
  title: string;
  width: 'narrow' | 'medium' | 'wide';
  filter: ColumnFilter;
  chat?: Chat;
};
export type AuthState =
  | { state: 'setup' | 'starting' | 'phone' | 'password' | 'email' | 'emailCode' | 'ready' | 'closed' }
  | { state: 'code'; delivery: 'telegram' | 'sms' | 'call' | 'email' | 'other' }
  | { state: 'unsupported'; reason: 'registration' | 'premium' | 'deviceConfirmation' };
export const authSteps = ['phone', 'code', 'password', 'email', 'emailCode'] as const;
export type AuthInput = { step: typeof authSteps[number]; value: string };
export type SetupInput = { apiId: number; apiHash: string };
export type SendInput = { requestId: string; chatId: string; text: string; replyTo?: { chatId: string; messageId: string } };
export type Settings = { theme: 'system' | 'light' | 'dark'; accent: 'sage' | 'ocean' | 'rose' | 'amber';
  fontSize: 12 | 14 | 16 | 18; profilePictures: boolean; density: 'comfortable' | 'compact';
  messageStyle: 'flat' | 'bubbles'; layout: 'columns' | 'grid' | 'focus' };
export type ColumnPosition = Pick<Column, 'id' | 'width'>;
export type SavedLayout = { id: string; name: string; layout: Settings['layout']; columns: ColumnPosition[] };
export type WorkspacePreferences = { settings: Settings; columns: ColumnPosition[]; layouts: SavedLayout[] };
export type Page = { messages: Message[]; cursor?: string };
export type Snapshot = {
  mode: Mode;
  connection: Connection;
  columns: Column[];
  feeds: Record<string, Message[]>;
  auth: AuthState;
  authError?: ApiError;
  settings?: Settings;
  layouts?: SavedLayout[];
};
export type ServerEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'message' | 'messageEdited'; columnId: string; message: Message }
  | { type: 'messageReplaced'; columnId: string; oldKey: string; message: Message }
  | { type: 'messagesDeleted'; columnId: string; keys: string[] }
  | { type: 'columns'; columns: Column[] }
  | { type: 'connection'; connection: Connection }
  | { type: 'auth'; auth: AuthState }
  | { type: 'settings'; settings: Settings }
  | { type: 'columnError'; columnId: string; code: 'unavailable' | 'rateLimited'; retryAfter?: number };
export type ApiError = { error: 'unauthorized' | 'forbidden' | 'notFound' | 'invalidRequest' | 'unavailable' | 'invalidState' | 'invalidCredentials' | 'invalidPhone' | 'invalidCode' | 'expiredCode' | 'invalidPassword' | 'invalidEmail' | 'rateLimited' | 'columnLimit' | 'sendForbidden' | 'paidMessage' | 'replyUnavailable' | 'replyRequired' | 'sendUncertain' | 'textTooLong'; retryAfter?: number };

// Implemented: state/events, demo board, setup/auth, chat search and chat columns
// (POST /api/columns {chatId}, DELETE /api/columns/:id), and POST /api/send.
// Media downloads and uploads are not exposed yet.
