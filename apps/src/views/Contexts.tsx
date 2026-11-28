// The Contexts view: this chat's context for the person. What needs them, its
// questions and threads, its claims (with conflicts and history), its people
// and join codes, its settings (sharing, what it holds, deleting it), and the
// chat's contexts to turn on and off.
//
// It is the Claude Code mod's panel (plugin/hooks/register.tsx) for every
// other host: an agent app that shows MCP App views, or a browser tab from
// `vine ui`. Agents write; people steer: the view never writes a claim. Answer,
// Correct, "Keep this one" and the rest hand the person's words to the agent.
//
// It reads through `recent` with `activity`, which never uses up the notices meant
// for the agent, and acts through the server's ordinary tools. It polls.

import { Alert } from "@squonk/ui/alert";
import { Badge } from "@squonk/ui/badge";
import { Button } from "@squonk/ui/button";
import { Card } from "@squonk/ui/card";
import { Cluster } from "@squonk/ui/cluster";
import { Code } from "@squonk/ui/code";
import { Divider } from "@squonk/ui/divider";
import { Grid } from "@squonk/ui/grid";
import { Heading } from "@squonk/ui/heading";
import { HStack } from "@squonk/ui/hstack";
import {
  ActivityIcon,
  AddIcon,
  AddUserIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  EditIcon,
  HelpIcon,
  KeyIcon,
  LinkIcon,
  PinIcon,
  RemoveUserIcon,
  ReplyIcon,
  TransferIcon,
} from "@squonk/ui/icon";
import { IconButton } from "@squonk/ui/icon-button";
import { Presentation } from "@squonk/ui/presentation";
import { Select } from "@squonk/ui/select";
import { Spinner } from "@squonk/ui/spinner";
import { Split } from "@squonk/ui/split";
import { Switch } from "@squonk/ui/switch";
import { Tabs } from "@squonk/ui/tabs";
import { Text } from "@squonk/ui/text";
import { TextField } from "@squonk/ui/text-field";
import { Textarea } from "@squonk/ui/textarea";
import { VStack } from "@squonk/ui/vstack";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NoToolCalls, asks, copyText, usePoll, type Bridge } from "../bridge";
import {
  ago,
  answerPrompt,
  filtered,
  ids,
  matches,
  newContextProblem,
  prompts,
  prop,
  relations,
  sendLine,
  plain,
  short,
  tail,
  threads,
  type Activity,
  type Change,
  type ContextDetails,
  type Found,
  type Filters,
  type GraphNode,
  type Invite,
  type NoContext,
  type Person,
  type Role,
  type Tab,
  type Thread,
} from "../contexts/logic";

const POLL_MS = 4000;
const NOTICE_MS = 6000;
/** How many items a list shows before "Show more". */
const PAGE = 20;

const TABS: { tab: Tab; label: string }[] = [
  { tab: "overview", label: "Overview" },
  { tab: "questions", label: "Questions" },
  { tab: "claims", label: "Claims" },
  { tab: "people", label: "People" },
  { tab: "settings", label: "Settings" },
];
/** How many recent changes the Overview shows before "Show more". */
const RECENT = 5;
// The header names at most this many members (you, then who's online); the People tab has everyone.
const HEADER_PEOPLE = 6;
// The "you claimed:" part of an activity line is who-did-what metadata: drawn muted so the claim itself reads first.
const lead = (c: Change) => {
  const summary = plain(c.summary);
  const i = /^(claim|question|reply|describe)$/.test(c.kind) ? summary.indexOf(": ") : -1;
  return i < 0 ? { head: "", body: summary } : { head: summary.slice(0, i + 2), body: summary.slice(i + 2) };
};
/** A way out of a step (Cancel, Done, Back) leads with a back chevron, so it reads as going back. */
const backLabel = (label: string) => label.replace(/^‹\s*/, "");
const ICON: Record<string, typeof PinIcon> = {
  claim: PinIcon,
  question: HelpIcon,
  reply: ReplyIcon,
  link: LinkIcon,
  withdraw: CloseIcon,
  add_member: AddUserIcon,
  remove_member: RemoveUserIcon,
  set_role: KeyIcon,
  rename: EditIcon,
  describe: EditIcon,
  create: AddIcon,
};
const ROLES: Role[] = ["reader", "contributor", "admin"];

type Tone = "warn" | "ok" | "bad" | "accent" | undefined;
const ALERT_TONE = { warn: "warning", ok: "success", bad: "error" } as const;
const TEXT_TONE = { warn: "warning", ok: "success", bad: "error", accent: "info" } as const;

/**
 * A box around one thing. A status tone (warn, ok, bad) is the tone's quiet
 * wash; accent (this chat's context, you) is the raised surface. The wash is
 * a container here, not an announcement, so it takes no live-region role.
 */
const Box = ({ tone, children }: { tone?: Tone; children: ReactNode }) =>
  tone && tone !== "accent" ? (
    <Alert variant="tinted" tone={ALERT_TONE[tone]} role={undefined}>
      {children}
    </Alert>
  ) : (
    <Card variant={tone === "accent" ? "filled" : "outlined"}>{children}</Card>
  );
const Meta = ({ children }: { children: ReactNode }) => <Text tone="muted">{children}</Text>;
/** Text drawn in a tone, inside a line. */
const Toned = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <Text as="span" tone={tone ? TEXT_TONE[tone] : "secondary"}>
    {children}
  </Text>
);
const SectionTitle = ({ children, count }: { children: ReactNode; count?: number | string }) => (
  <Heading as="h2" level={5}>
    {children}
    {count !== undefined && (
      <Text as="span" tone="muted">
        {" "}
        {count}
      </Text>
    )}
  </Heading>
);
/** One of a few choices shown together (a filter, the context shown): pressed when it's the one. */
const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <Button variant={active ? "primary" : "secondary"} aria-pressed={active} onClick={onClick}>
    {children}
  </Button>
);
const OpenButton = ({ onClick, variant }: { onClick: () => void; variant?: "primary" | "secondary" }) => (
  <Button variant={variant} onClick={onClick}>
    Open <ChevronRightIcon />
  </Button>
);
/** A line of text that's no longer current: struck through and muted. */
const Ended = ({ ended, children }: { ended: boolean; children: ReactNode }) => (
  <Text tone={ended ? "muted" : undefined}>{ended ? <s>{children}</s> : children}</Text>
);
/** A reply under its question, set in from the left. */
const Indented = ({ children }: { children: ReactNode }) => (
  <VStack gap="none" style={{ paddingInlineStart: "var(--squonk-spacing-md)" }}>
    {children}
  </VStack>
);
const Facts = ({ children }: { children: ReactNode }) => (
  <Grid as="dl" columns="max-content 1fr" gap="xs">
    {children}
  </Grid>
);
const Fact = ({ name, children }: { name: string; children: ReactNode }) => (
  <>
    <Text as="dt" tone="secondary">
      {name}
    </Text>
    <Text as="dd">{children}</Text>
  </>
);
const Loading = ({ children = "Loading…" }: { children?: ReactNode }) => (
  <HStack gap="xs" align="center">
    <Spinner />
    <Text tone="muted">{children}</Text>
  </HStack>
);

