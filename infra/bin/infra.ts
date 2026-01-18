#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { ObservabilityStack } from "../lib/observability/ObservabilityStack";
import { TenantDomainsStack } from "../lib/domains/TenantDomainsStack";
import { TenantServiceStack } from "../lib/domains/TenantServiceStack";
import { StorefrontEdgeStack } from "../lib/domains/StorefrontEdgeStack";
import { AuthControlPlaneStack } from "../lib/auth/AuthControlPlaneStack";
import { PlatformDomainsStack } from "../lib/domains/PlatformDomainsStack";
import { PlatformEdgeStack } from "../lib/domains/PlatformEdgeStack";

const app = new cdk.App();

const STAGE = (
  app.node.tryGetContext("stage") ??
  process.env.STAGE ??
  "dev"
).toLowerCase();

const PREFIX = `wasit-${STAGE}`;

const account = "226147495990";
const envEU = { account, region: "eu-central-1" };

const TENANT_ROOT_DOMAIN =
  STAGE === "prod" ? "store.eg" : "dev.cairoessentials.com";
const PLATFORM_DOMAIN = "wasit.eg";
const PLATFORM_SUBDOMAINS = ["api", "admin", "god"];

// CloudFront custom domains you want to serve.
// If you also want the apex, add TENANT_ROOT_DOMAIN here too.
const STOREFRONT_DOMAIN_NAMES = [`*.${TENANT_ROOT_DOMAIN}`];

const obs = new ObservabilityStack(app, `${PREFIX}-observability`, {
  env: envEU,
  prefix: PREFIX,
  stage: STAGE,
});

// Tenant-only domains + wildcard cert + tenant-frontend bucket
const tenantDomains = new TenantDomainsStack(app, `${PREFIX}-tenant-domains`, {
  env: envEU,
  stage: STAGE,
  tenantRootDomain: TENANT_ROOT_DOMAIN,
  tenantWildcardDomain: `*.${TENANT_ROOT_DOMAIN}`,
});

// Tenant service owns stores table and exposes /resolve
const tenant = new TenantServiceStack(app, `${PREFIX}-tenant`, {
  env: envEU,
  stage: STAGE,
  prefix: PREFIX,
  logDeliveryStreamArn: obs.logDeliveryStreamArn,
});

// Storefront edge owns CloudFront + Route53 alias pointing wildcard -> CloudFront
new StorefrontEdgeStack(app, `${PREFIX}-storefront-edge`, {
  env: envEU,
  crossRegionReferences: true,
  tenantApiUrl: tenant.apiUrl,
  stage: STAGE,
  logDeliveryStreamArn: obs.logDeliveryStreamArn,
  domainNames: STOREFRONT_DOMAIN_NAMES,
  certificateArn: tenantDomains.tenantWildcardCertArn,
  tenantHostedZone: tenantDomains.tenantZone,
  domainRecordName: "*",
});

new AuthControlPlaneStack(app, `${PREFIX}-auth-controlplane`, {
  env: envEU,
  prefix: PREFIX,
  googleSecretName: `${PREFIX}/google-oauth`,
  createGoogleSecretIfMissing: false,
  enableGoogleIdp: true, // IMPORTANT for now
  callbackUrls: ["http://localhost:3000/auth/callback"],
  logoutUrls: ["http://localhost:3000/"],
});

// Platform domains (OFF for now)
// Creates platform frontend bucket only (no hosted zone, no cert, no DNS wiring).
const platformDomains = new PlatformDomainsStack(app, `${PREFIX}-platform-domains`, {
  env: envEU,
  stage: STAGE, // lifecycle only
  platformDomain: PLATFORM_DOMAIN,
  platformSubdomains: PLATFORM_SUBDOMAINS,
  enablePlatformCustomDomain: false, // <-- switch OFF
});

// Platform edge (ALWAYS ON): creates CloudFront distro in front of platform bucket.
// When enablePlatformCustomDomain=false, this becomes an orphan cloudfront.net distro.
// When you later flip the switch ON, it will auto wire domainNames + cert + Route53.
new PlatformEdgeStack(app, `${PREFIX}-platform-edge`, {
  env: envEU,
  stage: STAGE,
  platformFrontendBucketName: platformDomains.platformFrontendBucket.bucketName,

  // Only wire custom domain if the cert exists (toggle ON)
  domainNames: platformDomains.platformCertArn
    ? [PLATFORM_DOMAIN, ...PLATFORM_SUBDOMAINS.map((s) => `${s}.${PLATFORM_DOMAIN}`)]
    : undefined,
  certificateArn: platformDomains.platformCertArn,
  platformHostedZone: platformDomains.platformZone,
});
