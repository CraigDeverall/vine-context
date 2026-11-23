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
// It reads through `context_activity`, which never uses up the notices meant
// for the agent, and acts through the server's ordinary tools. It polls.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { NoToolCalls, asks, copyText, usePoll, type Bridge } from "../bridge";
import {
  ago,
  answerPrompt,
  matches,
  newContextProblem,
  prompts,
  prop,
  relations,
  sendLine,
  short,
  tail,
  threads,
  type Activity,
  type Change,
  type ContextDetails,
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
const ICON: Record<string, string> = { claim: "📌", question: "❓", reply: "↳", link: "🔗", withdraw: "✕", add_member: "👋", remove_member: "🚪", set_role: "🔑", rename: "✎", describe: "✎", create: "✦" };
const ROLES: Role[] = ["reader", "contributor", "admin"];

type Tone = "warn" | "ok" | "bad" | "accent" | undefined;

const Card = ({ tone, children }: { tone?: Tone; children: ReactNode }) => <div className={`card${tone ? ` ${tone}` : ""}`}>{children}</div>;
const Meta = ({ children }: { children: ReactNode }) => <p className="faint wrap">{children}</p>;
const Heading = ({ children, count }: { children: ReactNode; count?: number | string }) => (
  <h2>
    {children}
    {count !== undefined && <span className="faint"> {count}</span>}
  </h2>
);
const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <button className={`chip${active ? " on" : ""}`} aria-pressed={active} onClick={onClick}>
    {children}
  </button>
);

/** An underlined link that opens and closes what it's about. */
const Toggle = ({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) => (
  <button className="link more" aria-expanded={open} onClick={onClick}>
    {children} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
  </button>
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
    <Toggle open={open} onClick={() => setOpen(!open)}>
      {open ? `Show fewer ${p.what}` : `${hidden} ${p.latest ? "earlier" : "more"} ${hidden === 1 && p.one ? p.one : p.what}`}
    </Toggle>
  );
  return (
    <>
      {p.latest && link}
      {shown.map(p.render)}
      {!p.latest && link}
    </>
  );
}

