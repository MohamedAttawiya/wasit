import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";

import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";

export interface TenantServiceStackProps extends cdk.StackProps {
  logDeliveryStreamArn: string;
  stage: string;
}

export class TenantServiceStack extends cdk.Stack {
  public readonly apiUrl: string;
  public readonly storesTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: TenantServiceStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();

    // ---------------- Stores table (owned here) ----------------
    const storesTable = new dynamodb.Table(this, "StoresTable", {
      tableName: "stores",
      partitionKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordType", type: dynamodb.AttributeType.STRING }, // META
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy:
        stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    storesTable.addGlobalSecondaryIndex({
      indexName: "gsi_hostname",
      partitionKey: { name: "hostname", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "storeId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.storesTable = storesTable;

    // ---------------- Lambda ----------------
    const fn = new nodeLambda.NodejsFunction(this, "TenantResolveFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: "lambda/tenant-resolve/index.ts",
      handler: "handler",
      environment: {
        STORES_TABLE: storesTable.tableName,
        STORES_HOSTNAME_GSI: "gsi_hostname",
        ENV: stage,
        SERVICE: "tenant-service",
      },
    });

    storesTable.grantReadData(fn);

    // ---------------- Ensure LogGroup exists ----------------
    const tenantLogGroup = new logs.LogGroup(this, "TenantResolveLogGroup", {
      logGroupName: `/aws/lambda/${fn.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---------------- Logs -> Firehose subscription ----------------
    const cwLogsToFirehoseRole = new iam.Role(this, "CwLogsToFirehoseRole", {
      assumedBy: new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      description:
        "Allows CloudWatch Logs subscription filter to write into Firehose",
    });

    const policy = new iam.Policy(this, "CwLogsToFirehosePolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "firehose:PutRecord",
            "firehose:PutRecordBatch",
            "firehose:DescribeDeliveryStream",
          ],
          resources: [props.logDeliveryStreamArn],
        }),
      ],
    });
    policy.attachToRole(cwLogsToFirehoseRole);

    const sub = new logs.CfnSubscriptionFilter(this, "TenantLogsToFirehose", {
      logGroupName: tenantLogGroup.logGroupName,
      destinationArn: props.logDeliveryStreamArn,
      roleArn: cwLogsToFirehoseRole.roleArn,
      filterPattern: "",
    });

    sub.node.addDependency(tenantLogGroup);
    sub.node.addDependency(policy);
    sub.node.addDependency(cwLogsToFirehoseRole);

    // ---------------- HTTP API ----------------
    const httpApi = new apigwv2.HttpApi(this, "TenantApi", {
      apiName: `tenant-service-${stage}`,
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
    new cdk.CfnOutput(this, "StoresTableName", { value: storesTable.tableName });
    new cdk.CfnOutput(this, "TenantResolveLogGroupName", {
      value: tenantLogGroup.logGroupName,
    });
  }
}
