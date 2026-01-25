
https://auth.wasit-platform.shop/oauth2/authorize?response_type=code&client_id=4ia0l44d9h3th3hiv911b7pf1i&redirect_uri=https://admin.wasit-platform.shop/callback&scope=openid+email+profile

# Wasit Deployment Domains — Order and Dependencies

This is the **domain-owned deployment order** for Wasit. Each item is a deployable “domain” (CDK stack group) that owns its data + compute + APIs for that domain.

---

## 1) Observability (Platform Domain)
**Depends on:** nothing  
**Enables:** centralized logging/metrics for everything else  
**Owns:** log archive, firehose, athena/glue, shared alarms (optional)

---

## 2) Domains & Certificates (Platform Domain)
**Depends on:** nothing  
**Enables:** all stable hostnames + TLS for CloudFront/Cognito/APIs  
**Owns:**
- Route53 hosted zones + records (as needed)
- ACM certs:
  - us-east-1 (CloudFront/Cognito-backed)
  - regional certs (if needed later)

**Rule:** no other domain creates certs.

---

## 3) Auth (Control Plane Domain)
**Depends on:** Domains & Certificates  
**Enables:** identity + JWTs + authorization model used by all control planes  
**Owns:**
- Cognito user pool + client + custom domain (`auth.<platformRoot>`)
- Auth data model: `users_state`, `authz_capabilities`, `authz_grants`
- Auth API: `/me`, `/admin/*`
- Authz enforcement logic (`ACTIVE`, capabilities)

---

## 4) Tenant Registry (Control Plane Domain)
**Depends on:** Auth  
**Enables:** multi-tenancy resolution and onboarding  
**Owns:**
- Tenants table(s): tenant/store metadata, hostnames, status
- Tenant resolution API: “who is this host?”, “what tenant is this user in?”
- Admin-only onboarding endpoints (create tenant/store, assign owners)

---

## 5) Commerce Core (Application Domain)
**Depends on:** Auth, Tenant Registry  
**Enables:** actual platform transactions  
**Owns (initial):**
- Catalog (products, categories)
- Orders + order items
- Inventory state/events (if you’re doing ledger + derived state)

---

## 6) Payments & Ledger (Application Domain)
**Depends on:** Commerce Core, Auth, Tenant Registry  
**Enables:** payment intent/capture/refund and financial truth  
**Owns:**
- Payments, refunds, ledger entries
- Idempotency and reconciliation primitives

---

## 7) Fulfillment / Shipping (Application Domain)
**Depends on:** Commerce Core, Auth, Tenant Registry  
**Enables:** delivery workflows and carrier integrations  
**Owns:**
- Fulfillment jobs, shipment state, tracking
- Carrier adapters (e.g., Bosta)

---

## 8) Edge Delivery (Platform Edge Domain)
**Depends on:** Domains & Certificates, Origins from control/app domains  
**Enables:** stable public entry points  
**Owns:**
- Admin UI distribution (`admin.<platformRoot>`)
- Storefront wildcard distribution (`*.storefrontRoot`)
- DNS aliases to CloudFront

**Rule:** Edge never feeds back into Auth.

---

## 9) Frontend Deployments (Delivery Domain)
**Depends on:** Edge Delivery  
**Enables:** shipping UI builds and redeploying safely  
**Owns:**
- Build + upload (S3)
- CloudFront invalidation (if used)

---

## Minimal Deploy Order (MVP)
1. Observability  
2. Domains & Certificates  
3. Auth  
4. Tenant Registry  
5. Commerce Core  
6. Edge Delivery  
7. Frontend Deployments  