/** Extra detail behind an underlined link, closed until asked for. */
function Reveal({ label, hide = "Less", children }: { label: string; hide?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Toggle open={open} onClick={() => setOpen(!open)}>
        {open ? hide : label}
      </Toggle>
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
  return (
    <div className="field">
      {p.label && <label>{p.label}</label>}
      <div className="linkbox">
        {p.rows ? (
          <textarea
            rows={p.rows}
            value={v}
            placeholder={p.placeholder}
            autoFocus={p.autoFocus}
            aria-label={p.label ?? p.placeholder}
            onInput={(e) => change(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && p.onSubmit(v)}
          />
        ) : (
          <input
            value={v}
            placeholder={p.placeholder}
            autoFocus={p.autoFocus}
            aria-label={p.label ?? p.placeholder}
            onInput={(e) => change(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && p.onSubmit(v)}
          />
        )}
        {p.submit && (
          <button className="primary" onClick={() => p.onSubmit(v)}>
            {p.submit}
          </button>
        )}
      </div>
      {p.help && <Meta>{p.help}</Meta>}
    </div>
  );
}

export function Contexts({ b }: { b: Bridge }) {
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
  /** How many more items than the first page a list shows. */
  const [more, setMore] = useState(0);
  /** The item (a claim's or question's key) shown on its own. */
  const [detail, setDetail] = useState<string | null>(null);
  /** The claim (by key) a correction is being written for. */
  const [composing, setComposing] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ error: string | null } | null>(null);
  /** A context that's off for this chat (by name), shown on its own page: it can't be opened. */
  const [managing, setManaging] = useState<string | null>(null);
  /** Its details (`context_details`), or those of the open context's Settings tab. */
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
      take(await b.call<Activity | NoContext>("context_activity", { limit: 40, snapshot: true, ...(which ? { context: which } : {}) }));
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
      const d = await b.call<ContextDetails>("context_details", { name });
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
    <div className={`notice ${error ? "bad" : "ok"} item`} role={error ? "alert" : "status"}>
      <span className="grow wrap">{error ?? notice}</span>
      <button
        className="link"
        aria-label="Dismiss"
        onClick={() => {
          setError(null);
          setNotice(null);
        }}
      >
        ×
      </button>
    </div>
  );

  /** A step that takes the whole view: a title, what it's about, its body, and a way out. */
  const modal = (title: string, about: ReactNode, body: ReactNode, close?: { label: string; onClick: () => void }) => (
    <div className="stack lg">
      <div className="stack sm">
        <div className="spread">
          <h1 className="title wrap">{title}</h1>
          {close && <button onClick={close.onClick}>{close.label}</button>}
        </div>
        {about && <p className="wrap">{about}</p>}
      </div>
      {messages}
      {body}
    </div>
  );

  if (!ready && !a && !none) return <p className="faint">Loading the context…</p>;

  const here = none ?? a?.your_contexts ?? [];
  const using = a?.contexts ?? [];
  const inChat = (n: string) => using.find((c) => c.name === n);
  /** Turns a context on or off for this chat. */
  const toggle = (n: string) =>
    void (inChat(n)
      ? act("remove_context", { name: n }, `'${n}' is off for this chat. It stays on this machine.`)
      : act(using.length ? "add_context" : "use_context", { name: n }, `'${n}' is on for this chat.`));
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
  const writeHere = (n: string) => void act("add_context", { name: n, write_here: true }, `New items go to '${n}' unless another fits better.`);

  /** A context's pin: whether new chats started in this chat's folder (or below it) start with it. */
  const pin = (n: string) => {
    const f = a?.folder;
    if (!f) return null;
    const pinned = (f.pinned ?? []).includes(n);
    return (
      <button
        className="link pin"
        aria-pressed={pinned}
        onClick={() => void act("link_folder", pinned ? { name: n, off: true } : { name: n }, pinned ? `New chats in this folder no longer start with '${n}'.` : `New chats in this folder start with '${n}'.`)}
      >
        {pinned ? "📌 Pinned to " : "📌 Pin to "}
        <span className="faint">{tail(f.folder, 32)}</span>
      </button>
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
    return (
      <div className="stack lg">
        <div className="stack sm">
          <Heading>This chat</Heading>
          <div className="row">
            <Chip active={!!c} onClick={() => toggle(n)}>
              {c ? "◉ On" : "○ Off"}
            </Chip>
            {c && severalOn && !c.writes_here && <button onClick={() => writeHere(n)}>✎ Write here</button>}
            {c && !inTab && <button onClick={() => void show(n)}>Open</button>}
          </div>
          <Meta>
            {c
              ? severalOn
                ? c.writes_here
                  ? "Your agent reads it, and writes here when no other context clearly fits."
                  : "Your agent reads it, and writes here when its description fits."
                : "Your agent reads and writes here. Turning it off leaves it on this machine."
              : "Off for this chat. Turn it on to open it here, share it or change its settings."}
          </Meta>
          {pin(n)}
        </div>
        <div className="stack sm">
          <Heading>Sharing</Heading>
          {sharing === undefined ? (
            <p className="faint">Loading…</p>
          ) : (
            <p className="wrap">
              <span className={sharing ? "t-ok" : "t-warn"}>● </span>
              {sharing ? "Syncing" : "Offline"}
              {d && (
                <span className="muted">
                  {" "}
                  · {d.members} member{d.members === 1 ? "" : "s"}
                  {d.members > 1 ? ` · ${d.online} of the others online` : ""}
                  {d.open_invites ? ` · ${d.open_invites} join code${d.open_invites === 1 ? "" : "s"} waiting` : ""}
                </span>
              )}
              {sharing && relays !== undefined && (
                <span className="muted">
                  {" "}
                  · {relays} signalling relay{relays === 1 ? "" : "s"} reachable
                </span>
              )}
            </p>
          )}
          <Meta>
            {sharing === false
              ? "Your copy keeps working. What you write is sent when you’re back online."
              : relays === 0
                ? "No relay is reachable, so the others can’t find this machine right now."
                : "Every member keeps a full copy. Changes travel directly between your machines whenever you’re both online."}
          </Meta>
          {c && (
            <div className="row">
              {isAdmin && (
                <button
                  className="primary"
                  onClick={() => {
                    draft.current.invite = "";
                    if (inTab) setInviting("contributor");
                    else void share(n);
                  }}
                >
                  + Invite someone
                </button>
              )}
              {sharing !== undefined &&
                (sharing ? (
                  <button onClick={() => void act("stop_sharing", { context: n }, `'${n}' is offline: not syncing until you go online again.`)}>Go offline</button>
                ) : (
                  <button onClick={() => void act("start_sharing", { context: n }, `'${n}' is back online: syncing with the other members.`)}>Go online</button>
                ))}
            </div>
          )}
          {c && !isAdmin && <Meta>Only an admin can invite people.</Meta>}
        </div>
        <div className="stack sm">
          <Heading>About</Heading>
          {d ? (
            <>
              <dl className="kv">
                <dt>Your role</dt>
                <dd>{d.role ?? "removed (you keep your copy to read)"}</dd>
                <dt>Made by</dt>
                <dd>{d.yours ? "you" : (d.created_by ?? "unknown")}</dd>
                <dt>Holds</dt>
                <dd>
                  {count("Claim", "claim", "claims")} · {count("Question", "question", "questions")} · {count("Reply", "reply", "replies")}
                </dd>
                {d.held > 0 && (
                  <>
                    <dt>Not yet sent</dt>
                    <dd>{d.held} just written, still only on this machine</dd>
                  </>
                )}
              </dl>
              <Reveal label="Id, storage and history" hide="Hide id, storage and history">
                <dl className="kv">
                  <dt>Changes</dt>
                  <dd>
                    {d.changes} in all, withdrawn items included
                  </dd>
                  <dt>Id</dt>
                  <dd className="mono">{d.id ?? "none"}</dd>
                  <dt>Stored at</dt>
                  <dd className="mono">{d.stored_at}</dd>
                </dl>
              </Reveal>
            </>
          ) : (
            <p className="faint">{error ? "Couldn’t read its details." : "Loading…"}</p>
          )}
        </div>
        <div className="stack sm">
          <Heading>Delete</Heading>
          <Meta>Deletes this machine’s copy for good. Other members keep theirs. You’ll be asked to confirm.</Meta>
          <div className="row">
            <button
              className="danger"
              onClick={() => {
                draft.current.del = "";
                setDeleting({ name: n, error: null });
              }}
            >
              Delete from this machine…
            </button>
          </div>
        </div>
      </div>
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
      <div className="stack lg">
        <Card tone="warn">
          <div className="stack sm">
            {others === null ? (
              <p className="wrap">Other members keep their own copies. If you’re its only member, it’s gone for good.</p>
            ) : others > 0 ? (
              <p className="wrap">
                {others} other member{others === 1 ? " keeps their" : "s keep their"} own copy, and nothing is deleted for them. To get it back you’d need a new join code from one of its admins.
              </p>
            ) : (
              <p className="t-warn wrap">You’re its only member, so this is the only copy: once deleted, it’s gone for good.</p>
            )}
            {known?.yours && others !== null && others > 0 && (
              <p className="t-warn wrap">You made this context. The other members keep syncing with each other, but the join codes you made stop working.</p>
            )}
            {inChat(n) && <Meta>To only stop using it in this chat, turn it off instead: it stays on this machine.</Meta>}
          </div>
        </Card>
        <Field key={`delete-${n}`} label={`Type ${n} to confirm`} placeholder={n} autoFocus onInput={(v) => (draft.current.del = v)} onSubmit={confirm} />
        {deleting.error && <p className="t-bad wrap">{deleting.error}</p>}
        <div className="row">
          <button className="primary" onClick={close}>
            Keep it
          </button>
          <button className="danger" onClick={() => confirm(draft.current.del ?? "")}>
            Delete permanently
          </button>
        </div>
      </div>,
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
      void act(a ? "add_context" : "use_context", { name, description }, `Created '${name}'${a ? " and added it to this chat" : ""}. No one is invited yet: use Invite someone when you want to let a person in.`);
    };
    return modal(
      "Create a new context",
      "A context holds what a group knows, as claims and questions, shared with the people you invite.",
      <div className="stack lg">
        <Field label="Name" placeholder="e.g. checkout-incident" autoFocus help="Short: lower-case letters, digits and dashes." onInput={(v) => (draft.current.name = v)} onSubmit={create} />
        <Field
          label="What is it for?"
          placeholder="What goes in it, in a sentence or two"
          rows={3}
          help="Every member’s agent reads this to decide what belongs there. You can change it later."
          onInput={(v) => (draft.current.description = v)}
          onSubmit={create}
        />
        {creating.error && <p className="t-bad wrap">{creating.error}</p>}
        <div className="row">
          <button className="primary" onClick={create}>
            Create
          </button>
          <button onClick={close}>Cancel</button>
        </div>
        <Meta>It’s yours: you’re its admin, and it’s added to this chat. Invite people from its People tab, or with Share in the list.</Meta>
      </div>,
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
        <div className="stack lg">
          <div className="stack sm">
            <Heading>What it’s for</Heading>
            {description ? <p className="wrap">{description}</p> : <p className="faint wrap">No description yet, so agents won’t know what belongs here.</p>}
          </div>
          {settings(n, false)}
        </div>,
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
      <div className="stack">
        <div className="stack sm">
          <div className="row">
            <button
              className="primary"
              onClick={() => {
                draft.current.name = draft.current.description = "";
                setCreating({ error: null });
              }}
            >
              + Create new context
            </button>
          </div>
          <Meta>Got a join code? Paste it to your agent.</Meta>
        </div>
        {here.map((n) => {
          const c = inChat(n);
          return (
            <Card key={n} tone={c ? "accent" : undefined}>
              <div className="stack sm">
                <div className="item">
                  <div className="row grow">
                    <button className="link name" onClick={() => void (c ? show(n) : manage(n))}>
                      {n}
                    </button>
                    {c && <span className="muted">· {c.role ?? "removed"}</span>}
                    {c && many && c.writes_here && <span className="t-accent">✎ writes here</span>}
                  </div>
                  <Chip active={!!c} onClick={() => toggle(n)}>
                    {c ? "◉ On" : "○ Off"}
                  </Chip>
                </div>
                {c && <p className="faint wrap">{c.description ?? "No description yet"}</p>}
                <div className="row">
                  {c ? (
                    <>
                      <button onClick={() => void show(n)}>Open</button>
                      <button onClick={() => void settingsTab(n)}>Settings</button>
                    </>
                  ) : (
                    <button onClick={() => void manage(n)}>Settings</button>
                  )}
                  {c?.role === "admin" && <button onClick={() => void share(n)}>Share</button>}
                  {c && many && !c.writes_here && <button onClick={() => writeHere(n)}>✎ Write here</button>}
                </div>
                {pin(n)}
              </div>
            </Card>
          );
        })}
        {a?.folder && here.length > 0 && <Meta>📌 A pinned context is on in every new chat started in that folder, or below it. It’s kept on this machine: nothing is written into the folder.</Meta>}
      </div>,
      none ? undefined : { label: "Done", onClick: () => setSwitching(false) },
    );
  }

  if (!a) return <p className="notice bad">{trouble ?? "Couldn’t load the context."}</p>;

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
  const held = (n: GraphNode) => heldByNode.has(n.key) && <span className="t-warn"> · still only on this machine</span>;
  const undo = (n: GraphNode) => {
    const change = heldByNode.get(n.key);
    return (
      change && (
        <button className="primary" onClick={() => void act("take_back", { id: change.id, ...ctx }, "Taken back. It never left this machine.")}>
          Undo
        </button>
      )
    );
  };
  /** Withdraw, for its author or an admin, once it has been shared (before that, Undo). */
  const withdraw = (n: GraphNode) =>
    !heldByNode.has(n.key) &&
    !n.ended &&
    canWrite &&
    (isMine(n) || admin) && (
      <button
        onClick={() => {
          openItem(null);
          void act("withdraw", { id: n.key, ...ctx }, "Withdrawn. It stays in the history.");
        }}
      >
        Withdraw
      </button>
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
          if (v.trim() && v.trim() !== a.description) void act("describe_context", { description: v.trim(), ...ctx }, "Saved. Every member’s agent sees it.");
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
          if (v.trim() && v.trim() !== a.you.name) void act("set_my_name", { name: v.trim() }, `You're now ${v.trim()} in every context on this machine.`);
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
      <div className="stack">
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
      </div>,
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
      <div className="stack">
        <div className="field">
          <label htmlFor="invite-role">They can</label>
          <select id="invite-role" value={role} onChange={(e) => setInviting(e.currentTarget.value as Role)}>
            <option value="contributor">Read and add (contributor)</option>
            <option value="reader">Only read (reader)</option>
            <option value="admin">Read, add and invite (admin)</option>
          </select>
        </div>
        <Field
          label="Who is it for? (optional)"
          placeholder="e.g. Sam: shown when they join, so a code used by someone else stands out"
          autoFocus
          onInput={(v) => (draft.current.invite = v)}
          onSubmit={make}
        />
        <div className="row">
          <button className="primary" onClick={() => make(draft.current.invite ?? "")}>
            Make join code
          </button>
        </div>
        <Meta>This machine answers the code, so it must be online when they use it. Everyone in the context is told who joined.</Meta>
      </div>,
      { label: "Cancel", onClick: () => setInviting(null) },
    );
  }

  // Confirming a removal: only that.
  const leaving = confirmRemove ? a.people.find((p) => p.fingerprint === confirmRemove) : undefined;
  if (leaving)
    return modal(
      `Remove ${leaving.name}?`,
      `Every member’s machine stops syncing with ${leaving.name} and refuses their later changes. What they wrote stays, and they keep the copy they already had.`,
      <div className="row">
        <button
          className="primary"
          onClick={() => {
            setConfirmRemove(null);
            void act("remove_peer", { name: leaving.name, ...ctx }, `${leaving.name} was removed. They keep the copy they already had.`);
          }}
        >
          Remove {leaving.name}
        </button>
      </div>,
      { label: "Cancel", onClick: () => setConfirmRemove(null) },
    );

  // One item on its own: a question with its thread, or a claim with everything linked to it.
  const item = detail && rel ? rel.byKey.get(detail) : undefined;
  if (item && rel && t) {
    const back = { label: trail.current.length > 1 ? "‹ Back" : "‹ Back to the list", onClick: backItem };
    /** A linked item: its text, who and when, and a way to open it. */
    const related = (label: string, tone: Tone, n: GraphNode) => (
      <div key={`${label}-${n.key}`} className="item">
        <div className="grow">
          <p className={`wrap${n.label === "Claim" && !rel.current(n) ? " ended" : ""}`}>
            <span className={tone ? `t-${tone}` : "muted"}>{label} </span>
            {short(n.title, 300)}
          </p>
          <Meta>
            {byline(n)} · {n.key}
          </Meta>
        </div>
        <button onClick={() => openItem(n.key)}>Open</button>
      </div>
    );
    const group = (title: string, label: string, tone: Tone, list: GraphNode[]) =>
      list.length > 0 && (
        <div key={title} className="stack sm">
          <Heading count={list.length}>{title}</Heading>
          {list.map((n) => related(label, tone, n))}
        </div>
      );

    if (item.label === "Question") {
      const th = [...t.open, ...t.answered].find((x) => x.q.id === item.id);
      const answered = !!th?.answers.length;
      const open = !answered && !item.ended;
      return modal(
        item.ended ? "Withdrawn question" : answered ? "Answered question" : "Open question",
        item.title,
        <div className="stack">
          <Meta>
            asked by {byline(item)} · {item.key}
            {held(item)}
          </Meta>
          {group("It’s about", "→", undefined, rel.linked(item.id, "ABOUT", "out"))}
          {th && th.replies.length > 0 && (
            <div className="stack sm">
              <Heading count={th.replies.length}>Thread</Heading>
              {th.replies.map((r) => (
                <div key={r.key} className="item">
                  <div className="grow">
                    <p className="wrap">
                      <span className="muted">↳ </span>
                      {short(r.title, 600)}
                    </p>
                    <Meta>
                      {byline(r)}
                      {held(r)}
                    </Meta>
                  </div>
                  <div className="row">
                    {undo(r)}
                    {open && canWrite && <button onClick={() => void ask(answerPrompt(item, { reply: r }, named))}>Answer with this</button>}
                  </div>
                </div>
              ))}
            </div>
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
          <div className="row">
            {open && canWrite && <button onClick={() => void ask(prompts.investigate(item, named))}>Ask my agent to look into it</button>}
            <button onClick={() => void copy(`${item.title} (${item.key})`)}>Copy</button>
            {undo(item)}
            {withdraw(item)}
          </div>
          {open && <Meta>Agents reply on the thread. Your answer goes to your agent, which records it as a claim that answers the question.</Meta>}
        </div>,
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
      <div className="stack">
        <p className={`wrap${rel.current(item) ? "" : " ended"}`}>{item.title}</p>
        <div>
          <Meta>
            recorded by {byline(item)} · {item.key}
            {held(item)}
          </Meta>
          {prop(item, "source") && <Meta>Source: {prop(item, "source")}</Meta>}
          {(from || to) && <Meta>About {from && to ? `${from.slice(0, 10)} to ${to.slice(0, 10)}` : from ? `${from.slice(0, 10)} onwards` : `up to ${to.slice(0, 10)}`}</Meta>}
          {item.ended && (
            <p className="faint t-warn wrap">
              Withdrawn{prop(item, "withdrawn_by") ? ` by ${prop(item, "withdrawn_by")}` : ""}
              {prop(item, "withdrawn_at") ? ` · ${ago(prop(item, "withdrawn_at"), now)}` : ""}
              {prop(item, "withdraw_reason") ? `: ${prop(item, "withdraw_reason")}` : ""}
            </p>
          )}
        </div>
        {newer && group("Replaced by", "↑", "ok", [newer])}
        {group("Can’t be true alongside", "⚡", "warn", contradicts)}
        {group("Answers", "?", undefined, rel.linked(item.id, "ANSWERS", "out"))}
        {group("Evidence for it", "+", "ok", rel.linked(item.id, "SUPPORTS", "in"))}
        {group("It’s evidence for", "→", undefined, rel.linked(item.id, "SUPPORTS", "out"))}
        {group("Earlier versions", "↓", undefined, rel.linked(item.id, "REPLACES", "out"))}
        {group("Questions about it", "?", "warn", rel.linked(item.id, "ABOUT", "in"))}
        <div className="row">
          {rel.current(item) && canWrite && !heldByNode.has(item.key) && (
            <button className="primary" onClick={() => setComposing(item.key)}>
              Correct it
            </button>
          )}
          <button onClick={() => void copy(`${item.title} (${item.key})`)}>Copy</button>
          {undo(item)}
          {withdraw(item)}
        </div>
        {rel.current(item) && canWrite && <Meta>Correct it when it’s wrong or out of date: the new claim replaces this one, which stays in the history. Withdraw it when it should never have been recorded.</Meta>}
      </div>,
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
  const setFilter = (patch: Partial<Filters>) => {
    setMore(0);
    setFilters((v) => ({ ...v, ...patch }));
  };
  const members = a.people.filter((p) => p.role);
  const counts: Record<Tab, number | undefined> = { overview: undefined, questions: t?.open.length, claims: t?.claims.length, people: members.length, settings: undefined };
  const goOnline = (
    <button className="primary" onClick={() => void act("start_sharing", { ...ctx }, "Back online: syncing with the other members.")}>
      Go online
    </button>
  );
  // The latest news from someone else: what their changes meant for you if that's newest, else their latest change.
  const digest = a.digest?.at(-1);
  const latest = a.recent.find((c) => !c.mine && !c.held && c.kind !== "create");
  const news = digest?.lines[0] && (!latest || digest.at >= latest.at) ? `${short(digest.lines[0], 90)} (${ago(digest.at, now)})` : latest ? `${latest.by} ${short(latest.summary, 80)} (${ago(latest.at, now)})` : "";

  const header = (
    <div className="stack sm">
      <div className="spread">
        <h1 className="title wrap">{a.context}</h1>
        <button onClick={() => setSwitching(true)}>{many ? `⇄ ${a.contexts.length} contexts` : "⇄ Contexts"}</button>
      </div>
      {many && (
        <div className="row">
          {a.contexts.map((c) => (
            <Chip key={c.name} active={c.name === a.context} onClick={() => void view(c.name)}>
              {c.name}
              {c.writes_here ? " ✎" : ""}
            </Chip>
          ))}
        </div>
      )}
      <div className="item">
        {a.description ? <p className="grow wrap">{a.description}</p> : <p className="grow faint wrap">No description yet{admin ? "" : ": an admin can add one"}, so agents won’t know what belongs here.</p>}
        {admin && (
          <button className="link" aria-label="Edit description" onClick={() => setEditing(true)}>
            ✎
          </button>
        )}
      </div>
      <div className="row who">
        <span className={a.sharing ? "t-ok" : "t-warn"} title={a.sharing ? `Syncing with the other members · ${a.relays_up} signalling relay${a.relays_up === 1 ? "" : "s"} reachable` : "Not syncing: what you write stays on this machine until you go online"}>
          {a.sharing ? "⇅ Syncing" : "● Offline"}
        </span>
        <button className="link" onClick={() => void act(a.sharing ? "stop_sharing" : "start_sharing", { ...ctx }, a.sharing ? "Offline: not syncing until you go online again." : "Back online: syncing with the other members.")}>
          {a.sharing ? "Go offline" : "Go online"}
        </button>
        <span className="faint" aria-hidden="true">
          |
        </span>
        {members.map((p) => (
          <span
            key={p.fingerprint}
            className={p.online ? "on" : ""}
            title={`${p.name} · ${p.role}${p.creator ? " · made this context" : ""} · ${p.online ? "online now" : "offline"} · key ${p.fingerprint}${p.agent ? ` · ${p.agent}` : ""}${p.platform ? ` · ${p.platform}` : ""}`}
          >
            <span className={p.online ? "t-ok" : ""}>●</span> {p.name}
            {p.you ? " (you)" : ""}
          </span>
        ))}
      </div>
      {news && <Meta>Latest: {news}</Meta>}
      <div className="tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.tab} role="tab" aria-selected={tab === x.tab} onClick={() => setTab(x.tab)}>
            {x.label}
            {counts[x.tab] !== undefined ? ` ${counts[x.tab]}` : ""}
          </button>
        ))}
      </div>
      {trouble && <p className="notice bad wrap">{trouble}</p>}
      {messages}
    </div>
  );

  /** The filter box above a list, and what it's filtering by. */
  const filterBox = (what: string) => (
    <div className="stack sm">
      <Field key={`filter-${tab}-${f.text}`} value={f.text} placeholder={`Filter ${what} by words, a person or an id`} submit="Filter" onSubmit={(v) => setFilter({ text: v.trim() })} />
      {f.text && (
        <div className="row">
          <span className="faint">
            Showing {what} matching “{short(f.text, 40)}”
          </span>
          <button className="link" onClick={() => setFilter({ text: "" })}>
            × Clear
          </button>
        </div>
      )}
    </div>
  );
  /** The first page of a list, and a button for the rest. */
  const paged = <T,>(list: T[]) => list.slice(0, PAGE + more);
  const showMore = (total: number) =>
    total > PAGE + more && (
      <button className="link more" onClick={() => setMore((n) => n + PAGE)}>
        Show {Math.min(PAGE, total - PAGE - more)} more of {total}
      </button>
    );

  let body: ReactNode;
  if (!snap || !t || !rel) body = <p className="faint">Loading…</p>;
  else if (tab === "overview") {
    const heldMine = a.recent.filter((c) => c.held && c.mine);
    const waiting = t.open.filter((th) => th.replies.length);
    const mineOpen = t.open.filter((th) => isMine(th.q) && th.replies.length);
    const need = (key: string, tone: Tone, text: ReactNode, button: ReactNode) => (
      <Card key={key} tone={tone}>
        <div className="item center">
          <span className="grow wrap">{text}</span>
          {button}
        </div>
      </Card>
    );
    const needs = [
      !a.sharing && need("offline", "warn", "You’re offline: what you write stays on this machine, and you don’t see what others add, until you’re back.", goOnline),
      a.sharing && a.relays_up === 0 && need("relays", "warn", "No signalling relay is reachable, so the other members can’t find this machine right now.", null),
      rel.conflicts.length > 0 &&
        need(
          "conflicts",
          "warn",
          `⚡ ${rel.conflicts.length} pair${rel.conflicts.length === 1 ? "" : "s"} of claims can’t both be true. Someone needs to say which stands.`,
          <button className="primary" onClick={() => setTab("claims", { text: "", claims: "conflicts" })}>
            Settle
          </button>,
        ),
      mineOpen.length > 0 &&
        need(
          "replies",
          "accent",
          `↳ ${mineOpen.length} of your questions ${mineOpen.length === 1 ? "has" : "have"} replies: ${short(mineOpen[0]!.q.title, 80)}`,
          <button className="primary" onClick={() => openItem(mineOpen[0]!.q.key)}>
            Read
          </button>,
        ),
      t.open.length > 0 &&
        need(
          "questions",
          undefined,
          `❓ ${t.open.length} open question${t.open.length === 1 ? "" : "s"}${waiting.length ? `, ${waiting.length} with replies` : ""}.`,
          <button onClick={() => setTab("questions", { text: "", questions: "open" })}>See</button>,
        ),
      admin &&
        !a.description &&
        need(
          "describe",
          "accent",
          "This context has no description, so agents can’t tell what belongs in it.",
          <button className="primary" onClick={() => setEditing(true)}>
            Describe
          </button>,
        ),
      admin &&
        members.length === 1 &&
        !invites.length &&
        need(
          "alone",
          "accent",
          "It’s just you here so far.",
          <button className="primary" onClick={() => setInviting("contributor")}>
            Invite someone
          </button>,
        ),
      invites.length > 0 && need("invites", undefined, `${invites.length} join code${invites.length === 1 ? " is" : "s are"} waiting to be used.`, <button onClick={() => setTab("people")}>See</button>),
    ].filter(Boolean);
    body = (
      <div className="stack">
        {heldMine.length > 0 && (
          <Card tone="warn">
            <div className="stack sm">
              <p className="t-warn">Just written, still only on this machine:</p>
              {heldMine.map((c) => (
                <div key={c.id} className="item center">
                  <span className="grow wrap">{short(c.summary, 140)}</span>
                  <button className="primary" onClick={() => void act("take_back", { id: c.id, ...ctx }, "Taken back. It never left this machine.")}>
                    Undo
                  </button>
                </div>
              ))}
            </div>
          </Card>
        )}
        <Heading count={needs.length || undefined}>Needs you</Heading>
        {needs.length ? (
          <Folded list={needs} first={3} what="things" one="thing" render={(x) => x} />
        ) : (
          <Card tone="ok">
            <span className="t-ok">✓ Nothing needs you right now.</span>
          </Card>
        )}
        {digest && digest.lines.length > 0 && (
          <>
            <Heading>What changed for you</Heading>
            <Card tone="accent">
              <div className="stack sm">
                <Folded
                  list={digest.lines.map((line, i) => ({ line, i }))}
                  first={3}
                  what="changes"
                  one="change"
                  render={({ line, i }) => (
                    <p key={i} className="wrap">
                      {line}
                    </p>
                  )}
                />
                <Meta>{ago(digest.at, now)}</Meta>
              </div>
            </Card>
          </>
        )}
        <Heading>Ask your agent</Heading>
        <div className="row">
          <button onClick={() => void ask(prompts.catchUp(a.context))}>Catch me up</button>
          {canWrite && <button onClick={() => void ask(prompts.saveChat(a.context))}>Save what this chat learned</button>}
        </div>
        <Heading>Recent activity</Heading>
        {!a.recent.length && <Meta>Nothing yet. What your agent and the other members’ agents record shows up here.</Meta>}
        <Folded
          list={a.recent}
          first={RECENT}
          what="changes"
          one="change"
          render={(c: Change) => (
            <div key={c.id} className="item">
              <div className="grow">
                <p className="wrap">
                  <span className="muted">{ICON[c.kind] ?? "·"} </span>
                  <strong>{c.mine ? "you" : c.by}</strong> {short(c.summary, 200)}
                </p>
                <Meta>
                  {ago(c.at, now)}
                  {c.held && <span className="t-warn"> · still only on this machine</span>}
                </Meta>
              </div>
              {c.node && rel.byKey.has(c.node) && <button onClick={() => openItem(c.node)}>Open</button>}
            </div>
          )}
        />
        <Meta>
          {t.claims.length} claim{t.claims.length === 1 ? "" : "s"} · {t.open.length} open and {t.answered.length} answered question{t.answered.length === 1 ? "" : "s"} · {rel.history.length} replaced or withdrawn · {a.changes} changes in all
          {snap.truncated ? " · showing the latest items only" : ""}
        </Meta>
      </div>
    );
  } else if (tab === "questions") {
    const scopes = { open: t.open, answered: t.answered, mine: [...t.open, ...t.answered].filter((th) => isMine(th.q)) };
    const scope = f.questions in scopes ? f.questions : "open";
    const list = scopes[scope].filter((th) => matches(th.q, f.text) || th.replies.some((r) => matches(r, f.text)) || th.answers.some((c) => matches(c, f.text)));
    const question = (th: Thread) => {
      const q = th.q;
      const answered = th.answers.length > 0;
      return (
        <Card key={q.key} tone={heldByNode.has(q.key) ? "warn" : answered ? "ok" : undefined}>
          <div className="stack sm">
            <div className="item">
              <div className="grow">
                <p className="wrap">
                  <strong>{short(q.title, 300)}</strong>
                </p>
                <Meta>
                  asked by {byline(q)}
                  {th.replies.length ? ` · ${th.replies.length} repl${th.replies.length === 1 ? "y" : "ies"}` : ""}
                  {held(q)}
                </Meta>
              </div>
              <div className="row">
                {undo(q)}
                {answered || !canWrite ? (
                  <button onClick={() => openItem(q.key)}>Open</button>
                ) : (
                  <button className="primary" onClick={() => openItem(q.key)}>
                    Answer
                  </button>
                )}
              </div>
            </div>
            <Folded
              list={th.replies}
              first={2}
              latest
              what="replies"
              one="reply"
              render={(r) => (
                <div key={r.key} className="reply">
                  <p className="wrap">
                    <span className="muted">↳ </span>
                    {short(r.title, 240)}
                  </p>
                  <Meta>
                    {byline(r)}
                    {held(r)}
                  </Meta>
                </div>
              )}
            />
            {th.answers.map((c) => (
              <div key={c.key} className="reply">
                <p className="wrap">
                  <span className="t-ok">✓ </span>
                  {short(c.title, 300)}
                </p>
                <Meta>answered by {byline(c)}</Meta>
              </div>
            ))}
          </div>
        </Card>
      );
    };
    body = (
      <div className="stack">
        <div className="row">
          <Chip active={scope === "open"} onClick={() => setFilter({ questions: "open" })}>
            Open {t.open.length}
          </Chip>
          <Chip active={scope === "answered"} onClick={() => setFilter({ questions: "answered" })}>
            Answered {t.answered.length}
          </Chip>
          <Chip active={scope === "mine"} onClick={() => setFilter({ questions: "mine" })}>
            Mine {scopes.mine.length}
          </Chip>
        </div>
        {filterBox("questions")}
        {!list.length && (
          <p className="empty">
            {f.text
              ? "No questions match."
              : scope === "open"
                ? t.answered.length
                  ? "✓ Every question has an answer."
                  : "No questions yet. When your agent records something the group needs to find out, it shows up here with its thread."
                : scope === "answered"
                  ? "No question has been answered yet."
                  : "You haven’t asked anything here yet."}
          </p>
        )}
        {paged(list).map(question)}
        {showMore(list.length)}
        <Meta>Agents ask and reply. Answer gives your agent your answer, and it records it as a claim.</Meta>
      </div>
    );
  } else if (tab === "claims") {
    const scopes = { current: t.claims, mine: t.claims.filter(isMine), conflicts: t.claims.filter((n) => rel.inConflict.has(n.id)), history: rel.history };
    const scope = f.claims in scopes ? f.claims : "current";
    const list = scopes[scope].filter((n) => matches(n, f.text));
    const pairs = scope === "history" ? [] : rel.conflicts.filter(([x, y]) => matches(x, f.text) || matches(y, f.text));
    const side = (keep: GraphNode, drop: GraphNode) => (
      <div className="item">
        <div className="grow">
          <p className="wrap">{short(keep.title, 300)}</p>
          <Meta>
            {byline(keep)} · {keep.key}
          </Meta>
        </div>
        <div className="row">
          {canWrite && <button onClick={() => void ask(prompts.settle(keep, drop, named))}>Keep this one</button>}
          <button onClick={() => openItem(keep.key)}>Open</button>
        </div>
      </div>
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
      <div className="stack">
        <div className="row">
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
        </div>
        {filterBox("claims")}
        {pairs.map(([x, y]) => (
          <Card key={`${x.key}-${y.key}`} tone="warn">
            <div className="stack sm">
              <strong className="t-warn">⚡ These can’t both be true</strong>
              {side(x, y)}
              <span className="faint">— or —</span>
              {side(y, x)}
            </div>
          </Card>
        ))}
        {scope === "conflicts" && !pairs.length && (
          <Card tone="ok">
            <span className="t-ok">✓ No claims contradict each other.</span>
          </Card>
        )}
        {scope !== "conflicts" && !list.length && (
          <p className="empty">
            {f.text
              ? "No claims match."
              : scope === "current"
                ? "No claims yet. What your agent records as true shows up here. Try “Save what this chat learned” on the Overview."
                : scope === "mine"
                  ? "None of the current claims are yours."
                  : "Nothing has been replaced or withdrawn."}
          </p>
        )}
        {scope !== "conflicts" &&
          paged(list).map((n) => {
            const newer = rel.replacedBy.get(n.id);
            return (
              <Card key={n.key} tone={heldByNode.has(n.key) || rel.inConflict.has(n.id) ? "warn" : undefined}>
                <div className="item">
                  <div className="grow">
                    <p className={`wrap${scope === "history" ? " ended" : ""}`}>
                      {rel.inConflict.has(n.id) && <span className="t-warn">⚡ </span>}
                      {short(n.title, 300)}
                    </p>
                    <Meta>
                      {byline(n)}
                      {scope === "history"
                        ? n.ended
                          ? ` · withdrawn${prop(n, "withdrawn_by") ? ` by ${prop(n, "withdrawn_by")}` : ""}${prop(n, "withdraw_reason") ? `: ${short(prop(n, "withdraw_reason"), 80)}` : ""}`
                          : newer
                            ? ` · replaced by ${newer.key}: ${short(newer.title, 80)}`
                            : ""
                        : badges(n)}
                      {held(n)}
                    </Meta>
                  </div>
                  <div className="row">
                    {undo(n)}
                    <button onClick={() => openItem(n.key)}>Open</button>
                  </div>
                </div>
              </Card>
            );
          })}
        {scope !== "conflicts" && showMore(list.length)}
        {scope === "history" && <Meta>Nothing is deleted: replaced and withdrawn claims stay, so anyone can see what the group believed before.</Meta>}
      </div>
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
      <Card key={p.fingerprint} tone={p.you ? "accent" : undefined}>
        <div className="item center">
          <div className="grow">
            <p>
              <span className={p.online ? "t-ok" : "muted"}>●</span> <strong className={p.role ? "" : "muted"}>{p.name}</strong>
              <span className="muted">
                {p.you ? " (you)" : ""} · {p.role ?? "removed"}
                {p.creator ? " · made this context" : ""}
                {p.role ? (p.online ? " · online" : " · offline") : ""}
              </span>
            </p>
            <Meta>{wrote(p)}</Meta>
            <Reveal label="Key and agent" hide="Hide key and agent">
              <p className="faint mono wrap">
                {p.fingerprint}
                {p.agent ? ` · ${p.agent}` : ""}
                {p.platform ? ` · ${p.platform}` : ""}
              </p>
            </Reveal>
          </div>
          <div className="row">
            {p.you && <button onClick={() => setRenaming(true)}>✎ Rename</button>}
            {admin && !p.creator && !p.you && p.role && (
              <>
                <select aria-label={`Role of ${p.name}`} value={p.role} onChange={(e) => void act("set_peer_role", { name: p.name, role: e.currentTarget.value, ...ctx }, `${p.name} is now ${e.currentTarget.value}.`)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button onClick={() => setConfirmRemove(p.fingerprint)}>Remove</button>
              </>
            )}
          </div>
        </div>
      </Card>
    );
    body = (
      <div className="stack">
        <Heading count={members.length}>Members</Heading>
        {members.map(person)}
        {admin && (
          <Card tone="accent">
            <div className="stack">
              <div className="spread">
                <span>
                  <strong>Join codes</strong>
                  <span className="muted"> {invites.length ? `${invites.length} waiting` : "none waiting"}</span>
                </span>
                <button className="primary" onClick={() => setInviting("contributor")}>
                  + Invite someone
                </button>
              </div>
              {invites.length === 0 ? (
                <Meta>Each code lets one person in: whoever uses it first. Codes stay here until they’re used, cancelled or expire.</Meta>
              ) : (
                invites.map((i) => {
                  const hours = Math.round(Math.max(0, Date.parse(i.expires_at) - now) / 3600_000);
                  return (
                    <div key={i.id} className="stack sm">
                      <div className="spread">
                        <span>
                          <strong>{i.label ? `For ${i.label.replace(/^for\s+/i, "")}` : "No note"}</strong>
                          <span className="muted">
                            {" "}
                            · {i.role} · {hours >= 1 ? `expires in ${hours}h` : "expires soon"}
                          </span>
                          {i.id === made && <span className="t-ok"> · new: send it now</span>}
                        </span>
                        <button onClick={() => void act("revoke_invite", { id: i.id, ...ctx }, "Cancelled: that code no longer works.")}>Cancel</button>
                      </div>
                      <div className="linkbox">
                        <input readOnly value={sendLine(i.code)} onFocus={(e) => e.currentTarget.select()} aria-label="Message to send" />
                        <button onClick={() => void copy(sendLine(i.code), "Copied: send it privately, to that one person.")}>Copy</button>
                      </div>
                    </div>
                  );
                })
              )}
              {!a.sharing && invites.length > 0 && <p className="t-warn">You’re offline, so these codes won’t work until you go online.</p>}
            </div>
          </Card>
        )}
        {gone.length > 0 && <Heading count={gone.length}>Removed</Heading>}
        {gone.map(person)}
      </div>
    );
  }

  return (
    <div className="stack lg">
      {header}
      {body}
    </div>
  );
}
