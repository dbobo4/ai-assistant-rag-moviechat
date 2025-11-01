'use client';

import { useRef, useState } from "react";

interface UiMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export default function Chat() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const controllerRef = useRef<AbortController | null>(null);

  const placeholder = "Ask something about movies from memory";

  async function send() {
    const text = input.trim();
    if (!text) return;

    const userMsg: UiMsg = { id: crypto.randomUUID(), role: "user", text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    const payload = {
      messages: [
        ...messages.map((message) => ({
          role: message.role,
          parts: [{ type: "text", text: message.text }],
        })),
        { role: "user", parts: [{ type: "text", text }] },
      ],
    };

    controllerRef.current?.abort();
    controllerRef.current = new AbortController();

    const assistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", text: "" },
    ]);

    const res = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      signal: controllerRef.current.signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "Request failed.");
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? { ...message, text: `Hiba: ${errText}` }
            : message
        )
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let done = false;

    while (!done) {
      const { value, done: isDone } = await reader.read();
      done = isDone;
      const chunk = decoder.decode(value || new Uint8Array(), {
        stream: !done,
      });

      if (chunk) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, text: message.text + chunk }
              : message
          )
        );
      }
    }
  }

  return (
    <div className="chat-app">
      <div className="chat-shell">
        <aside className="chat-sidebar">
          <div className="chat-sidebar__title">MovieChat</div>
          <p className="chat-sidebar__description">
            Movie knowledge base assistant.
          </p>
        </aside>

        <div className="chat-main">
          <header className="chat-header">
            <h1 className="chat-header__title">Movie knowledge chat</h1>
            <p className="chat-header__subtitle">
              Ask about movies, people in movies, and share new details.
            </p>
          </header>

          <main className="chat-history">
            <div className="chat-history__inner">
              {messages.length === 0 && (
                <div className="chat-empty">
                  Start by asking about your favorite movie from memory.
                </div>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`chat-message-row ${
                    message.role === "user" ? "is-user" : "is-assistant"
                  }`}
                >
                  <div
                    className={`chat-bubble ${message.role} whitespace-pre-wrap`}
                  >
                    {message.text || "..."}
                  </div>
                </div>
              ))}
            </div>
          </main>

          <footer className="chat-footer">
            <form
              className="chat-form"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <textarea
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                className="chat-input"
                placeholder={placeholder}
                rows={2}
              />
              <button
                type="submit"
                className="chat-send"
                disabled={!input.trim()}
                aria-label="Send"
              >
                &#10148;
              </button>
            </form>
          </footer>
        </div>
      </div>
    </div>
  );
}
