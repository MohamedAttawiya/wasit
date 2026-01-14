import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

// ✅ Observability wiring (NO aws-logs-destinations, NO firehose constructs)
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";

export interface StorefrontEdgeStackProps extends cdk.StackProps {
  tenantApiUrl: string;
  certificateArn?: string; // OPTIONAL for Phase 1
  domainNames?: string[]; // OPTIONAL for Phase 1

  // ✅ Observability wiring (explicit)
  logDeliveryStreamArn: string; // from ObservabilityStack output
  envName?: string; // default: "dev"
}

export class StorefrontEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StorefrontEdgeStackProps) {
    super(scope, id, props);

    const envName = (props.envName ?? "dev").toLowerCase();

    const ssrFn = new nodeLambda.NodejsFunction(this, "StorefrontSsrFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: "lambda/storefront-ssr/index.ts",
      handler: "handler",
      environment: {
        TENANT_API_URL: props.tenantApiUrl,

        // ✅ helps keep log schema stable
        ENV: envName,
        SERVICE: "storefront-ssr",
      },
    });

// ---------------- Observability: CloudWatch Logs -> Firehose (L1) ----------------
const cwLogsToFirehoseRole = new iam.Role(this, "CwLogsToFirehoseRole", {
  assumedBy: new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
  description: "Allows CloudWatch Logs subscription filter to write into Firehose",
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

const ssrLogGroupName = `/aws/lambda/${ssrFn.functionName}`;

const sub = new logs.CfnSubscriptionFilter(this, "SsrLogsToFirehose", {
  logGroupName: ssrLogGroupName,
  destinationArn: props.logDeliveryStreamArn,
  roleArn: cwLogsToFirehoseRole.roleArn,
  filterPattern: "",
});

// ✅ Force ordering: policy MUST exist before the subscription filter test fires
sub.node.addDependency(policy);
sub.node.addDependency(cwLogsToFirehoseRole);

    // ---------------- Existing infra (unchanged) ----------------
    const fnUrl = ssrFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Cache varies per hostname; do NOT cache across stores
    const cachePolicy = new cloudfront.CachePolicy(this, "NoHostCachePolicy", {
      headerBehavior: cloudfront.CacheHeaderBehavior.none(), // ✅ important
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
    });

    // ✅ DO NOT forward Host to a Lambda Function URL origin.
    // Instead, forward a safe header we set at the edge: x-forwarded-host
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      "ForwardTenantHeaders",
      {
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          "x-forwarded-host",
          "x-correlation-id"
        ),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      }
    );

    // ✅ CloudFront Function: copy viewer Host into x-forwarded-host
    const addForwardedHostFn = new cloudfront.Function(
      this,
      "AddXForwardedHostV2",
      {
        code: cloudfront.FunctionCode.fromInline(
          `
function handler(event) {
  var req = event.request;

  // If caller already provided x-forwarded-host (useful for Phase 0 testing), keep it.
  if (req.headers["x-forwarded-host"] && req.headers["x-forwarded-host"].value) {
    return req;
  }

  // Otherwise derive from viewer Host (real DNS+cert phase)
  var h = req.headers.host && req.headers.host.value ? req.headers.host.value : "";
  if (h) {
    req.headers["x-forwarded-host"] = { value: h };
  }

  return req;
}
        `.trim()
        ),
      }
    );

    const distribution = new cloudfront.Distribution(this, "StorefrontDist", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(
          cdk.Fn.select(2, cdk.Fn.split("/", fnUrl.url)),
          {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }
        ),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy,
        originRequestPolicy,
        functionAssociations: [
          {
            function: addForwardedHostFn,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },

      // Only applied if provided
      domainNames: props.domainNames,
      certificate: props.certificateArn
        ? acm.Certificate.fromCertificateArn(
            this,
            "StorefrontCert",
            props.certificateArn
          )
        : undefined,

      comment: "Wasit storefront SSR stub",
    });

    new cdk.CfnOutput(this, "StorefrontCloudFrontDomain", {
      value: distribution.distributionDomainName,
    });

    // Helpful for debugging wiring
    new cdk.CfnOutput(this, "StorefrontSsrLogGroupName", {
      value: ssrLogGroupName,
    });
  }
}
