// infra/lib/domains/storefront/StorefrontCertsUsEast1Stack.ts
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface StorefrontCertsUsEast1StackProps extends cdk.StackProps {
  stage: string;

  /**
   * Hosted Zone attributes exported from StorefrontDomainsEuStack
   */
  storefrontHostedZoneId: string;
  storefrontRootDomain: string; // "cairoessentials.com"
}

export class StorefrontCertsUsEast1Stack extends cdk.Stack {
  public readonly storefrontWildcardHost: string;
  public readonly storefrontWildcardCertArnUsEast1: string;

  constructor(scope: Construct, id: string, props: StorefrontCertsUsEast1StackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();

    this.storefrontWildcardHost = `*.${props.storefrontRootDomain}`;

    // Import the Hosted Zone that was created in the primary/EU stack
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "StorefrontZoneImported", {
      hostedZoneId: props.storefrontHostedZoneId,
      zoneName: props.storefrontRootDomain,
    });

    /**
     * CloudFront requires ACM certs in us-east-1.
     * This stack MUST be deployed in us-east-1.
     *
     * Using acm.Certificate (NOT deprecated).
     */
    const cert = new acm.Certificate(this, "StorefrontWildcardCertUsEast1", {
      domainName: this.storefrontWildcardHost,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Optional safety (dev): keep cert around if you nuke stacks
    // cert.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.storefrontWildcardCertArnUsEast1 = cert.certificateArn;

    new cdk.CfnOutput(this, "StorefrontStage", { value: stage });

    new cdk.CfnOutput(this, "StorefrontWildcardHost", {
      value: this.storefrontWildcardHost,
    });

    new cdk.CfnOutput(this, "StorefrontWildcardCertArnUsEast1", {
      value: this.storefrontWildcardCertArnUsEast1,
    });
  }
}
