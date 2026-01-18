import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";

export interface AuthzSmokeStackProps extends cdk.StackProps {
  prefix: string;
}

export class AuthzSmokeStack extends cdk.Stack {
  public readonly smokeFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: AuthzSmokeStackProps) {
    super(scope, id, props);

    this.smokeFn = new NodejsFunction(this, "SmokeAuthFn", {
      functionName: `${props.prefix}-authz-smoke`,
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: "lambda/_smoke-auth/index.ts",
      handler: "handler",
      environment: {
        SMOKE_GROUP: "Seller",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node20",
        sourceMap: true,
        minify: false,
        externalModules: [],
      },
    });

    new cdk.CfnOutput(this, "SmokeAuthFnName", {
      value: this.smokeFn.functionName,
    });
  }
}
