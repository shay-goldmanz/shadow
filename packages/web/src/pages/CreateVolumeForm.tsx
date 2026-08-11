import { type FormEvent, useState } from "react";

/**
 * Volume creation, front and centre on the landing view — this is the
 * critical path's first step ("operator opens interface and creates a
 * volume"), so it takes one field, one button, no modal.
 */
export function CreateVolumeForm({
  onCreate,
  pending,
  error,
}: {
  /** Resolves `true` on success, `false` on a handled failure (the caller already recorded `error`) — never rejects. */
  readonly onCreate: (input: { title: string; description: string }) => Promise<boolean>;
  readonly pending: boolean;
  readonly error: string | undefined;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    // Only clear the operator's typing on success — a duplicate slug,
    // invalid slug, or the API being unreachable must leave both fields
    // exactly as typed so the operator can fix and resubmit rather than
    // retyping from scratch.
    const created = await onCreate({ title: trimmed, description: description.trim() });
    if (created) {
      setTitle("");
      setDescription("");
    }
  }

  return (
    <form
      className="create-volume-form"
      onSubmit={(event) => void handleSubmit(event)}
      aria-label="Create a volume"
    >
      <div className="create-volume-form__row">
        <label htmlFor="new-volume-title">Title</label>
        <input
          id="new-volume-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Design Inspiration"
          required
        />
        <button type="submit" disabled={pending || title.trim().length === 0}>
          {pending ? "Creating…" : "Create volume"}
        </button>
      </div>
      <div className="create-volume-form__row create-volume-form__row--description">
        <label htmlFor="new-volume-description">Description (optional)</label>
        <input
          id="new-volume-description"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this volume for?"
        />
      </div>
      {error && (
        <p role="alert" className="create-volume-form__error">
          {error}
        </p>
      )}
    </form>
  );
}
