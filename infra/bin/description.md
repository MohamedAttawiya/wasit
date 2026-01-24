# Wasit Infrastructure — Compressed Layering & Deployment Order

This document defines the **final, compressed infrastructure layers**, their **contents**, **dependencies**, and **non-negotiable rules**, along with the **deployment order**.  
It is intended to be the architectural target state.

---

## 1) Observability

### Contains
- Log archive buckets / Firehose / Athena / Glue / Workgroups  
- (Optional) shared KMS keys  
- (Optional) shared alarms and metrics  

### Depends on
- Nothing

### Consumed by
- All other layers (optional but recommended)

---

## 2) Domains and Certs

### Contains

#### Platform domain primitives (dev: `wasit-platform.shop`)
- Hosted zone + DNS records (authoritative or delegated)
- Certificates:
  - `admin.<platformRoot>` (CloudFront cert in **us-east-1**)
  - `auth.<platformRoot>` (Cognito custom domain cert in **us-east-1**)
  - `api.<platformRoot>` (only if using API Gateway custom domain directly; often regional)

#### Storefront domain primitives (dev: `dev.cairoessentials.com`)
- Hosted zone + wildcard record planning
- Wildcard cert `*.dev.cairoessentials.com` (CloudFront cert in **us-east-1**)

### Depends on
- Nothing (only stage config)

### Outputs
- Stable hostnames (strings):
  - `adminHost`
  - `apiHost`
  - `authHost`
  - `storefrontWildcardHost`
- Certificate ARNs per use-case
- Hosted zone IDs

### Non-negotiable rule
- **No other layer creates certificates.**

---

## 3) Auth

### Contains
- Cognito User Pool
- User Pool Client
- Cognito custom domain: `auth.<platformRoot>`
- Callback / logout URLs pinned to stable hostnames:
  - `https://admin.<platformRoot>/auth/callback`
  - `https://admin.<platformRoot>/logout` (or chosen path)

### Depends on
- Domains and certs  
  - (`authHost` certificate + `adminHost` string)

### Outputs
- `userPoolId`
- `clientId`
- `issuer`
- `authDomainUrl`

### Non-negotiable rule
- **Auth must not depend on Edge distribution hostnames.**

---

## 4) Data and Tables

### Contains
- `users_state`
- `authz_capabilities`
- `authz_grants`
- Tenant / store metadata tables
- (Later) product, order, payment, inventory tables

### Depends on
- Nothing  
- (Optionally Observability for alarms)

### Outputs
- Table names and ARNs

### Non-negotiable rule
- **No Lambdas or APIs in this layer.**

---

## 5) APIs & Control

### Contains
- HTTP API(s) and routes
- Lambdas:
  - `/me`
  - Tenant resolution (`/resolve`)
  - Future admin / seller endpoints
- JWT authorizers (optional now, but belong here)
- Optional: `/.well-known/wasit-config` bootstrap endpoint

### Depends on
- Auth (issuer / authorizer inputs, `/me` resolver context)
- Data and tables (DynamoDB)
- Observability (optional)

### Outputs
- `apiBaseUrl`  
  - Ideally stable via custom domain mapping: `https://api.<platformRoot>`
- Tenant service URL (if separate)

### Non-negotiable rule
- **This layer must be deployable without Edge.**

---

## 6) Edge

### Contains

#### Platform edge
- CloudFront distribution for admin UI
- Route53 alias: `admin.<platformRoot>` → CloudFront

#### Storefront edge
- CloudFront distribution for `*.dev.cairoessentials.com`
- Route53 wildcard alias → CloudFront

#### Storefront SSR wiring
- CloudFront → SSR origin (service)

> SSR runtime can live in **APIs & control** or **Edge**, but ownership should be:
> - Runtime = control  
> - Distribution + DNS = edge

### Depends on
- Domains and certs (certificates + hosted zones)
- APIs & control (only if routing to API or SSR origins)

### Outputs
- Stable public URLs:
  - `https://admin.<platformRoot>`
  - `https://<tenant>.dev.cairoessentials.com`

### Non-negotiable rule
- **Edge never feeds back into Auth.**

---

## 7) Frontend

### Contains
- Platform frontend deployment (build + bucket sync)
- Storefront frontend deployment (if separate from SSR)
- CloudFront invalidations (if needed)

### Depends on
- Edge (distributions / buckets must exist)
- APIs & control (only for functional completeness; not required for deployment if stable domains are hardcoded)

### Non-negotiable rule
- **Do not couple frontend builds to infra outputs unless you explicitly accept that tradeoff.**

---

## Final Compressed Deployment Order

1. Observability  
2. Domains and certs  
3. Auth  
4. Data and tables  
5. APIs & control  
6. Edge  
7. Frontend  

---

## Architectural Guarantees Preserved

- Auth depends only on domains, **not Edge**  
- APIs depend on **Auth + Data**  
- Edge depends on **Domains + Origins (APIs / SSR)**  
- Frontend is last and can be redeployed freely

---
