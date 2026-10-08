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
