#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { ObservabilityStack } from "../lib/observability/ObservabilityStack";
import { TenantDomainsStack } from "../lib/domains/TenantDomainsStack";
import { TenantServiceStack } from "../lib/domains/TenantServiceStack";
import { StorefrontEdgeStack } from "../lib/domains/StorefrontEdgeStack";
import { AuthControlPlaneStack } from "../lib/auth/AuthControlPlaneStack";
import { PlatformDomainsStack } from "../lib/domains/PlatformDomainsStack";
import { PlatformEdgeStack } from "../lib/domains/PlatformEdgeStack";
import { PlatformConfigStack } from "../lib/domains/PlatformConfigStack";


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


// ------------------------------
// Platform: bucket + (optional) zone/cert
// ------------------------------
const platformDomains = new PlatformDomainsStack(
  app,
  `${PREFIX}-platform-domains`,
  {
    env: envEU,
    stage: STAGE,
    platformDomain: PLATFORM_DOMAIN,
    platformSubdomains: PLATFORM_SUBDOMAINS,
    enablePlatformCustomDomain: false,
    // NOTE: Do NOT pass authConfig here anymore if you want auth callback to come from Edge.
    // We'll wire authConfig after auth exists (requires a small split stack), or you keep it fixed.
  }
);

// ------------------------------
// Platform Edge: CloudFront in front of platform bucket
// ------------------------------
const platformEdge = new PlatformEdgeStack(app, `${PREFIX}-platform-edge`, {
  env: envEU,
  stage: STAGE,
  platformFrontendBucketName: platformDomains.platformFrontendBucket.bucketName,
  domainNames: platformDomains.platformCertArn
    ? [
        PLATFORM_DOMAIN,
        ...PLATFORM_SUBDOMAINS.map((s) => `${s}.${PLATFORM_DOMAIN}`),
      ]
    : undefined,
  certificateArn: platformDomains.platformCertArn,
  platformHostedZone: platformDomains.platformZone,
});

// ------------------------------
// Auth: callback/logout URLs derived from the PlatformEdge distribution domain
// ------------------------------
const platformCallbackUrl = `https://${platformEdge.distributionDomainName}/index.html`;
const platformOrigin = `https://${platformEdge.distributionDomainName}`;
const auth = new AuthControlPlaneStack(app, `${PREFIX}-auth-controlplane`, {
  env: envEU,
  prefix: PREFIX,

  googleSecretName: `${PREFIX}/google-oauth`,
  createGoogleSecretIfMissing: false,

  enableGoogleIdp: false,

  // ✅ derived from creator (PlatformEdgeStack)
  callbackUrls: [platformCallbackUrl],
  logoutUrls: [platformCallbackUrl],

  // ✅ NEW: dynamic CORS (plus local dev)
  corsAllowOrigins: [
    "http://localhost:3000",
    "http://localhost:5173",
    platformOrigin,
  ],
});

// Ensure the CloudFront domain is available for the callback URL token
auth.addDependency(platformEdge);


const platformConfig = new PlatformConfigStack(app, `${PREFIX}-platform-config`, {
  env: envEU,
  stage: STAGE,
  platformFrontendBucketName: platformDomains.platformFrontendBucket.bucketName,
  authConfig: {
    clientId: auth.webClient.userPoolClientId,
    apiBaseUrl: auth.httpApi.apiEndpoint,
    userPoolId: auth.userPool.userPoolId,
    issuer: auth.issuer,
    cognitoDomain: auth.cognitoHostedDomain,
  },
});

platformConfig.addDependency(platformDomains);
platformConfig.addDependency(auth);
