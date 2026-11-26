// The Vine Context mark with its name and byline, as every surface shows it.
import { HStack } from "@squonk/ui/hstack";
import { Text } from "@squonk/ui/text";
import { VStack } from "@squonk/ui/vstack";
import { LOGO_PATH, LOGO_VIEWBOX } from "./logo";

export function Brand() {
  return (
    <HStack gap="xs" align="center">
      <svg viewBox={LOGO_VIEWBOX} aria-hidden="true" style={{ height: 26, width: "auto", flex: "none", fill: "var(--squonk-colors-primary)" }}>
        <path fillRule="evenodd" d={LOGO_PATH} />
      </svg>
      <VStack gap="none">
        <Text as="span" weight="bold" style={{ fontFamily: "var(--squonk-typography-fonts-heading)", lineHeight: 1.1 }}>
          Vine Context
        </Text>
        <Text as="span" tone="muted" style={{ fontSize: "var(--squonk-roles-type-small)", lineHeight: 1.2 }}>
          P2P Shared Memories
        </Text>
      </VStack>
    </HStack>
  );
}
