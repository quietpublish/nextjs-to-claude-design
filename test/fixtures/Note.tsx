// Named export matching the component name (no default) — exercises export detection.
export function Note({ text = "a note" }: { text?: string }) {
  return <p data-kind="note">{text}</p>;
}
