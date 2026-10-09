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
// Only established member HTTP and settings contracts are published here.
// Visitor issuance, browser WSS authentication and signed sync cursors remain T2.
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
  senderMemberId: string;
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
} as const;
export function talkNotificationDedupKey(roomId: string, occurrenceId: string) {
  if (
    !new RegExp(TALK_UUID_PATTERN).test(roomId) ||
    !new RegExp(TALK_UUID_PATTERN).test(occurrenceId)
  )
    throw new Error("Room and occurrence UUIDs required.");
  return roomId + ":" + occurrenceId;
}
