#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { ObservabilityStack } from "../lib/observability/ObservabilityStack";
import { TenantDomainsStack } from "../lib/domains/TenantDomainsStack";
import { TenantServiceStack } from "../lib/domains/TenantServiceStack";
import { StorefrontEdgeStack } from "../lib/domains/StorefrontEdgeStack";

// Optional (keep disabled for now)
// import { PlatformDomainsStack } from "../lib/domains/PlatformDomainsStack";

const app = new cdk.App();

const STAGE = (
  app.node.tryGetContext("stage") ??
  process.env.STAGE ??
  "dev"
).toLowerCase();

const PREFIX = `wasit-${STAGE}`;

const account = "226147495990";
const envEU = { account, region: "eu-central-1" };

const TENANT_ROOT_DOMAIN = STAGE === "prod" ? "store.eg" : "dev.cairoessentials.com";

// CloudFront custom domains you want to serve.
// If you also want the apex, add TENANT_ROOT_DOMAIN here too.
const STOREFRONT_DOMAIN_NAMES = [`*.${TENANT_ROOT_DOMAIN}`];

const obs = new ObservabilityStack(app, `${PREFIX}-observability`, {
  env: envEU,
  prefix: PREFIX,
});

// Tenant-only domains + wildcard cert + tenant-frontend bucket
const tenantDomains = new TenantDomainsStack(app, `${PREFIX}-tenant-domains`, {
  env: envEU,
  stage: STAGE,
  tenantRootDomain: TENANT_ROOT_DOMAIN,
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
