// The sharing console. As host: the link, who is waiting (with the key
// fingerprint to check), who is connected, and their roles. As a peer: your
// connection to someone else's graph.

import { useCallback, useEffect, useState } from "react";
import { usePoll, when, type Bridge } from "../bridge";

type Role = "reader" | "contributor" | "admin";
interface Peer {
  name: string;
  fingerprint: string;
  role?: Role;
  since?: string;
  approved_at?: string;
}
interface HostState {
  mode: "host";
  using: string;
  graph: string;
  host: string;
  sharing: boolean;
  link: string | null;
  connected: Peer[];
  waiting: Peer[];
  approved: Peer[];
  you: { name: string; fingerprint: string; name_from: "P2PCG_USER" | "set_my_name" | "git" | "login" };
}
interface PeerState {
  mode: "peer";
  using: string;
  host: string | null;
  graph: string | null;
  state: "connecting" | "pending" | "active" | "denied" | "closed";
  reason: string | null;
  role: Role | null;
  you: { name: string; fingerprint: string };
}
type State = HostState | PeerState;

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
  const [copied, setCopied] = useState(false);
  const [pick, setPick] = useState<Record<string, Role>>({});
  const [naming, setNaming] = useState<string>();
  const saveName = async () => {
    await act("name", "set_my_name", { name: naming!.trim() });
    setNaming(undefined);
  };

  useEffect(() => {
    if (b.data) setState(b.data as State);
  }, [b.data]);

  const refresh = useCallback(async () => {
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
      await b.call(tool, args);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (!state) return <p className="faint">Loading…</p>;

  if (state.mode === "peer") {
    const tone = state.state === "active" ? "ok" : state.state === "pending" || state.state === "connecting" ? "warn" : "bad";
    return (
      <div>
        <div className="head">
          <h1>{state.host ? `${state.host}'s graph` : "Joining a graph"}</h1>
          <span className={`pill ${tone}`}>{state.state === "active" ? `joined as ${state.role}` : state.state}</span>
        </div>
        {state.state === "pending" && (
          <p className="notice">
            Waiting for {state.host ?? "the host"} to approve you. Tell them your name and fingerprint so they can check it's you.
          </p>
        )}
        {state.reason && state.state !== "active" && <p className="notice bad">{state.reason}</p>}
        <h2>You</h2>
        <dl className="kv">
          <dt>Name</dt>
          <dd>{state.you.name}</dd>
          <dt>Fingerprint</dt>
          <dd>
            <span className="fp">{state.you.fingerprint}</span>
          </dd>
          {state.graph && (
            <>
              <dt>Graph</dt>
              <dd>{state.graph}</dd>
            </>
          )}
        </dl>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="danger" disabled={!!busy} onClick={() => act("leave", "leave_graph")}>
            Leave and go back to my graph
          </button>
        </div>
        {error && <p className="notice bad">{error}</p>}
      </div>
    );
  }

  const copy = async () => {
    if (!state.link) return;
    try {
      await navigator.clipboard.writeText(state.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      (document.getElementById("p2pcg-link") as HTMLInputElement | null)?.select();
    }
  };
  const offline = state.approved.filter((a) => !state.connected.some((c) => c.name === a.name));

  return (
    <div>
      <div className="head">
        <div className="row">
          <span className={`dot ${state.sharing ? "on" : ""}`} aria-hidden />
          <h1>
            {state.sharing ? "Sharing" : "Not sharing"} <span className="muted">graph '{state.graph}'</span>
          </h1>
        </div>
        {state.sharing ? (
          <button className="danger" disabled={!!busy} onClick={() => act("unshare", "stop_sharing")}>
            Stop sharing
          </button>
        ) : (
          <button className="primary" disabled={!!busy} onClick={() => act("share", "share_graph")}>
            Share this graph
          </button>
        )}
      </div>

      <div className="you">
        {naming === undefined ? (
          <p>
            People see you as <strong>{state.you.name}</strong> <span className="fp">{state.you.fingerprint}</span>{" "}
            {state.you.name_from !== "P2PCG_USER" && (
              <button className="link" onClick={() => setNaming(state.you.name)}>
                Change
              </button>
            )}
            <span className="faint">
              {" "}
              {state.you.name_from === "git" ? "(from git's user.name)" : state.you.name_from === "login" ? "(your login name)" : state.you.name_from === "P2PCG_USER" ? "(set by P2PCG_USER)" : ""}
            </span>
          </p>
        ) : (
          // Not a <form>: views run sandboxed without allow-forms, which blocks submits.
          <div className="row" role="group" aria-label="Change your name">
            <label htmlFor="p2pcg-name">Your name</label>
            <input
              id="p2pcg-name"
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
              Cancel
            </button>
          </div>
        )}
      </div>

      {state.sharing && state.link && (
        <>
          <h2>Join link</h2>
          <div className="linkbox">
            <input id="p2pcg-link" readOnly value={state.link} onFocus={(e) => e.currentTarget.select()} aria-label="Join link" />
            <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p className="faint">Send it privately. Anyone with it can ask to join; you approve each person here.</p>
        </>
      )}

      <h2>
        Waiting {state.waiting.length > 0 && <span className="pill warn">{state.waiting.length}</span>}
      </h2>
      {state.waiting.length === 0 ? (
        <p className="empty">{state.sharing ? "No one is waiting." : "Share the graph to let people ask to join."}</p>
      ) : (
        <div className="list">
          {state.waiting.map((p) => (
            <div className="card spread" key={p.name}>
              <div className="grow">
                <strong>{p.name}</strong> <span className="fp">{p.fingerprint}</span>
                <p className="faint">Check this fingerprint with {p.name} by a channel you trust before approving.</p>
              </div>
              <div className="row">
                <RolePicker value={pick[p.name] ?? "contributor"} onChange={(r) => setPick({ ...pick, [p.name]: r })} />
                <button className="primary" disabled={!!busy} onClick={() => act(`approve ${p.name}`, "approve_peer", { name: p.name, role: pick[p.name] ?? "contributor" })}>
                  Approve
                </button>
                <button disabled={!!busy} onClick={() => act(`refuse ${p.name}`, "remove_peer", { name: p.name })}>
                  Refuse
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Connected</h2>
      {state.connected.length === 0 ? (
        <p className="empty">No one is connected.</p>
      ) : (
        <table>
          <tbody>
            {state.connected.map((p) => (
              <tr key={p.name}>
                <td>
                  <span className="dot on" aria-hidden /> <strong>{p.name}</strong>
                </td>
                <td>
                  <span className="fp">{p.fingerprint}</span>
                </td>
                <td className="faint">{when(p.since)}</td>
                <td>
                  <RolePicker value={p.role ?? "reader"} disabled={!!busy} onChange={(r) => act(`role ${p.name}`, "set_peer_role", { name: p.name, role: r })} />
                </td>
                <td>
                  <button className="danger" disabled={!!busy} onClick={() => act(`remove ${p.name}`, "remove_peer", { name: p.name })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {offline.length > 0 && (
        <>
          <h2>Approved, not connected</h2>
          <table>
            <tbody>
              {offline.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>
                    <span className="fp">{p.fingerprint}</span>
                  </td>
                  <td>
                    <RolePicker value={p.role ?? "reader"} disabled={!!busy} onChange={(r) => act(`role ${p.name}`, "set_peer_role", { name: p.name, role: r })} />
                  </td>
                  <td>
                    <button className="danger" disabled={!!busy} onClick={() => act(`remove ${p.name}`, "remove_peer", { name: p.name })}>
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}
