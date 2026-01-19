# 15. CDK Stack Breakdown

## 15.1 Principles

- **Domains are the only authorities.** Every business capability (orders, pricing, inventory, financials, etc.) is owned and enforced by a single domain stack. Domains own their data, APIs, invariants, and workflows. Nothing else is allowed to mutate domain state.
- **UI stacks are clients, not systems.** GodStack, SellerAdminStack, InternalOpsStack, StorefrontStack, and WasitMainStack are delivery planes only (UI + edge + routing). They call domain APIs; they do not own domain logic, domain tables, or domain state.
- **One source of truth per domain.** Current state lives exactly once. Historical facts are append-only. Financial, inventory, and order facts are immutable once written.
- **Privilege is a scope, not a code path.** God, seller, and ops capabilities differ only by authorization scope enforced inside domain APIs. No admin shortcuts or bypasses.
- **Surfaces do not coordinate business rules.** UI stacks may orchestrate calls for UX, but never decide eligibility, pricing, refunds, or policy outcomes.
- **Explicit dependencies only.** Stacks interact only through declared outputs, runtime configuration, and public domain APIs.
- **Late binding over redeploys.** UI stacks resolve domain endpoints at runtime; domains deploy independently.
- **Environment isolation by account.** Dev, staging, and prod are separated at the AWS account level.
- **Minimal blast radius by design.** Domain stacks deploy independently; shared primitives change rarely.
- **Idempotency is mandatory.** Any retriable handler must be idempotent.
- **Derived state is disposable.** Projections and caches can be rebuilt from immutable logs.
- **Authentication is centralized, enforcement is local.** Auth primitives are shared; enforcement happens per domain.
- **Observability is non-optional.** Every compute emits structured logs with correlation IDs.
- **Prefer boring AWS primitives.** DynamoDB, Lambda, S3, CloudFront first.

---

## 15.2 ObservabilityStack (`lib/observability/ObservabilityStack.ts`)

### Owns
- S3 log archive bucket (NDJSON)
- Firehose stream (DirectPut → S3) + processor Lambda
- Athena results bucket
- Glue database + external tables
- Athena workgroup

### Exports
- Log archive bucket name/ARN  
- Firehose stream name/ARN  
- Glue database and table names  
- Athena workgroup name  

### Depends on
- None

### Depended on by
- All Domain Stacks and Layer Stacks

---

## 15.3 EdgeDomainsStack (`lib/domains/EdgeDomainsStack.ts`)

### Owns
- Route53 hosted zones: `wasit.eg`, `store.eg`
- DNS records:
  - `*.store.eg` → CloudFront
  - Platform records under `wasit.eg`
- ACM certificates:
  - Wildcard `*.store.eg`
  - Certificates for `wasit.eg` subdomains
- DNS validation records

### Exports
- Hosted zone IDs/names
- Certificate ARNs
- Canonical domain names

### Depends on
- None

### Depended on by
- StorefrontStack  
- WasitMainStack  
- GodAdminStack  

---

## 15.4 AuthStack (`lib/auth/AuthStack.ts`)


aws cloudfront create-invalidation \
  --distribution-id E2N2B59MWGRBEA \
  --paths "/*"

### Owns
- Authentication system (e.g., Cognito)
- User groups and roles
- API authorizers
- IAM roles/policies (where required)

### Exports
- User Pool IDs / Client IDs
- Authorizer ARNs/IDs
- Issuer/JWKS metadata
- Privileged role ARNs

### Depends on
- None

### Depended on by
- StorefrontStack  
- WasitMainStack  
- GodAdminStack  
- All Domain API stacks  

---

## 15.5 StorefrontStack (`lib/storefront/StorefrontStack.ts`)

### Owns
- Tenant resolution:
  - DynamoDB tenant table
  - Resolver Lambda + endpoint
- Storefront delivery:
  - SSR Lambda
  - Static assets bucket (optional)
  - CloudFront distribution for `*.store.eg`
- Edge security (optional)
- Log subscriptions → Firehose

