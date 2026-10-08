import css from "./style.css?inline";
const source = (document.currentScript as HTMLScriptElement | null)?.src;
if (source)
  void (async () => {
    try {
      const url = new URL(source);
      if (url.protocol !== "https:") return;
      const response = await fetch(new URL("/ext/talk/v1/preflight", url), {
        credentials: "omit",
        redirect: "error",
      });
      if (!response.ok) return;
      const state = (await response.json()) as {
        allowed?: boolean;
        available?: boolean;
      };
      // Availability stays false until the actual visitor/token transport is bound.
      if (state.allowed !== true || state.available !== true) return;
      const host = document.createElement("div"),
        root = host.attachShadow({ mode: "closed" }),
        style = document.createElement("style"),
        panel = document.createElement("section"),
        button = document.createElement("button");
      style.textContent = css;
      panel.hidden = true;
      panel.textContent = "상담 연결 준비 중";
      button.textContent = "상담";
      button.setAttribute("aria-expanded", "false");
      button.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
      });
      root.append(style, panel, button);
      document.body.append(host);
    } catch {
      /* Failed/disabled services never display a button. */
    }
  })();
