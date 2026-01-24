#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ObservabilityStack } from "../lib/observability/ObservabilityStack";
import { PlatformDomainsStack } from "../lib/domains/PlatformDomainsStack";
import { StorefrontDomainsStack } from "../lib/domains/StorefrontDomainsStack";

const app = new cdk.App();

/* ========================================================================
 * 1) CONFIGURATION (NO LOGIC — literals only)
 * ====================================================================== */

const CFG_STAGE = "dev";
const CFG_APP_NAME = "wasit";

const CFG_ACCOUNT_ID = "267949707488";
const CFG_PRIMARY_REGION = "eu-central-1";

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

const REGION =
  process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? CFG_PRIMARY_REGION;

const envPrimary = { account: ACCOUNT, region: REGION };

/* ========================================================================
 * 3) STACK INSTANTIATION (wiring only)
 * ====================================================================== */

new ObservabilityStack(app, `${PREFIX}-observability`, {
  env: envPrimary,
  prefix: PREFIX,
  stage: STAGE,
});

new PlatformDomainsStack(app, `${PREFIX}-platform-domains`, {
  env: envPrimary,
  stage: STAGE,
  platformRootDomain: CFG_PLATFORM_ROOT_DOMAIN,
});

new StorefrontDomainsStack(app, `${PREFIX}-storefront-domains`, {
  env: envPrimary,
  stage: STAGE,
  storefrontRootDomain: CFG_STOREFRONT_ROOT_DOMAIN,
});
