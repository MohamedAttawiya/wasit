import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface CertStackProps extends cdk.StackProps {
  domainName: string; // "cairoessentials.com"
}

export class CertStack extends cdk.Stack {
  public readonly certificateArn: string;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);

    const cert = new acm.Certificate(this, "WildcardCert", {
      domainName: `*.${props.domainName}`,
      subjectAlternativeNames: [props.domainName],
      validation: acm.CertificateValidation.fromDns(), // manual
    });

    this.certificateArn = cert.certificateArn;

    new cdk.CfnOutput(this, "CertArn", {
      value: cert.certificateArn,
    });
  }
}
