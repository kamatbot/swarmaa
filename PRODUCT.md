# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS/JS served as Cloudflare Workers static assets, with a small Worker endpoint for the waitlist (KV). Lives in `site/`. Domain: swarmaa.com (Cloudflare zone).

## Users

Developers who already use several AI coding agents and chat agents (Claude Code, Codex, Antigravity, Dot, Grok) and lose context and quota juggling between them. On the landing page they are evaluating whether Swarmaa is worth joining the waitlist for; the web portal to manage swarms comes later.

## Product Purpose

Swarmaa gives every agent a developer uses one shared memory and one task queue, so any agent can pick up work another started, and read work is routed to whichever provider has the most quota left. Success on the landing page is a developer joining the waitlist.

## Positioning

One brain, every agent. Swarmaa is not another agent: it is the shared memory and dispatch layer underneath the agents a developer already pays for, running locally on their own Mac, with each client holding its own scoped credential.

## Operating Context

- Runs locally: PostgreSQL + a small Node service on the developer's Mac, started at login; `npm run setup` connects the CLIs.
- Interactive clients connect over MCP (Claude Code, Codex, Antigravity); hosted agents (Dot, Grok) connect over HTTPS through a tunnel.
- Background workers (Claude, Codex) take read-only review/research tasks with leases, checkpoints and retries.
- Workers report each provider's quota windows and reset times; `auto.read` tasks go to the live provider with most headroom.
- NotchTrader (macOS notch app) shows agents and swarms; a web portal at swarmaa.com is planned.

## Capabilities and Constraints

Confirmed: shared scoped memory with sources and revision history; durable tasks with leases, checkpoints, retries and idempotent handoffs; MCP + REST + OAuth; per-client scoped identities; quota-aware routing; read-only autonomous workers (Claude file-edit mode opt-in only); macOS LaunchAgent autostart; notch dashboard.
Constraints: no unattended Antigravity worker; shared memory holds what agents publish, it does not import vendors' private memories; hosted agents need a public HTTPS endpoint.
Undecided: pricing, licensing/open-source status, release date, portal feature set, non-macOS support.

## Brand Commitments

Name: Swarmaa (domain swarmaa.com). Agent and product names (Claude Code, Codex, Antigravity, Dot, Grok) are third-party names used descriptively only, not as endorsements or logos.

## Evidence on Hand

Working local system with passing test suites and real quota readings from Claude and Codex on the founder's machine. No customers, testimonials, benchmarks, press, pricing or user counts exist; do not fabricate any.

## Product Principles

1. Your agents, your machine: data and credentials stay local by default.
2. Agents are interchangeable entry points; no work is trapped in one vendor's chat.
3. Spend quota where it is available instead of hitting a wall.
4. Autonomy is opt-in and bounded: read-only by default, every write leased and fenced.
5. Say exactly what works today; label what is planned.
