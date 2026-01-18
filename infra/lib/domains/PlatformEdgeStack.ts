import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";

import * as s3 from "aws-cdk-lib/aws-s3";

export interface PlatformEdgeStackProps extends cdk.StackProps {
  stage: string;

  // IMPORTANT: pass NAME only to avoid cross-stack cycles
  platformFrontendBucketName: string;

  // Optional: only when you own the domain
  domainNames?: string[];
  certificateArn?: string;

  platformHostedZone?: route53.IHostedZone;

  spaFallbackToIndex?: boolean;
}

export class PlatformEdgeStack extends cdk.Stack {
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: PlatformEdgeStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();
    const spaFallback = props.spaFallbackToIndex ?? true;

    // Import bucket by name (breaks CFN token dependency)
    const bucket = s3.Bucket.fromBucketName(
      this,
      "PlatformFrontendBucket",
      props.platformFrontendBucketName
    );

    const distribution = new cloudfront.Distribution(this, "PlatformDist", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },

      // Switchable: undefined => orphan cloudfront.net distro
      domainNames: props.domainNames?.length ? props.domainNames : undefined,
      certificate: props.certificateArn
        ? acm.Certificate.fromCertificateArn(this, "PlatformCert", props.certificateArn)
        : undefined,

      comment: `Wasit platform admin UI (${stage})`,

      // SPA fallback (optional)
      defaultRootObject: "index.html",
      errorResponses: spaFallback
        ? [
            {
              httpStatus: 403,
              responseHttpStatus: 200,
              responsePagePath: "/index.html",
              ttl: cdk.Duration.seconds(0),
            },
            {
              httpStatus: 404,
              responseHttpStatus: 200,
              responsePagePath: "/index.html",
              ttl: cdk.Duration.seconds(0),
            },
          ]
        : undefined,
    });

    this.distributionDomainName = distribution.distributionDomainName;

    // ---- CRITICAL: explicit bucket policy for OAC ----
    // Because the bucket is imported by name, CDK can't auto-attach the bucket policy.
    // This policy allows only this CloudFront distribution to read objects.
    new s3.CfnBucketPolicy(this, "PlatformBucketPolicyForOAC", {
      bucket: props.platformFrontendBucketName,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCloudFrontReadViaOAC",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${props.platformFrontendBucketName}/*`,
            Condition: {
              StringEquals: {
                "AWS:SourceArn": `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
              },
            },
          },
        ],
      },
    });

    // Optional DNS wiring (only if you own/manage the domain)
    if (props.platformHostedZone && props.domainNames?.length) {
      for (const dn of props.domainNames) {
        const zoneName = props.platformHostedZone.zoneName.replace(/\.$/, "");
        const fqdn = dn.replace(/\.$/, "");

        const recordName =
          fqdn === zoneName
            ? undefined
            : fqdn.endsWith(`.${zoneName}`)
              ? fqdn.slice(0, -(zoneName.length + 1))
              : fqdn;

        new route53.ARecord(this, `PlatformAliasA-${fqdn}`, {
          zone: props.platformHostedZone,
          recordName,
          target: route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(distribution)
          ),
        });

        new route53.AaaaRecord(this, `PlatformAliasAAAA-${fqdn}`, {
          zone: props.platformHostedZone,
          recordName,
          target: route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(distribution)
          ),
        });
      }
    }

    new cdk.CfnOutput(this, "PlatformCloudFrontDomain", {
      value: distribution.distributionDomainName,
    });

    new cdk.CfnOutput(this, "PlatformCustomDomainEnabled", {
      value: props.domainNames?.length && props.certificateArn ? "true" : "false",
    });
  }
}
