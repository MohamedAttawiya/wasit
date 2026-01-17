// infra/lib/domains/TenantDomainsStack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface TenantDomainsStackProps extends cdk.StackProps {
  tenantRootDomain: string; // store.eg or cairoessentials.com
  stage: string; // dev/prod
}

export class TenantDomainsStack extends cdk.Stack {
  public readonly tenantZone: route53.IHostedZone;
  public readonly tenantWildcardCertArn: string;
  public readonly tenantFrontendBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: TenantDomainsStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();

    const tenantZone = new route53.PublicHostedZone(this, "TenantZone", {
      zoneName: props.tenantRootDomain,
    });
    this.tenantZone = tenantZone;

    // CloudFront requires the cert in us-east-1
    const tenantWildcardCert = new acm.DnsValidatedCertificate(
      this,
      "TenantWildcardCert",
      {
        domainName: `*.${props.tenantRootDomain}`,
        hostedZone: tenantZone,
        region: "us-east-1",
      }
    );

    this.tenantWildcardCertArn = tenantWildcardCert.certificateArn;

    const tenantFrontendBucket = new s3.Bucket(this, "TenantFrontendBucket", {
      bucketName: `wasit-${stage}-tenant-frontend-${this.account}-${this.region}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy:
        stage === "prod" ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage === "prod" ? false : true,
    });
    this.tenantFrontendBucket = tenantFrontendBucket;

    new cdk.CfnOutput(this, "TenantWildcardCertArn", {
      value: tenantWildcardCert.certificateArn,
    });

    new cdk.CfnOutput(this, "TenantHostedZoneId", {
      value: tenantZone.hostedZoneId,
    });

    new cdk.CfnOutput(this, "TenantHostedZoneName", {
      value: tenantZone.zoneName,
    });

    new cdk.CfnOutput(this, "TenantFrontendBucketName", {
      value: tenantFrontendBucket.bucketName,
    });
  }
}
