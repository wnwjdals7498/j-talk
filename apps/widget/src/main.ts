import css from "./style.css?inline";
import { TALK_VISITOR_PATHS as paths } from "@j-talk/contracts";
import type { TalkSync, TalkVisitorToken } from "@j-talk/contracts";
const script = document.currentScript as HTMLScriptElement | null;
const source = script?.src;
const guest =
  script?.dataset.guestId && script.dataset.guestExp && script.dataset.guestSig
    ? {
        guestId: script.dataset.guestId,
        exp: Number(script.dataset.guestExp),
        sig: script.dataset.guestSig,
      }
    : undefined;
if (source)
  void (async () => {
    try {
      const origin = new URL(source).origin;
      if (!origin.startsWith("https://")) return;
      const available = await fetch(new URL("/ext/talk/v1/preflight", origin), {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!available.ok) return;
      const state = (await available.json()) as {
        allowed?: boolean;
        available?: boolean;
      };
      if (state.allowed !== true || state.available !== true) return;
      const host = document.createElement("div"),
        root = host.attachShadow({ mode: "open" }),
        style = document.createElement("style"),
        panel = document.createElement("section"),
        heading = document.createElement("h2"),
        history = document.createElement("ol"),
        status = document.createElement("p"),
        form = document.createElement("form"),
        input = document.createElement("textarea"),
        send = document.createElement("button"),
        button = document.createElement("button");
      style.textContent = css;
      panel.hidden = true;
      panel.setAttribute("aria-label", "상담 대화");
      heading.textContent = "상담";
      history.setAttribute("aria-label", "대화 기록");
      history.setAttribute("aria-live", "polite");
      status.setAttribute("role", "status");
      input.setAttribute("aria-label", "문의 메시지");
      input.maxLength = 4096;
      send.type = "submit";
      send.textContent = "보내기";
      button.type = "button";
      button.textContent = "상담";
      button.setAttribute("aria-expanded", "false");
      form.append(input, send);
      panel.append(heading, history, status, form);
      root.append(style, panel, button);
      document.body.append(host);
      button.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
        if (!panel.hidden) input.focus();
      });
      const storageKey = "j-talk:v1:" + origin,
        seen = new Set<string>();
      let credential: TalkVisitorToken | undefined,
        cursor: string | undefined,
        socket: WebSocket | undefined,
        retry: ReturnType<typeof setTimeout> | undefined,
        rotation: ReturnType<typeof setTimeout> | undefined,
        stopped = false,
        recovering: Promise<void> | undefined;
      const save = () => {
        try {
          localStorage.setItem(
            storageKey,
            JSON.stringify({ ...credential, guest: guest?.guestId ?? null }),
          );
        } catch {
          /* Storage may be disabled; use memory for this page. */
        }
      };
      const request = (path: string, body?: unknown, authorized = true) =>
        fetch(new URL(path, origin), {
          method: body === undefined ? "GET" : "POST",
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: {
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...(authorized && credential
              ? { Authorization: "Bearer " + credential.token }
              : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const apply = (events: TalkSync) => {
        for (const event of events.items) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          if (event.message) {
            const item = document.createElement("li");
            item.textContent =
              (event.message.senderMemberId ? "담당자: " : "나: ") +
              event.message.text;
            history.append(item);
            item.scrollIntoView({ block: "nearest" });
          } else if (event.type === "talk.closed")
            status.textContent =
              "상담이 종료되었습니다. 새 메시지를 보내면 새 문의가 시작됩니다.";
        }
        cursor = events.cursor;
      };
      const sync = async () => {
        for (let page = 0; page < 100; page++) {
          let response = await request(
            paths.sync +
              (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
          );
          if (response.status === 400 && cursor) {
            cursor = undefined;
            response = await request(paths.sync);
          }
          if (!response.ok) throw new Error();
          const events = (await response.json()) as TalkSync;
          apply(events);
          if (!events.hasMore) return;
        }
        throw new Error();
      };
      const issue = async () => {
        const response = await request(
          paths.tokens,
          { ...(guest ? { guest } : {}) },
          false,
        );
        if (!response.ok) throw new Error();
        credential = (await response.json()) as TalkVisitorToken;
        cursor = undefined;
        save();
      };
      const connect = () => {
        if (stopped || !credential) return;
        socket?.close();
        const url = new URL(paths.websocket, origin);
        url.protocol = "wss:";
        const current = new WebSocket(url);
        socket = current;
        current.addEventListener("open", () =>
          current.send(
            JSON.stringify({
              type: "authenticate",
              token: credential!.token,
              ...(cursor ? { cursor } : {}),
            }),
          ),
        );
        current.addEventListener("message", (event) => {
          if (socket !== current) return;
          try {
            const data = JSON.parse(String(event.data)) as TalkSync & {
              type: string;
            };
            if (data.type === "events") {
              apply(data);
              if (data.hasMore)
                void sync().catch(() => {
                  status.textContent = "연결 복구 중입니다.";
                });
            }
          } catch {
            current.close();
          }
        });
        current.addEventListener("close", () => {
          if (stopped || socket !== current) return;
          status.textContent =
            "연결 복구 중입니다. 전송한 메시지는 다시 보내지 않습니다.";
          retry = setTimeout(() => {
            void recover();
          }, 1000);
        });
      };
      const scheduleRotation = () => {
        if (rotation) clearTimeout(rotation);
        if (!credential) return;
        rotation = setTimeout(
          () => {
            void (async () => {
              const response = await request(paths.tokens + "/rotate", {});
              if (!response.ok) throw new Error();
              credential = (await response.json()) as TalkVisitorToken;
              save();
              connect();
              scheduleRotation();
            })().catch(() => {
              void recover();
            });
          },
          Math.max(1000, Date.parse(credential.expiresAt) - Date.now() - 60000),
        );
      };
      const recover = () => {
        recovering ??= (async () => {
          if (!credential) await issue();
          const current = await request(paths.session);
          if (current.status === 401) {
            status.textContent =
              "방문자 세션이 만료되었습니다. 새 문의를 시작합니다.";
            await issue();
          } else if (!current.ok) throw new Error();
          await sync();
          connect();
          scheduleRotation();
        })()
          .catch(() => {
            status.textContent =
              "상담 연결을 다시 시도합니다. 잠시 기다려 주세요.";
            if (!stopped)
              retry = setTimeout(() => {
                void recover();
              }, 5000);
          })
          .finally(() => {
            recovering = undefined;
          });
        return recovering;
      };
      try {
        const value: unknown = JSON.parse(
          localStorage.getItem(storageKey) ?? "null",
        );
        if (value && typeof value === "object") {
          const saved = value as Record<string, unknown>;
          if (
            typeof saved.token === "string" &&
            /^jtv_[A-Za-z0-9_-]{43}$/.test(saved.token) &&
            typeof saved.expiresAt === "string" &&
            Date.parse(saved.expiresAt) > Date.now() &&
            saved.guest === (guest?.guestId ?? null)
          )
            credential = { token: saved.token, expiresAt: saved.expiresAt };
        }
      } catch {
        /* Corrupt/denied storage starts a new session. */
      }
      let pending: { requestId: string; text: string } | undefined;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = input.value;
        if (!text.trim() || new TextEncoder().encode(text).length > 4096) {
          status.textContent = "메시지는 1~4096바이트로 입력해 주세요.";
          return;
        }
        if (send.disabled) return;
        send.disabled = true;
        if (pending?.text !== text)
          pending = { requestId: crypto.randomUUID(), text };
        void (async () => {
          if (!credential) await recover();
          const response = await request(paths.messages, pending);
          if (response.status === 429) {
            status.textContent =
              "전송 한도를 초과했습니다. 잠시 후 다시 보내 주세요.";
            return;
          }
          if (!response.ok) {
            status.textContent =
              "전송을 확인하지 못했습니다. 다시 보내기를 누르면 같은 요청으로 재시도합니다.";
            return;
          }
          input.value = "";
          pending = undefined;
          status.textContent = "전송되었습니다.";
          await sync();
        })()
          .catch(() => {
            status.textContent =
              "전송을 확인하지 못했습니다. 다시 시도해 주세요.";
          })
          .finally(() => {
            send.disabled = false;
          });
      });
      window.addEventListener(
        "pagehide",
        () => {
          stopped = true;
          if (retry) clearTimeout(retry);
          if (rotation) clearTimeout(rotation);
          socket?.close();
        },
        { once: true },
      );
      await recover();
    } catch {
      /* Failed/disabled services never expose an unbound widget. */
    }
  })();
