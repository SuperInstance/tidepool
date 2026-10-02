# PAM Hedge — cite/differentiate vs arXiv 2605.11032 (Portable Agent Memory)

**Date:** 2026-10-02 (pulse mission L2, per lanes/PLAN-2026-10-02.md)
**Source:** S. K. Ravindran, "Portable Agent Memory", arXiv:2605.11032v1,
submitted 2026-05-10, fetched 2026-10-02 ~17:58 CST (abstract + full HTML).
**Motive (queue, 12:25 10/2):** "Cite/differentiate before the vocabulary gets
owned elsewhere." PAM's terms (Merkle-DAG provenance, root signing, selective
disclosure, rehydration) overlap fleet vocabulary. This doc pins, per term,
what PAM claims, what the fleet already has (with dated receipts), and the
verdict: **ADOPT** (take it, cite it) or **DIFFERENTIATE** (say plainly why
we diverge). Nothing here upgrades any referral edge; merges gate that.

---

## Per-term ledger

### 1. Five-component memory model M=(E,S,P,W,I)

- **CLAIM-THEIRS:** agent memory decomposes into episodic / semantic /
  procedural / working / identity components, each with its own schema, to
  make memory model-agnostic and portable across GPT/Claude/Gemini/Llama.
- **CLAIM-OURS:** tidepool deliberately uses a **free-form `kind` field**
  (lesson | audit | design | playtest | pattern | tile | musician | session
  | …) plus an optional 16-number `native` structural fingerprint; recall
  ranks by relevance, recency, and labeled authorship, not by cognitive
  taxonomy. README: "the product is the discipline, not the store."
- **VERDICT: DIFFERENTIATE.** The fleet treats memory as an
  operator-owned witness store, not a model psyche. A fixed E/S/P/W/I
  schema is target-model psychologizing: it optimizes for *rehydration
  into another LLM*, which is not our product. We would pay schema-maintenance
  cost for a portability axis we don't sell. If a future fleet lane does
  cross-agent memory handoff, revisit — the taxonomy is then worth citing.

### 2. Merkle-DAG provenance with content-addressed ids (BLAKE3)

- **CLAIM-THEIRS:** entry id = BLAKE3(canonical JSON); `parent_ids` form a
  Merkle-DAG giving derivation tracking + tamper evidence + selective
  disclosure via transitive ancestors. 1000/1000 single-field mutation
  detection reported.
