import { useCallback, useEffect, useState } from "react";
import { ChatAction } from "@/lib/chatApi";

export interface ChatSessionMessage {
  role: "user" | "assistant";
  content: string;
  action?: ChatAction | null;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatSessionMessage[];
  updatedAt: number;
}

interface Store {
  sessions: ChatSession[];
  activeId: string;
}

const STORAGE_KEY = "lelab.chat.sessions.v1";

function uid(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function blank(): ChatSession {
  return { id: uid(), title: "New chat", messages: [], updatedAt: Date.now() };
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Store;
      if (parsed.sessions?.length) {
        const activeId = parsed.sessions.some((s) => s.id === parsed.activeId)
          ? parsed.activeId
          : parsed.sessions[0].id;
        return { sessions: parsed.sessions, activeId };
      }
    }
  } catch {
    /* corrupt or unavailable — start fresh */
  }
  const seed = blank();
  return { sessions: [seed], activeId: seed.id };
}

/**
 * Chat sessions persisted to localStorage — full history survives reloads and
 * restarts. Each session keeps its own messages so the model only ever gets the
 * active conversation's context.
 */
export function useChatSessions() {
  const [store, setStore] = useState<Store>(loadStore);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* over quota or unavailable — keep working in-memory */
    }
  }, [store]);

  const active = store.sessions.find((s) => s.id === store.activeId) ?? store.sessions[0];

  const newSession = useCallback(() => {
    setStore((s) => {
      // Reuse an existing empty "New chat" rather than piling up blanks.
      const empty = s.sessions.find((x) => x.messages.length === 0);
      if (empty) return { ...s, activeId: empty.id };
      const fresh = blank();
      return { sessions: [fresh, ...s.sessions], activeId: fresh.id };
    });
  }, []);

  const selectSession = useCallback((id: string) => {
    setStore((s) => ({ ...s, activeId: id }));
  }, []);

  const deleteSession = useCallback((id: string) => {
    setStore((s) => {
      const remaining = s.sessions.filter((x) => x.id !== id);
      const sessions = remaining.length ? remaining : [blank()];
      const activeId = s.activeId === id ? sessions[0].id : s.activeId;
      return { sessions, activeId };
    });
  }, []);

  const setActiveMessages = useCallback(
    (
      updater:
        | ChatSessionMessage[]
        | ((prev: ChatSessionMessage[]) => ChatSessionMessage[]),
    ) => {
      setStore((s) => ({
        ...s,
        sessions: s.sessions.map((session) => {
          if (session.id !== s.activeId) return session;
          const messages =
            typeof updater === "function" ? updater(session.messages) : updater;
          let title = session.title;
          if (title === "New chat" || !title) {
            const firstUser = messages.find((m) => m.role === "user");
            if (firstUser) {
              title = firstUser.content.replace(/\s+/g, " ").trim().slice(0, 40) || "New chat";
            }
          }
          return { ...session, messages, title, updatedAt: Date.now() };
        }),
      }));
    },
    [],
  );

  return {
    sessions: store.sessions,
    activeId: store.activeId,
    active,
    newSession,
    selectSession,
    deleteSession,
    setActiveMessages,
  };
}
