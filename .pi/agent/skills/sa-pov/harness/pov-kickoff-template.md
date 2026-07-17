# Proof of Value - Kickoff Document

**{{CUSTOMER}} x {{VENDOR}}**

| | |
| :---- | :---- |
| **Duration** | {{START}} -> {{END}} ({{N}} weeks) |
| **Technical Owner (Customer)** | {{NAME}}, {{TITLE}} |
| **Account Executive** | {{AE}} ({{AE_EMAIL}}) |
| **Solutions Architect** | {{SA}} ({{SA_EMAIL}}) |
| **Date** | {{DATE}} |

---

## 1. Objective & Decision

{{One paragraph: who the customer is, what product(s) are under test, the workload,
the user scale, the stack, the region/residency requirement, and what this PoV must prove.}}

**What a PASS unlocks:** {{plan-tier selection, security questionnaire, procurement path,
target production date}}.

## 2. Workload Under Test

{{The product areas and the integration shape - where the product sits in the request path,
what data it owns, what the customer's system owns.}}

### Customer architecture (confirmed on kickoff call)
- **Frontend / Backend / DB:** {{...}}
- **Network / residency:** {{region, VNet, public exposure}}
- **Integration model:** {{where identity/data lives; who calls what}}

### In Scope
- {{criterion-bearing features}}

### Out of Scope
- {{production cutover, features confirmed not required, add-ons not needed for the PoV}}

## 3. Success Criteria

**Native** = configuration only. **Custom build** = something the customer owns built on a
native primitive. Per-criterion docs in 3.1; live-validated reference in 3.2.

| # | Criterion | Target | Type | Status |
| :---: | :---- | :---- | :---- | :---- |
| 1 | {{...}} | {{measurable pass condition}} | Native | Not Started |

**Status:** `Not Started` -> `In Progress` -> `Met` / `Not Met` / `At Risk`

**Customer priorities:** {{which 2-3 criteria are decision-critical}}.

### 3.1 Implementation references

{{Per-criterion links to the vendor's real doc pages. Verify each is HTTP 200 before
sharing - vendors reorganize slugs.}}

1. **{{Criterion}}** - [{{doc title}}](https://{{vendor-docs-url}}/...)

### 3.2 Validated reference implementation (if live-validated)

Every criterion below has working code + live test evidence in **Appendix A** (validated on
a throwaway {{plan}} environment in {{region}}, then torn down).

| # | Criterion | Reference | Validation result |
| :---: | :---- | :---- | :---- |
| 1 | {{...}} | Appendix A #1 | Validated ({{evidence}}) |

> Google Docs navigation: markdown cannot create in-doc jump links (Google renders `#anchor`
> as a dead web link). Use **View > Show outline** or **Insert > Table of contents**.

## 4. Technical Prerequisites & Access

| Item | Detail / Owner | Status |
| :---- | :---- | :---- |
| {{Org & environment provisioning}} | {{who creates it; who applies credits/permissions}} | Not Started |
| {{IdP metadata / keys / migration source + hash format / sample data}} | {{owner}} | Not Started |

## 5. Data Handling

{{Staging environment, representative sample not prod volume; PII scope; region; deletion at
PoV end unless Go.}}

## 6. Timeline ({{N}} weeks)

| Week | Focus | Activities & Deliverables |
| :---: | :---- | :---- |
| 1 | {{Setup & core}} | {{...}} |

## 7. Check-in Cadence

**Async:** dedicated shared channel; SA responds within 1 business day.

| Touchpoint | Timing | Purpose |
| :---- | :---- | :---- |
| Kickoff | {{...}} | {{...}} |
| Mid-Point | {{...}} | {{...}} |
| Readout | {{...}} | Results vs. criteria + recommendation |

## 8. Roles & Responsibilities

| {{Customer}} | {{Vendor}} |
| :---- | :---- |
| {{owners + what they own}} | Dedicated SA; kickoff/checkin/readout; compliance docs |

## 9. Credits & Resources

| | |
| :---- | :---- |
| **Credits** | ${{X}} |
| **Credit Expiration** | {{set a date - avoid N/A}} |
| **Plan During PoV** | {{tier required for the gated criteria}} |

## 10. Risks & Mitigations

| Risk | Mitigation | Owner |
| :---- | :---- | :---- |
| {{custom builds are engineering work}} | {{scoped in the timeline}} | Joint |
| {{plan-gated features, quota/pricing}} | {{size early, confirm before sign-off}} | Joint |

## 11. Decision & Next Steps

- **Go** -> {{plan-tier selection, commercials, security questionnaire, production plan}}.
- **Conditional** -> {{likely open items}} resolved in a short follow-up.
- **No-go** -> documented reasons; alternative path.

## 12. Acknowledgment

| {{Customer Name & Title}} | {{AE/SA Name & Title}}, {{Vendor}} |
| :---- | :---- |
| Date: ____________ | Date: ____________ |
