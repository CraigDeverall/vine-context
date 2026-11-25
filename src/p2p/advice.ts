// What to tell a person when members are found but can't be connected to.

/** "Sam", "Sam and Ana", "Sam, Ana and Lee". */
export function names(list: string[]): string {
  if (list.length <= 1) return list[0] ?? "a member";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * The message for members found through the relays whose links never
 * connect. `anyLinked`: whether this machine reaches any member at all (then
 * changes still arrive, forwarded, and nothing needs doing). `turn`: whether
 * a TURN server is set here.
 */
export function unreachableAdvice(who: string[], o: { anyLinked: boolean; turn: "none" | "cloudflare" | "custom" | "env" }): string {
  const machine = who.length === 1 ? `${who[0]}'s machine` : `the machines of ${names(who)}`;
  const found = `Found ${machine}, but your networks wouldn't allow a direct connection.`;
  if (o.anyLinked) return `${found} Nothing to do: you're linked to another member, so their changes still reach you, forwarded.`;
  if (o.turn === "none")
    return (
      `${found} A TURN server can carry the connection (it only relays encrypted data, and only one of you needs one). ` +
      "Run `vine turn set --provider cloudflare` (or `npx vine-context setup`) to set up Cloudflare's, free for this use."
    );
  if (o.turn === "env") return `${found} VINE_ICE is set here and replaces the TURN setting: check the TURN server in it.`;
  return `${found} Even your TURN server didn't get through: run \`vine turn test\` to check it.`;
}
