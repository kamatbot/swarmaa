# Third-Party Notices

Swarmaa (`github.com/kamatbot/swarmaa`) is released under the MIT License (`LICENSE`). It incorporates, adapts, or bundles the following third-party software and fonts under their respective open-source licenses.

---

## 1. Asymptote Labs — `agent-beacon` (MIT License)

- **Source:** https://github.com/asymptote-labs/agent-beacon
- **License:** MIT License
- **Copyright:** `Copyright (c) Asymptote Labs` *(TODO: verify exact copyright line/year from the upstream `agent-beacon` `LICENSE` file)*
- **Where used in Swarmaa:**
  - Read-only local chat history readers in `src/capture/` (`cline.ts`, `copilot.ts`, `cursor.ts`, `devin.ts`, `factory.ts`, `hermes.ts`, `opencode.ts`, `pi.ts`, `util.ts`) adapt session-discovery and transcript-parsing recipes from `agent-beacon`.
  - Single-event safety lint regex rules in `src/safety/lint.ts` and test fixtures in `tests/fixtures/beacon-lint-fixtures.json` adapt rules from `agent-beacon`'s `rules/prompt-injection`, `rules/credential-access`, and `rules/risky-commands`.

### MIT License

```text
MIT License

Copyright (c) Asymptote Labs (TODO: replace with exact copyright line from upstream agent-beacon LICENSE)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Reason Network (MIT OR Apache-2.0)

- **Source:** https://github.com/reason-machines/reason-network (pinned commit `3e08ce1d4e538a5576f52cc06b62ca36c2360998`, upstream package version `0.12.3`)
- **Location:** `vendor/reason-network/`
- **License:** Dual-licensed under MIT OR Apache-2.0 (`vendor/reason-network/LICENSE-MIT`, `vendor/reason-network/LICENSE-APACHE`, and `vendor/reason-network/NOTICE`).
- **Copyright:**
  - `Copyright 2026 Reason Machines, Inc.`
  - `Copyright (c) 2026 the tincan contributors` (originally developed at https://github.com/larstalian/tincan)
- **Notes:** Git metadata, upstream `.github` automation, and upstream `assets/` branding images are omitted from the vendored snapshot. Swarmaa does not compile or execute the vendored installers automatically; `src/bridge/reason.ts` invokes an operator-installed `reason-network` binary only when explicitly configured.

---

## 3. Web Fonts — IBM Plex & Stardos Stencil (SIL Open Font License 1.1)

The web assets under `site/public/fonts/` bundle the following fonts under the SIL Open Font License, Version 1.1:

### IBM Plex Mono & IBM Plex Sans Condensed
- **Files:** `site/public/fonts/ibm-plex-mono-*.woff2`, `site/public/fonts/ibm-plex-sans-condensed-*.woff2`
- **Source:** https://github.com/IBM/plex
- **Copyright:** `Copyright © 2017 IBM Corp. with Reserved Font Name "Plex".`
- **License:** SIL Open Font License, Version 1.1

### Stardos Stencil
- **Files:** `site/public/fonts/stardos-stencil-700.woff2`
- **Source:** https://fonts.google.com/specimen/Stardos+Stencil
- **Copyright:** `Copyright (c) 2010, Vernon Adams (vern@newtypography.co.uk), with Reserved Font Names "Stardos Stencil".`
- **License:** SIL Open Font License, Version 1.1

### SIL Open Font License, Version 1.1

```text
PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## 4. npm Dependencies

Swarmaa declares the following direct runtime and development dependencies in `package.json` (their full resolved tree and individual license metadata are recorded in `package-lock.json` and `node_modules/` upon installation):

| Package | Version | License | Repository |
|---|---|---|---|
| `@simplewebauthn/server` | `14.0.3` | MIT | https://github.com/MasterKale/SimpleWebAuthn |
| `ipaddr.js` | `2.5.0` | MIT | https://github.com/whitequark/ipaddr.js |
| `pg` | `8.23.1` | MIT | https://github.com/brianc/node-postgres |
| `node-pty` | `1.1.0` | MIT | https://github.com/microsoft/node-pty |
| `@types/node` | `26.6.5` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/pg` | `8.23.1` | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `tsx` | `4.23.15` | MIT | https://github.com/privatenumber/tsx |
| `typescript` | `7.0.2` | Apache-2.0 | https://github.com/microsoft/TypeScript |

---

## 5. HarnessRouter (Apache-2.0)

- **Source:** https://github.com/harnessrouter/harnessrouter (borrowed from `docs/harness-verification.md` and `scripts/support-matrix/`)
- **License:** Apache License 2.0
- **Copyright:** Copyright (c) HarnessRouter Contributors
- **Where used in Swarmaa:**
  - `scripts/smoke-providers.ts` adapts the provider verification matrix methodology (scenarios per provider, connection/provider served verification, run duration metrics, and markdown/JSON result matrices).
  - Closed failure-code taxonomy, retry semantics, and error classifications in `src/core/failures.ts` and `src/bridge/adapters.ts` adapt definitions from UHP `protocol/versions/2026-10-19/errors.md`.
  - Model equivalence logic and substitution verification (`sameModel`) in `src/core/failures.ts` adapt `scripts/support-matrix/samemodel.py`.

### Apache License 2.0 Notice

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

---

## 6. Trademark and Non-Affiliation Notice

Swarmaa is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Google, Anysphere, xAI, Reason Machines, Asymptote Labs, or IBM.

- **Claude** and **Claude Code** are trademarks of Anthropic, PBC.
- **Codex**, **ChatGPT**, and **Dot** are trademarks of OpenAI.
- **Antigravity** and **Gemini** are trademarks of Google LLC.
- **Cursor** is a trademark of Anysphere, Inc.
- **Grok** is a trademark of xAI Corp.

---

## 7. AgentWorkforce Relay (Apache-2.0)

- **Source:** https://github.com/AgentWorkforce/relay, local reference commit `c3a92d9c179972963756ebce3fcd106679302934`.
- **License:** Apache License 2.0; preserved in [docs/licenses/agentworkforce-relay-APACHE-2.0.txt](docs/licenses/agentworkforce-relay-APACHE-2.0.txt).
- **Adaptation:** `src/wrap/terminal.ts`, `src/wrap/delivery.ts`, and `tests/fixtures/pty/composers.json`
  adapt composer/cursor readiness, Codex activity recognition, control-character sanitization,
  paste selection, the 15-second prompt deadline, separate delayed CR, human cancellation and bounded
  submit-only recovery from `crates/relay-pty/src/{readiness.rs,detection.rs,wait.rs,pty.rs}`,
  `crates/broker/src/{wrap.rs,pty_worker.rs,injection_wire.rs,terminal_control.rs}` and
  `docs/harnesses/{pty-delivery.md,injection.md}`.
- **Changes:** Reimplemented in TypeScript with a bounded conservative VT observer, a 1,500-byte
  whole-notice cap, one extra CR, Swarmaa inbox receipts and explicit unconfirmed verdicts. No Relay
  broker, messaging transport or account integration is bundled or executed.
