// The sharing console: everyone in the graph (key fingerprint, agent, role,
// online or not), whether this machine is syncing, the signalling relays, and
// (for admins) the join codes this machine answers.

import { Alert } from "@squonk/ui/alert";
import { Badge } from "@squonk/ui/badge";
import { Button } from "@squonk/ui/button";
import { Card } from "@squonk/ui/card";
import { Code } from "@squonk/ui/code";
import { Divider } from "@squonk/ui/divider";
import { Heading } from "@squonk/ui/heading";
import { HStack } from "@squonk/ui/hstack";
import { CheckIcon, CopyIcon } from "@squonk/ui/icon";
import { LinkButton } from "../linkbutton";
import { Presentation } from "@squonk/ui/presentation";
import { Select } from "@squonk/ui/select";
import { Split } from "@squonk/ui/split";
import { Text } from "@squonk/ui/text";
import { TextField } from "@squonk/ui/text-field";
import { VStack } from "@squonk/ui/vstack";
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
  you: { name: string; role: Role | null; fingerprint: string; name_from: "VINE_USER" | "set_my_name" | "git" | "os" | "login" | "generated" };
}

const ROLES: Role[] = ["reader", "contributor", "admin"];
const ROLE_HELP: Record<Role, string> = {
  reader: "search and read",
  contributor: "also add and link",
  admin: "also withdraw anyone's items",
};
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r, description: ROLE_HELP[r] }));
const NEW_CODE_ROLES: { value: Role; label: string }[] = [
  { value: "contributor", label: "Read and add (contributor)" },
  { value: "reader", label: "Only read (reader)" },
  { value: "admin", label: "Read, add and invite (admin)" },
];
// Secondary detail lines, one step down the theme's text-size ladder.
const small = { fontSize: "var(--squonk-roles-type-small)" } as const;

