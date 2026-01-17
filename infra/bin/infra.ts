#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ObservabilityStack } from "../lib/observability/ObservabilityStack";

// --- NON-OBSERVABILITY (COMMENTED OUT) ---
// import { DataStack } from "../lib/DataStack";
// import { CertStack } from "../lib/CertStack";
// import { TenantServiceStack } from "../lib/TenantServiceStack";
// import { StorefrontEdgeStack } from "../lib/StorefrontEdgeStack";

const app = new cdk.App();

// ---- Stage is owned HERE (single source of truth) ----
const STAGE = (app.node.tryGetContext("stage") ?? process.env.STAGE ?? "dev").toLowerCase();
const PREFIX = `wasit-${STAGE}`;

// ---- Account/regions ----
const account = "226147495990";
const envEU = { account, region: "eu-central-1" };

// --- NON-OBSERVABILITY (COMMENTED OUT) ---
// const envUSE1 = { account, region: "us-east-1" };

// ---- Domain config (can later be stage-aware) ----
// const DOMAIN = "cairoessentials.com";
// const DOMAIN_NAMES = [`*.${DOMAIN}`, DOMAIN];

// ✅ Observability first (exports Firehose ARN + bucket)
const obs = new ObservabilityStack(app, `${PREFIX}-observability`, {
  env: envEU,
  prefix: PREFIX,
});

// --- NON-OBSERVABILITY STACKS (COMMENTED OUT) ---
// const data = new DataStack(app, `${PREFIX}-data`, {
//   env: envEU,
//   prefix: PREFIX,
// });

// const cert = new CertStack(app, `${PREFIX}-cert`, {
//   env: envUSE1,
//   domainName: DOMAIN,
// });

// const tenant = new TenantServiceStack(app, `${PREFIX}-tenant`, {
//   env: envEU,
//   storesTable: data.storesTable,
//   envName: STAGE,
//   logDeliveryStreamArn: obs.logDeliveryStreamArn,
// });

// new StorefrontEdgeStack(app, `${PREFIX}-storefront-edge`, {
//   env: envEU,
//   crossRegionReferences: true,
//   tenantApiUrl: tenant.apiUrl,
//   envName: STAGE,
//   logDeliveryStreamArn: obs.logDeliveryStreamArn,
//   certificateArn: cert.certificateArn,
//   domainNames: DOMAIN_NAMES,
// });
