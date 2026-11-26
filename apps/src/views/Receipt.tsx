// What the agent just wrote. For a few seconds it is still only on this
// machine: Undo removes it without trace. After that it has been sent to the
// other members, and the button becomes Withdraw (it stays in the history).

import { Alert } from "@squonk/ui/alert";
import { Badge } from "@squonk/ui/badge";
import { Button } from "@squonk/ui/button";
import { Card } from "@squonk/ui/card";
import { Code } from "@squonk/ui/code";
import { Grid } from "@squonk/ui/grid";
import { HStack } from "@squonk/ui/hstack";
import { LinkButton } from "../linkbutton";
import { Presentation } from "@squonk/ui/presentation";
import { Split } from "@squonk/ui/split";
import { Text } from "@squonk/ui/text";
import { Tooltip } from "@squonk/ui/tooltip";
import { VStack } from "@squonk/ui/vstack";
import { useEffect, useState } from "react";
import { asks, type Bridge } from "../bridge";
import type { Panel } from "../panel";

interface ReceiptData {
  tool: string;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  undo: { take_back: boolean; withdraw: boolean } | null;
  where: string;
}

// Secondary detail lines, one step down the theme's text-size ladder.
const small = { fontSize: "var(--squonk-roles-type-small)" } as const;

const show = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v));

export function Receipt({ b, open }: { b: Bridge; open?: (p: Panel) => void }) {
  const d = b.data as ReceiptData | undefined;
  const [undone, setUndone] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sharedAt = typeof d?.result?.shared_at === "string" ? Date.parse(d.result.shared_at) : 0;
  useEffect(() => {
    if (!sharedAt || sharedAt <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [sharedAt]);
  if (!d) return <Text tone="muted">Waiting for the result…</Text>;

  const input = Object.entries(d.input ?? {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
  const main = input.find(([k]) => k === "text");
  const rest = input.filter(([k]) => k !== "text");
  const change = typeof d.result?.change === "string" ? d.result.change : undefined;
  const item = typeof d.result?.id === "string" ? d.result.id : undefined;
  const left = Math.ceil((sharedAt - now) / 1000);
  const held = Boolean(d.undo?.take_back && change && left > 0);
  const canWithdraw = Boolean(d.undo?.withdraw && item && !held && (d.tool === "add_claim" || d.tool === "ask_question"));

  const run = async (tool: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const how = await b.run(tool, args, asks(tool, args));
      setUndone(how === "called" ? done : "Asked your agent to do that. Check its reply.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const undo = () => run("take_back", { id: change }, "Taken back. It never left this machine.");
  const withdraw = () => run("withdraw", { id: item }, "Withdrawn. The other members have it, so it stays in the graph's history.");

  return (
    <Presentation register="compact">
      <Card variant="outlined">
        <VStack gap="sm">
          <Split align="center" wrap>
            <HStack gap="sm" align="center" wrap>
              <Badge tone={undone ? "neutral" : held ? "warning" : "success"}>{undone ? "undone" : held ? "on this machine" : "shared"}</Badge>
              <Text as="span" weight="bold">
                {d.title}
              </Text>
              {d.result && typeof d.result.id === "string" && (
                <Text as="span" tone="muted" style={small}>
                  <Code>{d.result.id}</Code>
                </Text>
              )}
            </HStack>
            {!undone && held && (
              <Tooltip content="It is still only on this machine: Undo removes it without trace">
                <Button variant="secondary" disabled={busy} onClick={undo}>
                  Undo ({left}s)
                </Button>
              </Tooltip>
            )}
            {!undone && canWithdraw && (
              <Tooltip content="Already sent to the other members: withdrawing keeps it in the history">
                <Button variant="secondary" disabled={busy} onClick={withdraw}>
                  Withdraw
                </Button>
              </Tooltip>
            )}
          </Split>
          {main && (
            <Text tone={undone ? "muted" : undefined} style={undone ? { textDecoration: "line-through" } : undefined}>
              {show(main[1])}
            </Text>
          )}
          {rest.length > 0 && (
            <Grid as="dl" columns="max-content 1fr" gap="xs" style={{ ...small, margin: 0, columnGap: "var(--squonk-spacing-md)" }}>
              {rest.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <Text as="dt" tone="secondary">
                    {k.replace(/_/g, " ")}
                  </Text>
                  <Text as="dd" style={{ margin: 0, overflowWrap: "anywhere" }}>
                    {show(v)}
                  </Text>
                </div>
              ))}
            </Grid>
          )}
          <Split align="center" wrap>
            <Text tone="muted" style={small}>
              In {d.where}
            </Text>
            {open && (
              <HStack gap="md" align="center" wrap>
                <LinkButton  onClick={() => open("explorer")}>
                  Explore graph
                </LinkButton>
                <LinkButton  onClick={() => open("console")}>
                  Console
                </LinkButton>
              </HStack>
            )}
          </Split>
          {undone && (
            <Alert tone="info" variant="tinted">
              {undone}
            </Alert>
          )}
          {error && (
            <Alert tone="error" variant="tinted">
              {error}
            </Alert>
          )}
        </VStack>
      </Card>
    </Presentation>
  );
}
