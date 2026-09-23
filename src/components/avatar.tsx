/** Iniciales con un color estable por persona (mismo nombre → mismo color). */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const hue = (seed: string) => [...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % 6;

export function Avatar({
  name,
  size = "md",
  title,
}: {
  name: string | null | undefined;
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const label = initials(name);
  const cls = ["avatar", size === "sm" ? "sm" : size === "lg" ? "lg" : "", name ? `h${hue(name)}` : "empty"]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} title={title ?? name ?? undefined} aria-hidden="true">
      {label}
    </span>
  );
}
