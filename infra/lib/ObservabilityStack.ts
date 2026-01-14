import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface ObservabilityStackProps extends cdk.StackProps {
  prefix: string;
}

export class ObservabilityStack extends cdk.Stack {
  public readonly logArchiveBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    this.logArchiveBucket = new s3.Bucket(this, "LogArchiveBucket", {
      bucketName: `${props.prefix}-logs-${this.account}-${this.region}`.toLowerCase(),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,

      // dev-friendly
      versioned: false,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new cdk.CfnOutput(this, "LogArchiveBucketName", {
      value: this.logArchiveBucket.bucketName,
    });
  }
}
