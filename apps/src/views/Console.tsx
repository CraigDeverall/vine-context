// The sharing console: everyone in the graph (key fingerprint, agent, role,
// online or not), whether this machine is syncing, the signalling relays, and
// (for admins) the join codes this machine answers.

import { useCallback, useEffect, useState } from "react";
import { asks, copyText, usePoll, when, type Bridge } from "../bridge";

type Role = "reader" | "contributor" | "admin";
interface Invite {
  id: string;
  label: string | null;
  role?: Role;
  state: "open" | "used" | "expired" | "revoked";
  code: string | null;
  for: { name: string; since: string } | null;
  created_at: string;
  expires_at: string | null;
}
interface Person {
  name: string;
  role: Role | null;
  you?: boolean;
  creator?: boolean;
  online: boolean;
  fingerprint: string;
  joined_at?: string;
  removed_at?: string | null;
  invite?: { id: string; label: string | null } | null;
  agent?: string | null;
  platform?: string | null;
  vine?: string | null;
}
interface State {
  using: string;
  graph: string;
  host: string | null;
  sharing: boolean;
  can_invite: boolean;
  invites: Invite[];
  links: { name: string; fingerprint: string; state: string; since: string; route?: "direct" | "relayed" }[];
  ice?: { stun: string[]; turn: string | null; source: "default" | "setting" | "env"; problem?: string };
  relays: Record<string, string>;
  people: Person[];
  log: { changes: number; held: number; refused: number };
  you: { name: string; role: Role | null; fingerprint: string; name_from: "VINE_USER" | "set_my_name" | "git" | "login" };
}

const ROLES: Role[] = ["reader", "contributor", "admin"];
const ROLE_HELP: Record<Role, string> = {
  reader: "search and read",
  contributor: "also add and link",
  admin: "also withdraw anyone's items",
};

function RolePicker({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Role)} aria-label="Role">
      {ROLES.map((r) => (
        <option key={r} value={r} title={ROLE_HELP[r]}>
          {r}
        </option>
      ))}
    </select>
  );
}

