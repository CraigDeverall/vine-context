// The graph explorer: the graph as it stood at a moment, as a node-link
// picture. Works for any model: labels and relationship types come from the
// snapshot's schema. Each label is a node kind with its own shape (and the
// data palette's colour in model order); each relationship type is a link
// kind, named on the link and in the legend. Ended (withdrawn) items are
// dashed, with the reason in their description.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert } from "@squonk/ui/alert";
import { Badge } from "@squonk/ui/badge";
import { Button } from "@squonk/ui/button";
import { Card } from "@squonk/ui/card";
import { EmptyState } from "@squonk/ui/empty-state";
import { Grid } from "@squonk/ui/grid";
import { Heading } from "@squonk/ui/heading";
import { HStack } from "@squonk/ui/hstack";
import { ExploreIcon, HelpIcon, QuoteIcon, ReplyIcon, SearchIcon, UserIcon } from "@squonk/ui/icon";
import { LinkButton } from "../linkbutton";
import {
  NetworkGraph,
  NetworkGraphLegend,
  type NetworkGraphHiddenKinds,
  type NetworkGraphLink,
  type NetworkGraphLinkKinds,
  type NetworkGraphNode,
  type NetworkGraphNodeKinds,
  type NetworkGraphNodeShape,
} from "@squonk/ui/network-graph";
import { ScrollBox } from "@squonk/ui/scroll-box";
import { Spinner } from "@squonk/ui/spinner";
import { Split } from "@squonk/ui/split";
import { Text } from "@squonk/ui/text";
import { TextField } from "@squonk/ui/text-field";
import { VStack } from "@squonk/ui/vstack";
import { usePoll, when, type Bridge } from "../bridge";

interface SNode {
  id: string;
  key: string;
  label: string;
  title: string;
  ended: boolean;
  props: Record<string, unknown>;
}
interface SEdge {
  type: string;
  source: string;
  target: string;
  props: Record<string, unknown>;
}
interface Snapshot {
  graph: string;
  at: string;
  where: string;
  schema: { nodes: { label: string }[]; relationships: { type: string; description: string }[]; time: { recorded: string; ended?: string } | null };
  nodes: SNode[];
  edges: SEdge[];
  truncated: boolean;
}

// One shape per label, in model order, so kinds differ by more than colour.
const SHAPES: NetworkGraphNodeShape[] = ["circle", "square", "diamond", "triangle", "hexagon"];
// Icons for the labels of the built-in model; other models' labels go without.
const ICONS: Record<string, ReactNode> = {
  Claim: <QuoteIcon />,
  Question: <HelpIcon />,
  Reply: <ReplyIcon />,
  Person: <UserIcon />,
};

/** True when the view is wide enough to put the details beside the graph. */
function useWide(min = 640) {
  const query = `(min-width: ${min}px)`;
  const get = () => typeof matchMedia !== "function" || matchMedia(query).matches;
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return wide;
}

const short = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Why an ended node is dashed: "ended", with its reason when it has one. */
function endedNote(n: SNode): string {
  const reasonKey = Object.keys(n.props).find((k) => /reason$/.test(k));
  const reason = reasonKey ? n.props[reasonKey] : undefined;
  return typeof reason === "string" && reason ? `ended: ${reason}` : "ended";
}

const struck = { textDecoration: "line-through" } as const;

