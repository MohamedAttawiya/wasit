// infra/lib/domains/StorefrontEdgeStack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";

import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";

export interface StorefrontEdgeStackProps extends cdk.StackProps {
  tenantApiUrl: string;

  stage: string; // owned by infra.ts

  // Domain config (owned by infra.ts)
  domainNames?: string[];

  // TLS (owned by EdgeDomainsStack, wired by infra.ts)
  certificateArn?: string;

  // Route53 zone (owned by EdgeDomainsStack, wired by infra.ts)
  tenantHostedZone?: route53.IHostedZone;
  domainRecordName?: string; // default "*"

  // Observability wiring (owned by ObservabilityStack)
  logDeliveryStreamArn: string;
}

export class StorefrontEdgeStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: StorefrontEdgeStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();
    const effectiveDomainNames = props.domainNames;

    // ---------------- SSR Lambda ----------------
    const ssrFn = new nodeLambda.NodejsFunction(this, "StorefrontSsrFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: "lambda/storefront-ssr/index.ts",
      handler: "handler",
      environment: {
        TENANT_API_URL: props.tenantApiUrl,
        ENV: stage,
        SERVICE: "storefront-ssr",
      },
    });

    // ---------------- Ensure LogGroup exists (avoid flaky deploy) ----------------
    const ssrLogGroup = new logs.LogGroup(this, "StorefrontSsrLogGroup", {
      logGroupName: `/aws/lambda/${ssrFn.functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy:
        stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ---------------- Observability: CloudWatch Logs -> Firehose (L1) ----------------
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

    const logsSub = new logs.CfnSubscriptionFilter(this, "SsrLogsToFirehose", {
      logGroupName: ssrLogGroup.logGroupName,
      destinationArn: props.logDeliveryStreamArn,
      roleArn: cwLogsToFirehoseRole.roleArn,
      filterPattern: "",
    });

    logsSub.node.addDependency(ssrLogGroup);
    logsSub.node.addDependency(cwLogsToFirehosePolicy);
    logsSub.node.addDependency(cwLogsToFirehoseRole);

    // ---------------- Lambda Function URL origin ----------------
    const fnUrl = ssrFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ---------------- CloudFront policies ----------------
    const cachePolicy = new cloudfront.CachePolicy(this, "NoHostCachePolicy", {
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
    });

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

    const addForwardedHostFn = new cloudfront.Function(
      this,
      "AddXForwardedHostV2",
      {
        code: cloudfront.FunctionCode.fromInline(
          `
function handler(event) {
  var req = event.request;

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

      domainNames: effectiveDomainNames,
      certificate: props.certificateArn
        ? acm.Certificate.fromCertificateArn(
            this,
            "StorefrontCert",
            props.certificateArn
          )
        : undefined,

      comment: `Wasit storefront SSR stub (${stage})`,
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // ---------------- Route53 alias record (owned here) ----------------
    if (
      props.tenantHostedZone &&
      effectiveDomainNames &&
      effectiveDomainNames.length > 0
    ) {
      new route53.ARecord(this, "TenantWildcardAlias", {
        zone: props.tenantHostedZone,
        recordName: props.domainRecordName ?? "*",
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(distribution)
        ),
      });
    }

    // ---------------- Outputs ----------------
    new cdk.CfnOutput(this, "StorefrontCloudFrontDomain", {
      value: distribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, "StorefrontSsrLogGroupName", {
      value: ssrLogGroup.logGroupName,
    });
  }
}
