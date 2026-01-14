#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ObservabilityStack } from "../lib/ObservabilityStack";
import { DataStack } from "../lib/DataStack";

// NEW
import { CertStack } from "../lib/CertStack";
import { TenantServiceStack } from "../lib/TenantServiceStack";
import { StorefrontEdgeStack } from "../lib/StorefrontEdgeStack";

const app = new cdk.App();

const account = "336814728114";
const envEU = { account, region: "eu-central-1" };
const envUSE1 = { account, region: "us-east-1" };

// ✅ Observability first (exports Firehose ARN + bucket)
const obs = new ObservabilityStack(app, "wasit-dev-observability", {
  env: envEU,
  prefix: "wasit-dev",
  envName: "dev",
});

const data = new DataStack(app, "wasit-dev-data", {
  env: envEU,
  prefix: "wasit-dev",
});

// CloudFront cert MUST be in us-east-1
const cert = new CertStack(app, "wasit-dev-cert", {
  env: envUSE1,
  domainName: "cairoessentials.com",
});

// Tenant resolution API (reads Stores table + gsi_hostname)
const tenant = new TenantServiceStack(app, "wasit-dev-tenant", {
  env: envEU,
  storesTable: data.storesTable,

  // ✅ wire observability (L1 Firehose ARN from ObservabilityStack)
  envName: "dev",
  logDeliveryStreamArn: obs.logDeliveryStreamArn,
});

// CloudFront + SSR stub (Host header → tenant API → placeholder HTML)
new StorefrontEdgeStack(app, "wasit-dev-storefront-edge", {
  env: envEU,
  crossRegionReferences: true, // ← keep

  tenantApiUrl: tenant.apiUrl,

  // ✅ wire observability (L1 Firehose ARN from ObservabilityStack)
  envName: "dev",
  logDeliveryStreamArn: obs.logDeliveryStreamArn,

  //certificateArn: cert.certificateArn,
  //domainNames: ["*.store.eg", "store.eg"],
});
