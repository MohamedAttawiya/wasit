import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as s3 from "aws-cdk-lib/aws-s3";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";

export interface PlatformDomainsStackProps extends cdk.StackProps {
  stage: string;

  platformDomain: string; // e.g. "wasit.eg"
  platformSubdomains?: string[]; // e.g. ["api","admin","god"]

  enablePlatformCustomDomain?: boolean;
}

export class PlatformDomainsStack extends cdk.Stack {
  public readonly platformFrontendBucket: s3.Bucket;

  // Optional: only set when enablePlatformCustomDomain=true
  public readonly platformZone?: route53.IHostedZone;
  public readonly platformCertArn?: string;

  constructor(scope: Construct, id: string, props: PlatformDomainsStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();
    const enable = props.enablePlatformCustomDomain ?? false;

    // Always: platform frontend bucket
    this.platformFrontendBucket = new s3.Bucket(this, "PlatformFrontendBucket", {
      bucketName: `wasit-${stage}-platform-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy:
        stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage === "prod" ? false : true,
    });

    // Auto-upload local platform-frontend -> S3 on deploy
    new s3deploy.BucketDeployment(this, "DeployPlatformFrontend", {
      destinationBucket: this.platformFrontendBucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../../platform-frontend"))],
    });

    new cdk.CfnOutput(this, "PlatformFrontendBucketName", {
      value: this.platformFrontendBucket.bucketName,
      exportName: `wasit-${stage}-platform-frontend-bucket`,
    });

    if (!enable) {
      new cdk.CfnOutput(this, "PlatformCustomDomainEnabled", {
        value: "false",
        exportName: `wasit-${stage}-platform-custom-domain-enabled`,
      });
      return;
    }

    // Hosted Zone (only when enabled)
    const zone = new route53.PublicHostedZone(this, "PlatformZone", {
      zoneName: props.platformDomain,
    });
    this.platformZone = zone;

    // Certificate MUST be us-east-1 for CloudFront
    const altNames =
      props.platformSubdomains?.map((s) => `${s}.${props.platformDomain}`) ?? [];

    const cert = new acm.DnsValidatedCertificate(this, "PlatformCertUsEast1", {
      domainName: props.platformDomain,
      subjectAlternativeNames: altNames.length ? altNames : undefined,
      hostedZone: zone,
      region: "us-east-1",
    });
    this.platformCertArn = cert.certificateArn;

    new cdk.CfnOutput(this, "PlatformCustomDomainEnabled", {
      value: "true",
      exportName: `wasit-${stage}-platform-custom-domain-enabled`,
    });

    new cdk.CfnOutput(this, "PlatformHostedZoneId", {
      value: zone.hostedZoneId,
      exportName: `wasit-${stage}-platform-zone-id`,
    });

    new cdk.CfnOutput(this, "PlatformHostedZoneName", {
      value: zone.zoneName,
      exportName: `wasit-${stage}-platform-zone-name`,
    });

    new cdk.CfnOutput(this, "PlatformCertArnUsEast1", {
      value: cert.certificateArn,
      exportName: `wasit-${stage}-platform-cert-arn-us-east-1`,
    });
  }
}