/** A link-like button that opens and closes what it's about. */
const Toggle = ({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) => (
  <Button variant="ghost" aria-expanded={open} onClick={onClick}>
    {children} {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
  </Button>
);

/**
 * A list that shows only a few of its items, with a link for the rest (and one
 * to fold them away again). With `latest`, the few are the last ones and the
 * link comes first, as for the earlier replies in a thread.
 */
function Folded<T>(p: { list: T[]; first: number; what: string; one?: string; render: (x: T) => ReactNode; latest?: boolean }) {
  const [open, setOpen] = useState(false);
  const hidden = p.list.length - p.first;
  if (hidden <= 0) return <>{p.list.map(p.render)}</>;
  const shown = open ? p.list : p.latest ? p.list.slice(-p.first) : p.list.slice(0, p.first);
  const link = (
    <HStack>
      <Toggle open={open} onClick={() => setOpen(!open)}>
        {open ? `Show fewer ${p.what}` : `${hidden} ${p.latest ? "earlier" : "more"} ${hidden === 1 && p.one ? p.one : p.what}`}
      </Toggle>
    </HStack>
  );
  return (
    <>
      {p.latest && link}
      {shown.map(p.render)}
      {!p.latest && link}
    </>
  );
}

/** Extra detail behind a link-like button, closed until asked for. */
function Reveal({ label, hide = "Less", children }: { label: string; hide?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HStack>
        <Toggle open={open} onClick={() => setOpen(!open)}>
          {open ? hide : label}
        </Toggle>
      </HStack>
      {open && children}
    </>
  );
}

/** A labelled text field with its own Send button. Enter sends (⌘/Ctrl+Enter in a multi-line field). */
function Field(p: {
  label?: string;
  help?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  submit?: string;
  autoFocus?: boolean;
  onInput?: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState(p.value ?? "");
  const change = (x: string) => {
    setV(x);
    p.onInput?.(x);
  };
  // A field with no visible label is named by its placeholder.
  const name = p.label ? undefined : p.placeholder;
  const control = p.rows ? (
    <Textarea
      label={p.label}
      aria-label={name}
      rows={p.rows}
      value={v}
      placeholder={p.placeholder}
      autoFocus={p.autoFocus}
      onChange={(e) => change(e.currentTarget.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && p.onSubmit(v)}
    />
  ) : (
    <TextField
      label={p.label}
      aria-label={name}
      value={v}
      placeholder={p.placeholder}
      autoFocus={p.autoFocus}
      onChange={(e) => change(e.currentTarget.value)}
      onKeyDown={(e) => e.key === "Enter" && p.onSubmit(v)}
    />
  );
  return (
    <VStack gap="xs">
      {p.submit ? (
        <HStack gap="xs" align="end">
          {control}
          <Button variant="primary" onClick={() => p.onSubmit(v)}>
            {p.submit}
          </Button>
        </HStack>
      ) : (
        control
      )}
      {p.help && <Meta>{p.help}</Meta>}
    </VStack>
  );
}

/** The panel, in the compact register: it sits inside a chat. */
export function Contexts({ b }: { b: Bridge }) {
  return (
    <Presentation register="compact">
      <ContextsPanel b={b} />
    </Presentation>
  );
}

function ContextsPanel({ b }: { b: Bridge }) {
  const [a, setA] = useState<Activity | null>(null);
  /** With no context in this chat: the contexts on this machine to choose from. */
  const [none, setNone] = useState<string[] | null>(null);
  const [ready, setReady] = useState(false);
  /** Why the last refresh failed; cleared by the next one that works. */
  const [trouble, setTrouble] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>("overview");
  const [filters, setFilters] = useState<Filters>({ text: "", claims: "current", questions: "open" });
  /** The search behind the filter's text: the lists add its best matches to those that share its words. */
  const [found, setFound] = useState<Found | null>(null);
  /** How many more items than the first page a list shows. */
  const [more, setMore] = useState(0);
  /** The item (a claim's or question's key) shown on its own. */
  const [detail, setDetail] = useState<string | null>(null);
  /** The claim (by key) a correction is being written for. */
  const [composing, setComposing] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ error: string | null } | null>(null);
  /** A context that's off for this chat (by name), shown on its own page: it can't be opened. */
  const [managing, setManaging] = useState<string | null>(null);
  /** Its details (`context_info` with `details`), or those of the open context's Settings tab. */
  const [details, setDetails] = useState<ContextDetails | null>(null);
  const [deleting, setDeleting] = useState<{ name: string; error: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  /** Whether the view shows the chat's contexts, to turn on and off, instead of a context. */
  const [switching, setSwitching] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [inviting, setInviting] = useState<Role | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** The invite just made (its id), marked in the list. */
  const [made, setMade] = useState<string | null>(null);
  /** Which of the chat's contexts the view shows; null is the one writes go to. */
  const viewing = useRef<string | null>(null);
  /** The context whose details are being loaded, so a late answer for another is dropped. */
  const managingNow = useRef<string | null>(null);
  /** The items opened one after another, so Back returns to the one before. */
  const trail = useRef<string[]>([]);
  /** What's typed in a step's fields, for that step's own button. */
  const draft = useRef<Record<string, string>>({});

  const take = (r: Activity | NoContext) => {
    setReady(true);
    setTrouble(undefined);
    if (r.context === null) {
      setNone(r.your_contexts);
      setA(null);
      viewing.current = null;
      return;
    }
    setNone(null);
    setA(r);
    if (viewing.current && viewing.current !== r.context) viewing.current = null; // it was taken out of the chat
  };

  const refresh = async (which = viewing.current) => {
    try {
      take(await b.call<Activity | NoContext>("recent", { activity: true, limit: 40, snapshot: true, ...(which ? { context: which } : {}) }));
    } catch (e) {
      setReady(true);
      setTrouble(e instanceof NoToolCalls ? "This app can’t refresh the view by itself. Ask your agent to open the contexts panel again to see the latest." : (e as Error).message);
    }
  };

  // The result of the tool call that opened the view, then a poll.
  useEffect(() => {
    if (b.data && typeof b.data === "object" && "your_contexts" in b.data) take(b.data as Activity | NoContext);
  }, [b.data]);
  usePoll(() => void (b.canCall && refresh()), POLL_MS, [b.canCall]);

  // Each step starts at its top: without this, an item opened from far down a
  // list shows scrolled, its title against (or past) the top edge.
  // Some hosts scroll the view's own frame and others size the frame to its
  // content and scroll around it, so this scrolls a mark at the view's top into
  // sight, which reaches both.
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    let mark = document.getElementById("vine-top");
    if (!mark) {
      mark = document.createElement("div");
      mark.id = "vine-top";
      mark.style.cssText = "position:absolute;top:0;left:0;width:1px;height:0";
      document.body.prepend(mark);
    }
    mark.scrollIntoView({ block: "nearest" });
  }, [tab, detail, composing, creating !== null, managing, deleting?.name, editing, switching, renaming, inviting !== null, confirmRemove]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // The Settings tab shows the open context's details: loaded when it's shown.
  const settingsOf = tab === "settings" && !switching && !managing ? (a?.context ?? null) : null;
  useEffect(() => {
    if (!settingsOf) return;
    managingNow.current = settingsOf;
    void loadDetails();
  }, [settingsOf]);

  const openItem = (key: string | null) => {
    if (key) trail.current.push(key);
    else trail.current = [];
    setDetail(key);
  };
  const backItem = () => {
    trail.current.pop();
    setDetail(trail.current.at(-1) ?? null);
  };

  const loadDetails = async () => {
    const name = managingNow.current;
    if (!name) return;
    try {
      const d = await b.call<ContextDetails>("context_info", { context: name, details: true });
      if (managingNow.current === name) setDetails(d);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  /** Opens one context's details (or, with null, goes back to the list). */
  const manage = (name: string | null) => {
    setDetails(null);
    setManaging(name);
    managingNow.current = name;
    return loadDetails();
  };
  /** Shows another of the chat's contexts. */
  const view = (name: string | null) => {
    viewing.current = name;
    return refresh(name);
  };

  /** Runs a tool from a button or field, then refreshes. Where the app can't run tools, asks the agent to. */
  const act = async (tool: string, args: Record<string, unknown>, done?: string) => {
    setError(null);
    try {
      const r = await b.call<{ invite?: { id?: string } } | undefined>(tool, args);
      setNotice(done ?? null);
      // A new join code (from Invite): marked in the People tab's list.
      if (r && typeof r === "object" && r.invite?.id) setMade(r.invite.id);
    } catch (e) {
      if (!(e instanceof NoToolCalls)) setError((e as Error).message);
      else
        await b.say(asks(tool, args)).then(
          () => setNotice("Asked your agent to do that."),
          (e2: Error) => setError(e2.message),
        );
    }
    await refresh();
    await loadDetails();
  };

  /** Hands the person's words to the agent, as their own prompt. */
  const ask = async (text: string) => {
    setComposing(null);
    openItem(null);
    setError(null);
    try {
      await b.say(text);
      setNotice("Handed to your agent.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copy = async (text: string, ok = "Copied.") => {
    setNotice((await copyText(text)) ? ok : "This app doesn’t allow copying from here: select the text and copy it.");
  };

  const messages = (error || notice) && (
    <Alert
      tone={error ? "error" : "success"}
      onDismiss={() => {
        setError(null);
        setNotice(null);
      }}
    >
      {error ?? notice}
    </Alert>
  );

  /** A step that takes the whole view: a title, what it's about, its body, and a way out. */
  const modal = (title: string, about: ReactNode, body: ReactNode, close?: { label: string; onClick: () => void }) => (
    <VStack gap="lg">
      <VStack gap="sm">
        <Split align="start">
          <Heading as="h1" level={3}>{title}</Heading>
          {close && (
            <Button onClick={close.onClick}>
              <ChevronLeftIcon /> {backLabel(close.label)}
            </Button>
          )}
        </Split>
        {about && <Text>{about}</Text>}
      </VStack>
      {messages}
      {body}
    </VStack>
  );

  if (!ready && !a && !none) return <Loading>Loading the context…</Loading>;

  const here = none ?? a?.your_contexts ?? [];
  const using = a?.contexts ?? [];
  const inChat = (n: string) => using.find((c) => c.name === n);
  /** Turns a context on or off for this chat. */
  const toggle = (n: string) =>
    void (inChat(n)
      ? act("use_context", { name: n, mode: "remove" }, `'${n}' is off for this chat. It stays on this machine.`)
      : act("use_context", { name: n, ...(using.length ? { mode: "add" } : {}) }, `'${n}' is on for this chat.`));
  /** The switch that turns a context on or off for this chat. */
  const onSwitch = (n: string) => {
    const c = inChat(n);
    return <Switch label={c ? "On" : "Off"} aria-label={`${n} in this chat`} checked={!!c} onChange={() => toggle(n)} />;
  };
  /** Leaves the contexts list for one of the chat's contexts. */
  const show = async (n: string) => {
    await view(n);
    await manage(null);
    setSwitching(false);
  };
  /** Opens one of the chat's contexts on its Settings tab. */
  const settingsTab = (n: string) =>
    show(n).then(() => {
      setMore(0);
      setTabState("settings");
    });
  /** Starts the join-code step for one of the chat's contexts. */
  const share = (n: string) => {
    draft.current.invite = "";
    return show(n).then(() => setInviting("contributor"));
  };
  const writeHere = (n: string) => void act("use_context", { name: n, mode: "add", write_here: true }, `New items go to '${n}' unless another fits better.`);

  /** A context's pin: whether new chats started in this chat's folder (or below it) start with it. */
  const pin = (n: string) => {
    const f = a?.folder;
    if (!f) return null;
    const pinned = (f.pinned ?? []).includes(n);
    return (
      <HStack>
        <Button
          variant="ghost"
          aria-pressed={pinned}
          onClick={() => void act("link_folder", pinned ? { name: n, off: true } : { name: n }, pinned ? `New chats in this folder no longer start with '${n}'.` : `New chats in this folder start with '${n}'.`)}
        >
          <PinIcon /> {pinned ? "On for new chats in " : "Turn on for new chats in "}
          <Text as="span" tone="muted">
            {tail(f.folder, 32)}
          </Text>
        </Button>
      </HStack>
    );
  };

  /**
   * A context's settings: how this chat uses it, its sharing, what it holds, and
   * deleting it. The open context's Settings tab, and the page of one that's off
   * for this chat (`inTab` false), where only some of it can be changed.
   */
  const settings = (n: string, inTab: boolean) => {
    const c = inChat(n);
    const d = details && details.name === n ? details : null;
    const isAdmin = (d?.role ?? c?.role) === "admin";
    const severalOn = using.length > 1;
    const sharing = d?.sharing ?? (inTab ? a?.sharing : undefined);
    const relays = inTab ? a?.relays_up : undefined;
    const count = (k: string, one: string, plural: string) => `${d?.items[k] ?? 0} ${(d?.items[k] ?? 0) === 1 ? one : plural}`;
    /** No one else has joined, so there is nobody to sync with. */
    const alone = d?.members === 1;
    return (
      <VStack gap="lg">
        <VStack gap="sm">
          <SectionTitle>This chat</SectionTitle>
          <Split wrap>
            <Cluster>
              {onSwitch(n)}
              {c && severalOn && !c.writes_here && (
                <Button onClick={() => writeHere(n)}>
                  <EditIcon /> Write here
                </Button>
              )}
            </Cluster>
            {c && !inTab && <OpenButton onClick={() => void show(n)} />}
          </Split>
          <Meta>
            {c
              ? severalOn
                ? c.writes_here
                  ? "Your agent looks things up in this context, and records new items in it unless another context clearly fits better."
                  : "Your agent looks things up in this context, and records a new item in it only when the item fits its description."
                : "This chat uses this context: your agent looks things up in it and records new claims and questions in it. Turning it off only affects this chat. Your copy stays on this machine."
              : "This chat isn’t using this context. Turn it on to open it here, share it or change its settings."}
          </Meta>
          {pin(n)}
        </VStack>
        <VStack gap="sm">
          <SectionTitle>Sharing</SectionTitle>
          {sharing === undefined ? (
            <Loading />
          ) : (
            <Text>
              <Text as="span" tone={sharing ? "success" : "warning"} aria-hidden="true">
                ●{" "}
              </Text>
              {!sharing ? "Offline" : alone ? "Only you so far" : "Syncing"}
              {d && (
                <Text as="span" tone="secondary">
                  {!sharing && alone ? " · only you so far" : ""}
                  {!alone ? ` · ${d.members} members · ${d.online} of the others online now` : ""}
                  {d.open_invites ? ` · ${d.open_invites} join code${d.open_invites === 1 ? "" : "s"} not used yet` : ""}
                </Text>
              )}
            </Text>
          )}
          <Meta>
            {sharing === false
              ? "Your copy keeps working. What you write is sent when you’re back online."
              : relays === 0
                ? "This machine can’t reach the servers that help members find each other, so nothing syncs right now."
                : alone
                  ? d?.open_invites
                    ? "Nobody has joined yet. Syncing starts when someone uses a join code you sent."
                    : "Nobody else is in this context yet. Invite someone to share it with them."
                  : "Every member keeps a full copy. Changes travel directly between your machines whenever you’re both online."}
          </Meta>
          {c && (
            <Cluster>
              {isAdmin && (
                <Button
                  variant="primary"
                  onClick={() => {
                    draft.current.invite = "";
                    if (inTab) setInviting("contributor");
                    else void share(n);
                  }}
                >
                  <AddIcon /> Invite someone
                </Button>
              )}
              {sharing !== undefined &&
                (sharing ? (
                  <Button onClick={() => void act("sharing", { action: "off", context: n }, `'${n}' is offline: not syncing until you go online again.`)}>Go offline</Button>
                ) : (
                  <Button onClick={() => void act("sharing", { action: "on", context: n }, `'${n}' is back online: syncing with the other members.`)}>Go online</Button>
                ))}
            </Cluster>
          )}
          {c && !isAdmin && <Meta>Only an admin can invite people.</Meta>}
        </VStack>
        <VStack gap="sm">
          <SectionTitle>About</SectionTitle>
          {d ? (
            <>
              <Facts>
                <Fact name="Your role">{d.role ?? "removed (you keep your copy to read)"}</Fact>
                <Fact name="Made by">{d.yours ? "you" : (d.created_by ?? "unknown")}</Fact>
                <Fact name="Holds">
                  {count("Claim", "claim", "claims")} · {count("Question", "question", "questions")} · {count("Reply", "reply", "replies")}
                </Fact>
                {d.held > 0 && <Fact name="Not yet sent">{d.held} just written, still only on this machine</Fact>}
              </Facts>
              <Reveal label="Id, storage and history" hide="Hide id, storage and history">
                <Facts>
                  <Fact name="Changes">{d.changes} in all, withdrawn items included</Fact>
                  <Fact name="Id">
                    <Code>{d.id ?? "none"}</Code>
                  </Fact>
                  <Fact name="Stored at">
                    <Code>{d.stored_at}</Code>
                  </Fact>
                </Facts>
              </Reveal>
            </>
          ) : error ? (
            <Meta>Couldn’t read its details.</Meta>
          ) : (
            <Loading />
          )}
        </VStack>
        <VStack gap="sm">
          <SectionTitle>Delete</SectionTitle>
          <Meta>Deletes this machine’s copy for good. Other members keep theirs. You’ll be asked to confirm.</Meta>
          <Cluster>
            <Button
              variant="danger"
              onClick={() => {
                draft.current.del = "";
                setDeleting({ name: n, error: null });
              }}
            >
              Delete from this machine…
            </Button>
          </Cluster>
        </VStack>
      </VStack>
    );
  };

  // Confirming a deletion, from the Settings tab or an off context's page: only
  // that. Nothing goes until the name is typed.
  if (deleting && here.includes(deleting.name)) {
    const n = deleting.name;
    const known = details && details.name === n ? details : null;
    const close = () => {
      draft.current.del = "";
      setDeleting(null);
    };
    const confirm = (typed: string) => {
      if (typed.trim() !== n) return setDeleting({ name: n, error: `Type ${n} exactly to delete it. Nothing was deleted.` });
      draft.current.del = "";
      setDeleting(null);
      void manage(null);
      viewing.current = null;
      setTabState("overview");
      void act("delete_context", { name: n, confirm: n }, `'${n}' was deleted from this machine.`);
    };
    const items = known ? Object.values(known.items).reduce((x, y) => x + y, 0) : null;
    const others = known ? known.members - (known.role ? 1 : 0) : null;
    return modal(
      `Delete ${n}?`,
      `This permanently deletes this machine’s copy of '${n}'${items !== null ? `: its ${items} item${items === 1 ? "" : "s"}, their history` : ": its claims, questions and replies, their history"}, the join codes made here, and every chat’s and folder’s link to it. It can’t be undone.`,
      <VStack gap="lg">
        <Box tone="warn">
          <VStack gap="sm">
            {others === null ? (
              <Text>Other members keep their own copies. If you’re its only member, it’s gone for good.</Text>
            ) : others > 0 ? (
              <Text>
                {others} other member{others === 1 ? " keeps their" : "s keep their"} own copy, and nothing is deleted for them. To get it back you’d need a new join code from one of its admins.
              </Text>
            ) : (
              <Text tone="warning">You’re its only member, so this is the only copy: once deleted, it’s gone for good.</Text>
            )}
            {known?.yours && others !== null && others > 0 && (
              <Text tone="warning">You made this context. The other members keep syncing with each other, but the join codes you made stop working.</Text>
            )}
            {inChat(n) && <Meta>To only stop using it in this chat, turn it off instead: it stays on this machine.</Meta>}
          </VStack>
        </Box>
        <Field key={`delete-${n}`} label={`Type ${n} to confirm`} placeholder={n} autoFocus onInput={(v) => (draft.current.del = v)} onSubmit={confirm} />
        {deleting.error && <Text tone="error">{deleting.error}</Text>}
        <Cluster>
          <Button variant="primary" onClick={close}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => confirm(draft.current.del ?? "")}>
            Delete permanently
          </Button>
        </Cluster>
      </VStack>,
      { label: "Cancel", onClick: close },
    );
  }

  // A new context: its name and what it's for, together. Only that.
  if (creating) {
    const close = () => setCreating(null);
    const create = () => {
      const name = (draft.current.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
      const description = (draft.current.description ?? "").trim();
      const problem = newContextProblem(name, description, here);
      if (problem) return setCreating({ error: problem });
      draft.current.name = draft.current.description = "";
      setCreating(null);
      setSwitching(false);
      viewing.current = name;
      void act("use_context", { name, description, ...(a ? { mode: "add" } : {}) }, `Created '${name}'${a ? " and added it to this chat" : ""}. No one is invited yet: use Invite someone when you want to let a person in.`);
    };
    return modal(
      "Create a new context",
      "A context holds what a group knows, as claims and questions, shared with the people you invite.",
      <VStack gap="lg">
        <Field label="Name" placeholder="e.g. checkout-incident" autoFocus help="Short: lower-case letters, digits and dashes." onInput={(v) => (draft.current.name = v)} onSubmit={create} />
        <Field
          label="What is it for?"
          placeholder="What goes in it, in a sentence or two"
          rows={3}
          help="Every member’s agent reads this to decide what belongs there. You can change it later."
          onInput={(v) => (draft.current.description = v)}
          onSubmit={create}
        />
        {creating.error && <Text tone="error">{creating.error}</Text>}
        <Cluster>
          <Button variant="primary" onClick={create}>
            Create
          </Button>
          <Button onClick={close}>
            <ChevronLeftIcon /> Cancel
          </Button>
        </Cluster>
        <Meta>It’s yours: you’re its admin, and it’s added to this chat. Invite people from its People tab, or with Share in the list.</Meta>
      </VStack>,
      { label: "Cancel", onClick: close },
    );
  }

  // The chat's contexts, each with a switch: on means this chat uses it.
  if (none !== null || switching) {
    const many = using.length > 1;

    // A context that's off for this chat: what it's for and its settings. One
    // that's on opens instead, with these on its Settings tab.
    if (managing && here.includes(managing)) {
      const n = managing;
      const c = inChat(n);
      const d = details && details.name === n ? details : null;
      const description = d ? d.description : (c?.description ?? null);
      return modal(
        n,
        null,
        <VStack gap="lg">
          <VStack gap="sm">
            <SectionTitle>What it’s for</SectionTitle>
            {description ? <Text>{description}</Text> : <Meta>No description yet, so agents won’t know what belongs here.</Meta>}
          </VStack>
          {settings(n, false)}
        </VStack>,
        { label: "‹ Contexts", onClick: () => void manage(null) },
      );
    }

    return modal(
      "Contexts in this chat",
      none
        ? here.length
          ? "This chat has no context yet, so your agent will ask which it’s for. Turn one on, or create one."
          : "A context holds what a group knows, as claims and questions, shared with the people you invite. Create one for this chat, or join one with a code someone sent you."
        : many
          ? "Your agent reads all of these, and puts each new item in the one whose description fits. ✎ marks where it writes when none clearly does."
          : "Most chats use one context. Turn another on to use it too: your agent then picks the right one for each item.",
      <VStack gap="md">
        <VStack gap="sm">
          <Cluster>
            <Button
              variant="primary"
              onClick={() => {
                draft.current.name = draft.current.description = "";
                setCreating({ error: null });
              }}
            >
              <AddIcon /> Create new context
            </Button>
          </Cluster>
          <Meta>Got a join code? Paste it to your agent.</Meta>
        </VStack>
        {here.map((n) => {
          const c = inChat(n);
          return (
            <Box key={n} tone={c ? "accent" : undefined}>
              <VStack gap="sm">
                <Split align="start">
                  <Cluster gap="xs">
                    <Button variant="ghost" onClick={() => void (c ? show(n) : manage(n))}>
                      {n}
                    </Button>
                    {c && <Text as="span" tone="secondary">· {c.role ?? "removed"}</Text>}
                    {c && many && c.writes_here && <Badge tone="primary">✎ writes here</Badge>}
                  </Cluster>
                  {onSwitch(n)}
                </Split>
                {c && <Meta>{c.description ?? "No description yet"}</Meta>}
                <Split wrap>
                  <Cluster>
                    <Button onClick={() => void (c ? settingsTab(n) : manage(n))}>Settings</Button>
                    {c?.role === "admin" && <Button onClick={() => void share(n)}>Share</Button>}
                    {c && many && !c.writes_here && (
                      <Button onClick={() => writeHere(n)}>
                        <EditIcon /> Write here
                      </Button>
                    )}
                  </Cluster>
                  {c && <OpenButton onClick={() => void show(n)} />}
                </Split>
                {pin(n)}
              </VStack>
            </Box>
          );
        })}
        {a?.folder && here.length > 0 && (
          <Meta>
            <PinIcon /> A pinned context is on in every new chat started in that folder, or below it. It’s kept on this machine: nothing is written into the folder.
          </Meta>
        )}
      </VStack>,
      none ? undefined : { label: "Done", onClick: () => setSwitching(false) },
    );
  }

  if (!a) return <Alert tone="error">{trouble ?? "Couldn’t load the context."}</Alert>;

  const many = a.contexts.length > 1;
  /** The context an action is about: named only when the chat has several (the tools take `context` then). */
  const ctx = many ? { context: a.context } : {};
  const named = many ? a.context : undefined;
  const admin = a.you.role === "admin";
  const invites: Invite[] = admin ? (a.invites ?? []) : [];
  const canWrite = a.you.role === "admin" || a.you.role === "contributor";
  const snap = a.snapshot;
  const t = snap ? threads(snap.nodes, snap.edges) : undefined;
  const rel = snap ? relations(snap.nodes, snap.edges) : undefined;
  const now = Date.now();
  const heldByNode = new Map(a.recent.filter((c) => c.held && c.node).map((c) => [c.node!, c]));
  const isMine = (n: GraphNode) => prop(n, "recorded_by") === a.you.name;
  const byline = (n: GraphNode) => {
    const by = prop(n, "recorded_by") || "?";
    const at = prop(n, "recorded_at");
    return `${by === a.you.name ? "you" : by}${at ? ` · ${ago(at, now)}` : ""}`;
  };
  const held = (n: GraphNode) => heldByNode.has(n.key) && <Toned tone="warn"> · still only on this machine</Toned>;
  const undo = (n: GraphNode) => {
    const change = heldByNode.get(n.key);
    return (
      change && (
        <Button variant="primary" onClick={() => void act("withdraw", { id: change.id, undo_only: true, ...ctx }, "Taken back. It never left this machine.")}>
          Undo
        </Button>
      )
    );
  };
  /** Withdraw, for its author or an admin, once it has been shared (before that, Undo). */
  const withdraw = (n: GraphNode) =>
    !heldByNode.has(n.key) &&
    !n.ended &&
    canWrite &&
    (isMine(n) || admin) && (
      <Button
        onClick={() => {
          openItem(null);
          void act("withdraw", { id: n.key, ...ctx }, "Withdrawn. It stays in the history.");
        }}
      >
        Withdraw
      </Button>
    );

  // Editing the description: only that.
  if (editing)
    return modal(
      `Describe ${a.context}`,
      "What goes in it, and what doesn’t. It syncs to every member, and their agents use it to decide what belongs here.",
      <Field
        label={`What is '${a.context}' for?`}
        value={a.description ?? ""}
        placeholder="What goes in it, in a sentence or two"
        rows={3}
        submit="Save"
        autoFocus
        onSubmit={(v) => {
          setEditing(false);
          if (v.trim() && v.trim() !== a.description) void act("update_context", { purpose: v.trim(), ...ctx }, "Saved. Every member’s agent sees it.");
        }}
      />,
      { label: "Cancel", onClick: () => setEditing(false) },
    );

  // Changing your name: only that.
  if (renaming)
    return modal(
      "Your name",
      `Everyone sees you as ${a.you.name}. Each person names themselves: the name travels with your key, to every context on this machine, and every member sees the change.`,
      <Field
        label="The name you’d like others to see"
        value={a.you.name}
        submit="Rename"
        autoFocus
        onSubmit={(v) => {
          setRenaming(false);
          if (v.trim() && v.trim() !== a.you.name) void act("update_context", { my_name: v.trim() }, `You're now ${v.trim()} in every context on this machine.`);
        }}
      />,
      { label: "Cancel", onClick: () => setRenaming(false) },
    );

  // Correcting a claim: only the claim and what's right instead. The agent records it.
  const composeOn = composing && rel ? rel.byKey.get(composing) : undefined;
  if (composeOn) {
    const send = (v: string) => v.trim() && void ask(prompts.correct(composeOn, v.trim(), named));
    return modal(
      "Correct this claim",
      composeOn.title,
      <VStack gap="md">
        <Meta>
          {byline(composeOn)} · {composeOn.key}
        </Meta>
        <Field
          key={`correct-${composeOn.key}`}
          label="What’s right instead?"
          placeholder="In your own words: your agent records it as a claim that replaces this one"
          rows={3}
          submit="Send to agent"
          autoFocus
          onSubmit={send}
        />
        <Meta>The old claim stays in the history, marked as replaced, so anyone can see what was believed before.</Meta>
      </VStack>,
      { label: "Cancel", onClick: () => setComposing(null) },
    );
  }

  // Making a join code: who it's for and their role, then back to the list, where it waits to be sent.
  if (admin && inviting) {
    const role = inviting;
    const make = (text: string) => {
      draft.current.invite = "";
      setInviting(null);
      setTabState("people");
      void act("share_context", { ...(text.trim() ? { label: text.trim() } : {}), ...(role !== "contributor" ? { role } : {}), ...ctx }, "Join code made. Copy it and send it privately, to that one person.");
    };
    return modal(
      `Invite someone to ${a.context}`,
      "A join code lets one person in: whoever uses it first. Send it to them privately. It expires in 24 hours if no one uses it.",
      <VStack gap="md">
        <Select<Role>
          label="They can"
          value={role}
          onChange={(v) => v && setInviting(v)}
          options={[
            { value: "contributor", label: "Read and add (contributor)" },
            { value: "reader", label: "Only read (reader)" },
            { value: "admin", label: "Read, add and invite (admin)" },
          ]}
        />
        <Field
          label="Who is it for? (optional)"
          placeholder="e.g. Sam: shown when they join, so a code used by someone else stands out"
          autoFocus
          onInput={(v) => (draft.current.invite = v)}
          onSubmit={make}
        />
        <Cluster>
          <Button variant="primary" onClick={() => make(draft.current.invite ?? "")}>
            Make join code
          </Button>
        </Cluster>
        <Meta>This machine answers the code, so it must be online when they use it. Everyone in the context is told who joined.</Meta>
      </VStack>,
      { label: "Cancel", onClick: () => setInviting(null) },
    );
  }

  // Confirming a removal: only that.
  const leaving = confirmRemove ? a.people.find((p) => p.fingerprint === confirmRemove) : undefined;
  if (leaving)
    return modal(
      `Remove ${leaving.name}?`,
      `Every member’s machine stops syncing with ${leaving.name} and refuses their later changes. What they wrote stays, and they keep the copy they already had.`,
      <Cluster>
        <Button
          variant="primary"
          onClick={() => {
            setConfirmRemove(null);
            void act("manage_member", { action: "remove", name: leaving.name, ...ctx }, `${leaving.name} was removed. They keep the copy they already had.`);
          }}
        >
          Remove {leaving.name}
        </Button>
      </Cluster>,
      { label: "Cancel", onClick: () => setConfirmRemove(null) },
    );

  // One item on its own: a question with its thread, or a claim with everything linked to it.
  const item = detail && rel ? rel.byKey.get(detail) : undefined;
  if (item && rel && t) {
    const back = { label: trail.current.length > 1 ? "‹ Back" : "‹ Back to the list", onClick: backItem };
    /** A linked item: its text, who and when, and a way to open it. */
    const related = (label: string, tone: Tone, n: GraphNode) => (
      <Split key={`${label}-${n.key}`} align="start">
        <VStack gap="none">
          <Ended ended={n.label === "Claim" && !rel.current(n)}>
            <Toned tone={tone}>{label} </Toned>
            {short(n.title, 300)}
          </Ended>
          <Meta>
            {byline(n)} · {n.key}
          </Meta>
        </VStack>
        <OpenButton onClick={() => openItem(n.key)} />
      </Split>
    );
    const group = (title: string, label: string, tone: Tone, list: GraphNode[]) =>
      list.length > 0 && (
        <VStack key={title} gap="sm">
          <SectionTitle count={list.length}>{title}</SectionTitle>
          {list.map((n) => related(label, tone, n))}
        </VStack>
      );

    if (item.label === "Question") {
      const th = [...t.open, ...t.answered].find((x) => x.q.id === item.id);
      const answered = !!th?.answers.length;
      const open = !answered && !item.ended;
      return modal(
        item.ended ? "Withdrawn question" : answered ? "Answered question" : "Open question",
        item.title,
        <VStack gap="md">
          <Meta>
            asked by {byline(item)} · {item.key}
            {held(item)}
          </Meta>
          {group("It’s about", "→", undefined, rel.linked(item.id, "ABOUT", "out"))}
          {th && th.replies.length > 0 && (
            <VStack gap="sm">
              <SectionTitle count={th.replies.length}>Thread</SectionTitle>
              {th.replies.map((r) => (
                <Split key={r.key} align="start">
                  <VStack gap="none">
                    <Text>
                      <Text as="span" tone="secondary">
                        ↳{" "}
                      </Text>
                      {short(r.title, 600)}
                    </Text>
                    <Meta>
                      {byline(r)}
                      {held(r)}
                    </Meta>
                  </VStack>
                  <Cluster>
                    {undo(r)}
                    {open && canWrite && <Button onClick={() => void ask(answerPrompt(item, { reply: r }, named))}>Answer with this</Button>}
                  </Cluster>
                </Split>
              ))}
            </VStack>
          )}
          {th && group("Answer", "✓", "ok", th.answers)}
          {group("Questions about this one", "?", "warn", rel.linked(item.id, "ABOUT", "in"))}
          {open && canWrite && (
            <Field
              key={`answer-${item.key}`}
              label="Your answer"
              placeholder="In your own words: your agent records it as a claim that answers this"
              submit="Send to agent"
              autoFocus
              onSubmit={(v) => v.trim() && void ask(answerPrompt(item, { text: v.trim() }, named))}
            />
          )}
          <Cluster>
            {open && canWrite && <Button onClick={() => void ask(prompts.investigate(item, named))}>Ask my agent to look into it</Button>}
            <Button onClick={() => void copy(`${item.title} (${item.key})`)}>Copy</Button>
            {undo(item)}
            {withdraw(item)}
          </Cluster>
          {open && <Meta>Agents reply on the thread. Your answer goes to your agent, which records it as a claim that answers the question.</Meta>}
        </VStack>,
        back,
      );
    }

    const newer = rel.replacedBy.get(item.id);
    const state = item.ended ? "Withdrawn claim" : newer ? "Replaced claim" : rel.inConflict.has(item.id) ? "Claim in conflict" : "Claim";
    const from = prop(item, "about_from");
    const to = prop(item, "about_to");
    const contradicts = [...rel.linked(item.id, "CONTRADICTS", "out"), ...rel.linked(item.id, "CONTRADICTS", "in")].filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i);
    return modal(
      state,
      null,
      <VStack gap="md">
        <Ended ended={!rel.current(item)}>{item.title}</Ended>
        <VStack gap="none">
          <Meta>
            recorded by {byline(item)} · {item.key}
            {held(item)}
          </Meta>
          {prop(item, "source") && <Meta>Source: {prop(item, "source")}</Meta>}
          {(from || to) && <Meta>About {from && to ? `${from.slice(0, 10)} to ${to.slice(0, 10)}` : from ? `${from.slice(0, 10)} onwards` : `up to ${to.slice(0, 10)}`}</Meta>}
          {item.ended && (
            <Text tone="warning">
              Withdrawn{prop(item, "withdrawn_by") ? ` by ${prop(item, "withdrawn_by")}` : ""}
              {prop(item, "withdrawn_at") ? ` · ${ago(prop(item, "withdrawn_at"), now)}` : ""}
              {prop(item, "withdraw_reason") ? `: ${prop(item, "withdraw_reason")}` : ""}
            </Text>
          )}
        </VStack>
        {newer && group("Replaced by", "↑", "ok", [newer])}
        {group("Can’t be true alongside", "⚡", "warn", contradicts)}
        {group("Answers", "?", undefined, rel.linked(item.id, "ANSWERS", "out"))}
        {group("Evidence for it", "+", "ok", rel.linked(item.id, "SUPPORTS", "in"))}
        {group("It’s evidence for", "→", undefined, rel.linked(item.id, "SUPPORTS", "out"))}
        {group("Earlier versions", "↓", undefined, rel.linked(item.id, "REPLACES", "out"))}
        {group("Questions about it", "?", "warn", rel.linked(item.id, "ABOUT", "in"))}
        <Cluster>
          {rel.current(item) && canWrite && !heldByNode.has(item.key) && (
            <Button variant="primary" onClick={() => setComposing(item.key)}>
              Correct it
            </Button>
          )}
          <Button onClick={() => void copy(`${item.title} (${item.key})`)}>Copy</Button>
          {undo(item)}
          {withdraw(item)}
        </Cluster>
        {rel.current(item) && canWrite && <Meta>Correct it when it’s wrong or out of date: the new claim replaces this one, which stays in the history. Withdraw it when it should never have been recorded.</Meta>}
      </VStack>,
      back,
    );
  }

  const f = filters;
  /** Another tab starts from the top, without the last tab's filter words. */
  const setTab = (x: Tab, patch: Partial<Filters> = {}) => {
    setMore(0);
    setFilters((v) => ({ ...v, ...(x === tab ? {} : { text: "" }), ...patch }));
    setTabState(x);
  };
  /**
   * Asks the server's search for what the filter's text is close to, in the
   * context shown, ended items included so History can use it too. A server
   * from before `include_ended` is asked again without it.
   */
  const findRelated = async (text: string) => {
    if (!text || !b.canCall) return setFound(null);
    const context = a.context;
    setFound({ text, context, ids: null });
    const ask = { query: text, kind: "any", limit: 50, ...ctx };
    const settle = (next: Found) => setFound((v) => (v?.text === text && v.context === context ? next : v));
    try {
      const rows = await b.call("search", { ...ask, include_ended: true }).catch((e) => {
        if (e instanceof NoToolCalls) throw e;
        return b.call("search", ask);
      });
      settle({ text, context, ids: ids(rows) });
    } catch {
      settle({ text, context, ids: [], failed: true });
    }
  };
  const setFilter = (patch: Partial<Filters>) => {
    setMore(0);
    setFilters((v) => ({ ...v, ...patch }));
    if (patch.text !== undefined) void findRelated(patch.text);
  };
  /** The search behind the filter's text, once it has answered for this text in this context. */
  const near = f.text && found && found.text === f.text && found.context === a.context ? found : null;
  const members = a.people.filter((p) => p.role);
  const rank = (p: Person) => (p.you ? 0 : p.online ? 1 : 2);
  const shown = [...members].sort((x, y) => rank(x) - rank(y)).slice(0, HEADER_PEOPLE);
  const unshown = members.length - shown.length;
  const unshownOnline = members.filter((p) => p.online).length - shown.filter((p) => p.online).length;
  const counts: Record<Tab, number | undefined> = { overview: undefined, questions: t?.open.length, claims: t?.claims.length, people: members.length, settings: undefined };
  const goOnline = (
    <Button variant="primary" onClick={() => void act("sharing", { action: "on", ...ctx }, "Back online: syncing with the other members.")}>
      Go online
    </Button>
  );
  // The latest news from someone else: what their changes meant for you if that's newest, else their latest change.
  const digest = a.digest?.at(-1);
  const latest = a.recent.find((c) => !c.mine && !c.held && c.kind !== "create");
  const news = digest?.lines[0] && (!latest || digest.at >= latest.at) ? `${short(plain(digest.lines[0]), 90)} (${ago(digest.at, now)})` : latest ? `${latest.by} ${short(plain(latest.summary), 80)} (${ago(latest.at, now)})` : "";

  const header = (
    <VStack gap="sm">
      <Split align="start">
        <Heading as="h1" level={3}>{a.context}</Heading>
        <Button onClick={() => setSwitching(true)}>
          <TransferIcon /> {many ? `${a.contexts.length} contexts` : "Contexts"}
        </Button>
      </Split>
      {many && (
        <Cluster>
          {a.contexts.map((c) => (
            <Chip key={c.name} active={c.name === a.context} onClick={() => void view(c.name)}>
              {c.name}
              {c.writes_here ? " ✎" : ""}
            </Chip>
          ))}
        </Cluster>
      )}
      <Split align="start">
        {a.description ? <Text>{a.description}</Text> : <Meta>No description yet{admin ? "" : ": an admin can add one"}, so agents won’t know what belongs here.</Meta>}
        {admin && <IconButton icon={<EditIcon />} label="Edit description" onClick={() => setEditing(true)} />}
      </Split>
      <Cluster gap="xs">
        <Badge
          variant="dot"
          tone={a.sharing ? "success" : "warning"}
          title={a.sharing ? `Syncing with the other members · ${a.relays_up} signalling relay${a.relays_up === 1 ? "" : "s"} reachable` : "Not syncing: what you write stays on this machine until you go online"}
        >
          {a.sharing ? "Syncing" : "Offline"}
        </Badge>
        <Button variant="ghost" onClick={() => void act("sharing", { action: a.sharing ? "off" : "on", ...ctx }, a.sharing ? "Offline: not syncing until you go online again." : "Back online: syncing with the other members.")}>
          {a.sharing ? "Go offline" : "Go online"}
        </Button>
        <Divider orientation="vertical" aria-hidden="true" />
        {shown.map((p) => (
          <Text
            as="span"
            key={p.fingerprint}
            tone={p.online ? "secondary" : "muted"}
            title={`${p.name} · ${p.role}${p.creator ? " · made this context" : ""} · ${p.online ? "online now" : "offline"} · key ${p.fingerprint}${p.agent ? ` · ${p.agent}` : ""}${p.platform ? ` · ${p.platform}` : ""}`}
          >
            <Text as="span" tone={p.online ? "success" : "muted"} aria-hidden="true">
              ●
            </Text>{" "}
            {p.name}
            {p.you ? " (you)" : ""}
          </Text>
        ))}
        {unshown > 0 && (
          <Button variant="ghost" onClick={() => setTab("people")}>
            +{unshown} more{unshownOnline ? ` · ${unshownOnline} online` : ""}
          </Button>
        )}
      </Cluster>
      {news && <Meta>Latest: {news}</Meta>}
    </VStack>
  );

  /** The filter box above a list, and what it's filtering by: its words, and how many more are close in meaning. */
  const filterBox = (what: string, byMeaning: number) => (
    <VStack gap="sm">
      <Field key={`filter-${tab}-${f.text}`} value={f.text} placeholder={`Search ${what} by meaning, words, a person or an id`} submit="Search" onSubmit={(v) => setFilter({ text: v.trim() })} />
      {f.text && (
        <Cluster gap="xs">
          <Text as="span" tone="muted">
            Showing {what} matching “{short(f.text, 40)}”
            {!b.canCall
              ? ""
              : !near || near.ids === null
                ? " · looking for ones close in meaning…"
                : near.failed
                  ? " · search by meaning isn’t available, so only words match"
                  : byMeaning
                    ? `, then ${byMeaning} close in meaning`
                    : ""}
          </Text>
          <Button variant="ghost" onClick={() => setFilter({ text: "" })}>
            <CloseIcon /> Clear
          </Button>
        </Cluster>
      )}
    </VStack>
  );
  /** The first page of a list, and a button for the rest. */
  const paged = <T,>(list: T[]) => list.slice(0, PAGE + more);
  const showMore = (total: number) =>
    total > PAGE + more && (
      <HStack>
        <Button variant="ghost" onClick={() => setMore((n) => n + PAGE)}>
          Show {Math.min(PAGE, total - PAGE - more)} more of {total}
        </Button>
      </HStack>
    );
  /** What a list says when it has nothing to show. */
  const empty = (text: string) => <Text tone="muted">{text}</Text>;

  let body: ReactNode;
  if (!snap || !t || !rel) body = <Loading />;
  else if (tab === "overview") {
    const heldMine = a.recent.filter((c) => c.held && c.mine);
    const waiting = t.open.filter((th) => th.replies.length);
    const mineOpen = t.open.filter((th) => isMine(th.q) && th.replies.length);
    const need = (key: string, tone: Tone, text: ReactNode, button: ReactNode) => (
      <Box key={key} tone={tone}>
        <Split>
          <Text>{text}</Text>
          {button}
        </Split>
      </Box>
    );
    const needs = [
      !a.sharing && need("offline", "warn", "You’re offline: what you write stays on this machine, and you don’t see what others add, until you’re back.", goOnline),
      // Members already linked need no relay: it only matters for finding each other.
      a.sharing && a.relays_up === 0 && a.online.length === 0 && a.members > 1 && need("relays", "warn", "No signalling relay is reachable, so the other members can’t find this machine right now.", null),
      rel.conflicts.length > 0 &&
        need(
          "conflicts",
          "warn",
          `⚡ ${rel.conflicts.length} pair${rel.conflicts.length === 1 ? "" : "s"} of claims can’t both be true. Someone needs to say which stands.`,
          <Button variant="primary" onClick={() => setTab("claims", { text: "", claims: "conflicts" })}>
            Settle
          </Button>,
        ),
      mineOpen.length > 0 &&
        need(
          "replies",
          "accent",
          `↳ ${mineOpen.length} of your questions ${mineOpen.length === 1 ? "has" : "have"} replies: ${short(mineOpen[0]!.q.title, 80)}`,
          <Button variant="primary" onClick={() => openItem(mineOpen[0]!.q.key)}>
            Read
          </Button>,
        ),
      t.open.length > 0 &&
        need(
          "questions",
          undefined,
          `❓ ${t.open.length} open question${t.open.length === 1 ? "" : "s"}${waiting.length ? `, ${waiting.length} with replies` : ""}.`,
          <Button onClick={() => setTab("questions", { text: "", questions: "open" })}>See</Button>,
        ),
      admin &&
        !a.description &&
        need(
          "describe",
          "accent",
          "This context has no description, so agents can’t tell what belongs in it.",
          <Button variant="primary" onClick={() => setEditing(true)}>
            Describe
          </Button>,
        ),
      admin &&
        members.length === 1 &&
        !invites.length &&
        need(
          "alone",
          "accent",
          "It’s just you here so far.",
          <Button variant="primary" onClick={() => setInviting("contributor")}>
            Invite someone
          </Button>,
        ),
      invites.length > 0 && need("invites", undefined, `${invites.length} join code${invites.length === 1 ? " is" : "s are"} waiting to be used.`, <Button onClick={() => setTab("people")}>See</Button>),
    ].filter(Boolean);
    body = (
      <VStack gap="md">
        {heldMine.length > 0 && (
          <Box tone="warn">
            <VStack gap="sm">
              <Text tone="warning">Just written, still only on this machine:</Text>
              {heldMine.map((c) => (
                <Split key={c.id}>
                  <Text>{short(plain(c.summary), 140)}</Text>
                  <Button variant="primary" onClick={() => void act("withdraw", { id: c.id, undo_only: true, ...ctx }, "Taken back. It never left this machine.")}>
                    Undo
                  </Button>
                </Split>
              ))}
            </VStack>
          </Box>
        )}
        <SectionTitle count={needs.length || undefined}>Needs you</SectionTitle>
        {needs.length ? (
          <Folded list={needs} first={3} what="things" one="thing" render={(x) => x} />
        ) : (
          <Box tone="ok">
            <Text tone="success">✓ Nothing needs you right now.</Text>
          </Box>
        )}
        {digest && digest.lines.length > 0 && (
          <>
            <SectionTitle>What changed for you</SectionTitle>
            <Box tone="accent">
              <VStack gap="sm">
                <Folded list={digest.lines.map((line, i) => ({ line, i }))} first={3} what="changes" one="change" render={({ line, i }) => <Text key={i}>{plain(line)}</Text>} />
                <Meta>{ago(digest.at, now)}</Meta>
              </VStack>
            </Box>
          </>
        )}
        <SectionTitle>Ask your agent</SectionTitle>
        <Cluster>
          <Button onClick={() => void ask(prompts.catchUp(a.context))}>Catch me up</Button>
          {canWrite && <Button onClick={() => void ask(prompts.saveChat(a.context))}>Save what this chat learned</Button>}
        </Cluster>
        <SectionTitle>Recent activity</SectionTitle>
        {!a.recent.length && <Meta>Nothing yet. What your agent and the other members’ agents record shows up here.</Meta>}
        <Folded
          list={a.recent}
          first={RECENT}
          what="changes"
          one="change"
          render={(c: Change) => {
            const KindIcon = ICON[c.kind] ?? ActivityIcon;
            return (
              <Split key={c.id} align="start">
                <VStack gap="none">
                  <Text>
                    <Text as="span" tone="secondary">
                      <KindIcon /> {c.mine ? "you" : c.by} {lead(c).head}
                    </Text>
                    {short(lead(c).body, 200)}
                  </Text>
                  <Meta>
                    {ago(c.at, now)}
                    {c.held && <Toned tone="warn"> · still only on this machine</Toned>}
                  </Meta>
                </VStack>
                {c.node && rel.byKey.has(c.node) && <OpenButton onClick={() => openItem(c.node)} />}
              </Split>
            );
          }}
        />
        <Meta>
          {t.claims.length} claim{t.claims.length === 1 ? "" : "s"} · {t.open.length} open and {t.answered.length} answered question{t.answered.length === 1 ? "" : "s"} · {rel.history.length} replaced or withdrawn · {a.changes} changes in all
          {snap.truncated ? " · showing the latest items only" : ""}
        </Meta>
      </VStack>
    );
  } else if (tab === "questions") {
    const scopes = { open: t.open, answered: t.answered, mine: [...t.open, ...t.answered].filter((th) => isMine(th.q)) };
    const scope = f.questions in scopes ? f.questions : "open";
    const { list, byMeaning } = filtered(
      scopes[scope],
      (th) => th.q.key,
      (th) => matches(th.q, f.text) || th.replies.some((r) => matches(r, f.text)) || th.answers.some((c) => matches(c, f.text)),
      near?.ids,
    );
    const question = (th: Thread) => {
      const q = th.q;
      const answered = th.answers.length > 0;
      return (
        <Box key={q.key} tone={heldByNode.has(q.key) ? "warn" : undefined}>
          <VStack gap="sm">
            <Split align="start">
              <VStack gap="none">
                <Text weight="bold">{short(q.title, 300)}</Text>
                <Meta>
                  asked by {byline(q)}
                  {th.replies.length ? ` · ${th.replies.length} repl${th.replies.length === 1 ? "y" : "ies"}` : ""}
                  {byMeaning.has(q.key) ? " · close in meaning" : ""}
                  {held(q)}
                </Meta>
              </VStack>
              <Cluster>
                {undo(q)}
                {answered || !canWrite ? (
                  <OpenButton onClick={() => openItem(q.key)} />
                ) : (
                  <Button variant="primary" onClick={() => openItem(q.key)}>
                    Answer
                  </Button>
                )}
              </Cluster>
            </Split>
            <Folded
              list={th.replies}
              first={2}
              latest
              what="replies"
              one="reply"
              render={(r) => (
                <Indented key={r.key}>
                  <Text>
                    <Text as="span" tone="secondary">
                      ↳{" "}
                    </Text>
                    {short(r.title, 240)}
                  </Text>
                  <Meta>
                    {byline(r)}
                    {held(r)}
                  </Meta>
                </Indented>
              )}
            />
            {th.answers.map((c) => (
              <Indented key={c.key}>
                <Text>
                  <Text as="span" tone="success">
                    ✓{" "}
                  </Text>
                  {short(c.title, 300)}
                </Text>
                <Meta>answered by {byline(c)}</Meta>
              </Indented>
            ))}
          </VStack>
        </Box>
      );
    };
    body = (
      <VStack gap="md">
        <Cluster>
          <Chip active={scope === "open"} onClick={() => setFilter({ questions: "open" })}>
            Open {t.open.length}
          </Chip>
          <Chip active={scope === "answered"} onClick={() => setFilter({ questions: "answered" })}>
            Answered {t.answered.length}
          </Chip>
          <Chip active={scope === "mine"} onClick={() => setFilter({ questions: "mine" })}>
            Mine {scopes.mine.length}
          </Chip>
        </Cluster>
        {filterBox("questions", byMeaning.size)}
        {!list.length &&
          empty(
            f.text
              ? "No questions match."
              : scope === "open"
                ? t.answered.length
                  ? "✓ Every question has an answer."
                  : "No questions yet. When your agent records something the group needs to find out, it shows up here with its thread."
                : scope === "answered"
                  ? "No question has been answered yet."
                  : "You haven’t asked anything here yet.",
          )}
        {paged(list).map(question)}
        {showMore(list.length)}
        <Meta>Agents ask and reply. Answer gives your agent your answer, and it records it as a claim.</Meta>
      </VStack>
    );
  } else if (tab === "claims") {
    const scopes = { current: t.claims, mine: t.claims.filter(isMine), conflicts: t.claims.filter((n) => rel.inConflict.has(n.id)), history: rel.history };
    const scope = f.claims in scopes ? f.claims : "current";
    const { list, byMeaning } = filtered(scopes[scope], (n) => n.key, (n) => matches(n, f.text), near?.ids);
    const pairs = scope === "history" ? [] : rel.conflicts.filter(([x, y]) => matches(x, f.text) || matches(y, f.text));
    const side = (keep: GraphNode, drop: GraphNode) => (
      <Split align="start">
        <VStack gap="none">
          <Text>{short(keep.title, 300)}</Text>
          <Meta>
            {byline(keep)} · {keep.key}
          </Meta>
        </VStack>
        <Cluster>
          {canWrite && <Button onClick={() => void ask(prompts.settle(keep, drop, named))}>Keep this one</Button>}
          <OpenButton onClick={() => openItem(keep.key)} />
        </Cluster>
      </Split>
    );
    const badges = (n: GraphNode) => {
      const evidence = rel.linked(n.id, "SUPPORTS", "in").filter(rel.current).length;
      return [
        rel.linked(n.id, "ANSWERS", "out").length ? "answers a question" : "",
        evidence ? `${evidence} in support` : "",
        rel.linked(n.id, "REPLACES", "out").length ? "updated" : "",
        prop(n, "source") ? short(prop(n, "source"), 50) : "",
      ]
        .filter(Boolean)
        .map((x) => ` · ${x}`)
        .join("");
    };
    body = (
      <VStack gap="md">
        <Cluster>
          <Chip active={scope === "current"} onClick={() => setFilter({ claims: "current" })}>
            Current {t.claims.length}
          </Chip>
          <Chip active={scope === "mine"} onClick={() => setFilter({ claims: "mine" })}>
            Mine {scopes.mine.length}
          </Chip>
          {(rel.conflicts.length > 0 || scope === "conflicts") && (
            <Chip active={scope === "conflicts"} onClick={() => setFilter({ claims: "conflicts" })}>
              ⚡ Conflicts {rel.conflicts.length}
            </Chip>
          )}
          <Chip active={scope === "history"} onClick={() => setFilter({ claims: "history" })}>
            History {rel.history.length}
          </Chip>
        </Cluster>
        {filterBox("claims", byMeaning.size)}
        {pairs.map(([x, y]) => (
          <Box key={`${x.key}-${y.key}`} tone="warn">
            <VStack gap="sm">
              <Text weight="bold" tone="warning">
                ⚡ These can’t both be true
              </Text>
              {side(x, y)}
              <Text tone="muted">— or —</Text>
              {side(y, x)}
            </VStack>
          </Box>
        ))}
        {scope === "conflicts" && !pairs.length && (
          <Box tone="ok">
            <Text tone="success">✓ No claims contradict each other.</Text>
          </Box>
        )}
        {scope !== "conflicts" &&
          !list.length &&
          empty(
            f.text
              ? "No claims match."
              : scope === "current"
                ? "No claims yet. What your agent records as true shows up here. Try “Save what this chat learned” on the Overview."
                : scope === "mine"
                  ? "None of the current claims are yours."
                  : "Nothing has been replaced or withdrawn.",
          )}
        {scope !== "conflicts" &&
          paged(list).map((n) => {
            const newer = rel.replacedBy.get(n.id);
            return (
              <Box key={n.key} tone={heldByNode.has(n.key) || rel.inConflict.has(n.id) ? "warn" : undefined}>
                <Split align="start">
                  <VStack gap="none">
                    <Ended ended={scope === "history"}>
                      {rel.inConflict.has(n.id) && <Toned tone="warn">⚡ </Toned>}
                      {short(n.title, 300)}
                    </Ended>
                    <Meta>
                      {byline(n)}
                      {byMeaning.has(n.key) ? " · close in meaning" : ""}
                      {scope === "history"
                        ? n.ended
                          ? ` · withdrawn${prop(n, "withdrawn_by") ? ` by ${prop(n, "withdrawn_by")}` : ""}${prop(n, "withdraw_reason") ? `: ${short(prop(n, "withdraw_reason"), 80)}` : ""}`
                          : newer
                            ? ` · replaced by ${newer.key}: ${short(newer.title, 80)}`
                            : ""
                        : badges(n)}
                      {held(n)}
                    </Meta>
                  </VStack>
                  <Cluster>
                    {undo(n)}
                    <OpenButton onClick={() => openItem(n.key)} />
                  </Cluster>
                </Split>
              </Box>
            );
          })}
        {scope !== "conflicts" && showMore(list.length)}
        {scope === "history" && <Meta>Nothing is deleted: replaced and withdrawn claims stay, so anyone can see what the group believed before.</Meta>}
      </VStack>
    );
  } else if (tab === "settings") {
    body = settings(a.context, true);
  } else {
    const gone = a.people.filter((p) => !p.role);
    const wrote = (p: Person) => {
      const mine = snap.nodes.filter((n) => !n.ended && prop(n, "recorded_by") === p.name);
      const n = (label: string) => mine.filter((x) => x.label === label).length;
      const parts = (
        [
          [n("Claim"), "claim"],
          [n("Question"), "question"],
          [n("Reply"), "repl"],
        ] as [number, string][]
      )
        .filter(([count]) => count)
        .map(([count, word]) => `${count} ${word}${word === "repl" ? (count === 1 ? "y" : "ies") : count === 1 ? "" : "s"}`);
      const last = a.recent.find((c) => c.by === p.name);
      return `${p.joined_at ? `joined ${ago(p.joined_at, now)}` : ""}${parts.length ? ` · ${parts.join(", ")}` : " · nothing recorded yet"}${last ? ` · active ${ago(last.at, now)}` : ""}`.replace(/^ · /, "");
    };
    const person = (p: Person) => (
      <Box key={p.fingerprint} tone={p.you ? "accent" : undefined}>
        <Split>
          <VStack gap="none">
            <Text>
              <Text as="span" tone={p.online ? "success" : "secondary"} aria-hidden="true">
                ●
              </Text>{" "}
              <Text as="span" weight="bold" tone={p.role ? undefined : "secondary"}>
                {p.name}
              </Text>
              <Text as="span" tone="secondary">
                {p.you ? " (you)" : ""} · {p.role ?? "removed"}
                {p.creator ? " · made this context" : ""}
                {p.role ? (p.online ? " · online" : " · offline") : ""}
              </Text>
            </Text>
            <Meta>{wrote(p)}</Meta>
            <Reveal label="Key and agent" hide="Hide key and agent">
              <Text tone="muted">
                <Code>{p.fingerprint}</Code>
                {p.agent ? ` · ${p.agent}` : ""}
                {p.platform ? ` · ${p.platform}` : ""}
              </Text>
            </Reveal>
          </VStack>
          <Cluster>
            {p.you && (
              <Button onClick={() => setRenaming(true)}>
                <EditIcon /> Rename
              </Button>
            )}
            {admin && !p.creator && !p.you && p.role && (
              <>
                <Select<Role>
                  aria-label={`Role of ${p.name}`}
                  fullWidth={false}
                  value={p.role}
                  onChange={(v) => v && v !== p.role && void act("manage_member", { action: "set_role", name: p.name, role: v, ...ctx }, `${p.name} is now ${v}.`)}
                  options={ROLES.map((r) => ({ value: r, label: r }))}
                />
                <Button onClick={() => setConfirmRemove(p.fingerprint)}>Remove</Button>
              </>
            )}
          </Cluster>
        </Split>
      </Box>
    );
    body = (
      <VStack gap="md">
        <SectionTitle count={members.length}>Members</SectionTitle>
        {members.map(person)}
        {admin && (
          <Box tone="accent">
            <VStack gap="md">
              <Split>
                <Text as="span">
                  <Text as="span" weight="bold">
                    Join codes
                  </Text>
                  <Text as="span" tone="secondary">
                    {" "}
                    {invites.length ? `${invites.length} waiting` : "none waiting"}
                  </Text>
                </Text>
                <Button variant="primary" onClick={() => setInviting("contributor")}>
                  <AddIcon /> Invite someone
                </Button>
              </Split>
              {invites.length === 0 ? (
                <Meta>Each code lets one person in: whoever uses it first. Codes stay here until they’re used, cancelled or expire.</Meta>
              ) : (
                invites.map((i) => {
                  const hours = Math.round(Math.max(0, Date.parse(i.expires_at) - now) / 3600_000);
                  return (
                    <VStack key={i.id} gap="sm">
                      <Split>
                        <Text as="span">
                          <Text as="span" weight="bold">
                            {i.label ? `For ${i.label.replace(/^for\s+/i, "")}` : "No note"}
                          </Text>
                          <Text as="span" tone="secondary">
                            {" "}
                            · {i.role} · {hours >= 1 ? `expires in ${hours}h` : "expires soon"}
                          </Text>
                          {i.id === made && <Toned tone="ok"> · new: send it now</Toned>}
                        </Text>
                        <Button onClick={() => void act("manage_member", { action: "revoke_invite", invite: i.id, ...ctx }, "Cancelled: that code no longer works.")}>Cancel</Button>
                      </Split>
                      <HStack gap="xs">
                        <TextField readOnly value={sendLine(i.code)} onFocus={(e) => e.currentTarget.select()} aria-label="Message to send" />
                        <Button onClick={() => void copy(sendLine(i.code), "Copied: send it privately, to that one person.")}>Copy</Button>
                      </HStack>
                    </VStack>
                  );
                })
              )}
              {!a.sharing && invites.length > 0 && <Text tone="warning">You’re offline, so these codes won’t work until you go online.</Text>}
            </VStack>
          </Box>
        )}
        {gone.length > 0 && <SectionTitle count={gone.length}>Removed</SectionTitle>}
        {gone.map(person)}
      </VStack>
    );
  }

  return (
    <VStack gap="lg">
      {header}
      <Tabs<Tab>
        value={tab}
        onValueChange={(x) => setTab(x)}
        items={TABS.map((x) => ({
          value: x.tab,
          label: x.label,
          badge: counts[x.tab] !== undefined ? <Badge tone="neutral">{counts[x.tab]}</Badge> : undefined,
          content:
            x.tab === tab ? (
              <VStack gap="lg">
                {trouble && <Alert tone="error">{trouble}</Alert>}
                {messages}
                {body}
              </VStack>
            ) : null,
        }))}
      />
    </VStack>
  );
}
