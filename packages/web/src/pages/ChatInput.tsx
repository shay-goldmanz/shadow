import { type FormEvent, useState } from "react";

export function ChatInput({
  onSend,
  disabled,
}: {
  readonly onSend: (message: string) => void;
  readonly disabled: boolean;
}) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form className="chat-input" onSubmit={handleSubmit}>
      <label htmlFor="chat-message" className="visually-hidden">
        Message Shadow
      </label>
      <textarea
        id="chat-message"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Tell Shadow what you believe…"
        rows={2}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }
        }}
      />
      <button type="submit" disabled={disabled || value.trim().length === 0}>
        Send
      </button>
    </form>
  );
}
