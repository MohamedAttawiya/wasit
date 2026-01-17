// lib/StorefrontEdgeStack.ts
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

  // ✅ Real DNS + TLS phase
  certificateArn?: string;
  domainNames?: string[];

  // ✅ Observability wiring (explicit)
  logDeliveryStreamArn: string; // from ObservabilityStack output
  envName?: string; // default: "dev"
}

export class StorefrontEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StorefrontEdgeStackProps) {
    super(scope, id, props);

    const envName = (props.envName ?? "dev").toLowerCase();

    // ---------------- SSR Lambda ----------------
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
    // CloudWatch Logs service principal is region-scoped
    const cwLogsToFirehoseRole = new iam.Role(this, "CwLogsToFirehoseRole", {
      assumedBy: new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      description:
        "Allows CloudWatch Logs subscription filter to write into Firehose",
    });

    const cwLogsToFirehosePolicy = new iam.Policy(
      this,
      "CwLogsToFirehosePolicy",
      {
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
      }
    );
    cwLogsToFirehosePolicy.attachToRole(cwLogsToFirehoseRole);

    const ssrLogGroupName = `/aws/lambda/${ssrFn.functionName}`;

    const sub = new logs.CfnSubscriptionFilter(this, "SsrLogsToFirehose", {
      logGroupName: ssrLogGroupName,
      destinationArn: props.logDeliveryStreamArn,
      roleArn: cwLogsToFirehoseRole.roleArn,
      filterPattern: "",
    });

    // ✅ Force ordering: role + policy MUST exist before CW Logs tests subscription
    sub.node.addDependency(cwLogsToFirehosePolicy);
    sub.node.addDependency(cwLogsToFirehoseRole);

    // ---------------- Lambda Function URL origin ----------------
    const fnUrl = ssrFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ---------------- CloudFront policies ----------------
    // ✅ Don’t cache across stores; keep it zero TTL for now
    const cachePolicy = new cloudfront.CachePolicy(this, "NoHostCachePolicy", {
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
    });

    // ✅ DO NOT forward Host to Lambda Function URL origin.
    // Forward only safe headers we control.
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

    // ✅ CloudFront Function: copy viewer Host into x-forwarded-host (unless already provided)
    const addForwardedHostFn = new cloudfront.Function(
      this,
      "AddXForwardedHostV2",
      {
        code: cloudfront.FunctionCode.fromInline(
          `
function handler(event) {
  var req = event.request;

  // Keep explicit x-forwarded-host (useful for early header-based tests)
  if (req.headers["x-forwarded-host"] && req.headers["x-forwarded-host"].value) {
    return req;
  }

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

    // Function URL looks like: https://abcde.lambda-url.eu-central-1.on.aws/
    const fnUrlHost = cdk.Fn.select(2, cdk.Fn.split("/", fnUrl.url));

    // ---------------- CloudFront distribution ----------------
    const distribution = new cloudfront.Distribution(this, "StorefrontDist", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(fnUrlHost, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
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

      // ✅ Applied only when provided (real DNS + TLS phase)
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

    new cdk.CfnOutput(this, "StorefrontSsrLogGroupName", {
      value: ssrLogGroupName,
    });
  }
}