function RolePicker({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return <Select value={value} disabled={disabled} onChange={(r) => r && onChange(r)} aria-label="Role" options={ROLE_OPTIONS} />;
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

  if (!state) return <Text tone="muted">Loading…</Text>;

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
    <Presentation register="compact">
      <VStack gap="md">
        <VStack gap="xs">
          <Split align="center" wrap>
            <Heading as="h1" level={3}>
              <HStack as="span" gap="sm" align="center" wrap>
                <Badge tone={state.sharing ? "success" : "neutral"}>{state.sharing ? "Syncing" : "Offline"}</Badge>
                <Text as="span" tone="secondary">
                  {state.using}
                </Text>
              </HStack>
            </Heading>
            {state.sharing ? (
              <Button variant="danger" disabled={!!busy} onClick={() => act("unshare", "stop_sharing")}>
                Go offline
              </Button>
            ) : admin ? (
              <Button variant="primary" disabled={!!busy} onClick={() => act("share", "start_sharing")}>
                Go online
              </Button>
            ) : null}
          </Split>
          <Text tone="muted" style={small}>
            Your copy holds {state.log.changes} changes
            {state.log.held ? `; ${state.log.held} still on this machine (Undo possible)` : ""}.{" "}
            {state.sharing && relays.length > 0 && `Signalling relays: ${relaysUp} of ${relays.length} connected.`}
            {state.sharing && relays.length > 0 && relaysUp === 0 && " None are reachable: other members can't find you until one is."}
            {state.sharing && state.ice?.turn && ` TURN server: ${state.ice.turn}${state.ice.problem ? ` (not in use: ${state.ice.problem})` : relayed ? `, carrying ${relayed} of ${state.links.length} connections` : ""}.`}
          </Text>
        </VStack>
        <Divider />

        {naming === undefined ? (
          <Text>
            People see you as <strong>{state.you.name}</strong> <Code>{state.you.fingerprint}</Code>
            <Text as="span" tone="muted">
              {state.you.role ? ` (${state.you.role})` : " (removed: read only)"}
            </Text>{" "}
            {state.you.name_from !== "VINE_USER" && (
              <LinkButton  onClick={() => setNaming(state.you.name)}>
                Change
              </LinkButton>
            )}
            <Text as="span" tone="muted" style={small}>
              {" "}
              {{ git: "(from git's user.name)", os: "(from your computer account)", login: "(your login name: set your own)", generated: "(made up: set your own)", VINE_USER: "(set by VINE_USER)", set_my_name: "" }[state.you.name_from] ?? ""}
            </Text>
          </Text>
        ) : (
          // Not a <form>: views run sandboxed without allow-forms, which blocks submits.
          <HStack gap="sm" align="end" wrap role="group" aria-label="Change your name">
            <TextField
              id="vine-name"
              label="Your name"
              value={naming}
              maxLength={40}
              onChange={(e) => setNaming(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && naming.trim()) void saveName();
                if (e.key === "Escape") setNaming(undefined);
              }}
              autoFocus
            />
            <Button variant="primary" type="button" onClick={() => void saveName()} disabled={!!busy || !naming.trim()}>
              Save
            </Button>
            <Button variant="ghost" type="button" onClick={() => setNaming(undefined)}>
              ‹ Cancel
            </Button>
          </HStack>
        )}

        {state.sharing && admin && (
          <VStack gap="sm">
            <Heading as="h2" level={5}>Invites</Heading>
            <Text tone="muted" style={small}>
              Each join code is for one person: the first machine to use it gets in, with a full copy of the graph. This machine answers it, so it must be online then. An unused code expires. Send it privately.
            </Text>
            {open.length === 0 && <Text tone="muted">No open join codes.</Text>}
            {open.map((i) => (
              <Card variant="outlined" key={i.id}>
                <VStack gap="sm">
                  <Split align="center" wrap>
                    <Text>
                      <strong>{i.label ?? "Join code"}</strong>{" "}
                      <Text as="span" tone="muted" style={small}>
                        expires {when(i.expires_at!)}
                      </Text>
                    </Text>
                    <Button variant="secondary" disabled={!!busy} onClick={() => act(`cancel ${i.id}`, "revoke_invite", { id: i.id })}>
                      Cancel
                    </Button>
                  </Split>
                  <HStack gap="sm" align="end">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TextField id={`vine-code-${i.id}`} label="Message to send" readOnly value={sendLine(i.code!)} onFocus={(e) => e.currentTarget.select()} fullWidth />
                    </div>
                    <Button variant="secondary" onClick={() => void copy(i)}>
                      {copied === i.id ? <CheckIcon /> : <CopyIcon />}
                      {copied === i.id ? "Copied" : "Copy"}
                    </Button>
                  </HStack>
                </VStack>
              </Card>
            ))}
            {/* Not a <form>: views run sandboxed without allow-forms, which blocks submits. */}
            <HStack gap="sm" align="end" wrap role="group" aria-label="New join code">
              <TextField
                label="Who the code is for"
                value={label}
                maxLength={60}
                placeholder="Who it's for (optional)"
                onChange={(e) => setLabel(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && void invite()}
              />
              <Select label="What they can do" value={role} options={NEW_CODE_ROLES} onChange={(r) => r && setRole(r)} />
              <Button variant="secondary" disabled={!!busy} onClick={() => void invite()}>
                New join code
              </Button>
            </HStack>
            {used.length > 0 && (
              <Text tone="muted" style={small}>
                In use: {used.map((i) => `${i.label ? `${i.label}: ` : ""}${i.for!.name}`).join(", ")}
              </Text>
            )}
          </VStack>
        )}

        <VStack gap="sm">
          <Heading as="h2" level={5}>
            People{" "}
            <Text as="span" tone="muted">
              {members.filter((p) => p.online).length} online
            </Text>
          </Heading>
          {members.length === 0 ? (
            <Text tone="muted">{admin ? "No one else is in this graph yet. Whoever uses a code first is let in, and everyone is told." : "No one else is in this graph."}</Text>
          ) : (
            <VStack as="ul" gap="sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {members.map((p, n) => (
                <VStack as="li" gap="sm" key={p.name}>
                  {n > 0 && <Divider />}
                  <Split align="center" wrap>
                    <VStack gap="xxs">
                      <HStack gap="sm" align="center" wrap>
                        <Text as="span" weight="bold">
                          {p.name}
                        </Text>
                        <Badge variant="dot" tone={p.online ? "success" : "neutral"}>
                          {p.online ? "online" : "offline"}
                        </Badge>
                        {p.creator && (
                          <Text as="span" tone="muted" style={small}>
                            (made this graph)
                          </Text>
                        )}
                      </HStack>
                      <Text tone="muted" style={small}>
                        {[p.agent, p.platform, p.invite?.label && `via '${p.invite.label}'`, p.joined_at && `joined ${when(p.joined_at)}`].filter(Boolean).join(" · ")}
                      </Text>
                      <Text style={small}>
                        <Code>{p.fingerprint}</Code>
                      </Text>
                    </VStack>
                    <HStack gap="sm" align="center">
                      {admin && !p.creator ? (
                        <RolePicker value={p.role ?? "reader"} disabled={!!busy} onChange={(r) => act(`role ${p.name}`, "set_peer_role", { name: p.name, role: r })} />
                      ) : (
                        <Text as="span">{p.role}</Text>
                      )}
                      {admin && !p.creator && (
                        <Button variant="danger" disabled={!!busy} onClick={() => act(`remove ${p.name}`, "remove_peer", { name: p.name })}>
                          Remove
                        </Button>
                      )}
                    </HStack>
                  </Split>
                </VStack>
              ))}
            </VStack>
          )}
        </VStack>

        {error && <Alert tone="error">{error}</Alert>}
      </VStack>
    </Presentation>
  );
}
