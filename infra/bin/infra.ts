#!/usr/bin/env node
// infra/bin/infra.ts
import * as cdk from "aws-cdk-lib";

import { ObservabilityStack } from "../lib/observability/ObservabilityStack";
import { AuthControlPlaneStack } from "../lib/auth/AuthControlPlaneStack";

import { PlatformDomainsEuStack } from "../lib/domains/platform/PlatformDomainsEuStack";
import { PlatformCertsUsEast1Stack } from "../lib/domains/platform/PlatformCertsUsEast1Stack";

import { StorefrontDomainsEuStack } from "../lib/domains/storefront/StorefrontDomainsEuStack";
import { StorefrontCertsUsEast1Stack } from "../lib/domains/storefront/StorefrontCertsUsEast1Stack";

const app = new cdk.App();

/* ========================================================================
 * 1) CONFIGURATION (NO LOGIC — literals only)
 * ====================================================================== */

const CFG_STAGE = "dev";
const CFG_APP_NAME = "wasit";

const CFG_ACCOUNT_ID = "267949707488";
const CFG_PRIMARY_REGION = "eu-central-1";
const CFG_US_EAST_1_REGION = "us-east-1";

// Domains: infra owns ONLY the root domain names
const CFG_PLATFORM_ROOT_DOMAIN = "wasit-platform.shop";
const CFG_STOREFRONT_ROOT_DOMAIN = "cairoessentials.com";

/* ========================================================================
 * 2) DERIVED VALUES (logic allowed)
 * ====================================================================== */

const STAGE =
  (app.node.tryGetContext("stage") ?? process.env.STAGE ?? CFG_STAGE).toLowerCase();

const PREFIX = `${CFG_APP_NAME}-${STAGE}`;

const ACCOUNT =
  process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID ?? CFG_ACCOUNT_ID;

// keep primary region deterministic unless explicitly overridden by CDK
const REGION =
  process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? CFG_PRIMARY_REGION;

const envPrimary = { account: ACCOUNT, region: REGION };
const envUsEast1 = { account: ACCOUNT, region: CFG_US_EAST_1_REGION };

/* ========================================================================
 * 3) STACK INSTANTIATION (wiring only)
 * ====================================================================== */

// Observability (independent, deploy first)
const obs = new ObservabilityStack(app, `${PREFIX}-observability`, {
  env: envPrimary,
  prefix: PREFIX,
  stage: STAGE,
});

// Platform domains (EU): HostedZone + regional certs + hostnames
const platformDomainsEu = new PlatformDomainsEuStack(app, `${PREFIX}-platform-domains-eu`, {
  env: envPrimary,
  crossRegionReferences: true,
  stage: STAGE,
  platformRootDomain: CFG_PLATFORM_ROOT_DOMAIN,
});

// Platform certs (US): wildcard + auth cert in us-east-1 (CloudFront-backed custom domains)
const platformCertsUs = new PlatformCertsUsEast1Stack(app, `${PREFIX}-platform-certs-us-east-1`, {
  env: envUsEast1,
  crossRegionReferences: true,
  stage: STAGE,
  platformHostedZoneId: platformDomainsEu.platformHostedZoneId,
  platformRootDomain: platformDomainsEu.platformRootDomain,
});

// Storefront domains (EU): HostedZone + hostnames
const storefrontDomainsEu = new StorefrontDomainsEuStack(
  app,
  `${PREFIX}-storefront-domains-eu`,
  {
    env: envPrimary,
    crossRegionReferences: true,
    stage: STAGE,
    storefrontRootDomain: CFG_STOREFRONT_ROOT_DOMAIN,
  }
);

// Storefront certs (US): wildcard cert in us-east-1 for CloudFront
const storefrontCertsUs = new StorefrontCertsUsEast1Stack(
  app,
  `${PREFIX}-storefront-certs-us-east-1`,
  {
    env: envUsEast1,
    crossRegionReferences: true,
    stage: STAGE,
    storefrontHostedZoneId: storefrontDomainsEu.storefrontHostedZoneId,
    storefrontRootDomain: storefrontDomainsEu.storefrontRootDomain,
  }
);

// Auth owns: Cognito + auth tables + auth API (/me + /admin/*)
const auth = new AuthControlPlaneStack(app, `${PREFIX}-auth`, {
  env: envPrimary,
  crossRegionReferences: true,

  prefix: PREFIX,
  stage: STAGE,

  corsAllowOrigins: [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://admin.wasit-platform.shop",
    "https://internal.wasit-platform.shop",
  ],

  callbackUrls: [
    "http://localhost:5173/callback",
    "http://localhost:3000/callback",
    "https://admin.wasit-platform.shop/callback",
    "https://internal.wasit-platform.shop/callback",
  ],
  logoutUrls: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://admin.wasit-platform.shop",
    "https://internal.wasit-platform.shop",
  ],

  authSubdomain: "auth",
  platformRootDomain: CFG_PLATFORM_ROOT_DOMAIN,
  platformHostedZoneId: platformDomainsEu.platformHostedZoneId,

  /**
   * FIX:
   * Cognito UserPool custom domain is CloudFront-backed → cert must be in us-east-1.
   */
  platformAuthCertArnUsEast1: platformCertsUs.authCertArnUsEast1,

  /**
   * Optional wildcard for future edge needs.
   */
  platformWildcardCertArnUsEast1: platformCertsUs.wildcardCertArnUsEast1,
});

/* ========================================================================
 * 4) DEPENDENCIES (explicit)
 * ====================================================================== */

platformDomainsEu.addDependency(obs);
platformCertsUs.addDependency(platformDomainsEu);

storefrontDomainsEu.addDependency(obs);
storefrontCertsUs.addDependency(storefrontDomainsEu);

auth.addDependency(platformDomainsEu);
auth.addDependency(platformCertsUs);

// Optional: if Auth will later reference storefront outputs, wire it then.
// auth.addDependency(storefrontDomainsEu);
// auth.addDependency(storefrontCertsUs);