export function Explorer({ b }: { b: Bridge }) {
  const [snap, setSnap] = useState(b.data as Snapshot | undefined);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>();
  const [hidden, setHidden] = useState<NetworkGraphHiddenKinds>({ nodes: [], links: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [range, setRange] = useState<{ min: number; max: number }>();
  const [at, setAt] = useState<number>();
  const wide = useWide();

  useEffect(() => {
    if (b.data) setSnap(b.data as Snapshot);
  }, [b.data]);

  // The time range: the history in the latest "now" snapshot, from its first
  // event to its last (so old data isn't squeezed into a corner of the slider).
  useEffect(() => {
    if (!snap || at) return;
    const t = snap.schema.time;
    const times = t
      ? snap.nodes.flatMap((n) => [n.props[t.recorded], t.ended ? n.props[t.ended] : undefined]).map((v) => Date.parse(String(v ?? ""))).filter((v) => !Number.isNaN(v))
      : [];
    if (times.length) setRange({ min: Math.min(...times), max: Math.max(...times) });
  }, [snap, at]);

  const nodeKinds = useMemo<NetworkGraphNodeKinds>(() => {
    const k: NetworkGraphNodeKinds = {};
    snap?.schema.nodes.forEach((n, i) => {
      k[n.label] = { label: n.label, shape: SHAPES[i % SHAPES.length], icon: ICONS[n.label] };
    });
    return k;
  }, [snap?.schema]);
  const linkKinds = useMemo<NetworkGraphLinkKinds>(() => {
    const k: NetworkGraphLinkKinds = {};
    snap?.schema.relationships.forEach((r) => {
      k[r.type] = { label: r.type };
    });
    return k;
  }, [snap?.schema]);

  const q = filter.trim().toLowerCase();
  const matches = (n: SNode) => !q || n.title.toLowerCase().includes(q) || n.key.toLowerCase().includes(q);

  // What the graph draws: the snapshot's items (narrowed by the filter), with
  // ids that stay the same across snapshots so items keep their place while
  // the time slider replays history.
  const { gNodes, gLinks } = useMemo(() => {
    const shown = (snap?.nodes ?? []).filter(matches);
    const ids = new Set(shown.map((n) => n.id));
    const gNodes: NetworkGraphNode[] = shown.map((n) => ({
      id: n.id,
      label: n.title,
      kind: n.label,
      variant: n.ended ? "dashed" : "solid",
      description: n.ended ? endedNote(n) : undefined,
    }));
    const gLinks: NetworkGraphLink[] = (snap?.edges ?? [])
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, kind: e.type }));
    return { gNodes, gLinks };
  }, [snap, q]);

  // While showing "now", keep up with changes arriving from other members (a replayed moment stays as it is).
  usePoll(() => {
    if (b.canCall && at === undefined && !busy) void load();
  }, 2500, [b.canCall, at, busy]);

  const load = async (when?: number) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await b.call<Snapshot>("open_view", { view: "explorer", ...(when ? { at: new Date(when).toISOString() } : {}) });
      setSnap(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!snap)
    return (
      <HStack gap="sm" align="center">
        <Spinner label="Loading the graph" />
        <Text tone="muted">Loading the graph…</Text>
      </HStack>
    );
  const nodeById = new Map(snap.nodes.map((n) => [n.id, n]));
  const listed = snap.nodes.filter(matches);
  const sel = snap.nodes.find((n) => n.id === selected);

  const toolbar = (
    <VStack gap="sm">
      <HStack gap="sm" align="center">
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextField placeholder="Filter items" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter items" fullWidth />
        </div>
        {/* Only while an earlier moment is shown: with nothing to go back from, the button did nothing. */}
        {at !== undefined && (
          <Button variant="secondary" disabled={busy} onClick={() => (setAt(undefined), load())}>
            Back to now
          </Button>
        )}
      </HStack>
      {range && range.max > range.min && (
        <HStack gap="sm" align="center">
          <Text as="span" tone="muted">
            As of
          </Text>
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={Math.max(1, Math.round((range.max - range.min) / 200))}
            value={at ?? range.max}
            onChange={(e) => setAt(Number(e.target.value))}
            onPointerUp={() => at && load(at)}
            onKeyUp={() => at && load(at)}
            aria-label="Show the graph as it stood at this time"
            style={{ flex: 1, minWidth: 0, width: "100%", margin: 0, accentColor: "var(--squonk-colors-primary)" }}
          />
          <Text as="span" align="end" style={{ minWidth: "10em", fontVariantNumeric: "tabular-nums" }}>
            {at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "now"}
          </Text>
        </HStack>
      )}
    </VStack>
  );

  const details = sel ? (
    <Card variant="outlined">
      <VStack gap="sm">
        <Split align="center">
          <HStack gap="xs" align="center" wrap>
            <Badge variant="subtle">{sel.label}</Badge>
            {sel.ended && <Badge variant="outline">ended</Badge>}
          </HStack>
          <Button variant="ghost" onClick={() => setSelected(undefined)}>
            Close
          </Button>
        </Split>
        <Text tone={sel.ended ? "muted" : undefined} style={sel.ended ? struck : undefined}>
          {sel.title}
        </Text>
        <Grid as="dl" columns="max-content minmax(0, 1fr)" gap="xs" style={{ margin: 0 }}>
          {Object.entries(sel.props)
            .filter(([k, v]) => v !== null && v !== undefined && v !== "" && k !== "text")
            .map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <Text as="dt" tone="secondary">
                  {k.replace(/_/g, " ")}
                </Text>
                <Text as="dd" style={{ margin: 0, overflowWrap: "anywhere" }}>
                  {typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? when(v) : String(v)}
                </Text>
              </div>
            ))}
        </Grid>
        <Heading as="h3" level={6}>Links</Heading>
        <VStack gap="xs">
          {snap.edges
            .filter((e) => e.source === sel.id || e.target === sel.id)
            .map((e, i) => {
              const out = e.source === sel.id;
              const other = nodeById.get(out ? e.target : e.source);
              return (
                <LinkButton key={i}  style={{ textAlign: "start" }} onClick={() => other && setSelected(other.id)}>
                  <Text as="span" tone="muted">
                    {out ? `${e.type} →` : `← ${e.type}`}
                  </Text>{" "}
                  {other ? short(other.title, 60) : "?"}
                </LinkButton>
              );
            })}
        </VStack>
      </VStack>
    </Card>
  ) : (
    <Card variant="outlined">
      <VStack gap="sm">
        <Heading as="h2" level={5}>
          Items{" "}
          {q && (
            <Text as="span" tone="muted">
              ({listed.length})
            </Text>
          )}
        </Heading>
        {listed.length === 0 ? (
          <Text tone="muted">No items match.</Text>
        ) : (
          <ScrollBox maxHeight="360px">
            <VStack gap="xs">
              {listed.slice(0, 100).map((n) => (
                <LinkButton key={n.id}  variant="inherit" underline="hover" style={{ textAlign: "start" }} onClick={() => setSelected(n.id)}>
                  <Text as="span" tone="muted">
                    {n.label}
                  </Text>{" "}
                  <Text as="span" tone={n.ended ? "muted" : undefined} style={n.ended ? struck : undefined}>
                    {short(n.title, 80)}
                  </Text>
                </LinkButton>
              ))}
            </VStack>
          </ScrollBox>
        )}
      </VStack>
    </Card>
  );

  return (
    <VStack gap="md">
      <Heading as="h1" level={3}>
        {snap.where}{" "}
        <Text as="span" tone="muted">
          · {snap.nodes.length} items, {snap.edges.length} links
        </Text>
      </Heading>

      {toolbar}

      <Grid columns={wide ? "minmax(0, 1fr) 260px" : 1} gap="md">
        <VStack gap="sm">
          <div style={{ height: 420 }}>
            <NetworkGraph
              label={`Graph of ${snap.nodes.length} items and ${snap.edges.length} links in ${snap.where}${at ? ", as it stood at the chosen time" : ""}`}
              style={{ height: "100%" }}
              nodes={gNodes}
              links={gLinks}
              nodeKinds={nodeKinds}
              linkKinds={linkKinds}
              hiddenKinds={hidden}
              selectedId={selected ?? null}
              onSelectionChange={(id) => setSelected(id ?? undefined)}
              hoverHighlight="neighbours"
              autoFit={!!q}
              settleOnChange={!!q}
              maxFitZoom={q ? 1.75 : undefined}
              allowFullscreen
              fullscreenToolbar={toolbar}
              fullscreenAside={details}
              empty={
                <EmptyState
                  icon={snap.nodes.length === 0 ? <ExploreIcon /> : <SearchIcon />}
                  title={snap.nodes.length === 0 ? `Nothing in the graph ${at ? "at that time" : "yet"}.` : "No items match."}
                />
              }
            />
          </div>
          <NetworkGraphLegend nodeKinds={nodeKinds} linkKinds={linkKinds} nodes={gNodes} links={gLinks} hiddenKinds={hidden} onHiddenKindsChange={setHidden} />
          {snap.schema.time?.ended && (
            <Text tone="muted">A dashed outline means ended.</Text>
          )}
          {snap.truncated && <Text tone="muted">Showing the most recent items only.</Text>}
        </VStack>

        {details}
      </Grid>
      {error && <Alert tone="error">{error}</Alert>}
    </VStack>
  );
}
