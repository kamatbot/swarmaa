# Contributing

Reason Network tries to stay small and to just work: a change that removes code or a step is worth more than a new
option. [DESIGN.md](DESIGN.md) explains how the pieces fit, and the README says how to build and test.

- One change per pull request, saying what it changes and why. CI runs fmt, clippy and the tests on Linux, macOS and
  Windows.
- Match the code around you: plain names, few comments, and comments that say why.
- Never change the wire identifiers in `src/net.rs`, `src/team.rs` and `src/invite.rs`: every peer speaks them.
- Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you,
  as defined in the Apache-2.0 license, shall be dual licensed as MIT OR Apache-2.0, without any additional terms or
  conditions.

Security issues go through private reporting instead: see [SECURITY.md](SECURITY.md).
