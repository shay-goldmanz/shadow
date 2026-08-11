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
  readonly onCreate: (input: { title: string; description: string }) => void;
  readonly pending: boolean;
  readonly error: string | undefined;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onCreate({ title: trimmed, description: description.trim() });
    setTitle("");
    setDescription("");
  }

  return (
    <form className="create-volume-form" onSubmit={handleSubmit} aria-label="Create a volume">
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