### Exports
- CloudFront distribution ID/domain
- SSR origin endpoint
- Tenant resolver endpoint
- Tenant table name/ARN
- Assets bucket name/ARN (if applicable)

### Depends on
- EdgeDomainsStack  
- ObservabilityStack  
- AuthStack (optional)

### Depended on by
- Public storefront traffic  
- GodAdminStack  

---

## 15.6 WasitMainStack (`lib/wasitmain/WasitMainStack.ts`)

### Owns
- CloudFront for `wasit.eg`
- Static site or SSR origin
- DNS records under `wasit.eg`
- Logging wiring (if compute exists)

### Exports
- CloudFront distribution ID/domain
- Static bucket or SSR endpoint
- Canonical platform URLs

### Depends on
- EdgeDomainsStack  
- ObservabilityStack (if compute)  
- AuthStack (optional)

### Depended on by
- Public platform traffic  
- GodAdminStack  

---

## 15.7 Domain Stacks

### 15.7.1 Catalog (`lib/catalog/*`)
Owns global products, listings, catalog APIs.  
Depends on AuthStack, ObservabilityStack.  
Depended on by Storefront, Orders, Pricing, Procurement, GodAdmin.

### 15.7.2 Pricing (`lib/pricing/*`)
Owns pricing state and APIs.  
Depends on AuthStack, ObservabilityStack, Catalog.  
Depended on by Orders, Storefront, GodAdmin.

### 15.7.3 Inventory (`lib/inventory/*`)
Owns inventory ledger and balance projections.  
Depends on AuthStack, ObservabilityStack.  
Depended on by Orders, Fulfillment, Procurement, GodAdmin.

### 15.7.4 Procurement (`lib/procurement/*`)
Owns inbound receipts and APIs.  
Depends on Inventory, Catalog, AuthStack, ObservabilityStack.  
Depended on by Inventory, Financials, GodAdmin.

### 15.7.5 Orders (`lib/orders/*`)
Owns orders, checkout, and pricing snapshots.  
Depends on Catalog, Pricing, Inventory, AuthStack, ObservabilityStack.  
Depended on by Fulfillment, Financials, GodAdmin.

### 15.7.6 Fulfillment (`lib/fulfillment/*`)
Owns fulfillment jobs and shipment logic.  
Depends on Orders, Inventory, AuthStack, ObservabilityStack.  
Depended on by Orders, Financials, GodAdmin.

### 15.7.7 Financials (`lib/financials/*`)
Owns ledgers, settlements, refunds, PSP webhooks.  
Depends on Orders, AuthStack, ObservabilityStack.  
Depended on by GodAdmin, Orders.

---

## 15.8 GodAdminStack (`lib/admin/GodAdminStack.ts`)

### Purpose
Highest-privilege operator UI. Terminal surface only.

### Owns
- Admin UI (`admin.wasit.eg`)
- Thin UX aggregation layer
- Auth integration and god-scope recognition
- Correlation IDs and audit metadata
- Observability wiring

### Does NOT Own
- Domain APIs or tables
- Business rules or domain logic

### Invariant
God mode expands authorization scope only; enforcement remains in domains.

---

## 15.9 InternalOpsStack (`lib/ops/InternalOpsStack.ts`)

### Purpose
Internal day-to-day operations UI.

### Owns
- Ops UI (`ops.wasit.eg`)
- Scoped auth (Ops/Support/ReadOnly)
- Optional ops notes/audit store
- Observability wiring

### Does NOT Own
- Domain APIs or business rules

### Invariant
InternalOps cannot bypass domain enforcement.

---

## 15.10 SellerAdminStack (`lib/seller/SellerAdminStack.ts`)

### Purpose
Seller-facing backoffice UI, strictly store-scoped.

### Owns
- Seller admin UI
- Seller auth and session handling
- Store-scoped enforcement in client
- Seller audit/activity logs
- Observability wiring

### Does NOT Own
- Domain APIs or tables
- Cross-store or platform logic

### Invariant
All seller actions are store-scoped and enforced by domain APIs.
