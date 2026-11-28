// A link that does something on this page instead of going somewhere: the
// library's Link on a <button>, with the browser's own button chrome removed.
import { Link } from "@squonk/ui/link";
import type { ComponentProps, CSSProperties } from "react";

const plain: CSSProperties = { background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textAlign: "start" };

export function LinkButton({ style, ...rest }: Omit<ComponentProps<typeof Link<"button">>, "as">) {
  return <Link as="button" type="button" style={{ ...plain, ...style }} {...rest} />;
}
