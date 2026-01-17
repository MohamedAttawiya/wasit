// infra/lib/domains/PlatformDomainsStack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface PlatformDomainsStackProps extends cdk.StackProps {
  platformDomain: string; // e.g. wasit.eg
  platformSubdomains?: string[]; // ["api", "admin", "god"]

  // naming/ops
  stage: string; // "dev" | "prod" | ...
}

export class PlatformDomainsStack extends cdk.Stack {
  public readonly platformZone: route53.IHostedZone;
  public readonly platformCertArn: string;
  public readonly platformFrontendBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: PlatformDomainsStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();

    // ---------------- Hosted Zone ----------------
    const platformZone = new route53.PublicHostedZone(this, "PlatformZone", {
      zoneName: props.platformDomain,
    });
    this.platformZone = platformZone;

    // ---------------- Certificate ----------------
    const platformAltNames =
      props.platformSubdomains?.map((s) => `${s}.${props.platformDomain}`) ?? [];

    const platformCert = new acm.Certificate(this, "PlatformCert", {
      domainName: props.platformDomain,
      subjectAlternativeNames: platformAltNames.length ? platformAltNames : undefined,
      validation: acm.CertificateValidation.fromDns(platformZone),
    });

    this.platformCertArn = platformCert.certificateArn;

    // ---------------- Frontend Bucket (platform-frontend) ----------------
    const platformFrontendBucket = new s3.Bucket(this, "PlatformFrontendBucket", {
      bucketName: `wasit-${stage}-platform-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy:
        stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage === "prod" ? false : true,
    });

    this.platformFrontendBucket = platformFrontendBucket;

    // ---------------- Outputs ----------------
    new cdk.CfnOutput(this, "PlatformCertArn", { value: platformCert.certificateArn });
    new cdk.CfnOutput(this, "PlatformHostedZoneId", { value: platformZone.hostedZoneId });
    new cdk.CfnOutput(this, "PlatformHostedZoneName", { value: platformZone.zoneName });
    new cdk.CfnOutput(this, "PlatformFrontendBucketName", {
      value: platformFrontendBucket.bucketName,
    });
  }
}
