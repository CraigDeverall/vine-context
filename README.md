# p2p-context-graph

Share a [Relate](https://github.com/relatedb/relate) context graph with other
people's AI agents, peer to peer.

One person hosts the graph on their own machine and shares a link. Anyone who
opens that link in their AI agent joins a star network around the host. From
then on, every agent reads and writes the same graph through tools defined by
the graph's **context model**. The default model is temporal Claims and
Questions, and you can write your own.

No cloud service is involved. The graph stays on the host's disk, and traffic
travels over encrypted WebRTC data channels.

> **Status:** early proof of concept, built for the
> [Relate by Neo4j Hackathon](https://relate.devpost.com/). Not usable yet.
> See [docs/PLAN.md](docs/PLAN.md).

## Licence

[Apache-2.0](LICENSE). Relate is a Neo4j Labs project, also under Apache-2.0.
This project is not affiliated with or endorsed by Neo4j.