- **CLAIM-OURS:** the fleet pins **linear fnv1a-64 chains, genesis-anchored,
  order-not-time**: tidepool WAL row law (BIND/LINK/VIEW, fnv1a-64,
  genesis 0x16, re-homed in `tools/skill-stall.mjs` + pins, PR #11 merged
  2026-10-02); frozen-clock-lab P5 replay-detected + 10k-op frozen==honest
  byte-identical (PR #1 org merge sweep 01:49–02:39Z); jev-quilt
  `verify_tail` = boundary-stable binary-counter peaks + seeded sliver
  replay == full-chain root (PR #29, catches cross-chain checkpoint
  splicing). Hash canary pinned fleet-wide: fnv1a over canonical JSON
  (`sort_keys=True`, `separators=(comma, colon)`) = 0x24a555471370b18d.
- **VERDICT: DIFFERENTIATE — and the difference is deliberate, not weaker.**
  A DAG optimizes for *derivation fan-in* (semantic facts extracted from
  episodic events). Fleet chains optimize for *append-only witness streams*
  where fan-in is a forgery surface (see jev-quilt V1 vacuous-verify_tail
  hole, found by the org's own red-team). BLAKE3 vs fnv1a-64: we keep the
  cheap hash because every fleet consumer (awk, JS, D1 SQL-adjacent tooling)
  re-derives it, and the canary doctrine audits drift org-wide. We claim
  tamper-evidence, never tamper-proof; PAM's "blockchain-integrity"
  phrasing is stronger than what either system proves against an
  operator-key compromise.

### 3. Ed25519 root signing

- **CLAIM-THEIRS:** operator-owned Ed25519 keypair signs the artifact root
  hash; key rotation via trusted key registry.
- **CLAIM-OURS:** doubt-ledger wave-2 shipped **selective-disclosure export +
  Ed25519 root-signing over the tip root** (core stays stdlib-only; signing
  optional) — merged in the 01:49–02:39Z Casey sweep (doubt-ledger #1–#3).
  quilt-stone stone-v2 staples Ed25519 signatures at stone tips.
- **VERDICT: ADOPT — already adopted, receipted above.** Where PAM adds
  vocabulary worth borrowing: *key-id in the envelope + trusted key
  registry* for rotation. Note as candidate for doubt-ledger wave-3
  (separate lane; this doc does not spec it).

### 4. Capability-based access control / selective disclosure

- **CLAIM-THEIRS:** signed scoped capability tokens (component / entry-list /
  tag predicate / wildcard × read/write/derive/redact/export/rehydrate),
  audience-bound and expiring; enables per-role memory subsets.
- **CLAIM-OURS:** doubt-ledger has **export-side selective disclosure**:
  filtered slice → standalone JSONL, header binds the live tip, checksums
  recomputed, `verify_export` names the exact tampered line. Honest limit 5
  is pinned in-repo: export proves integrity *of the included*, never
  *completeness*. We have **no capability tokens** — no audience binding,
  no expiry, no per-permission scopes.
- **VERDICT: ADOPT-WITH-GAP-NAMED.** This is a real moat-shaped hole, said
  plainly rather than faked by analogy. The doubt-ledger export answers
  "was this slice tampered"; it does not answer "was the exporter allowed
  to show me this" or "does this grant expire". If a fleet lane ever hands
  memory across trust boundaries (the exact scenario PAM's capability
  tokens target), the spec to start from is PAM §3.3 — cited here so the
  vocabulary doesn't get owned elsewhere. Until then: named gap, not a
  denial and not a build.

### 5. Injection-resistant re-hydration + TCS metric

- **CLAIM-THEIRS:** 7-stage rehydration (verify → filter → rank → compress →
  format → frame → inject) with typed boundary markers, role-marker
  escaping, and schema quarantine; Transfer Continuity Score
  (TCS = target_success / source_success) reported 0.83–0.92 across
  Claude/GPT/Gemini pairs vs 0.28–0.45 no-memory baseline (pilot N=50,
  authors flag as directional).
- **CLAIM-OURS:** fleet doctrine is structurally different: memory entries
  are **untrusted evidence requiring receipts, not context to be framed**.
  Tidepool: "Never secrets", "Absence is information", every result carries
  author+ts, "Prefer recent; distrust unlabeled." Quarantine analog exists
  and is stronger in one axis: doubt-ledger's *discharge requires a reason*
  (unreasoned discharge = blindness again). Our "does recall preserve
  capability" metric is not TCS but executable: FAIL-first pins whose RED
  state must be demonstrated, fleet canary doctrine ("a canary that cannot
  fail is worse than no canary" — Mavis, wardroom #2).
- **VERDICT: DIFFERENTIATE.** Framing + escaping treats the target model as
  the trust anchor; receipts culture treats the *store* as the trust anchor
  and the model as an auditor. TCS is a nice instrument though — our
  nearest analog (fresh-clone re-verification counts, e.g. 19/19) measures
  reproducibility, not continuity. If tidepool ever ships cross-model
  recall-priming, TCS is the citation for how to score it honestly
  (pilot-scale caveat included).

### 6. JSON-first canonical serialization

- **CLAIM-THEIRS:** JSON primary, CBOR optional; canonical JSON for id
  computation.
- **CLAIM-OURS:** canonical JSON (sort_keys, tight separators) is already the
  fleet serialization law for hashing, pinned by the fnv1a canary above.
- **VERDICT: ADOPT — pre-aligned.** No action.

---

## Moat note (by our own words, per queue directive)

Tidepool's README concedes the moat gap: "the product is the discipline, not
the store." Nothing prevents copying the schema; the fleet answer is
receipts culture + org-wide canary + named refusals, not a proprietary
format. PAM does not change that calculus — it standardizes the *format*
axis while the fleet's differentiation sits in the *discipline* axis
(FAIL-first pins, genesis-anchored chains, honest limits, guardian audits).
Both can coexist; the risk this doc hedges is vocabulary: if a fleet lane
later says "provenance graph" or "selective disclosure" without citing
either our own receipts or PAM, the term will mean whichever spec an
outsider read first.

## Honest limits of this hedge

1. Single-source: only arXiv 2605.11032v1 was read (no AMCP/nunchi-ai
   spec, no pam-sdk source). Claims attributed to PAM are the paper's.
2. PAM pilot numbers (TCS, RHF, injection resistance) are reported as
   directional by the authors themselves; this doc cites them, does not
   endorse them.
3. Fleet receipts are cited from merge-sweep records (doubt-ledger #1–#3,
   tidepool #11); line-level re-verification of those repos' current main
   is a follow-up if any lane builds on this.
4. The capability-token gap is named, not scheduled. Scheduling it without
   a cross-trust-boundary consumer would be building ahead of the downbeat.

## Falsification (kill switch, per rules of engagement)

- If any fleet protocol adopts E/S/P/W/I component schemas or "rehydration"
  vocabulary without citing PAM or this doc → the hedge failed; escalate.
- If a cross-agent memory handoff lane ships and does not start from
  PAM §3.3 capability tokens → the ADOPT-WITH-GAP-NAMED verdict was
  ignored; reopen.
- If PAM's canonical JSON definition (JCS?) ever diverges from the fleet
  canary bytes-law, the fnv1a canary trips org-wide — that trip is this
  doc working, not failing.
