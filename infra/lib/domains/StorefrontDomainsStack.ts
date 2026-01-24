import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

export interface StorefrontDomainsStackProps extends cdk.StackProps {
  stage: string;

  // dev: dev.cairoessentials.com
  storefrontRootDomain: string; // "dev.cairoessentials.com"
}

export class StorefrontDomainsStack extends cdk.Stack {
  // Hosted zone
  public readonly storefrontZone: route53.IHostedZone;
  public readonly storefrontHostedZoneId: string;

  // Stable host(s)
  public readonly storefrontWildcardHost: string; // "*.dev.cairoessentials.com"

  // Cert ARNs
  public readonly storefrontWildcardCertArnUsEast1: string;

  constructor(scope: Construct, id: string, props: StorefrontDomainsStackProps) {
    super(scope, id, props);

    const stage = (props.stage ?? "dev").toLowerCase();

    this.storefrontWildcardHost = `*.${props.storefrontRootDomain}`;

    // Hosted Zone for storefront domain primitives
    // NOTE: If this is a subdomain zone (dev.cairoessentials.com),
    // ensure parent zone delegates NS for "dev" to this zone's NS set.
    const zone = new route53.PublicHostedZone(this, "StorefrontZone", {
      zoneName: props.storefrontRootDomain,
    });

    this.storefrontZone = zone;
    this.storefrontHostedZoneId = zone.hostedZoneId;

    // Wildcard cert for storefronts (CloudFront cert => us-east-1)
    const wildcardCert = new acm.DnsValidatedCertificate(
      this,
      "StorefrontWildcardCertUsEast1",
      {
        domainName: this.storefrontWildcardHost,
        hostedZone: zone,
        region: "us-east-1",
      }
    );

    this.storefrontWildcardCertArnUsEast1 = wildcardCert.certificateArn;

    // Outputs
    new cdk.CfnOutput(this, "StorefrontStage", { value: stage });

    new cdk.CfnOutput(this, "StorefrontHostedZoneId", {
      value: this.storefrontHostedZoneId,
    });

    new cdk.CfnOutput(this, "StorefrontHostedZoneNameServers", {
      value: cdk.Fn.join(",", zone.hostedZoneNameServers ?? []),
    });

    new cdk.CfnOutput(this, "StorefrontWildcardHost", {
      value: this.storefrontWildcardHost,
    });

    new cdk.CfnOutput(this, "StorefrontWildcardCertArnUsEast1", {
      value: this.storefrontWildcardCertArnUsEast1,
    });
  }
}
