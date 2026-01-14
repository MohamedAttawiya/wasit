  import * as cdk from "aws-cdk-lib";
  import { Construct } from "constructs";
  import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
  import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
  import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
  import * as lambda from "aws-cdk-lib/aws-lambda";
  import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";

  // ✅ Observability wiring (NO aws-logs-destinations, NO firehose constructs)
  import * as logs from "aws-cdk-lib/aws-logs";
  import * as iam from "aws-cdk-lib/aws-iam";

  export interface TenantServiceStackProps extends cdk.StackProps {
    storesTable: dynamodb.ITable;

    // ✅ Observability wiring (explicit)
    logDeliveryStreamArn: string; // from ObservabilityStack output
    envName?: string; // default: "dev"
  }

  export class TenantServiceStack extends cdk.Stack {
    public readonly apiUrl: string;

    constructor(scope: Construct, id: string, props: TenantServiceStackProps) {
      super(scope, id, props);

      const envName = (props.envName ?? "dev").toLowerCase();

      const fn = new nodeLambda.NodejsFunction(this, "TenantResolveFn", {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: "lambda/tenant-resolve/index.ts",
        handler: "handler",
        environment: {
          STORES_TABLE: props.storesTable.tableName,
          STORES_HOSTNAME_GSI: "gsi_hostname",

          // ✅ helps keep log schema stable
          ENV: envName,
          SERVICE: "tenant-service",
        },
      });

      props.storesTable.grantReadData(fn);
  // ---------------- Observability: CloudWatch Logs -> Firehose (L1) ----------------
  const cwLogsToFirehoseRole = new iam.Role(this, "CwLogsToFirehoseRole", {
    assumedBy: new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
    description: "Allows CloudWatch Logs subscription filter to write into Firehose",
  });

  // Create a managed policy attachment (explicit CFN resource) so we can depend on it
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

  const tenantLogGroupName = `/aws/lambda/${fn.functionName}`;

  const sub = new logs.CfnSubscriptionFilter(this, "TenantLogsToFirehose", {
    logGroupName: tenantLogGroupName,
    destinationArn: props.logDeliveryStreamArn,
    roleArn: cwLogsToFirehoseRole.roleArn,
    filterPattern: "",
  });

  // ✅ Force ordering: policy MUST exist before subscription filter test happens
  sub.node.addDependency(policy);
  sub.node.addDependency(cwLogsToFirehoseRole);


      // ---------------- Existing infra (unchanged) ----------------
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

      // Helpful for debugging wiring
      new cdk.CfnOutput(this, "TenantResolveLogGroupName", {
        value: tenantLogGroupName,
      });
    }
  }
