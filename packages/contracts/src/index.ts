export const TALK_PATHS = {
  origins: "/talk/settings/origins",
  widgetKey: "/talk/settings/widget-key",
  visitorPreflight: "/ext/talk/v1/preflight",
  widget: "/ext/talk/v1/widget.min.js",
  rooms: "/talk/rooms",
} as const;
export const WIDGET_PREVIOUS_KEY_SECONDS = 86400;
export interface OriginPage {
  items: string[];
  next: string | null;
}
export interface WidgetKeyStatus {
  issued: boolean;
  previousValidUntil: string | null;
}
export interface IssuedWidgetKey {
  key: string;
  previousValidUntil: string | null;
}
export interface GuestSignature {
  guestId: string;
  exp: number;
  sig: string;
}
// Public visitor credentials are distinct from Keycloak member Bearer tokens.
export const TALK_ROOM_STATUSES = ["waiting", "in_progress", "closed"] as const;
export type TalkRoomStatus = (typeof TALK_ROOM_STATUSES)[number];
export interface TalkRoom {
  id: string;
  status: TalkRoomStatus;
  assignedMemberId: string | null;
  guestId: string | null;
}
export interface TalkRoomSummary extends TalkRoom {
  createdAt: string;
}
export interface TalkPage<T> {
  items: T[];
  next: string | null;
}
export interface TalkMessage {
  id: string;
  text: string;
  senderMemberId: string | null;
  senderVisitorId: string | null;
  createdAt: string;
}
export interface TalkReplyRequest {
  requestId: string;
  text: string;
}
export interface TalkReplyResult {
  id: string;
  delivery: "pending";
}
export interface TalkAssignmentResult {
  id: string;
  status: "in_progress";
  assignedMemberId: string;
  occurrenceId: string;
}
export interface TalkAssignee {
  id: string;
  username: string;
}
export interface TalkAssigneePage {
  items: TalkAssignee[];
  nextCursor: string | null;
}
export interface TalkAssignRequest {
  memberId: string;
}
// Internal BFF-to-Talk envelope. The browser receives neither this proof nor its key.
export interface TalkTrustedAssignment extends TalkAssignRequest {
  authorization: string;
}
export const TALK_ASSIGNMENT_TTL_SECONDS = 10;
export const TALK_ASSIGNMENT_KEY_CONTEXT = "jgw-talk-assignment-v1:";
export interface TalkCloseResult {
  id: string;
  status: "closed";
}
export const TALK_MEMBER_LIMITS = { page: 100, textBytes: 4096 } as const;
export const TALK_UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const uuid = { type: "string", pattern: TALK_UUID_PATTERN };
export const TALK_MEMBER_SCHEMAS = {
  uuid,
  empty: { type: "object", additionalProperties: false },
  roomParams: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: uuid },
  },
  page: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      after: uuid,
    },
  },
  reply: {
    type: "object",
    additionalProperties: false,
    required: ["requestId", "text"],
    properties: {
      requestId: uuid,
      text: { type: "string", minLength: 1, maxLength: 4096 },
    },
  },
  assign: {
    type: "object",
    additionalProperties: false,
    required: ["memberId"],
    properties: { memberId: uuid },
  },
  trustedAssignment: {
    type: "object",
    additionalProperties: false,
    required: ["memberId", "authorization"],
    properties: {
      memberId: uuid,
      authorization: { type: "string", minLength: 1, maxLength: 2048 },
    },
  },
  assignees: {
    type: "object",
    additionalProperties: false,
    properties: {
      cursor: { type: "string", pattern: "^(0|[1-9][0-9]{0,5})$" },
    },
  },
} as const;
export function talkNotificationDedupKey(roomId: string, occurrenceId: string) {
  if (
    !new RegExp(TALK_UUID_PATTERN).test(roomId) ||
    !new RegExp(TALK_UUID_PATTERN).test(occurrenceId)
  )
    throw new Error("Room and occurrence UUIDs required.");
  return roomId + ":" + occurrenceId;
}
export const TALK_VISITOR_PATHS = {
  tokens: "/ext/talk/v1/tokens",
  session: "/ext/talk/v1/session",
  messages: "/ext/talk/v1/messages",
  sync: "/ext/talk/v1/sync",
  websocket: "/ext/talk/v1/ws",
} as const;
export const TALK_VISITOR_POLICY = {
  tokenSeconds: 1800,
  cursorSeconds: 300,
  issuePerMinute: 10,
  messagesPerMinute: 20,
  textBytes: 4096,
  authenticationSeconds: 5,
  pollMilliseconds: 250,
  page: 100,
} as const;
export interface TalkVisitorToken {
  token: string;
  expiresAt: string;
}
export interface TalkVisitorSession {
  guestId: string | null;
  room: TalkRoom | null;
  expiresAt: string;
}
export type TalkVisitorMessageRequest = TalkReplyRequest;
export interface TalkVisitorMessageResult {
  id: string;
  roomId: string;
}
export interface TalkEvent {
  id: string;
  roomId: string;
  type: "talk.new" | "talk.assigned" | "talk.message" | "talk.closed";
  message: TalkMessage | null;
}
export interface TalkSync {
  items: TalkEvent[];
  cursor: string;
  hasMore: boolean;
}
