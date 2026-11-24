import { useEffect, useMemo, useSyncExternalStore } from "react";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { noticePath } from "../../layout/nav";
import api from "../../api/api";
import { alertPerson } from "../../lib/alerts";
import type { ChatOverview } from "../chat/useChat";

// Live updates (GET /api/events, Server-Sent Events). The bell and its pop-up
// are instant. Open lists and records don't redraw by themselves (rows moving
// under your mouse is worse than a moment's delay): they show "Hana changed
// this · Refresh". Dashboards' counts update quietly.

export type LiveChange = { table: string; id: string | null; by: string; byName: string; deleted: boolean; at: number };

// changes by other people, kept for the open screens to ask about
let changes: LiveChange[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const push = (c: LiveChange) => {
  changes = [...changes.slice(-199), c];
  listeners.forEach((l) => l());
};

// Changes by others to this table (or this record) since `since`.
export function useLiveChanges(table: string, since: number, id?: string): LiveChange[] {
  const all = useSyncExternalStore(subscribe, () => changes);
  return useMemo(
    () => all.filter((c) => c.table === table && c.at > since && (!id || c.id === id || c.id === null)),
    [all, table, since, id]
  );
}

type Notice = { _id: string; title: string; tableName: string | null; recordId: string | null; read: boolean };

// The pop-up (and chime / desktop notification) for something in your bell
function announce(n: { title: string; table: string | null; id: string | null }, navigate: (to: string) => void) {
  const open = n.table && n.id ? () => navigate(noticePath(n.table!, n.id!)) : undefined;
  notifications.show({
    title: n.title,
    message: open ? "Click to open" : "",
    color: "blue",
    style: open ? { cursor: "pointer" } : undefined,
    onClick: open,
  });
  alertPerson(n.title, open ? "Click to open" : "", open);
}

// A new direct or group message, unless that conversation is open in front of you
function announceChat(channel: { _id: string; kind: string; name: string }, navigate: (to: string) => void) {
  if (channel.kind !== "dm" && channel.kind !== "group") return;
  const open = window.location.pathname === "/chat" && new URLSearchParams(window.location.search).get("c") === channel._id;
  if (open && document.visibilityState === "visible" && document.hasFocus()) return;
  alertPerson(
    channel.kind === "dm" ? `New message from ${channel.name}` : `New message in ${channel.name}`,
    "Click to open the conversation",
    () => navigate(`/chat?c=${encodeURIComponent(channel._id)}`)
  );
}

const HELLO_WAIT_MS = 8_000; // the server says hello at once; silence this long = held back
const SILENCE_MS = 70_000; // a ping every 25 s; none for this long = stalled
const POLL_MS = 5_000; // checking instead, while Zenin is in front
const POLL_HIDDEN_MS = 15_000; // …and while it's in the background

// One connection per browser tab, opened once signed in (AppLayout).
//
// Live: Server-Sent Events (GET /api/events). Some things in between hold the
// stream back (a Cloudflare Quick Tunnel doesn't support it; some office
// proxies and antivirus buffer it): then no "hello" arrives, and this checks
// every few seconds instead, with the same pop-ups and sounds, until the
// stream flows again.
export function useLiveConnection(meId: string) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    let lastHeard = 0;
    let polling: ReturnType<typeof setTimeout> | null = null;
    let seenNotices: Set<string> | null = null; // what was already in the bell
    let unread: Map<string, number> | null = null; // chat unread counts per conversation
    let closed = false;

    /* ---------- checking every few seconds (when the stream is held back) ---------- */
    const pollOnce = async () => {
      try {
        const bell = (await api.get<{ unread: number; items: Notice[] }>("/notifications")).data;
        qc.setQueryData(["notifications"], bell);
        if (seenNotices) {
          for (const n of bell.items) if (!n.read && !seenNotices.has(n._id)) announce({ title: n.title, table: n.tableName, id: n.recordId }, navigate);
        }
        seenNotices = new Set(bell.items.map((n) => n._id));

        const chat = (await api.get<ChatOverview>("/chat")).data;
        qc.setQueryData(["chat"], chat);
        if (chat.enabled) {
          const now = new Map(chat.channels.map((c) => [c._id, c.unread]));
          if (unread) for (const c of chat.channels) if ((now.get(c._id) ?? 0) > (unread.get(c._id) ?? 0)) announceChat(c, navigate);
          unread = now;
          qc.invalidateQueries({ queryKey: ["chatMessages"] }); // the open conversation
        }
        qc.invalidateQueries({ queryKey: ["comments"] }); // the open record's comments
        qc.invalidateQueries({ queryKey: ["tile"] }); // dashboard counts
      } catch {
        // signed out or offline: try again next time
      }
    };
    const startPolling = () => {
      if (polling || closed) return;
      const tick = async () => {
        await pollOnce();
        if (!closed && polling) polling = setTimeout(tick, document.visibilityState === "visible" ? POLL_MS : POLL_HIDDEN_MS);
      };
      polling = setTimeout(tick, 0);
    };
    const stopPolling = () => {
      if (polling) clearTimeout(polling);
      polling = null;
      seenNotices = null;
      unread = null;
    };

    /* ---------- the live stream ---------- */
    if (typeof EventSource === "undefined") {
      startPolling();
      return () => {
        closed = true;
        stopPolling();
      };
    }
    const source = new EventSource(`${import.meta.env.VITE_API_BASE_URL}/events`, { withCredentials: true });
    const alive = () => {
      lastHeard = Date.now();
      if (polling) stopPolling(); // flowing again: instant updates
    };
    source.addEventListener("hello", alive);
    source.addEventListener("ping", alive);
    source.addEventListener("notification", (e) => {
      alive();
      const n = JSON.parse((e as MessageEvent).data) as { title: string; table: string | null; id: string | null };
      qc.invalidateQueries({ queryKey: ["notifications"] });
      announce(n, navigate);
    });
    source.addEventListener("change", (e) => {
      alive();
      const c = JSON.parse((e as MessageEvent).data) as Omit<LiveChange, "at">;
      if (c.by === meId) return; // your own changes are already on screen
      push({ ...c, at: Date.now() });
      qc.invalidateQueries({ queryKey: ["tile"] }); // dashboard counts
    });
    source.addEventListener("chat", (e) => {
      alive();
      const c = JSON.parse((e as MessageEvent).data) as { channel: string; by: string; change: string };
      qc.invalidateQueries({ queryKey: ["chatMessages", c.channel] });
      if (c.by === meId) return;
      qc.invalidateQueries({ queryKey: ["chat"] }); // unread counts
      // a new message in a direct message or group: chime / desktop (mentions in
      // channels come through the bell; busy channels stay quiet)
      if (c.change !== "message") return;
      const channel = qc.getQueryData<ChatOverview>(["chat"])?.channels.find((ch) => ch._id === c.channel);
      if (channel) announceChat(channel, navigate);
    });
    source.addEventListener("comment", (e) => {
      alive();
      const c = JSON.parse((e as MessageEvent).data) as { table: string; id: string };
      qc.invalidateQueries({ queryKey: ["comments", c.table, c.id] });
    });
    // (re)connected: catch up on anything missed meanwhile
    source.onopen = () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["chat"] });
    };
    // Is the stream really flowing? Silence since the page connected (no
    // hello within 8 s), or since the last message (no ping for 70 s), means
    // it's held back: check instead. Counted from the start, not from each
    // reconnect, so a stream that keeps reopening without delivering is
    // caught too.
    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      if (polling) return;
      const silentFor = Date.now() - (lastHeard || startedAt);
      if (silentFor > (lastHeard ? SILENCE_MS : HELLO_WAIT_MS)) startPolling();
    }, 2_000);
    return () => {
      closed = true;
      source.close();
      stopPolling();
      clearInterval(watchdog);
    };
  }, [qc, navigate, meId]);
}
