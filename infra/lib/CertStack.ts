import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";

export interface CertStackProps extends cdk.StackProps {
  hostedZoneDomain: string;  // "store.eg"
}

export class CertStack extends cdk.Stack {
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: props.hostedZoneDomain,
    });

    const cert = new acm.DnsValidatedCertificate(this, "WildcardCert", {
      domainName: `*.${props.hostedZoneDomain}`,
      hostedZone: zone,
      region: "us-east-1", // critical for CloudFront
      subjectAlternativeNames: [props.hostedZoneDomain],
    });

    this.certificateArn = cert.certificateArn;

    new cdk.CfnOutput(this, "StorefrontCertArn", {
      value: this.certificateArn,
    });
  }
}