export function Console({ b }: { b: Bridge }) {
  const [state, setState] = useState<State | undefined>(b.data as State | undefined);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [label, setLabel] = useState("");
  // What the next join code lets its person do: chosen each time, never assumed.
  const [role, setRole] = useState<Role>("contributor");
  const [naming, setNaming] = useState<string>();
  const saveName = async () => {
    await act("name", "set_my_name", { name: naming!.trim() });
    setNaming(undefined);
  };

  useEffect(() => {
    if (b.data) setState(b.data as State);
  }, [b.data]);

  const refresh = useCallback(async () => {
    // Where the host doesn't pass tool calls on, this view can't refresh: it shows what it was opened with.
    if (!b.canCall) return;
    try {
      setState(await b.call<State>("open_console"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [b]);
  usePoll(refresh, 2500, [refresh]);

  const act = async (label: string, tool: string, args: Record<string, unknown> = {}) => {
    setBusy(label);
    setError(undefined);
    try {
      if ((await b.run(tool, args, asks(tool, args))) === "called") await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (!state) return <p className="faint">Loading…</p>;

  const sendLine = (code: string) => `Join my context graph: /vine-context:join ${code}`;
  const copy = async (inv: Invite) => {
    if (!inv.code) return;
    if (await copyText(sendLine(inv.code))) {
      setCopied(inv.id);
      setTimeout(() => setCopied(undefined), 1500);
    } else {
      (document.getElementById(`vine-code-${inv.id}`) as HTMLInputElement | null)?.select();
    }
  };
  const invite = async () => {
    await act("invite", "share_context", { ...(label.trim() ? { label: label.trim() } : {}), role });
    setLabel("");
  };
  const open = state.invites.filter((i) => i.state === "open");
  const used = state.invites.filter((i) => i.state === "used");
  const members = state.people.filter((p) => !p.you && !p.removed_at);
  const admin = state.you.role === "admin";
  const relays = Object.values(state.relays ?? {});
  const relaysUp = relays.filter((r) => r === "open").length;
  const relayed = (state.links ?? []).filter((l) => l.route === "relayed").length;

  return (
    <div>
      <div className="head">
        <div className="row">
          <span className={`dot ${state.sharing ? "on" : ""}`} aria-hidden />
          <h1>
            {state.sharing ? "Syncing" : "Offline"} <span className="muted">{state.using}</span>
          </h1>
        </div>
        {state.sharing ? (
          <button className="danger" disabled={!!busy} onClick={() => act("unshare", "stop_sharing")}>
            Go offline
          </button>
        ) : admin ? (
          <button className="primary" disabled={!!busy} onClick={() => act("share", "start_sharing")}>
            Go online
          </button>
        ) : null}
      </div>
      <p className="faint">
        Your copy holds {state.log.changes} changes
        {state.log.held ? `; ${state.log.held} still on this machine (Undo possible)` : ""}.{" "}
        {state.sharing && relays.length > 0 && `Signalling relays: ${relaysUp} of ${relays.length} connected.`}
        {state.sharing && relays.length > 0 && relaysUp === 0 && " None are reachable: other members can't find you until one is."}
        {state.sharing && state.ice?.turn && ` TURN server: ${state.ice.turn}${state.ice.problem ? ` (not in use: ${state.ice.problem})` : relayed ? `, carrying ${relayed} of ${state.links.length} connections` : ""}.`}
      </p>

      <div className="you">
        {naming === undefined ? (
          <p>
            People see you as <strong>{state.you.name}</strong> <span className="fp">{state.you.fingerprint}</span>
            {state.you.role ? <span className="faint"> ({state.you.role})</span> : <span className="faint"> (removed: read only)</span>}{" "}
            {state.you.name_from !== "VINE_USER" && (
              <button className="link" onClick={() => setNaming(state.you.name)}>
                Change
              </button>
            )}
            <span className="faint">
              {" "}
              {state.you.name_from === "git" ? "(from git's user.name)" : state.you.name_from === "login" ? "(your login name)" : state.you.name_from === "VINE_USER" ? "(set by VINE_USER)" : ""}
            </span>
          </p>
        ) : (
          // Not a <form>: views run sandboxed without allow-forms, which blocks submits.
          <div className="row" role="group" aria-label="Change your name">
            <label htmlFor="vine-name">Your name</label>
            <input
              id="vine-name"
              value={naming}
              maxLength={40}
              onInput={(e) => setNaming(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && naming.trim()) void saveName();
                if (e.key === "Escape") setNaming(undefined);
              }}
              autoFocus
            />
            <button className="primary" type="button" onClick={() => void saveName()} disabled={!!busy || !naming.trim()}>
              Save
            </button>
            <button type="button" onClick={() => setNaming(undefined)}>
              ‹ Cancel
            </button>
          </div>
        )}
      </div>

      {state.sharing && admin && (
        <>
          <h2>Invites</h2>
          <p className="faint">
            Each join code is for one person: the first machine to use it gets in, with a full copy of the graph. This machine answers it, so it must be online then. An unused code expires. Send it privately.
          </p>
          {open.length === 0 && <p className="empty">No open join codes.</p>}
          <div className="list">
            {open.map((i) => (
              <div className="card" key={i.id}>
                <div className="spread">
                  <span>
                    <strong>{i.label ?? "Join code"}</strong> <span className="faint">expires {when(i.expires_at!)}</span>
                  </span>
                  <button disabled={!!busy} onClick={() => act(`cancel ${i.id}`, "revoke_invite", { id: i.id })}>
                    Cancel
                  </button>
                </div>
                <div className="linkbox">
                  <input id={`vine-code-${i.id}`} readOnly value={sendLine(i.code!)} onFocus={(e) => e.currentTarget.select()} aria-label="Message to send" />
                  <button onClick={() => void copy(i)}>{copied === i.id ? "Copied" : "Copy"}</button>
                </div>
              </div>
            ))}
          </div>
          {/* Not a <form>: views run sandboxed without allow-forms, which blocks submits. */}
          <div className="row" role="group" aria-label="New join code" style={{ marginTop: 8 }}>
            <input
              value={label}
              maxLength={60}
              placeholder="Who it's for (optional)"
              aria-label="Who the code is for"
              onInput={(e) => setLabel(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && void invite()}
            />
            <select value={role} aria-label="What they can do" onChange={(e) => setRole(e.currentTarget.value as typeof role)}>
              <option value="contributor">Read and add (contributor)</option>
              <option value="reader">Only read (reader)</option>
              <option value="admin">Read, add and invite (admin)</option>
            </select>
            <button disabled={!!busy} onClick={() => void invite()}>
              New join code
            </button>
          </div>
          {used.length > 0 && (
            <p className="faint">
              In use: {used.map((i) => `${i.label ? `${i.label}: ` : ""}${i.for!.name}`).join(", ")}
            </p>
          )}
        </>
      )}

      <h2>
        People <span className="faint">{members.filter((p) => p.online).length} online</span>
      </h2>
      {members.length === 0 ? (
        <p className="empty">{admin ? "No one else is in this graph yet. Whoever uses a code first is let in, and everyone is told." : "No one else is in this graph."}</p>
      ) : (
        <table>
          <tbody>
            {members.map((p) => (
              <tr key={p.name}>
                <td>
                  <span className={`dot ${p.online ? "on" : ""}`} aria-hidden /> <strong>{p.name}</strong>
                  {p.creator && <span className="faint"> (made this graph)</span>}
                  <div className="faint">
                    {[p.agent, p.platform, p.invite?.label && `via '${p.invite.label}'`, p.joined_at && `joined ${when(p.joined_at)}`].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td>
                  <span className="fp">{p.fingerprint}</span>
                </td>
                <td>
                  {admin && !p.creator ? (
                    <RolePicker value={p.role ?? "reader"} disabled={!!busy} onChange={(r) => act(`role ${p.name}`, "set_peer_role", { name: p.name, role: r })} />
                  ) : (
                    p.role
                  )}
                </td>
                <td>
                  {admin && !p.creator && (
                    <button className="danger" disabled={!!busy} onClick={() => act(`remove ${p.name}`, "remove_peer", { name: p.name })}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}
