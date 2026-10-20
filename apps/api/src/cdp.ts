/**
 * Takes a picture of what a Browser Use browser is showing, over the Chrome DevTools Protocol.
 * Browser Use has no screenshot API, but each open browser has a DevTools address (cdpUrl).
 * That address controls the browser, so it is treated like a password: never stored or logged.
 */

export interface CapturedTab {
  url: string;
  title: string | null;
  active: boolean;
}

export interface Capture {
  /** JPEG of the visible part of the page the browser is showing. */
  jpeg: Uint8Array;
  tabs: CapturedTab[];
}

/** Widest picture we keep, in pixels; a card thumbnail and the closed-browser panel need no more. */
const MAX_WIDTH = 1280;
const MAX_TABS = 8;

interface CdpMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

export async function captureOverCdp(cdpUrl: string, timeoutMs = 15000): Promise<Capture | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  const version = await fetch(`${cdpUrl.replace(/\/$/, "")}/json/version`, { signal });
  if (!version.ok) return null;
  const { webSocketDebuggerUrl } = (await version.json()) as { webSocketDebuggerUrl?: string };
  if (!webSocketDebuggerUrl) return null;

  const ws = new WebSocket(webSocketDebuggerUrl);
  let next = 0;
  const waiting = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  const failAll = (err: Error) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as CdpMessage;
    const w = msg.id ? waiting.get(msg.id) : undefined;
    if (!w) return;
    waiting.delete(msg.id!);
    if (msg.error) w.reject(new Error(msg.error.message));
    else w.resolve(msg.result ?? {});
  };
  ws.onclose = () => failAll(new Error("The browser closed the connection."));
  const onAbort = () => {
    failAll(new Error("Taking the picture took too long."));
    ws.close();
  };
  signal.addEventListener("abort", onAbort);
  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve: resolve as (r: Record<string, unknown>) => void, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Couldn't connect to the browser."));
      signal.addEventListener("abort", () => reject(new Error("Connecting took too long.")));
    });
    const { targetInfos } = await send<{
      targetInfos: { targetId: string; type: string; url: string; title: string }[];
    }>("Target.getTargets");
    const pages = targetInfos
      .filter((t) => t.type === "page" && !/^(chrome|devtools|chrome-extension):/.test(t.url))
      .slice(0, MAX_TABS);
    if (!pages.length) return null;

    // The tab on screen is the one whose page is visible.
    const sessions: { tab: CapturedTab; sessionId: string }[] = [];
    for (const p of pages) {
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: p.targetId,
        flatten: true,
      });
      const visible = await send<{ result: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "document.visibilityState", returnByValue: true },
        sessionId,
      ).catch(() => ({ result: {} as { value?: string } }));
      sessions.push({
        tab: { url: p.url, title: p.title || null, active: visible.result.value === "visible" },
        sessionId,
      });
    }
    const shown =
      sessions.find((s) => s.tab.active) ??
      [...sessions].reverse().find((s) => s.tab.url !== "about:blank") ??
      sessions[0]!;
    shown.tab.active = true;
    for (const s of sessions) if (s !== shown) s.tab.active = false;

    const metrics = await send<{
      cssVisualViewport: {
        pageX: number;
        pageY: number;
        clientWidth: number;
        clientHeight: number;
      };
    }>("Page.getLayoutMetrics", {}, shown.sessionId);
    const vp = metrics.cssVisualViewport;
    // The picture comes out at the screen's pixel density, so the scale allows for it.
    const dpr = await send<{ result: { value?: number } }>(
      "Runtime.evaluate",
      { expression: "window.devicePixelRatio", returnByValue: true },
      shown.sessionId,
    ).then(
      (r) => r.result.value || 1,
      () => 1,
    );
    const { data } = await send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 70,
        clip: {
          x: vp.pageX,
          y: vp.pageY,
          width: vp.clientWidth,
          height: vp.clientHeight,
          scale: Math.min(1, MAX_WIDTH / Math.max(1, vp.clientWidth * dpr)),
        },
      },
      shown.sessionId,
    );
    return { jpeg: new Uint8Array(Buffer.from(data, "base64")), tabs: sessions.map((s) => s.tab) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    ws.onclose = null;
    ws.close();
  }
}
