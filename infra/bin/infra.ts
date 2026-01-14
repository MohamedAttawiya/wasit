#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ObservabilityStack } from "../lib/ObservabilityStack";
import { DataStack } from "../lib/DataStack";

const app = new cdk.App();

new ObservabilityStack(app, "wasit-dev-observability", {
  env: {
    account: "336814728114",
    region: "eu-central-1",
  },
  prefix: "wasit-dev",
});

new DataStack(app, "wasit-dev-data", {
  env: { account: "336814728114", region: "eu-central-1" },
  prefix: "wasit-dev",
});