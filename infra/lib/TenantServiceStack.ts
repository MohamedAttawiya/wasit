import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";

export interface TenantServiceStackProps extends cdk.StackProps {
  storesTable: dynamodb.ITable;
}

export class TenantServiceStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: TenantServiceStackProps) {
    super(scope, id, props);

    const fn = new nodeLambda.NodejsFunction(this, "TenantResolveFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: "lambda/tenant-resolve/index.ts",
      handler: "handler",
      environment: {
        STORES_TABLE: props.storesTable.tableName,
        STORES_HOSTNAME_GSI: "gsi_hostname",
      },
    });

    props.storesTable.grantReadData(fn);

    const httpApi = new apigwv2.HttpApi(this, "TenantApi", {
      apiName: "tenant-service",
    });

    httpApi.addRoutes({
      path: "/resolve",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "ResolveIntegration",
        fn
      ),
    });

    this.apiUrl = httpApi.apiEndpoint;

    new cdk.CfnOutput(this, "TenantApiUrl", { value: this.apiUrl });
  }
}
