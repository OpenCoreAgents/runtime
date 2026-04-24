# Documentation Hub

Status: stable  
Audience: users, contributors, maintainers

This folder is organized by intent so you can find the right document faster.

- Start with [guides](./guides/README.md) if you are onboarding.
- Use [reference](./reference/README.md) for normative engine behavior.
- Use [roadmap](./roadmap/README.md) for implementation plans and open gaps.
- Use [archive](./archive/README.md) for historical design notes.

---

## Reading paths

### Path 1: New to the project (20-30 min)

1. [Getting started](./getting-started.md)
2. [Agent Engine overview](./roadmap/agent-engine-overview.md)
3. [Core reference index](./reference/core/README.md)

### Path 2: Shipping a production runtime

1. [Root README quickstart](../README.md#easy-getting-started-runnable-stack)
2. [Scope and security](./reference/core/11-scope-and-security.md)
3. [Cluster deployment](./reference/core/16-cluster-deployment.md)
4. [Dynamic runtime definitions](./reference/core/21-dynamic-runtime-rest.md)
5. [Technical debt: security and production](./roadmap/technical-debt-security-production.md)

### Path 3: Extending the engine

1. [Core reference index](./reference/core/README.md)
2. [Adapters and contracts](./reference/core/05-adapters-contracts.md)
3. [Adapters infrastructure](./reference/core/13-adapters-infrastructure.md)
4. [Definition syntax](./reference/core/06-definition-syntax.md)
5. [Planning index](./roadmap/README.md)

---

## Documentation map

| Area | Purpose | Primary entry |
|---|---|---|
| Guides | onboarding and practical setup | [guides/README.md](./guides/README.md) |
| Reference | canonical behavior and contracts | [reference/README.md](./reference/README.md) |
| Roadmap | plans, sequencing, known gaps | [roadmap/README.md](./roadmap/README.md) |
| Archive | historical design context | [archive/README.md](./archive/README.md) |

## Compatibility notes

- Existing paths under `docs/reference/core/`, `docs/roadmap/`, and `docs/archive/brainstorm/` remain valid.
- New sections above are the preferred navigation entrypoints.
