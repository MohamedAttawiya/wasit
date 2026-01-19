import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";

export interface PlatformConfigStackProps extends cdk.StackProps {
  stage: string;

  platformFrontendBucketName: string;

  authConfig: {
    clientId: string;
    apiBaseUrl: string;
    userPoolId: string;
    issuer?: string;
    cognitoDomain?: string;
  };
}

export class PlatformConfigStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlatformConfigStackProps) {
    super(scope, id, props);

    const bucket = s3.Bucket.fromBucketName(
      this,
      "PlatformFrontendBucket",
      props.platformFrontendBucketName
    );

    const authJson = JSON.stringify(
    {
        clientID: props.authConfig.clientId,
        apiBaseUrl: props.authConfig.apiBaseUrl,
        userPoolId: props.authConfig.userPoolId,
        issuer: props.authConfig.issuer,
        cognitoDomain: props.authConfig.cognitoDomain,

        // ✅ Forces CFN update so BucketDeployment runs
        deployedAt: new Date().toISOString(),
    },
    null,
    2
    );


    new s3deploy.BucketDeployment(this, "DeployAuthJson", {
      destinationBucket: bucket,
      sources: [s3deploy.Source.data("auth.json", authJson)],
      // no prune needed; this deployment owns exactly one key
      prune: false,
    });

    new cdk.CfnOutput(this, "AuthJsonPublished", {
      value: `s3://${props.platformFrontendBucketName}/auth.json`,
      exportName: `wasit-${props.stage.toLowerCase()}-platform-auth-json`,
    });
  }
}
