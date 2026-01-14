import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface StorefrontEdgeStackProps extends cdk.StackProps {
  tenantApiUrl: string;
  certificateArn: string; // from CertStack (us-east-1)
  domainNames: string[];  // ["*.store.eg", "store.eg"] (optional)
}

export class StorefrontEdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StorefrontEdgeStackProps) {
    super(scope, id, props);

    const ssrFn = new nodeLambda.NodejsFunction(this, "StorefrontSsrFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: "lambda/storefront-ssr/index.ts",
      handler: "handler",
      environment: {
        TENANT_API_URL: props.tenantApiUrl,
      },
    });

    const fnUrl = ssrFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    const cert = acm.Certificate.fromCertificateArn(
      this,
      "StorefrontCert",
      props.certificateArn
    );

    // Cache varies per hostname; do NOT cache across stores
    const cachePolicy = new cloudfront.CachePolicy(this, "PerHostCachePolicy", {
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList("host"),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      defaultTtl: cdk.Duration.seconds(30), // tiny TTL for now
      maxTtl: cdk.Duration.minutes(5),
      minTtl: cdk.Duration.seconds(0),
    });

    const originRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      "ForwardHostHeader",
      {
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList("host"),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      }
    );

    const distribution = new cloudfront.Distribution(this, "StorefrontDist", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(
          cdk.Fn.select(2, cdk.Fn.split("/", fnUrl.url)), // extracts domain from Function URL
          {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }
        ),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy,
        originRequestPolicy,
      },
      domainNames: props.domainNames,
      certificate: cert,
      comment: "Wasit storefront SSR stub",
    });

    new cdk.CfnOutput(this, "StorefrontCloudFrontDomain", {
      value: distribution.distributionDomainName,
    });
  }
}
