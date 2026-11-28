// Pairs of items that contradict each other, side by side. Works for any tool
// whose rows hold two items (objects) and some details about the pair.

import { Alert } from "@squonk/ui/alert";
import { Block } from "@squonk/ui/block";
import { Button } from "@squonk/ui/button";
import { Card } from "@squonk/ui/card";
import { Code } from "@squonk/ui/code";
import { Heading } from "@squonk/ui/heading";
import { HStack } from "@squonk/ui/hstack";
import { RefreshIcon } from "@squonk/ui/icon";
import { Presentation } from "@squonk/ui/presentation";
import { Split } from "@squonk/ui/split";
import { Text } from "@squonk/ui/text";
import { VStack } from "@squonk/ui/vstack";
import { useEffect, useState } from "react";
import { when, type Bridge } from "../bridge";

interface Data {
  tool: string;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>[] | Record<string, unknown>;
  where: string;
}
type Item = Record<string, unknown>;

const isItem = (v: unknown): v is Item => !!v && typeof v === "object" && !Array.isArray(v);
const label = (i: Item) => String(i.text ?? i.title ?? i.name ?? i.id ?? "");

// Secondary detail lines, one step down the theme's text-size ladder.
const small = { fontSize: "var(--squonk-roles-type-small)" } as const;
// Each side takes an equal share of the row and wraps under the other when narrow.
const sideStyle = { flex: "1 1 14em", minWidth: 0 } as const;

function split(row: Record<string, unknown>) {
  const entries = Object.entries(row);
  const items = entries.filter(([, v]) => isItem(v)) as [string, Item][];
  const details = entries.filter(([, v]) => !isItem(v));
  return { a: items[0], b: items[1], details };
}

function Side({ item }: { item: [string, Item] | undefined }) {
  if (!item)
    return (
      <Block padding="sm" radius="md" background="subtle" bordered style={sideStyle}>
        <Text tone="muted">—</Text>
      </Block>
    );
  const [, i] = item;
  return (
    <Block padding="sm" radius="md" background="subtle" bordered style={sideStyle}>
      <VStack gap="xs">
        <Text>{label(i)}</Text>
        <Text tone="muted" style={small}>
          {typeof i.id === "string" && <Code>{i.id}</Code>} {typeof i.recorded_by === "string" && <>· {i.recorded_by}</>}{" "}
          {typeof i.recorded_at === "string" && <>· {when(i.recorded_at)}</>}
        </Text>
      </VStack>
    </Block>
  );
}

export function Conflicts({ b }: { b: Bridge }) {
  const [data, setData] = useState(b.data as Data | undefined);
  const [error, setError] = useState<string>();
  const [asked, setAsked] = useState<number>();
  useEffect(() => setData(b.data as Data | undefined), [b.data]);
  if (!data) return <Text tone="muted">Waiting for the result…</Text>;
  const rows = Array.isArray(data.result) ? data.result : [data.result];

  const refresh = async () => {
    try {
      const r = await b.call<Data>(data.tool, data.input);
      setData(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const settle = async (i: number, a?: Item, c?: Item) => {
    setAsked(i);
    try {
      await b.say(
        `Help me settle this conflict: "${a ? label(a) : "?"}" (${String(a?.id ?? "")}) versus "${c ? label(c) : "?"}" (${String(c?.id ?? "")}). ` +
          "Look at the evidence for each, tell me which is better supported, and when I decide, record a claim that replaces the wrong one.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Presentation register="compact">
      <VStack gap="md">
        <Split align="center" wrap>
          <Heading as="h1" level={3}>
            {rows.length === 0 ? "No conflicts" : `${rows.length} conflict${rows.length === 1 ? "" : "s"}`}{" "}
            <Text as="span" tone="secondary">
              in {data.where}
            </Text>
          </Heading>
          <Button variant="secondary" onClick={refresh}>
            <RefreshIcon />
            Refresh
          </Button>
        </Split>
        {rows.length === 0 && <Text tone="muted">Nothing contradicts anything else right now.</Text>}
        {rows.map((row, i) => {
          const { a, b: c, details } = split(row);
          return (
            <Card key={i} variant="outlined">
              <VStack gap="sm">
                <HStack gap="sm" align="stretch" wrap>
                  <Side item={a} />
                  <Text as="span" tone="error" weight="bold" style={{ ...small, alignSelf: "center", marginInline: "auto" }}>
                    {c ? "vs" : ""}
                  </Text>
                  <Side item={c} />
                </HStack>
                <Split align="center" wrap>
                  <Text as="span" tone="muted" style={small}>
                    {details.map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? when(v) : String(v)}`).join(" · ")}
                  </Text>
                  <Button variant="ghost" disabled={asked === i} onClick={() => settle(i, a?.[1], c?.[1])}>
                    {asked === i ? "Asked your agent" : "Ask my agent to help settle it"}
                  </Button>
                </Split>
              </VStack>
            </Card>
          );
        })}
        {error && <Alert tone="error">{error}</Alert>}
      </VStack>
    </Presentation>
  );
}
